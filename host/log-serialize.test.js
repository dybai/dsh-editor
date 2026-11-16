import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogArgs } from './log-serialize.js';

test('joins args with single spaces', () => {
  assert.equal(formatLogArgs(['a', 1, { x: 2 }]), 'a 1 {"x":2}');
});
test('stringifies objects and escapes line breaks', () => {
  // 字符串参数内的换行替换为字面反斜杠 n，保证输出恒为单行
  assert.equal(formatLogArgs(['line1\nline2']), 'line1\\nline2');
});
test('degrades circular refs to [circular]', () => {
  const obj = {};
  obj.self = obj;
  const out = formatLogArgs([obj]); // 返回即未抛出
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('[circular]'));
});
test('degrades throwing getters to [unserializable]', () => {
  const out = formatLogArgs([{ get x() { throw 0; } }]);
  assert.ok(out.includes('[unserializable]'));
});
test('formats bigint, function, symbol placeholders', () => {
  assert.equal(formatLogArgs([1n]), '1n');
  assert.equal(formatLogArgs([() => {}]), '[function]');
  assert.equal(formatLogArgs([Symbol('s')]), '[symbol]');
});
test('truncates to maxChars with marker', () => {
  const out = formatLogArgs(['x'.repeat(3000)], { maxChars: 100 });
  assert.ok(out.length <= 100); // 含 marker 在内不超过 maxChars
  assert.ok(out.endsWith('…(truncated)'));
});
test('never throws on any input', () => {
  const circular = {};
  circular.self = circular;
  const cases = [
    undefined,
    null,
    true,
    0,
    -0,
    NaN,
    Infinity,
    1n,
    Symbol(),
    () => {},
    class Foo {},
    Object.create(null),
    new Date('invalid'),
    new Date(),
    new Map([[1, 2]]),
    new Set([1]),
    new WeakMap(),
    Promise.resolve(1),
    circular,
    { deep: { deeper: { deepest: [circular] } } },
    { get x() { throw 0; } },
    new Proxy({}, { get() { throw 0; } }), // get 陷阱抛错的 Proxy
    new Proxy({}, { ownKeys() { throw 0; } }), // ownKeys 陷阱抛错的 Proxy
  ];
  cases.forEach((value, i) => {
    let out;
    assert.doesNotThrow(() => { out = formatLogArgs([value]); }, `case #${i}`);
    assert.equal(typeof out, 'string', `case #${i}`);
  });
});

// 一致性哨兵：期望输出逐字取自 Task 1 的 src/serialize-log.test.js（客户端钉住的
// 同一用例矩阵）。宿主与客户端是两份独立实现、共享语义不共享代码，此用例钉死
// “同输入同输出”：任何一侧语义漂移都会在这里爆掉。
test('matches the pinned client matrix outputs', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(formatLogArgs(['a', 1, { x: 2 }]), 'a 1 {"x":2}');
  assert.equal(formatLogArgs(['line1\nline2']), 'line1\\nline2');
  assert.equal(formatLogArgs([circular]), '{"self":[circular]}');
  assert.equal(formatLogArgs([{ get x() { throw 0; } }]), '{"x":[unserializable]}');
  assert.equal(formatLogArgs([1n]), '1n');
  assert.equal(formatLogArgs([() => {}]), '[function]');
  assert.equal(formatLogArgs([Symbol('s')]), '[symbol]');
  // 88 个 'x' + 12 字符 marker = 恰好 100 字符（与客户端输出逐字一致）
  assert.equal(formatLogArgs(['x'.repeat(3000)], { maxChars: 100 }), `${'x'.repeat(88)}…(truncated)`);
});
