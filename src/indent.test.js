import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIndentUnit, resolveIndentUnit, indentOp, outdentOp, outdentSplice } from './indent.js';

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
test('outdentSplice: end inside the last touched line removed run → null (unsafe splice)', () => {
	assert.equal(outdentSplice('    x', 2, 2, '    '), null); // 折叠在 4 空格删除窗内 → 拼接会少替换
	assert.equal(outdentSplice('    x', 0, 0, '    '), null); // 行首折叠：end 亦落在删除窗内
	assert.equal(outdentSplice('    x', 1, 3, '    '), null);
	assert.equal(outdentSplice('abc\n    xyz', 0, 6, '    '), null); // 块形状：to 落在末触及行空格窗内
});
test('outdentSplice: safe shapes return the exact splice plan', () => {
	assert.deepEqual(outdentSplice('\ta\n\tb', 0, 5, '\t'), { segStart: 0, segEnd: 3, segText: 'a\nb' });
	assert.deepEqual(outdentSplice('\tab', 1, 1, '\t'), { segStart: 0, segEnd: 0, segText: '' });
	assert.deepEqual(outdentSplice('  ab', 2, 2, '    '), { segStart: 0, segEnd: 0, segText: '' }); // 删光整段 → 安全
});
test('outdentSplice: op null passes through as null', () => {
	assert.equal(outdentSplice('ab', 1, 1, '\t'), null);
});
test('outdentSplice: splice identity — replacing old[segStart, to) with segText yields op.text', () => {
	const src = '\ta\n\tb';
	const sp = outdentSplice(src, 0, 5, '\t');
	const op = outdentOp(src, 0, 5, '\t');
	assert.equal(src.slice(0, sp.segStart) + sp.segText + src.slice(5), op.text);
});
test('outdentOp: collapsed caret at column 0 of a non-first line outdents its own line', () => {
	assert.deepEqual(outdentOp('x\n\tab', 2, 2, '\t'), { text: 'x\nab', start: 2, end: 2 }); // 曾为 null：col-0 折叠丢失自己的行
});
test('outdentOp: bounds inside a removal window shift by the strictly-before portion', () => {
	assert.deepEqual(outdentOp('a\n    x', 3, 3, '    '), { text: 'a\nx', start: 2, end: 2 }); // 曾为 {start:0,end:0}：光标瞬移
	assert.deepEqual(outdentOp('a\n    x', 3, 5, '    '), { text: 'a\nx', start: 2, end: 2 }); // 曾为 {start:0,end:1}
});
test('indentOp: collapsed insert on a non-first line is unaffected (regression pin)', () => {
	assert.deepEqual(indentOp('x\n\tab', 2, 2, '\t'), { text: 'x\n\t\tab', start: 3, end: 3 });
});
test('outdentSplice: col-0 caret inside its own line removal window is unsafe → null (fallback)', () => {
	assert.equal(outdentSplice('x\n\tab', 2, 2, '\t'), null);
});
