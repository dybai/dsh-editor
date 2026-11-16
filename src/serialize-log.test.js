import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeLogArgs } from './serialize-log.js';

test('joins args with single spaces', () => {
  assert.equal(serializeLogArgs(['a', 1, { x: 2 }]), 'a 1 {"x":2}');
});
test('stringifies objects and escapes line breaks', () => {
  // 字符串参数内的换行替换为字面反斜杠 n，保证输出恒为单行
  assert.equal(serializeLogArgs(['line1\nline2']), 'line1\\nline2');
});
test('degrades circular refs to [circular]', () => {
  const obj = {};
  obj.self = obj;
  const out = serializeLogArgs([obj]); // 返回即未抛出
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('[circular]'));
});
test('degrades throwing getters to [unserializable]', () => {
  const out = serializeLogArgs([{ get x() { throw 0; } }]);
  assert.ok(out.includes('[unserializable]'));
});
test('formats bigint, function, symbol placeholders', () => {
  assert.equal(serializeLogArgs([1n]), '1n');
  assert.equal(serializeLogArgs([() => {}]), '[function]');
  assert.equal(serializeLogArgs([Symbol('s')]), '[symbol]');
});
test('truncates to maxChars with marker', () => {
  const out = serializeLogArgs(['x'.repeat(3000)], { maxChars: 100 });
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
    assert.doesNotThrow(() => { out = serializeLogArgs([value]); }, `case #${i}`);
    assert.equal(typeof out, 'string', `case #${i}`);
  });
});
