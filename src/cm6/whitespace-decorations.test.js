import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whitespaceDecorationDescriptors } from './whitespace-decorations.js';

// The glyph characters are pinned literally (not through WHITESPACE_GLYPHS):
// the shape table's contract is the character itself, and a wrong constant
// lookup inside the core must fail here.
const SPACE = '\u00B7';
const TAB = '\u2192';
const NEWLINE = '\u21B5';
const CARRIAGE = '\u240D';

const ALL_OFF = { spaces: false, tabs: false, newlines: false };
const ALL_ON = { spaces: true, tabs: true, newlines: true };

/* ------------------------------------------------ 三开关独立 -- */

test('whitespaceDecorationDescriptors: 三开关全关 → 空数组', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a b\tc\n', show: ALL_OFF }), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: '', show: ALL_OFF }), []);
});

test('whitespaceDecorationDescriptors: 三开关各自独立产生/不产生对应描述符', () => {
	// 同一行里三种可显示字符都在：逐开关打开只出现该族的描述符。
	const text = ' \t\n';
	assert.deepEqual(whitespaceDecorationDescriptors({ text, show: { spaces: true } }), [
		{ from: 0, to: 0, glyph: SPACE },
	]);
	assert.deepEqual(whitespaceDecorationDescriptors({ text, show: { tabs: true } }), [
		{ from: 1, to: 2, glyph: TAB, widthCols: 3 },
	]);
	assert.deepEqual(whitespaceDecorationDescriptors({ text, show: { newlines: true } }), [
		{ from: 2, to: 2, glyph: NEWLINE },
	]);
	// 全开 = 三族按文档偏移升序出现（空格 · → 制表 → 行断 ↵）。
	assert.deepEqual(whitespaceDecorationDescriptors({ text, show: ALL_ON }), [
		{ from: 0, to: 0, glyph: SPACE },
		{ from: 1, to: 2, glyph: TAB, widthCols: 3 },
		{ from: 2, to: 2, glyph: NEWLINE },
	]);
});

test('whitespaceDecorationDescriptors: 空格是点描述符（from === to）', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a  b', show: { spaces: true } }), [
		{ from: 1, to: 1, glyph: SPACE },
		{ from: 2, to: 2, glyph: SPACE },
	]);
});

/* ---------------------------------------------- 制表 widthCols -- */
// 列基准镜像 buildWhitespaceRow 的计数：行内从 0 起，空格/普通字符按
// codePointColumns（宽字符 2 列，代理对整体一码点），制表按 tabAdvance。

test('whitespaceDecorationDescriptors: widthCols = tabAdvance(列, 4)——第 0 列 → 4，第 2 列 → 2', () => {
	// 行首制表：列 0 → 下一停靠点 4 → 宽 4。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: '\tabc', show: { tabs: true } }), [
		{ from: 0, to: 1, glyph: TAB, widthCols: 4 },
	]);
	// 两个 ASCII 字符后：列 2 → 停靠点 4 → 宽 2。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'ab\tc', show: { tabs: true } }), [
		{ from: 2, to: 3, glyph: TAB, widthCols: 2 },
	]);
	// 恰好落在停靠点前一列：列 3 → 宽 1（对应 buildWhitespaceRow 的 pad-0 契约）。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'abc\t', show: { tabs: true } }), [
		{ from: 3, to: 4, glyph: TAB, widthCols: 1 },
	]);
});

test('whitespaceDecorationDescriptors: 宽字符按 2 列计列（镜像 buildWhitespaceRow 的 汉\\t 用例）', () => {
	// 汉 = 2 列 → 制表从列 2 起，宽 2（而按字符个数会是 3）。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: '\u6C49\t', show: { tabs: true } }), [
		{ from: 1, to: 2, glyph: TAB, widthCols: 2 },
	]);
});

test('whitespaceDecorationDescriptors: 代理对整体一个码点，偏移与列计数都不劈开', () => {
	// 😀 占 2 个 UTF-16 单元但只有 1 码点；空格在偏移 2，制表列 2 → 宽 2。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: '\u{1F600} \t', show: ALL_ON }), [
		{ from: 2, to: 2, glyph: SPACE },
		{ from: 3, to: 4, glyph: TAB, widthCols: 2 },
	]);
});

test('whitespaceDecorationDescriptors: 一行多个制表按累计列数递进', () => {
	// a(1) → 制表列 1 宽 3（到 4）；b → 列 5；制表列 5 宽 3（到 8）；c。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\tb\tc', show: { tabs: true } }), [
		{ from: 1, to: 2, glyph: TAB, widthCols: 3 },
		{ from: 3, to: 4, glyph: TAB, widthCols: 3 },
	]);
});

test('whitespaceDecorationDescriptors: widthCols 只出现在制表描述符上', () => {
	const descriptors = whitespaceDecorationDescriptors({ text: 'a b\t\n', show: ALL_ON });
	for (const descriptor of descriptors) {
		if (descriptor.glyph === TAB) continue;
		assert.equal(Object.hasOwn(descriptor, 'widthCols'), false, `${descriptor.glyph} 不得带 widthCols`);
	}
});

