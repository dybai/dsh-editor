import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPreferencesService } from './preferences-service.js';

/** 手动放行的 promise 门，用于让排队/读中辍检测试确定性成立。 */
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/**
 * 注入用 fake kv：内存实现 loadAll/putRecord/deleteRecord(s)/setGlobal/close。
 * `kv.ops` 记录操作日志（loadAll/put/deleteRecords/setGlobal/close 顺序），
 * `kv.openCalls`/`kv.descriptors` 记录 open 次数与收到的 descriptor。
 */
function fakeKv() {
  const kv = {
    openCalls: 0,
    descriptors: [],
    ops: [],
    unit: null,
    async open(descriptor) {
      kv.openCalls += 1;
      kv.descriptors.push(descriptor);
      const table = new Map();
      let global = null;
      let closed = false;
      kv.unit = {
        get closed() { return closed; },
        async loadAll() {
          kv.ops.push('loadAll');
          const records = {};
          for (const [key, value] of table) records[key] = value;
          return { tables: { modeAssociations: records }, global };
        },
        async putRecord(name, key, value) {
          assert.equal(name, 'modeAssociations');
          kv.ops.push(`put ${key}`);
          table.set(key, structuredClone(value));
        },
        async deleteRecord(name, key) {
          assert.equal(name, 'modeAssociations');
          kv.ops.push(`delete ${key}`);
          table.delete(key);
        },
        async deleteRecords(name, keys) {
          assert.equal(name, 'modeAssociations');
          kv.ops.push(`deleteRecords [${keys.slice().sort().join(',')}]`);
          for (const key of keys) table.delete(key);
        },
        async setGlobal(value) {
          kv.ops.push(`setGlobal ${value === null || value === undefined ? 'null' : value.updatedAt}`);
          global = structuredClone(value);
        },
        async close() {
          kv.ops.push('close');
          closed = true;
        },
      };
      return kv.unit;
    },
  };
  return kv;
}

/** 递增时钟的默认服务装配。 */
function makeService(kv, start = 1000) {
  let tick = start;
  const service = createPreferencesService({ kv, now: () => tick++ });
  return { service, nextTick: () => tick };
}

const isAbort = (error) => error instanceof Error && error.name === 'AbortError';
const isCoded = (code) => (error) =>
  error instanceof Error && error.message === code && error.code === code;

test('getModePreferences returns empty associations before first set', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  assert.deepEqual(await service.getModePreferences(), { associations: [], updatedAt: 0 });
});

test('setModePreferences persists associations and bumps updatedAt', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  const result = await service.setModePreferences([
    { glob: '*.ts', modeId: 'code-highlight' },
    { glob: '*.js', modeId: 'code-highlight' },
  ]);
  assert.deepEqual(result, { updatedAt: 1000 });
  // 记录形态：key = glob，value = { modeId, updatedAt }；global 承载 updatedAt
  const snapshot = await kv.unit.loadAll();
  assert.deepEqual(snapshot.tables.modeAssociations, {
    '*.ts': { modeId: 'code-highlight', updatedAt: 1000 },
    '*.js': { modeId: 'code-highlight', updatedAt: 1000 },
  });
  assert.deepEqual(snapshot.global, { updatedAt: 1000 });
  // 读回：按 glob 排序，条目只含 glob/modeId
  assert.deepEqual(await service.getModePreferences(), {
    associations: [
      { glob: '*.js', modeId: 'code-highlight' },
      { glob: '*.ts', modeId: 'code-highlight' },
    ],
    updatedAt: 1000,
  });
});

test('setModePreferences rejects stale expectedUpdatedAt with conflict error', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  await service.setModePreferences([{ glob: '*.ts', modeId: 'code-highlight' }]); // t=1000
  await assert.rejects(
    service.setModePreferences([{ glob: '*.ts', modeId: 'plain-text' }], 999),
    isCoded('mode-preferences/conflict'),
  );
  // 冲突后存储原样
  assert.deepEqual(await service.getModePreferences(), {
    associations: [{ glob: '*.ts', modeId: 'code-highlight' }],
    updatedAt: 1000,
  });
  assert.deepEqual(kv.ops, ['loadAll', 'put *.ts', 'setGlobal 1000', 'loadAll', 'loadAll']);
});

