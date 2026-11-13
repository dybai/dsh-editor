import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOfOffset, offsetOfLine, lineRangeOfOffsets, deleteLines, lineOfOffsetFast, caretOffsetOfSelection } from './lines.js';

test('lineOfOffset counts newlines before offset', () => {
  assert.equal(lineOfOffset('a\nb\nc', 0), 1);
  assert.equal(lineOfOffset('a\nb\nc', 2), 2);
  assert.equal(lineOfOffset('a\nb\nc', 5), 3);
});
test('lineOfOffsetFast matches lineOfOffset without allocating a split', () => {
  const text = 'a\nbb\nccc';
  for (const offset of [0, 1, 2, 4, 5, 8, 9, 100]) {
    assert.equal(lineOfOffsetFast(text, offset), lineOfOffset(text, offset), `offset ${offset}`);
  }
  assert.equal(lineOfOffsetFast('', 0), 1);
});
test('lineOfOffsetFast clamps out-of-range offsets (selectionStart never is, but callers stay total)', () => {
  assert.equal(lineOfOffsetFast('a\nb', -5), 1);
  assert.equal(lineOfOffsetFast('a\nb', 99), 2);
});
test('caretOffsetOfSelection tracks the moving edge (no previous knowledge → tail)', () => {
  assert.equal(caretOffsetOfSelection(null, 10, 20), 20);
});
test('caretOffsetOfSelection: a kept end boundary means the head edge moved (dragging up)', () => {
  assert.equal(caretOffsetOfSelection({ start: 10, end: 20 }, 5, 20), 5);
  assert.equal(caretOffsetOfSelection({ start: 10, end: 20 }, 0, 20), 0);
});
test('caretOffsetOfSelection: a kept start boundary means the tail edge moved (dragging down)', () => {
  assert.equal(caretOffsetOfSelection({ start: 10, end: 20 }, 10, 35), 35);
});
test('caretOffsetOfSelection: both edges moved or collapsed selection → tail (Ctrl+A, plain caret)', () => {
  assert.equal(caretOffsetOfSelection({ start: 10, end: 20 }, 0, 99), 99);
  assert.equal(caretOffsetOfSelection({ start: 5, end: 5 }, 5, 5), 5);
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
