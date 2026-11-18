import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIndentUnit, resolveIndentUnit, indentOp, outdentOp } from './indent.js';

test('detectIndentUnit: a single leading tab decides tabs', () => {
	assert.deepEqual(detectIndentUnit('a\n\tb\n      c'), { mode: 'tabs' });
});
test('detectIndentUnit: most frequent leading-space count wins; ties pick the smaller', () => {
	assert.deepEqual(detectIndentUnit('a\n  b\n  c\n    d'), { mode: 'spaces', width: 2 });
	assert.deepEqual(detectIndentUnit('a\n  b\n    c'), { mode: 'spaces', width: 2 });
});
test('detectIndentUnit: >16 leading spaces are alignment noise', () => {
	assert.deepEqual(detectIndentUnit('                    a\n    b'), { mode: 'spaces', width: 4 });
});
test('detectIndentUnit: only the first 200 non-empty lines are samples', () => {
	const head = Array.from({ length: 200 }, () => '  x').join('\n');
	assert.deepEqual(detectIndentUnit(`${head}\n    late`), { mode: 'spaces', width: 2 });
});
test('detectIndentUnit: blank and whitespace-only lines are not samples; no signal → null', () => {
	assert.equal(detectIndentUnit(''), null);
	assert.equal(detectIndentUnit('abc\ndef'), null);
	assert.deepEqual(detectIndentUnit('\n   \n\tab'), { mode: 'tabs' }); // '   ' trim 后为空，不占样本
});
test('detectIndentUnit: CRLF-safe', () => {
	assert.deepEqual(detectIndentUnit('a\r\n\tb'), { mode: 'tabs' });
});
test('resolveIndentUnit: explicit modes win, auto detects, fallback width', () => {
	assert.equal(resolveIndentUnit({ indentMode: 'tabs', indentWidth: 2 }, ''), '\t');
	assert.equal(resolveIndentUnit({ indentMode: 'spaces', indentWidth: 2 }, ''), '  ');
	assert.equal(resolveIndentUnit({ indentMode: 'spaces', indentWidth: 3 }, ''), '    '); // 非法宽度回 4
	assert.equal(resolveIndentUnit({ indentMode: 'auto', indentWidth: 2 }, 'a\n\tb'), '\t');
	assert.equal(resolveIndentUnit({ indentMode: 'auto', indentWidth: 2 }, 'a\n    b'), '    ');
	assert.equal(resolveIndentUnit({ indentMode: 'auto', indentWidth: 2 }, ''), '  '); // 探测 null → 设置宽度
	assert.equal(resolveIndentUnit(null, ''), '    '); // 防御：非法 settings → 4 空格
	assert.equal(resolveIndentUnit(undefined, undefined), '    ');
});

test('indentOp: collapsed caret inserts after the caret', () => {
	assert.deepEqual(indentOp('ab', 1, 1, '\t'), { text: 'a\tb', start: 2, end: 2 });
	assert.deepEqual(indentOp('ab', 0, 0, '  '), { text: '  ab', start: 2, end: 2 });
});
test('indentOp: single-line selection is replaced by the unit', () => {
	assert.deepEqual(indentOp('abc', 1, 2, '\t'), { text: 'a\tc', start: 2, end: 2 });
});
test('indentOp: newline inside the selection means block indent', () => {
	// 选区含换行但首末同行号（覆盖 'a\n'）→ 块缩进，换行保留
	assert.deepEqual(indentOp('a\nb', 0, 2, '\t'), { text: '\ta\nb', start: 1, end: 3 });
});
test('indentOp: block indent indents every touched line and shifts the selection', () => {
	assert.deepEqual(indentOp('a\nb\nc', 1, 4, '  '), { text: '  a\n  b\nc', start: 2, end: 8 });
	// 末行停在 col 0 不计入（lineOf(end−1) 口径）
	assert.deepEqual(indentOp('a\nb\nc', 0, 2, '\t'), { text: '\ta\nb\nc', start: 1, end: 3 });
});
test('indentOp: clamps and swaps out-of-range offsets', () => {
	assert.deepEqual(indentOp('ab', 5, 9, '\t'), { text: 'ab\t', start: 3, end: 3 });
	assert.deepEqual(indentOp('ab', 2, 0, '\t'), { text: '\t', start: 1, end: 1 });
	assert.deepEqual(indentOp('', 0, 0, '\t'), { text: '\t', start: 1, end: 1 });
});
test('outdentOp: removes one leading tab or up to unit-width leading spaces', () => {
	assert.deepEqual(outdentOp('\tab', 1, 1, '\t'), { text: 'ab', start: 0, end: 0 });
	assert.deepEqual(outdentOp('    ab', 4, 4, '    '), { text: 'ab', start: 0, end: 0 });
	assert.deepEqual(outdentOp('  ab', 2, 2, '    '), { text: 'ab', start: 0, end: 0 }); // 不足则删光
});
test('outdentOp: mixed block removes per line and shrinks the selection', () => {
	assert.deepEqual(outdentOp('\ta\n  b', 0, 5, '\t'), { text: 'a\n  b', start: 0, end: 4 });
	assert.deepEqual(outdentOp('\ta\nb', 0, 1, '\t'), { text: 'a\nb', start: 0, end: 0 }); // start 在行首 → clamp
});
test('outdentOp: nothing to remove returns null', () => {
	assert.equal(outdentOp('ab', 0, 0, '\t'), null);
	assert.equal(outdentOp('\tab', 1, 1, '    '), null);
	assert.equal(outdentOp('', 0, 0, '  '), null);
});