test('concurrent sets are serialized by the internal write chain', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  const [first, second] = await Promise.all([
    service.setModePreferences([{ glob: '*.a', modeId: 'mode-a' }]), // t=1000
    service.setModePreferences([{ glob: '*.b', modeId: 'mode-b' }]), // t=1001
  ]);
  assert.deepEqual(first, { updatedAt: 1000 });
  assert.deepEqual(second, { updatedAt: 1001 });
  // 第二次 set 是完整集合：第一次的 *.a 被删除；两个 set 依次完整生效
  assert.deepEqual(await service.getModePreferences(), {
    associations: [{ glob: '*.b', modeId: 'mode-b' }],
    updatedAt: 1001,
  });
  assert.deepEqual(kv.ops, [
    'loadAll', 'put *.a', 'setGlobal 1000',            // set #1 完整落地
    'loadAll', 'deleteRecords [*.a]', 'put *.b', 'setGlobal 1001', // set #2 才开始
    'loadAll',                                          // 最终读
  ]);
});

test('setModePreferences validates associations before the write chain', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  const invalid = [
    undefined, null, 'x', 42,
    [null], ['x'], [42], [{}],
    [{ glob: '', modeId: 'm' }],
    [{ glob: '*.ts', modeId: '' }],
    [{ glob: 7, modeId: 'm' }],
    [{ glob: '*.ts', modeId: 7 }],
    [{ glob: '*.ts' }],
    [{ modeId: 'm' }],
  ];
  for (const input of invalid) {
    await assert.rejects(service.setModePreferences(input), isCoded('mode-preferences/invalid-associations'));
  }
  assert.equal(kv.openCalls, 0); // 校验失败不触碰 kv（链前 fail loud，连 unit 都不打开）
  assert.deepEqual(await service.getModePreferences(), { associations: [], updatedAt: 0 });
});

test('expectedUpdatedAt 0 matches a never-written unit and undefined skips the check', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  const zero = await service.setModePreferences([{ glob: '*.md', modeId: 'plain-text' }], 0);
  assert.deepEqual(zero, { updatedAt: 1000 });
  const fresh = await service.setModePreferences([{ glob: '*.md', modeId: 'plain-text' }], 1000);
  assert.deepEqual(fresh, { updatedAt: 1001 });
  const unchecked = await service.setModePreferences([{ glob: '*.md', modeId: 'plain-text' }]);
  assert.deepEqual(unchecked, { updatedAt: 1002 });
});

test('a rejected set does not poison the write chain', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  await service.setModePreferences([{ glob: '*.a', modeId: 'm' }]); // t=1000
  await assert.rejects(
    service.setModePreferences([{ glob: '*.b', modeId: 'm' }], 999),
    isCoded('mode-preferences/conflict'),
  );
  const recovered = await service.setModePreferences([{ glob: '*.c', modeId: 'm' }]); // t=1001（冲突路径未取时钟）
  assert.deepEqual(recovered, { updatedAt: 1001 });
  assert.deepEqual((await service.getModePreferences()).associations, [{ glob: '*.c', modeId: 'm' }]);
});

test('an empty associations array clears all records but still bumps updatedAt', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  await service.setModePreferences([{ glob: '*.ts', modeId: 'm' }, { glob: '*.js', modeId: 'm' }]);
  const cleared = await service.setModePreferences([]);
  assert.deepEqual(cleared, { updatedAt: 1001 });
  assert.deepEqual(await service.getModePreferences(), { associations: [], updatedAt: 1001 });
});

test('an aborted signal rejects with AbortError before any unit work', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.getModePreferences(controller.signal), isAbort);
  await assert.rejects(
    service.setModePreferences([], undefined, controller.signal),
    isAbort,
  );
  assert.equal(kv.openCalls, 0); // 辍检在读/链之前：连 unit 都不打开
});

test('getModePreferences re-checks the signal after the read', async () => {
  const read = gate();
  let loadCalls = 0;
  const kv = {
    async open() {
      return {
        async loadAll() {
          loadCalls += 1;
          await read.promise;
          return { tables: { modeAssociations: { '*.ts': { modeId: 'm', updatedAt: 5 } } }, global: { updatedAt: 5 } };
        },
        async putRecord() {}, async deleteRecord() {}, async deleteRecords() {},
        async setGlobal() {}, async close() {},
      };
    },
  };
  const service = createPreferencesService({ kv, now: () => 1 });
  const controller = new AbortController();
  const pending = service.getModePreferences(controller.signal);
  controller.abort(); // 读取进行中
  read.release();
  await assert.rejects(pending, isAbort);
  assert.equal(loadCalls, 1);
});

