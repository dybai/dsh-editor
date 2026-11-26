/**
 * Tests for `src/token-rows.js` — the pure fragment builder behind the
 * syntax-highlight token layer (Task 6). The DOM layer paints whatever this
 * module computes, so every offset rule the layer depends on is pinned here:
 * token runs carry their token's color/fontStyle, gaps between tokens are
 * plain inherit runs (`color: undefined`, fontStyle 0), and a token crossing
 * a slice boundary splits EXACTLY at it — the wrap-mode per-visual-row
 * painter concatenates slices back into the line, so an off-by-one here
 * would duplicate or drop a character at every soft wrap (review focus #4).
 *
 * The engine's line contract (Task 4) is the input shape: `TokenLine` rows of
 * `{ start, end, color, fontStyle }` with line-relative offsets, and an
 * over-1000-char line arriving as ONE token with `color: ''` — the builder
 * treats `''` like `undefined` (a plain run), so such a line paints as text,
 * never as an invisible or undefined-colored run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTokenRowFragments, buildTokenRowFragmentsWithTints } from './token-rows.js';

/* The brief's shared fixture: one 12-char line, two tokens with a gap.
 * Indices: `const` = [0..5), ` x` = [5..7), ` = ` = [7..10), `1;` = [10..12). */
const LINE = 'const x = 1;';
const TOKENS = [
	{ start: 0, end: 5, color: 'c1', fontStyle: 1 },
	{ start: 7, end: 10, color: 'c2', fontStyle: 0 },
];

/* ------------------------------------------------------- whole line -- */

test('whole line: token runs carry color/fontStyle, gaps are inherit runs', () => {
	assert.deepEqual(buildTokenRowFragments(LINE, TOKENS, undefined), [
		{ text: 'const', color: 'c1', fontStyle: 1 },
		{ text: ' x', color: undefined, fontStyle: 0 },
		{ text: ' = ', color: 'c2', fontStyle: 0 },
		{ text: '1;', color: undefined, fontStyle: 0 },
	]);
});

test('no tokens: one inherit run covering the line', () => {
	assert.deepEqual(buildTokenRowFragments(LINE, [], undefined), [
		{ text: LINE, color: undefined, fontStyle: 0 },
	]);
});

/* ------------------------------------------------------------ slices -- */

test('slice across the first token boundary splits the token exactly at the slice edges', () => {
	// Slice [4..8) cuts token1's tail off ('t' stays colored), keeps the gap
	// as an inherit run, and cuts token2's head off (only the [7..8) char).
	const fragments = buildTokenRowFragments(LINE, TOKENS, { start: 4, end: 8 });
	assert.deepEqual(fragments, [
		{ text: 't', color: 'c1', fontStyle: 1 },
		{ text: ' x', color: undefined, fontStyle: 0 },
		{ text: ' ', color: 'c2', fontStyle: 0 },
	]);
});

test('slice entirely outside the tokens: single inherit run covering the slice', () => {
	assert.deepEqual(buildTokenRowFragments(LINE, TOKENS, { start: 10, end: 12 }), [
		{ text: '1;', color: undefined, fontStyle: 0 },
	]);
});

/* -------------------------------------------------- plain-line token -- */

test('a token colored with the empty string renders as a plain inherit run', () => {
	// Over-1000-char lines arrive as ONE token with color '' (spec §8): the
	// builder must treat '' like undefined, or such a line would paint with
	// an undefined color instead of inheriting the textarea's.
	assert.deepEqual(buildTokenRowFragments('let a;', [{ start: 0, end: 6, color: '', fontStyle: 0 }], undefined), [
		{ text: 'let a;', color: undefined, fontStyle: 0 },
	]);
});

/* ------------------------------------------------------- degradation -- */

test('unusable input degrades to safe output, never throws', () => {
	// A non-string line has no text to cover.
	assert.deepEqual(buildTokenRowFragments(null, TOKENS, undefined), []);
	// A non-array token list degrades to one plain run over the whole line.
	assert.deepEqual(buildTokenRowFragments(LINE, null, undefined), [
		{ text: LINE, color: undefined, fontStyle: 0 },
	]);
	// A token without usable offsets is skipped; the line still paints plain.
	assert.deepEqual(buildTokenRowFragments(LINE, [{ start: 'a', end: 3, color: 'c', fontStyle: 0 }], undefined), [
		{ text: LINE, color: undefined, fontStyle: 0 },
	]);
	// An inverted slice covers nothing.
	assert.deepEqual(buildTokenRowFragments(LINE, TOKENS, { start: 6, end: 4 }), []);
});

/* --------------------------------------- buildTokenRowFragmentsWithTints -- */

