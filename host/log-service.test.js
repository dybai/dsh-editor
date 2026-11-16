import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogService } from './log-service.js';
import { formatLogArgs } from './log-serialize.js';

const DAY = 24 * 60 * 60 * 1000;

/** 手动推进/回拨的假时钟（默认静止，调用方按需拨动）。 */
function fakeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    set: (value) => { at = value; },
    advance: (delta) => { at += delta; },
  };
}

/**
 * 注入用 fake KvFacet：open(descriptor) 返回内存 Map unit（loadAll /
 * putRecord / deleteRecords / setGlobal / close，写入值一律 structuredClone
 * 防别名）。`openError` 模拟存储后端未挂；`putErrors` 让前 N 次 putRecord
 * 抛错（写链拒绝场景）；`kv.openCalls`/`kv.descriptors` 记录 open 触达，
 * `kv.snapshot()` 以 loadAll 的形状回读当前介质（open 失败时 unit 为 null）。
 */
function fakeKv({ openError, putErrors = 0 } = {}) {
  let putFailures = putErrors;
  const kv = {
    openCalls: 0,
    descriptors: [],
    unit: null,
    async open(descriptor) {
      kv.openCalls += 1;
      kv.descriptors.push(descriptor);
      if (openError !== undefined) throw openError;
      const tables = new Map();
      let global = null;
      let closeCalls = 0;
      kv.unit = {
        get closed() { return closeCalls > 0; },
        get closeCalls() { return closeCalls; },
        async loadAll() {
          const snapshot = { tables: {}, global };
          for (const [name, map] of tables) {
            const records = {};
            for (const [key, value] of map) records[key] = value;
            snapshot.tables[name] = records;
          }
          return snapshot;
        },
        async putRecord(name, key, value) {
          if (putFailures > 0) {
            putFailures -= 1;
            throw new Error('medium busy');
          }
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name).set(key, structuredClone(value));
        },
        async deleteRecords(name, keys) {
          for (const key of keys) tables.get(name)?.delete(key);
        },
        async setGlobal(value) { global = structuredClone(value); },
        async close() { closeCalls += 1; },
      };
      return kv.unit;
    },
    /** 以 loadAll 形状回读介质（只能在 open 成功后调用）。 */
    async snapshot() {
      assert.ok(kv.unit !== null, 'snapshot() 只能在 open 成功后调用');
      return kv.unit.loadAll();
    },
  };
  return kv;
}

/** 合法 client 条目工厂：默认值全合法，overrides 注入坏值。 */
function makeEntry(overrides = {}) {
  return { ts: 1_234_567, level: 'info', source: 'client', scope: 'test', text: 'hello', ...overrides };
}

/** n 条合法条目（text 带 prefix 与序号）。 */
function makeBatch(n, prefix = 'e') {
  return Array.from({ length: n }, (_, i) => makeEntry({ text: `${prefix}${i}` }));
}

/** 等待 microtask 合批 + 立即型 promise 写链全部排空（宏任务边界）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** chunk 记录按 key（= seq，字典序即数值序）升序取出。 */
function sortedChunks(snapshot) {
  const chunks = snapshot.tables.chunks ?? {};
  return Object.keys(chunks).sort().map((key) => [key, chunks[key]]);
}

/** 默认装配：静息时钟（cutoff 为负，不触发天数轮转）+ 可选注入。 */
function setup({ openError, putErrors, report, now } = {}) {
  const kv = fakeKv({ openError, putErrors });
  const service = createLogService({ kv, now: now ?? (() => 1_000_000), report });
  return { service, kv };
}

const isInvalid = (error) =>
  error instanceof Error && error.message === 'logs/invalid' && error.code === 'logs/invalid';

test('constructor requires kv facet and now clock', () => {
  assert.throws(() => createLogService({ now: () => 0 }), /kv facet/);
  assert.throws(() => createLogService({ kv: fakeKv() }), /now\(\) clock/);
});

