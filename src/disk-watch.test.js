import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiskWatch } from './disk-watch.js';

const settle = async (times = 3) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * 可编排的流替身：scripts 是逐步脚本（yield 一帧 / throw 一个错误 / end 干净结束）。
 * 脚本耗尽后流保持打开（真实 $stream 的行为），直到 dispose；带 dispose 间谍。
 */
function makeStream(scripts) {
  const state = { disposed: false, disposeCalls: 0 };
  let release = null;
  const idle = new Promise((resolve) => { release = resolve; });
  const stream = {
    dispose() {
      state.disposed = true;
      state.disposeCalls++;
      release();
    },
    async *[Symbol.asyncIterator]() {
      for (const step of scripts) {
        if (state.disposed) return;
        if (step.throw !== undefined) throw step.throw;
        if (step.end) return;
        yield step.yield;
      }
      await idle; // 保持打开，等待 dispose
    },
  };
  return { stream, state };
}

/**
 * 可控推送的活流替身：测试方用 push() 在任意时机投递帧，模拟真实 $stream
 * 的“挂起等帧、随时可达可拆”生命周期；带 dispose 间谍。
 */
function makeLiveStream() {
  const state = { disposed: false, disposeCalls: 0 };
  const pending = [];
  let wake = null;
  const stream = {
    dispose() {
      state.disposed = true;
      state.disposeCalls++;
      const w = wake;
      wake = null;
      if (w) w();
    },
    push(step) {
      pending.push(step);
      const w = wake;
      wake = null;
      if (w) w();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (state.disposed) return;
        while (pending.length > 0) {
          if (state.disposed) return;
          const step = pending.shift();
          if (step.throw !== undefined) throw step.throw;
          if (step.end) return;
          yield step.yield;
        }
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return { stream, state };
}

// ---- 流式主路径 ----

test('ready frame is accepted and marks the watch streaming', async () => {
  const accept = () => {};
  const { stream, state } = makeStream([{ yield: { value: { kind: 'ready' }, accept } }]);
  const notices = [];
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => ({ version: 'v1' }),
    onNotice: (n) => notices.push(n),
  });
  await settle();
  assert.equal(watch.mode(), 'streaming');
  assert.deepEqual(notices, []); // ready 不是变更
  watch.dispose();
  assert.equal(state.disposeCalls, 1);
});

test('change frames pump as notices (version and absent)', async () => {
  const { stream } = makeStream([
    { yield: { value: { kind: 'ready' }, accept: () => {} } },
    { yield: { value: { kind: 'change', change: { absolutePath: 'X', version: 'v2' } } } },
    { yield: { value: { kind: 'change', change: { absolutePath: 'X', absent: true } } } },
  ]);
  const notices = [];
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => ({ version: 'v1' }),
    onNotice: (n) => notices.push(n),
  });
  await settle();
  assert.deepEqual(notices, [{ version: 'v2' }, { absent: true }]);
  watch.dispose();
});

test('malformed frames are skipped silently', async () => {
  const { stream } = makeStream([
    { yield: { value: { kind: 'ready' }, accept: () => {} } },
    { yield: { value: null } },
    { yield: { value: { kind: 'change' } } }, // 无 change 载荷
    { yield: { value: { kind: 'change', change: {} } } }, // 无版本也无 absent
    { yield: { value: { kind: 'wat' } } }, // 未知 kind
  ]);
  const notices = [];
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => ({ version: 'v1' }),
    onNotice: (n) => notices.push(n),
  });
  await settle();
  assert.deepEqual(notices, []);
  watch.dispose();
});

test('a throwing onNotice does not break the pump', async () => {
  const { stream } = makeStream([
    { yield: { value: { kind: 'ready' }, accept: () => {} } },
    { yield: { value: { kind: 'change', change: { version: 'v2' } } } },
    { yield: { value: { kind: 'change', change: { version: 'v3' } } } },
  ]);
  const notices = [];
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => ({ version: 'v1' }),
    onNotice: (n) => {
      notices.push(n);
      if (notices.length === 1) throw new Error('listener bug');
    },
  });
  await settle();
  assert.deepEqual(notices, [{ version: 'v2' }, { version: 'v3' }]); // 异常不吞后续帧
  watch.dispose();
});

// ---- 降级：流不可用/失败 → 手动 stat ----

test('watch-unsupported failure degrades to manual and re-syncs via stat', async () => {
  const { stream } = makeStream([
    { yield: { value: { kind: 'ready' }, accept: () => {} } },
    { throw: Object.assign(new Error('backend does not support watching'), { code: 'FS_WATCH_UNSUPPORTED' }) },
  ]);
  const statPaths = [];
  const notices = [];
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => {
      statPaths.push(1);
      return { version: 'v7' };
    },
    onNotice: (n) => notices.push(n),
  });
  await settle();
  assert.equal(watch.mode(), 'manual'); // 降级
  assert.deepEqual(notices, [{ version: 'v7' }]); // 立即重同步一次
  assert.equal(statPaths.length, 1);
  watch.dispose();
});

test('any other stream failure also degrades to manual', async () => {
  const { stream } = makeStream([{ throw: new Error('carrier lost') }]);
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => ({ version: 'v2' }),
    onNotice: () => {},
  });
  await settle();
  assert.equal(watch.mode(), 'manual');
  watch.dispose();
});

