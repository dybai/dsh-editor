import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogBuffer } from './log-buffer.js';

test('drains FIFO and empties', () => {
  const buf = createLogBuffer();
  buf.push({ id: 1 });
  buf.push({ id: 2 });
  buf.push({ id: 3 });
  assert.equal(buf.size(), 3);
  assert.deepEqual(buf.drain(), [{ id: 1 }, { id: 2 }, { id: 3 }]); // drain 顺序等于 push 顺序
  assert.equal(buf.size(), 0); // drain 后 size 归 0
  assert.deepEqual(buf.drain(), []); // 二次 drain 为空
});
test('drops oldest beyond cap', () => {
  const buf = createLogBuffer({ cap: 2 });
  buf.push(1);
  buf.push(2);
  buf.push(3);
  assert.deepEqual(buf.drain(), [2, 3]); // 超限丢最老，只剩后 2 条
});
test('requeue prepends in order under cap', () => {
  const buf = createLogBuffer({ cap: 4 });
  buf.push('a');
  buf.push('b');
  buf.requeue(['x', 'y']);
  assert.deepEqual(buf.drain(), ['x', 'y', 'a', 'b']); // requeue 按原序前插到头部
  const over = createLogBuffer({ cap: 3 }); // requeue 超量同样从最老端丢弃
  over.push('a');
  over.push('b');
  over.requeue(['x', 'y', 'z']); // 前插后 [x,y,z,a,b] 超限 → 丢最老的 x、y
  assert.deepEqual(over.drain(), ['z', 'a', 'b']);
});
test('cap 1 keeps only latest', () => {
  const buf = createLogBuffer({ cap: 1 });
  buf.push(1);
  buf.push(2);
  buf.push(3);
  assert.deepEqual(buf.drain(), [3]); // 只保留最新一条
});
test('default cap is 500', () => {
  const buf = createLogBuffer();
  for (let i = 1; i <= 501; i++) buf.push(i);
  const drained = buf.drain();
  assert.equal(drained.length, 500); // 长度 500
  assert.equal(drained[0], 2); // 首条是第 2 条
});
