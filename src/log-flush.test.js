import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogBuffer } from './log-buffer.js';
import { createLogFlusher } from './log-flush.js';

/** 等待微任务链排空（setTimeout 0 宏任务前所有微任务都会跑完）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 手动可控的 deferred：需要把某次 call 挂起时用。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 手动时钟：schedule 记录回调与 ms，cancel 撤销，advance 触发当前全部计时。
 */
function fakeClock() {
  const timers = new Map();
  let nextHandle = 1;
  let lastMs;
  return {
    schedule(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { fn, ms });
      lastMs = ms;
      return handle;
    },
    cancel(handle) {
      timers.delete(handle);
    },
    advance() {
      const fired = [...timers.values()]; // 快照：回调内可能再动 timers
      timers.clear();
      for (const timer of fired) timer.fn();
    },
    pending() {
      return timers.size;
    },
    lastMs() {
      return lastMs;
    },
  };
}

/**
 * 组装被测 flusher：真实 Task 2 buffer + 手动时钟 + 可编排结果的 call。
 * behavior(i, args) 的返回值（或抛出）就是第 i 次 call 的结局。
 */
function makeHarness(overrides) {
  const clock = fakeClock();
  const calls = [];
  const warns = [];
  let behavior = async () => ({ ok: true });
  const call = async (endpoint, args) => {
    calls.push({ endpoint, args });
    return behavior(calls.length, args);
  };
  const buffer = createLogBuffer();
  const flusher = createLogFlusher({
    call,
    buffer,
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: () => 0,
    onWarn: (message) => warns.push(message),
    ...overrides,
  });
  return {
    clock,
    calls,
    warns,
    buffer,
    flusher,
    setBehavior(fn) {
      behavior = fn;
    },
  };
}

test('debounces pushes into one flush', async () => {
  const h = makeHarness();
  h.flusher.push({ id: 1 });
  h.flusher.push({ id: 2 });
  h.flusher.push({ id: 3 });
  assert.equal(h.calls.length, 0); // 防抖窗口内不 call
  assert.equal(h.clock.pending(), 1); // 每次 push 重置计时，仍只有一个在飞计时器
  assert.equal(h.clock.lastMs(), 5000); // 防抖默认 5000ms
  h.clock.advance(); // 推进到防抖到期
  await tick();
  assert.equal(h.calls.length, 1); // 3 次 push 合并为一次 flush
  assert.equal(h.calls[0].endpoint, 'dshEditor/appendLogs');
  assert.deepEqual(h.calls[0].args, { entries: [{ id: 1 }, { id: 2 }, { id: 3 }] }); // entries 按 push 顺序
});

test('flushes immediately at batchSize', async () => {
  const h = makeHarness({ batchSize: 3 });
  h.flusher.push({ id: 1 });
  h.flusher.push({ id: 2 });
  assert.equal(h.calls.length, 0); // 未满批不 call
  h.flusher.push({ id: 3 }); // 第 3 条达到 batchSize
  assert.equal(h.calls.length, 1); // 不等防抖立即 call
  assert.deepEqual(h.calls[0].args.entries, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  await tick(); // 等这轮 flush 收尾
  assert.equal(h.buffer.size(), 0);
});

test('serializes flushes preserving order', async () => {
  const h = makeHarness();
  const gate = deferred();
  h.setBehavior(() => gate.promise); // 第一次 call 挂起，模拟 in-flight
  h.flusher.push('a');
  h.flusher.push('b');
  h.clock.advance(); // 触发 flush → call 1 in flight
  assert.equal(h.calls.length, 1);
  h.flusher.push('c'); // in-flight 期间新 push 只入缓冲排队
  await tick();
  assert.equal(h.calls.length, 1); // 单飞行：settle 前不得有第二次 call
  gate.resolve({ ok: true }); // 第一次 call 成功
  await tick(); // 等 settle 后的自动续排
  assert.equal(h.calls.length, 2); // 续排恰好一次
  assert.deepEqual(h.calls[1].args.entries, ['c']); // 顺序不乱：后进的后发
});

test('requeues entries on transport failure in order', async () => {
  const h = makeHarness();
  h.setBehavior(async () => {
    throw new Error('transport down'); // call 直接 reject
  });
  h.flusher.push('x');
  h.flusher.push('y');
  h.clock.advance();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.buffer.size(), 2); // 失败条目重推回缓冲
  await h.flusher.flush(); // flush 不因失败 reject（铁律）；下一次 flush 重试
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].args.entries, ['x', 'y']); // 下次 flush 内容与顺序不变
});

test('drops batch on logs/invalid', async () => {
  const h = makeHarness();
  h.setBehavior(async () => ({ ok: false, error: { code: 'logs/invalid' } }));
  h.flusher.push('bad1');
  h.flusher.push('bad2');
  h.clock.advance();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.buffer.size(), 0); // 无效载荷不重推：整批丢弃
  assert.equal(h.warns.length, 1); // onWarn 恰一次
  await h.flusher.flush(); // 丢弃后不再重试
  assert.equal(h.calls.length, 1); // 缓冲已空，无新 call
});

test('throttles warn on consecutive failures', async () => {
  const h = makeHarness();
  h.setBehavior(async () => {
    throw new Error('down');
  });
  for (let i = 0; i < 101; i++) {
    h.flusher.push(`e${i}`);
    await h.flusher.flush(); // 每轮一次失败（重推条目下一轮随新 push 一并发出）
  }
  assert.equal(h.calls.length, 101); // 每轮恰好一次 call
  assert.equal(h.warns.length, 3); // 第 1、50、100 次各 warn 一次
  h.setBehavior(async () => ({ ok: true }));
  h.flusher.push('ok');
  await h.flusher.flush(); // 成功：连续失败计数清零
  assert.equal(h.warns.length, 3);
  h.setBehavior(async () => {
    throw new Error('down');
  });
  h.flusher.push('again');
  await h.flusher.flush(); // 归零后重新从第 1 次起算 → 再 warn
  assert.equal(h.warns.length, 4);
});

test('dispose cancels pending timer', async () => {
  const h = makeHarness();
  h.flusher.push('a');
  assert.equal(h.clock.pending(), 1);
  h.flusher.dispose();
  assert.equal(h.clock.pending(), 0); // 计时器已取消
  h.clock.advance(); // 到期时刻到来
  await tick();
  assert.equal(h.calls.length, 0); // 不再触发 flush
});

test('treats malformed envelopes as transport failure', async () => {
  const h = makeHarness();
  h.setBehavior(async () => undefined); // call 返回非信封值（畸形信封）
  h.flusher.push('a');
  h.clock.advance();
  await tick();
  assert.equal(h.buffer.size(), 1); // 按普通失败重推回缓冲
  assert.equal(h.warns.length, 1); // 计入失败节流（第 1 次即 warn）
  await h.flusher.flush(); // 且 flush 不 reject（铁律）
});
