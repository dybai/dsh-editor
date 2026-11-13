import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineNumbersText, lineNumberDigits, gutterWidthCh } from './line-numbers.js';

test('lineNumbersText builds one number per line from 1 through N', () => {
  assert.equal(lineNumbersText(1), '1');
  assert.equal(lineNumbersText(3), '1\n2\n3');
  assert.equal(lineNumbersText(12), '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12');
});

test('lineNumbersText degrades an invalid count to a single "1"', () => {
  // 同 active-line 的防御哲学：非法输入绝不崩，退化为第 1 行。
  for (const count of [undefined, null, NaN, 0, -5, 'x']) {
    assert.equal(lineNumbersText(count), '1');
  }
});

test('lineNumbersText floors a fractional count', () => {
  // 小数行数不在契约内，但取整是更有用的归一（与 active-line 的 Math.floor 一致）。
  assert.equal(lineNumbersText(2.9), '1\n2');
  assert.equal(lineNumbersText(3.5), '1\n2\n3');
});

test('lineNumberDigits floors the count and clamps to at least 2 columns', () => {
  assert.equal(lineNumberDigits(1), 2);
  assert.equal(lineNumberDigits(9), 2);
  assert.equal(lineNumberDigits(99), 2);
  assert.equal(lineNumberDigits(100), 3);
  assert.equal(lineNumberDigits(99999), 5);
  assert.equal(lineNumberDigits(100000), 6);
});

test('lineNumberDigits degrades an invalid count to 2', () => {
  for (const count of [undefined, null, NaN, 0, -5, 'x']) {
    assert.equal(lineNumberDigits(count), 2);
  }
});

test('gutterWidthCh adds the inter-column gap to the digit count', () => {
  // 2 位（最小）+ 1.5ch 间隙；进位后随位数加宽。
  assert.equal(gutterWidthCh(99), 3.5);
  assert.equal(gutterWidthCh(100), 4.5);
  assert.equal(gutterWidthCh(1), 3.5);
});

test('gutterWidthCh degrades an invalid count to the minimum width', () => {
  for (const count of [undefined, null, NaN, 0, -5, 'x']) {
    assert.equal(gutterWidthCh(count), 3.5);
  }
});
