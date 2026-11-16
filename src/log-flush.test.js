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

test('splits oversized flushes into <=200-entry rpc calls', async () => {
  const h = makeHarness({ batchSize: 500 }); // batchSize 调大：单纯考察 >200 的拆分
  const gate = deferred();
  h.setBehavior((i) => (i === 1 ? gate.promise : { ok: true })); // 块 1 挂起，其余成功
  for (let i = 0; i < 450; i++) h.flusher.push(i);
  h.clock.advance(); // 触发 flush：drain 450 → 拆 200/200/50
  await tick();
  assert.equal(h.calls.length, 1); // 序列进行中：只有块 1 在飞
  h.flusher.push('late'); // 序列中途新 push：只能排队
  await tick();
  assert.equal(h.calls.length, 1); // 单飞行覆盖整个序列：中途不得插入新 call
  gate.resolve({ ok: true }); // 块 1 成功
  await tick(); // 块 2、块 3 顺序发出，随后续排 'late'
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.calls.map((c) => c.args.entries.length), [200, 200, 50, 1]); // 每块 ≤200
  assert.deepEqual(h.calls[0].args.entries, Array.from({ length: 200 }, (_, i) => i)); // 跨块原序
  assert.deepEqual(h.calls[1].args.entries, Array.from({ length: 200 }, (_, i) => i + 200));
  assert.deepEqual(h.calls[2].args.entries, Array.from({ length: 50 }, (_, i) => i + 400));
  assert.deepEqual(h.calls[3].args.entries, ['late']); // 中途 push 等序列结束后才续排
  assert.equal(h.buffer.size(), 0);
});

test('transport failure mid-split requeues unsent remainder in order', async () => {
  const h = makeHarness({ batchSize: 500 });
  h.setBehavior((i) => (i === 2 ? Promise.reject(new Error('down')) : { ok: true })); // 块 2 传输失败
  for (let i = 0; i < 450; i++) h.flusher.push(i);
  h.clock.advance();
  await tick();
  assert.equal(h.calls.length, 2); // 块 1 已发出，块 2 失败即终止序列
  assert.equal(h.calls[0].args.entries.length, 200);
  assert.equal(h.calls[1].args.entries.length, 200);
  assert.equal(h.buffer.size(), 250); // 失败块 + 未发送块（250 条）重推回缓冲
  assert.equal(h.warns.length, 1); // 整个 flush 只计一次失败（节流第 1 次）
  h.setBehavior(async () => ({ ok: true })); // 传输恢复
  await h.flusher.flush(); // flush 不因失败 reject（铁律）
  assert.equal(h.calls.length, 4); // 余量 250 再拆 200/50
  assert.deepEqual(h.calls[2].args.entries, Array.from({ length: 200 }, (_, i) => i + 200)); // 原序：块 2 内容重试
  assert.deepEqual(h.calls[3].args.entries, Array.from({ length: 50 }, (_, i) => i + 400)); // 原序：块 3 内容随后
  assert.equal(h.buffer.size(), 0); // 总量对账：块 1 已发出的 200 条不重推
});

test('invalid chunk drops only that chunk and continues', async () => {
  const h = makeHarness({ batchSize: 500 });
  h.setBehavior(async () => {
    throw new Error('down'); // 先制造一次传输失败：连续失败计数 = 1
  });
  for (let i = 0; i < 450; i++) h.flusher.push(i);
  h.clock.advance(); // flush：块 1 即失败 → 450 条整体重推
  await tick();
  assert.equal(h.warns.length, 1); // 失败第 1 次 warn
  h.setBehavior((_i, args) => (args.entries.includes(250) ? { ok: false, error: { code: 'logs/invalid' } } : { ok: true })); // 只有块 2（含 id 250）被拒
  await h.flusher.flush();
  assert.equal(h.calls.length, 4); // 块 1 重试成功 + 块 2 invalid + 块 3 仍发送
  assert.equal(h.calls[3].args.entries.length, 50); // 块 3 不受块 2 影响
  assert.equal(h.buffer.size(), 0); // 只丢块 2：其余全发出、无残留
  assert.equal(h.warns.length, 2); // invalid 恰好一次（按 flush 事件，不按块）
  h.setBehavior(async () => {
    throw new Error('down');
  });
  h.flusher.push('x');
  await h.flusher.flush(); // 计数已在上轮成功序列清零 → 重新按第 1 次计
  assert.equal(h.warns.length, 3); // 再 warn：成功清零路径完好
});