test('a queued set whose signal aborts before it runs writes nothing', async () => {
  let current = gate();
  const ops = [];
  const kv = {
    async open() {
      const table = new Map();
      let global = null;
      return {
        async loadAll() {
          await current.promise;
          const records = {};
          for (const [key, value] of table) records[key] = value;
          return { tables: { modeAssociations: records }, global };
        },
        async deleteRecords(_name, keys) {
          await current.promise;
          ops.push(`deleteRecords:${keys.join(',')}`);
          for (const key of keys) table.delete(key);
        },
        async putRecord(_name, key, value) {
          await current.promise;
          ops.push(`put:${key}`);
          table.set(key, value);
        },
        async setGlobal(value) {
          await current.promise;
          ops.push(`setGlobal:${value.updatedAt}`);
          global = value;
        },
        async deleteRecord() {}, async close() {},
      };
    },
  };
  const service = createPreferencesService({ kv, now: () => 1000 });
  const first = service.setModePreferences([{ glob: '*.a', modeId: 'm' }]);
  const controller = new AbortController();
  const second = service.setModePreferences([{ glob: '*.b', modeId: 'm' }], undefined, controller.signal);
  controller.abort(); // second 仍排队在 first 之后
  current.release();
  await first;
  await assert.rejects(second, isAbort);
  assert.deepEqual(ops, ['put:*.a', 'setGlobal:1000']); // second 没有落任何写
  assert.deepEqual((await service.getModePreferences()).associations, [{ glob: '*.a', modeId: 'm' }]);
});

test('the unit opens lazily exactly once with the contract descriptor', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  assert.equal(kv.openCalls, 0); // 构造不打开
  await Promise.all([service.getModePreferences(), service.getModePreferences()]);
  await service.setModePreferences([]);
  assert.equal(kv.openCalls, 1); // 并发读共享同一次 open
  assert.deepEqual(kv.descriptors[0], {
    name: 'dsh-editor',
    version: 1,
    tables: ['modeAssociations'],
    hasGlobal: true,
  });
});

test('a failed open is not memoized, so a later call retries', async () => {
  let failures = 1;
  const kv = {
    openCalls: 0,
    async open(descriptor) {
      this.openCalls += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error('backend-not-mounted');
      }
      return {
        async loadAll() { return { tables: { modeAssociations: {} }, global: null }; },
        async putRecord() {}, async deleteRecord() {}, async deleteRecords() {},
        async setGlobal() {}, async close() {},
      };
    },
  };
  const service = createPreferencesService({ kv, now: () => 1 });
  await assert.rejects(service.getModePreferences(), /backend-not-mounted/);
  assert.deepEqual(await service.getModePreferences(), { associations: [], updatedAt: 0 });
  assert.equal(kv.openCalls, 2);
});

test('a rejecting loadAll propagates to the caller (fail loud)', async () => {
  const kv = {
    async open() {
      return {
        async loadAll() { throw new Error('medium-unreadable'); },
        async putRecord() {}, async deleteRecord() {}, async deleteRecords() {},
        async setGlobal() {}, async close() {},
      };
    },
  };
  const service = createPreferencesService({ kv, now: () => 1 });
  await assert.rejects(service.getModePreferences(), /medium-unreadable/);
});

test('close drains the write chain and closes the memoized unit; a later call reopens', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  const write = service.setModePreferences([{ glob: '*.ts', modeId: 'm' }]);
  const closing = service.close(); // 写入在途时关闭
  await write;
  await closing;
  assert.equal(kv.unit.closed, true);
  assert.deepEqual(kv.ops, ['loadAll', 'put *.ts', 'setGlobal 1000', 'close']);
  await service.getModePreferences(); // 重新懒打开
  assert.equal(kv.openCalls, 2);
  await service.close(); // 未打开时 close 幂等 no-op
  assert.equal(kv.openCalls, 2);
});

test('setModePreferences signal is the last parameter (SRC cancellation convention)', async () => {
  const kv = fakeKv();
  const { service } = makeService(kv);
  // (associations, expectedUpdatedAt, signal) 三参形状已在上方各测试实际使用；
  // 此处固化：最后一位传 signal、第二位可省略传 undefined 的调用不抛 TypeError。
  const controller = new AbortController();
  const result = await service.setModePreferences([{ glob: '*.ts', modeId: 'm' }], undefined, controller.signal);
  assert.deepEqual(result, { updatedAt: 1000 });
  assert.equal(typeof service.getModePreferences.length, 'number');
  assert.ok(service.getModePreferences.length >= 1); // signal 是 get 的入参
});

test('the module imports nothing (kv and now are injected)', async () => {
  const source = await readFile(new URL('./preferences-service.js', import.meta.url), 'utf8');
  assert.equal(/^\s*(import|require\s*\()/m.test(source), false);
});
