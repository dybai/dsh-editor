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
import { buildTokenRowFragments } from './token-rows.js';

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