test('a stream that ends cleanly degrades to manual too', async () => {
  const { stream } = makeStream([
    { yield: { value: { kind: 'ready' }, accept: () => {} } },
    { end: true }, // 宿主主动收流
  ]);
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => ({ version: 'v2' }),
    onNotice: () => {},
  });
  await settle();
  assert.equal(watch.mode(), 'manual'); // 宿主收流后不再有推送，退回手动
  watch.dispose();
});

test('openChanges unavailable at creation starts in manual mode', async () => {
  const notices = [];
  const watch = createDiskWatch({
    openChanges: undefined,
    stat: async () => ({ version: 'v3' }),
    onNotice: (n) => notices.push(n),
  });
  assert.equal(watch.mode(), 'manual');
  await watch.checkNow();
  assert.deepEqual(notices, [{ version: 'v3' }]);
  watch.dispose();
});

test('openChanges throwing synchronously degrades to manual', async () => {
  const watch = createDiskWatch({
    openChanges: () => {
      throw new Error('no $stream on this remote face');
    },
    stat: async () => ({ version: 'v3' }),
    onNotice: () => {},
  });
  await settle();
  assert.equal(watch.mode(), 'manual');
  watch.dispose();
});

// ---- 手动 checkNow 语义 ----

test('checkNow stats once and reports the version', async () => {
  const watch = createDiskWatch({
    openChanges: undefined,
    stat: async () => ({ version: 'v4' }),
    onNotice: () => {},
  });
  await watch.checkNow();
  await watch.checkNow();
  watch.dispose();
});

test('not-found stat rejection reports absent', async () => {
  const notices = [];
  const watch = createDiskWatch({
    openChanges: undefined,
    stat: async () => {
      throw Object.assign(new Error('cannot stat "a.txt": not found'), { code: 'FS_NOT_FOUND' });
    },
    onNotice: (n) => notices.push(n),
  });
  await watch.checkNow();
  assert.deepEqual(notices, [{ absent: true }]);
  watch.dispose();
});

test('other stat failures are silent (next check retries)', async () => {
  const notices = [];
  const watch = createDiskWatch({
    openChanges: undefined,
    stat: async () => {
      throw new Error('network down');
    },
    onNotice: (n) => notices.push(n),
  });
  await watch.checkNow();
  assert.deepEqual(notices, []);
  watch.dispose();
});

test('concurrent checkNow calls coalesce into one follow-up stat', async () => {
  let inFlight = 0;
  let statCalls = 0;
  const first = { resolve: null };
  const gate = new Promise((resolve) => {
    first.resolve = resolve;
  });
  const notices = [];
  const watch = createDiskWatch({
    openChanges: undefined,
    stat: async () => {
      statCalls++;
      if (statCalls === 1) await gate; // 第一次挂住，制造并发窗口
      return { version: `v${statCalls}` };
    },
    onNotice: (n) => notices.push(n),
  });
  const p1 = watch.checkNow();
  const p2 = watch.checkNow(); // in-flight：只排队
  first.resolve();
  await Promise.all([p1, p2]);
  await settle(2);
  assert.equal(statCalls, 2); // 排队的那次在第一次结束后补跑一次
  assert.deepEqual(notices, [{ version: 'v1' }, { version: 'v2' }]);
  watch.dispose();
});

test('checkNow is a no-op after dispose', async () => {
  const statCalls = { n: 0 };
  const notices = [];
  const watch = createDiskWatch({
    openChanges: undefined,
    stat: async () => {
      statCalls.n++;
      return { version: 'v1' };
    },
    onNotice: (n) => notices.push(n),
  });
  watch.dispose();
  await watch.checkNow();
  assert.equal(statCalls.n, 0);
  assert.deepEqual(notices, []);
});

// ---- 生命周期 ----

test('abort disposes the stream and stops reporting', async () => {
  const abort = new AbortController();
  const { stream, state } = makeLiveStream();
  const notices = [];
  const statCalls = { n: 0 };
  const watch = createDiskWatch({
    signal: abort.signal,
    openChanges: () => stream,
    stat: async () => {
      statCalls.n++;
      return { version: 'v1' };
    },
    onNotice: (n) => notices.push(n),
  });
  stream.push({ yield: { value: { kind: 'ready' }, accept: () => {} } });
  await settle();
  assert.equal(watch.mode(), 'streaming');
  abort.abort();
  await settle();
  assert.equal(state.disposeCalls, 1); // 流被销毁
  stream.push({ yield: { value: { kind: 'change', change: { version: 'v2' } } } }); // abort 后到达
  await settle();
  assert.deepEqual(notices, []); // 不再报
  await watch.checkNow(); // dispose 后 checkNow 无操作
  assert.equal(statCalls.n, 0);
  assert.deepEqual(notices, []);
});

test('dispose stops the pump from delivering later frames', async () => {
  const { stream, state } = makeLiveStream();
  const notices = [];
  const watch = createDiskWatch({
    openChanges: () => stream,
    stat: async () => ({ version: 'v1' }),
    onNotice: (n) => notices.push(n),
  });
  stream.push({ yield: { value: { kind: 'ready' }, accept: () => {} } });
  await settle();
  assert.equal(watch.mode(), 'streaming');
  watch.dispose();
  assert.equal(state.disposeCalls, 1);
  stream.push({ yield: { value: { kind: 'change', change: { version: 'v2' } } } }); // dispose 后到达
  await settle();
  assert.deepEqual(notices, []);
});