test('assigns monotonic seq and chunk keys', async () => {
  const { service, kv } = setup();
  assert.deepEqual(await service.appendEntries([makeEntry({ text: 'one' })]), { accepted: 1 });
  assert.deepEqual(await service.appendEntries([makeEntry({ text: 'two' })]), { accepted: 1 });
  // unit descriptor 逐字钉死（存储契约）
  assert.deepEqual(kv.descriptors, [
    { name: 'dsh_editor_logs', version: 1, tables: ['chunks'], hasGlobal: true },
  ]);
  const chunks = sortedChunks(await kv.snapshot());
  assert.deepEqual(chunks.map(([key]) => key), ['c000000000001', 'c000000000002']);
  assert.deepEqual(chunks.map(([, value]) => value.seq), [1, 2]);
  assert.deepEqual((await kv.snapshot()).global, { lastSeq: 2 }); // global.lastSeq 递增
  // chunk 值形状：{ seq, ts, entries }，ts 为 append 时刻 Host 时钟
  assert.equal(chunks[0][1].ts, 1_000_000);
  assert.deepEqual(chunks[0][1].entries.map((entry) => entry.text), ['one']);
});

test('serializes concurrent appends through one chain', async () => {
  let tickNow = 0;
  const { service, kv } = setup({ now: () => ++tickNow }); // 严格递增时钟
  const batches = [
    [makeEntry({ text: 'a1' }), makeEntry({ text: 'a2' })],
    [makeEntry({ text: 'b1' }), makeEntry({ text: 'b2' })],
    [makeEntry({ text: 'c1' }), makeEntry({ text: 'c2' })],
  ];
  const results = await Promise.all(batches.map((batch) => service.appendEntries(batch)));
  assert.deepEqual(results, [{ accepted: 2 }, { accepted: 2 }, { accepted: 2 }]);
  const chunks = sortedChunks(await kv.snapshot());
  assert.deepEqual(chunks.map(([key]) => key), ['c000000000001', 'c000000000002', 'c000000000003']);
  const seqs = chunks.map(([, value]) => value.seq);
  const timestamps = chunks.map(([, value]) => value.ts);
  assert.deepEqual(seqs, [1, 2, 3]); // seq 严格递增
  for (let i = 1; i < timestamps.length; i++) {
    assert.ok(timestamps[i] > timestamps[i - 1], `chunk.ts 严格递增 @${i}`);
  }
  // 各批完整落在各自 chunk，无交叉
  assert.deepEqual(chunks[0][1].entries.map((entry) => entry.text), ['a1', 'a2']);
  assert.deepEqual(chunks[1][1].entries.map((entry) => entry.text), ['b1', 'b2']);
  assert.deepEqual(chunks[2][1].entries.map((entry) => entry.text), ['c1', 'c2']);
});

test('rejects invalid payloads with logs/invalid', async () => {
  const { service, kv } = setup();
  const cases = [
    ['entries 非数组', null],
    ['0 条', []],
    ['201 条', makeBatch(201)],
    ['level 越界', [makeEntry({ level: 'verbose' })]],
    ['source 非 client', [makeEntry({ source: 'host' })]],
    ['空 scope', [makeEntry({ scope: '' })]],
    ['scope 超 64 字符', [makeEntry({ scope: 'x'.repeat(65) })]],
    ['text 超 2000 字符', [makeEntry({ text: 'x'.repeat(2001) })]],
    ['ts 非有限', [makeEntry({ ts: Number.NaN })]],
  ];
  for (const [label, payload] of cases) {
    await assert.rejects(service.appendEntries(payload), isInvalid, label);
  }
  assert.equal(kv.unit, null); // 校验先于 open：零触达、零写入
});

test('converges to <=2000 entries', async () => {
  const clock = fakeClock(1_000_000);
  const { service, kv } = setup({ now: clock.now });
  for (let round = 0; round < 15; round++) {
    clock.advance(1000); // 全部年轻：隔离天数规则，只测计数收敛
    await service.appendEntries(makeBatch(200, `b${round}-`));
  }
  const chunks = sortedChunks(await kv.snapshot());
  const total = chunks.reduce((sum, [, value]) => sum + value.entries.length, 0);
  assert.ok(total <= 2000, `总条目 ${total} 应 ≤ 2000`);
  assert.equal(total, 2000); // 精确收敛：只在超限时删，不提前淘汰
  assert.deepEqual(
    chunks.map(([key]) => key).slice(0, 2),
    ['c000000000006', 'c000000000007'], // 最老 chunk（第 1 批）已删，存活最老为第 6 批
  );
  assert.equal(chunks[0][1].entries[0].text, 'b5-0');
  assert.deepEqual((await kv.snapshot()).global, { lastSeq: 15 });
});

