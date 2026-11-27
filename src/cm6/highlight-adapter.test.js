/**
 * Tests for `src/cm6/highlight-adapter.js` — the CM6 highlight pure core
 * that turns one line's cached shiki token row into document-absolute
 * decoration descriptors.
 *
 * Contract under test: `from`/`to` compose the in-line token offsets with
 * the line start, `to` clamps to the line end (a stale cache row may
 * overrun the line), the class string comes from `fontStyleClasses`, the
 * inline style carries the token colour only when there is one, and empty
 * ranges are skipped. The module is session-agnostic — the degraded/idle
 * guards live in the view shell (Task 8) — so no session shape appears
 * here; the view feeds it `session.lines[lineIndex]`, `line.from` and
 * `line.text`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTokenDecorations } from './highlight-adapter.js';

const TOK_ITALIC = 'dsh-editor-cm6-tok-i';
const TOK_BOLD = 'dsh-editor-cm6-tok-b';
const TOK_UNDERLINE = 'dsh-editor-cm6-tok-u';

/** A token row entry: in-line offsets, shiki colour and fontStyle bits. */
function token(start, end, color, fontStyle) {
	return { start, end, color, fontStyle };
}

test('a normal row composes document offsets and maps classes and colours', () => {
	const lineText = 'const x = 42;';
	const row = [
		token(0, 5, 'var(--shiki-token-keyword)', 3),
		token(6, 7, 'var(--shiki-token-variable)', 1),
		token(8, 12, 'var(--shiki-token-constant)', 6),
	];

	const decorations = lineTokenDecorations(row, 1000, lineText);

	assert.deepEqual(decorations, [
		{
			from: 1000,
			to: 1005,
			attrs: { class: `${TOK_ITALIC} ${TOK_BOLD}`, style: 'color: var(--shiki-token-keyword)' },
		},
		{
			from: 1006,
			to: 1007,
			attrs: { class: TOK_ITALIC, style: 'color: var(--shiki-token-variable)' },
		},
		{
			from: 1008,
			to: 1012,
			attrs: { class: `${TOK_BOLD} ${TOK_UNDERLINE}`, style: 'color: var(--shiki-token-constant)' },
		},
	]);
});

test('an empty line or an empty token row yields no decorations', () => {
	assert.deepEqual(lineTokenDecorations([], 0, ''), [], 'empty line, empty row');
	assert.deepEqual(lineTokenDecorations([], 500, 'some text'), [], 'a stale empty row on a non-empty line');
	const first = lineTokenDecorations([], 0, '');
	const second = lineTokenDecorations([], 0, '');
	assert.notEqual(first, second, 'a fresh array per call, never shared');
});

test('a stale token row never emits a range past the line end', () => {
	const lineText = 'abc';
	const row = [
		token(0, 7, '#ffffff', 0), // end overruns the line
		token(1, 2, '', 0), // fully inside
		token(2, 10, '', 0), // end overruns after a valid start
		token(3, 9, '', 0), // starts exactly at the line end: empty range
		token(6, 8, '', 0), // entirely past the line end: empty range
	];

	const decorations = lineTokenDecorations(row, 10, lineText);

	assert.deepEqual(decorations, [
		{ from: 10, to: 13, attrs: { class: '', style: 'color: #ffffff' } },
		{ from: 11, to: 12, attrs: { class: '' } },
		{ from: 12, to: 13, attrs: { class: '' } },
	]);
	for (const { from, to } of decorations) {
		assert.ok(from >= 10 && to <= 13, `range ${from}..${to} stays within the line`);
	}
});

test('a token whose clamped range is empty is skipped', () => {
	const row = [
		token(2, 2, 'var(--shiki-token-plain)', 0), // zero width
		token(3, 4, 'var(--shiki-token-plain)', 0), // the only real range
		token(9, 4, 'var(--shiki-token-plain)', 0), // inverted, also empty
	];

	const decorations = lineTokenDecorations(row, 20, 'abcd');

	assert.deepEqual(decorations, [
		{ from: 23, to: 24, attrs: { class: '', style: 'color: var(--shiki-token-plain)' } },
	]);
});

test('a fontStyle-0 token keeps an empty class attribute and no style without colour', () => {
	const row = [token(0, 4, '', 0)];
	const [decorated] = lineTokenDecorations(row, 0, 'text');
	assert.ok('class' in decorated.attrs, 'the class attribute is always emitted');
	assert.equal(decorated.attrs.class, '', 'fontStyle 0 joins to the empty string, not omitted');
	assert.equal(decorated.attrs.style, undefined, 'no colour means no style');

	const [coloured] = lineTokenDecorations([token(0, 4, 'var(--shiki-token-plain)', 0)], 0, 'text');
	assert.equal(coloured.attrs.class, '', 'a colour does not add fontStyle classes');
	assert.equal(coloured.attrs.style, 'color: var(--shiki-token-plain)', 'a colour becomes the inline style');
});
