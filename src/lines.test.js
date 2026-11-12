import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOfOffset, offsetOfLine, lineRangeOfOffsets, deleteLines } from './lines.js';

test('lineOfOffset counts newlines before offset', () => {
  assert.equal(lineOfOffset('a\nb\nc', 0), 1);
  assert.equal(lineOfOffset('a\nb\nc', 2), 2);
  assert.equal(lineOfOffset('a\nb\nc', 5), 3);
});
test('offsetOfLine returns start offset of 1-based line', () => {
  assert.equal(offsetOfLine('a\nb\nc', 1), 0);
  assert.equal(offsetOfLine('a\nb\nc', 2), 2);
  assert.equal(offsetOfLine('a\nb\nc', 9), 5); // 超出 → text.length
});
test('lineRangeOfOffsets maps offsets to inclusive lines', () => {
  assert.deepEqual(lineRangeOfOffsets('a\nbb\ncc', 0, 1), { lineStart: 1, lineEnd: 1 });
  assert.deepEqual(lineRangeOfOffsets('a\nbb\ncc', 2, 6), { lineStart: 2, lineEnd: 3 });
});
test('deleteLines removes caret line without selection', () => {
  assert.deepEqual(deleteLines('a\nbb\ncc', 2, 2), { text: 'a\ncc', caretLine: 2 });
});
test('deleteLines removes all touched lines with selection', () => {
  assert.deepEqual(deleteLines('a\nbb\ncc', 2, 6), { text: 'a', caretLine: 2 }); // 原起始行越界 → 末行
});