test('age-prunes chunks past 7 days', async () => {
  const clock = fakeClock(1_000_000);
  const { service, kv } = setup({ now: clock.now });
  await service.appendEntries([makeEntry({ text: 'exact-7d' })]); // chunk1.ts = 1_000_000
  // 恰 7 天：cutoff == chunk.ts → 保留（等于不删）
  clock.set(1_000_000 + 7 * DAY);
  await service.appendEntries([makeEntry({ text: 'boundary' })]);
  let chunks = Object.fromEntries(sortedChunks(await kv.snapshot()));
  assert.ok(chunks.c000000000001, '恰 7 天（ts == cutoff）保留');
  // 7 天 +1ms：cutoff 越过老 chunk.ts → 删除
  clock.set(1_000_000 + 7 * DAY + 1);
  await service.appendEntries([makeEntry({ text: 'after' })]);
  chunks = Object.fromEntries(sortedChunks(await kv.snapshot()));
  assert.equal(chunks.c000000000001, undefined, '7 天 +1ms 删除');
  assert.ok(chunks.c000000000002 && chunks.c000000000003, '年轻 chunk 不受影响');
});

test('clock regression does not delete fresh chunks', async () => {
  const clock = fakeClock(10 * DAY);
  const { service, kv } = setup({ now: clock.now });
  await service.appendEntries([makeEntry({ text: 'old-a' })]);
  await service.appendEntries([makeEntry({ text: 'old-b' })]);
  const oldTs = sortedChunks(await kv.snapshot()).map(([, value]) => value.ts);
  clock.set(2 * DAY); // 时钟回拨 8 天：cutoff = -5*DAY，远早于一切存量 ts
  await service.appendEntries([makeEntry({ text: 'new' })]);
  const after = sortedChunks(await kv.snapshot());
  assert.deepEqual(after.slice(0, 2).map(([, value]) => value.ts), oldTs); // 老 chunk.ts 原样
  assert.equal(after.length, 3); // 新 chunk 不被误删
  assert.equal(after[2][1].entries[0].text, 'new');
  assert.deepEqual((await kv.snapshot()).global, { lastSeq: 3 }); // seq 分配不受回拨影响
});

test('degrades permanently after open failure', async () => {
  const errors = [];
  const { service, kv } = setup({
    openError: new Error('backend not mounted'),
    report: { error: (...args) => errors.push(args) },
  });
  assert.deepEqual(await service.appendEntries(makeBatch(3)), { accepted: 0 }); // 首次 append 即降级
  assert.equal(errors.length, 1); // report.error 恰一次
  assert.deepEqual(await service.appendEntries(makeBatch(2)), { accepted: 0 });
  assert.deepEqual(await service.appendEntries(makeBatch(2)), { accepted: 0 }); // 后续恒 accepted:0
  assert.equal(errors.length, 1); // 不重复上报
  assert.equal(kv.openCalls, 1); // 永不再触 open
  assert.equal(kv.unit, null); // 零写入
  await assert.doesNotReject(service.close()); // 降级后的 close 不因 open 失败的 memo 炸
});

test('appendLogs still resolves accepted:0 when degraded', async () => {
  const { service, kv } = setup({
    openError: new Error('nope'),
    report: { error: () => {} },
  });
  await service.appendEntries([makeEntry()]); // 触发降级
  assert.deepEqual(await service.appendEntries(makeBatch(200)), { accepted: 0 }); // 满批也照常 resolve
  assert.equal(kv.openCalls, 1);
});

test('filters by logger name', async () => {
  const { service, kv } = setup();
  const exporter = service.createExporter({ loggerName: 'dsh-editor' });
  exporter.export({ name: 'cordis', type: 'info', args: ['not ours'] });
  exporter.export({ name: 'someone-else', type: 'error', args: ['nope'] });
  await tick();
  assert.equal(kv.openCalls, 0); // 零写入：连 unit 都不打开
  assert.equal(kv.unit, null);
});