/* ----------------------------------------------- 行断 ↵ -- */
// showsNewlineGlyph 语义原样保留：每个真实断行都画，含 EOF 尾随换行
// （0.13.0）；没有尾随换行的文件最后一行不画。

test('whitespaceDecorationDescriptors: 每个逻辑行行尾画 ↵', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\nb', show: { newlines: true } }), [
		{ from: 1, to: 1, glyph: NEWLINE },
	]);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\nb\nc', show: { newlines: true } }), [
		{ from: 1, to: 1, glyph: NEWLINE },
		{ from: 3, to: 3, glyph: NEWLINE },
	]);
});

test('whitespaceDecorationDescriptors: EOF 尾随换行画 ↵（0.13.0 语义）', () => {
	// 'a\n'：唯一的断行就是尾随换行，照样画在偏移 1。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\n', show: { newlines: true } }), [
		{ from: 1, to: 1, glyph: NEWLINE },
	]);
	// '\n'：空行 + 尾随换行 → 偏移 0 一个 ↵。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: '\n', show: { newlines: true } }), [
		{ from: 0, to: 0, glyph: NEWLINE },
	]);
	// '\n\n' → 偏移 0 与 1 各一个 ↵。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: '\n\n', show: { newlines: true } }), [
		{ from: 0, to: 0, glyph: NEWLINE },
		{ from: 1, to: 1, glyph: NEWLINE },
	]);
});

test('whitespaceDecorationDescriptors: 内部空行的断行画在它的行首', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\n\nb', show: { newlines: true } }), [
		{ from: 1, to: 1, glyph: NEWLINE },
		{ from: 2, to: 2, glyph: NEWLINE },
	]);
});

test('whitespaceDecorationDescriptors: 没有尾随换行的文件末行不画 ↵', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a', show: { newlines: true } }), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: '', show: { newlines: true } }), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\nb', show: { newlines: true } }), [
		{ from: 1, to: 1, glyph: NEWLINE },
	]);
});

test('whitespaceDecorationDescriptors: newlines=false → 完全没有行断描述符', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\nb\n', show: { spaces: true, tabs: true } }), []);
});

/* ------------------------------------- CRLF 的 ␍+↵（镜像 eol 分支） -- */
// buildWhitespaceRow 的 eol='crlf' 分支画 ␍+↵ 一对（与文件字节一对一）；
// 原始 CRLF 文本里 \r 是行内容最后一个真实字符，因此用 replace 描述符
// 覆盖它，↵ 点描述符仍落在行内容之后（\n 之前）。

test('whitespaceDecorationDescriptors: CRLF 行尾画 ␍+↵ 一对', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\r\nb', show: { newlines: true } }), [
		{ from: 1, to: 2, glyph: CARRIAGE },
		{ from: 2, to: 2, glyph: NEWLINE },
	]);
	// EOF 尾随 CRLF 同样画一对（0.13.0：尾随断行照画）。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\r\n', show: { newlines: true } }), [
		{ from: 1, to: 2, glyph: CARRIAGE },
		{ from: 2, to: 2, glyph: NEWLINE },
	]);
	// 多行 CRLF：每个断行一对。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a\r\nb\r\n', show: { newlines: true } }), [
		{ from: 1, to: 2, glyph: CARRIAGE },
		{ from: 2, to: 2, glyph: NEWLINE },
		{ from: 4, to: 5, glyph: CARRIAGE },
		{ from: 5, to: 5, glyph: NEWLINE },
	]);
});

test('whitespaceDecorationDescriptors: ␍ 挂在 newlines 开关下（同 buildWhitespaceRow 的 eol 分支）', () => {
	// newlines=false 时 CR 不产生任何描述符，空格照常。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a \r\n', show: { spaces: true } }), [
		{ from: 1, to: 1, glyph: SPACE },
	]);
	// 全开时顺序与 DOM 层一致：空格 · → ␍ → ↵。
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a \r\n', show: ALL_ON }), [
		{ from: 1, to: 1, glyph: SPACE },
		{ from: 2, to: 3, glyph: CARRIAGE },
		{ from: 3, to: 3, glyph: NEWLINE },
	]);
});

/* ------------------------------------------------ 防御归一 -- */

test('whitespaceDecorationDescriptors: 不可用输入退化为空数组，绝不抛错', () => {
	assert.deepEqual(whitespaceDecorationDescriptors(), []);
	assert.deepEqual(whitespaceDecorationDescriptors(null), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: null, show: ALL_ON }), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 42, show: ALL_ON }), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a b', show: null }), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a b' }), []);
});

test('whitespaceDecorationDescriptors: 开关只认字面 true（与 DOM 层同宽）', () => {
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a b\t\n', show: { spaces: 1, tabs: 'yes', newlines: {} } }), []);
	assert.deepEqual(whitespaceDecorationDescriptors({ text: 'a b\t\n', show: undefined }), []);
});