test('tints null/undefined/empty: exactly buildTokenRowFragments plus tint null on every run', () => {
	// 无 tint 时必须与旧路径逐 run 恒等（tint 字段全 null）——这是 plain 回退
	// 路径与 tint 路径不漂移的回归锚点。
	const withTintField = (runs) => runs.map((run) => ({ ...run, tint: null }));
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, null), withTintField(buildTokenRowFragments(LINE, TOKENS, undefined)));
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, { start: 4, end: 8 }, undefined), withTintField(buildTokenRowFragments(LINE, TOKENS, { start: 4, end: 8 })));
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, []), withTintField(buildTokenRowFragments(LINE, TOKENS, undefined)));
});
test('a tint interval splits runs exactly at its boundaries while token colors ride along', () => {
	// tint [4..8) 跨 token1 尾部、间隙、token2 头部：每个 run 在 4/8 处精确
	// 切分，着色段携带标签，未着色段 tint null。
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, [{ start: 4, end: 8, layer: 'word' }]), [
		{ text: 'cons', color: 'c1', fontStyle: 1, tint: null },
		{ text: 't', color: 'c1', fontStyle: 1, tint: 'word' },
		{ text: ' x', color: undefined, fontStyle: 0, tint: 'word' },
		{ text: ' ', color: 'c2', fontStyle: 0, tint: 'word' },
		{ text: '= ', color: 'c2', fontStyle: 0, tint: null }, // [8..10) = 下标 8,9 = '= '，tint 止于 8
		{ text: '1;', color: undefined, fontStyle: 0, tint: null },
	]);
});
test('tint and token boundaries combine into one split lattice, both seams exact', () => {
	// tint [5..9)：token2 [7..10) 在 9 处被切开——同 token 色、不同 tint 也要
	// 拆成两个 run（DOM 层按 run 决定背景类，不能合并）。
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, [{ start: 5, end: 9, layer: 'both' }]), [
		{ text: 'const', color: 'c1', fontStyle: 1, tint: null },
		{ text: ' x', color: undefined, fontStyle: 0, tint: 'both' },
		{ text: ' =', color: 'c2', fontStyle: 0, tint: 'both' },
		{ text: ' ', color: 'c2', fontStyle: 0, tint: null },
		{ text: '1;', color: undefined, fontStyle: 0, tint: null },
	]);
});
test('a tint exactly covering a token stays one run: token ink and tint label share the span', () => {
	// 本修订的核心断言：token 墨色与 tint 标签同 span 共存——正是消除 styled
	// token 步进错位的前提（同一 span 携带色/样式/背景）。
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, [{ start: 7, end: 10, layer: 'both' }]), [
		{ text: 'const', color: 'c1', fontStyle: 1, tint: null },
		{ text: ' x', color: undefined, fontStyle: 0, tint: null },
		{ text: ' = ', color: 'c2', fontStyle: 0, tint: 'both' },
		{ text: '1;', color: undefined, fontStyle: 0, tint: null },
	]);
});
test('slices with tints concatenate back into the line: the tinted span splits exactly at the seam', () => {
	const front = buildTokenRowFragmentsWithTints(LINE, TOKENS, { start: 0, end: 4 }, [{ start: 3, end: 7, layer: 'selection' }]);
	const back = buildTokenRowFragmentsWithTints(LINE, TOKENS, { start: 4, end: 12 }, [{ start: 3, end: 7, layer: 'selection' }]);
	// tint [3..7)='st x' 跨切片边界 4：前片着色 's'、后片着色 't x'，无缝性质
	// 保持——两片 runs 拼接回原行，不重不漏，且 tint 边界处精确切分。
	assert.deepEqual(front, [
		{ text: 'con', color: 'c1', fontStyle: 1, tint: null },
		{ text: 's', color: 'c1', fontStyle: 1, tint: 'selection' },
	]); // tint 自下标 3 起：前片 'con' 未着色 + 's'（下标 3）着色
	assert.deepEqual(back, [
		{ text: 't', color: 'c1', fontStyle: 1, tint: 'selection' },
		{ text: ' x', color: undefined, fontStyle: 0, tint: 'selection' },
		{ text: ' = ', color: 'c2', fontStyle: 0, tint: null },
		{ text: '1;', color: undefined, fontStyle: 0, tint: null },
	]); // tint [3..7) 止于 token2 起点（半开区间）：' = ' 整段未着色，无需切分
	assert.equal([...front, ...back].map((run) => run.text).join(''), LINE);
	assert.equal(front.map((run) => run.text).join(''), LINE.slice(0, 4));
	assert.equal(back.map((run) => run.text).join(''), LINE.slice(4));
	assert.equal(front[front.length - 1].text + back[0].text, 'st'); // 'st' 恰在边界 4 精确切分，双侧同标签
});
test('tints outside the slice tint nothing; the same tints still tint the whole line', () => {
	// tint 与 slice 同坐标系（行相对）：slice 外的 tint 不得干扰切片 runs。
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, { start: 10, end: 12 }, [{ start: 0, end: 5, layer: 'word' }]), [
		{ text: '1;', color: undefined, fontStyle: 0, tint: null },
	]);
	// 对照：同一 tint 在整行切片下确实生效（上一断言非空洞通过）。
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, [{ start: 0, end: 5, layer: 'word' }])[0], {
		text: 'const',
		color: 'c1',
		fontStyle: 1,
		tint: 'word',
	});
});
test('unusable input degrades safely with tints too, never throws', () => {
	const plain = buildTokenRowFragments(LINE, TOKENS, undefined).map((run) => ({ ...run, tint: null }));
	assert.deepEqual(buildTokenRowFragmentsWithTints(null, TOKENS, undefined, [{ start: 0, end: 2, layer: 'word' }]), []);
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, { start: 6, end: 4 }, [{ start: 0, end: 12, layer: 'word' }]), []); // 倒置切片
	// 非数组 tints、残缺/零长/未知标签的条目一律按无 tint 处理，不抛错。
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, 'x'), plain);
	assert.deepEqual(
		buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, [null, { start: 'a', end: 3 }, { start: 0, end: 5 }, { start: 0, end: 2, layer: 'nope' }]),
		plain
	);
	// 倒置 tint 条目交换；越出行尾的 tint 截到行内部分仍然着色。
	assert.deepEqual(buildTokenRowFragmentsWithTints(LINE, TOKENS, undefined, [{ start: 10, end: 99, layer: 'word' }]), [
		{ text: 'const', color: 'c1', fontStyle: 1, tint: null },
		{ text: ' x', color: undefined, fontStyle: 0, tint: null },
		{ text: ' = ', color: 'c2', fontStyle: 0, tint: null },
		{ text: '1;', color: undefined, fontStyle: 0, tint: 'word' },
	]);
});