test('coalesces same-tick messages into one chunk', async () => {
  const clock = fakeClock(5_000_000);
  const { service, kv } = setup({ now: clock.now });
  const exporter = service.createExporter({ loggerName: 'dsh-editor' });
  exporter.export({ name: 'dsh-editor', type: 'debug', args: ['boot'] });
  exporter.export({ name: 'dsh-editor', type: 'info', args: ['a', 1] });
  exporter.export({ name: 'dsh-editor', type: 'error', args: ['boom', { x: 2 }] });
  await tick();
  const chunks = sortedChunks(await kv.snapshot());
  assert.deepEqual(chunks.map(([key]) => key), ['c000000000001']); // 同 tick 合批：恰 1 个 chunk
  const entries = chunks[0][1].entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.source), ['host', 'host', 'host']);
  assert.deepEqual(entries.map((entry) => entry.scope), ['host', 'host', 'host']);
  assert.deepEqual(entries.map((entry) => entry.level), ['debug', 'info', 'error']);
  assert.equal(entries[0].text, formatLogArgs(['boot'])); // text = formatLogArgs(args)
  assert.equal(entries[1].text, formatLogArgs(['a', 1]));
  assert.equal(entries[2].text, formatLogArgs(['boom', { x: 2 }]));
  assert.equal(typeof entries[0].ts, 'number');
});

test('splits chatty ticks into <=200-entry appends', async () => {
  const { service, kv } = setup();
  const exporter = service.createExporter({ loggerName: 'dsh-editor' });
  for (let i = 0; i < 450; i++) {
    exporter.export({ name: 'dsh-editor', type: 'info', args: [`m${i}`] });
  }
  await tick();
  const chunks = sortedChunks(await kv.snapshot());
  assert.deepEqual(chunks.map(([, value]) => value.entries.length), [200, 200, 50]); // 按 200 切分
  assert.deepEqual(chunks.map(([key]) => key), ['c000000000001', 'c000000000002', 'c000000000003']);
  assert.equal(chunks[0][1].entries[0].text, 'm0');
  assert.equal(chunks[2][1].entries[49].text, 'm449'); // 批内顺序保持
});

test('never throws and guards re-entrancy', async () => {
  let exporter;
  let reportErrors = 0;
  const { service, kv } = setup({
    putErrors: 1, // 首次 putRecord 抛错：写链拒绝 → 处理期间 report.error 再触发 export
    report: {
      error: () => {
        reportErrors += 1;
        exporter.export({ name: 'dsh-editor', type: 'error', args: ['self-excitation'] });
      },
    },
  });
  exporter = service.createExporter({ loggerName: 'dsh-editor' });
  assert.doesNotThrow(() => {
    exporter.export({ name: 'dsh-editor', type: 'error', args: ['first'] });
    exporter.export(null); // 离谱消息形状不炸
    exporter.export(undefined);
    exporter.export({});
  });
  await tick();
  assert.equal(reportErrors, 1); // 恰一次：防自激标志在处理期间截断再入
  assert.equal(sortedChunks(await kv.snapshot()).length, 0); // 自产日志未落盘
  // 写链拒绝不毒化后续写入：直接 append 恢复成功
  assert.deepEqual(await service.appendEntries([makeEntry({ text: 'recovered' })]), { accepted: 1 });
  const chunks = sortedChunks(await kv.snapshot());
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][1].entries[0].text, 'recovered');
});

test('close is idempotent and drains the chain', async () => {
  const { service, kv } = setup();
  const pending = service.appendEntries([makeEntry({ text: 'last' })]); // 在途写
  await service.close();
  await service.close(); // 幂等
  assert.deepEqual(await pending, { accepted: 1 }); // 排空写链：在途写已落盘
  const chunks = sortedChunks(await kv.snapshot());
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][1].entries[0].text, 'last');
  assert.equal(kv.unit.closed, true);
  assert.equal(kv.unit.closeCalls, 1); // 两次 close 只关一次 unit
});

test('report defaults to console when not injected', async () => {
  const original = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args); };
  try {
    const { service } = setup({ openError: new Error('unmounted') }); // 未注入 report
    assert.deepEqual(await service.appendEntries([makeEntry()]), { accepted: 0 });
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1); // 降级上报缺省落 console.error
});
