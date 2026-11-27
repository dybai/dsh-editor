/**
 * Tests for `src/cm6/theme.js` — the CM6 theme pure core: the shiki
 * fontStyle bit table and the base `EditorView.theme` rule object.
 *
 * Both seams are pure data: `fontStyleClasses` is asserted over the full
 * 0–7 bit combination table, and `cm6BaseTheme` is asserted on its
 * selector keys, its declaration values and — the palette contract — on
 * every CSS custom property it references.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fontStyleClasses, cm6BaseTheme } from './theme.js';

const TOK_ITALIC = 'dsh-editor-cm6-tok-i';
const TOK_BOLD = 'dsh-editor-cm6-tok-b';
const TOK_UNDERLINE = 'dsh-editor-cm6-tok-u';

/** The exhaustive vscode-textmate bit table: i before b before u. */
const FONT_STYLE_TABLE = [
	[0, []],
	[1, [TOK_ITALIC]],
	[2, [TOK_BOLD]],
	[3, [TOK_ITALIC, TOK_BOLD]],
	[4, [TOK_UNDERLINE]],
	[5, [TOK_ITALIC, TOK_UNDERLINE]],
	[6, [TOK_BOLD, TOK_UNDERLINE]],
	[7, [TOK_ITALIC, TOK_BOLD, TOK_UNDERLINE]],
];

test('fontStyleClasses maps every fontStyle bit combination in i-b-u order', () => {
	for (const [fontStyle, expected] of FONT_STYLE_TABLE) {
		assert.deepEqual(fontStyleClasses(fontStyle), expected, `fontStyle ${fontStyle}`);
	}
});

test('fontStyleClasses ignores bits outside the three textmate fontStyle flags', () => {
	assert.deepEqual(fontStyleClasses(8), [], 'bit 8 is not a fontStyle flag');
	assert.deepEqual(fontStyleClasses(9), [TOK_ITALIC], 'only the italic bit survives');
	assert.deepEqual(fontStyleClasses(255), [TOK_ITALIC, TOK_BOLD, TOK_UNDERLINE], 'unknown high bits add no class');
});

test('fontStyleClasses returns a fresh array each call', () => {
	const first = fontStyleClasses(7);
	const second = fontStyleClasses(7);
	assert.notEqual(first, second, 'callers may not mutate shared state through one returned array');
	first.push('dsh-editor-cm6-tok-x');
	assert.deepEqual(second, [TOK_ITALIC, TOK_BOLD, TOK_UNDERLINE], 'mutating one result leaves later results untouched');
});

test('cm6BaseTheme returns a plain selector → declaration object', () => {
	const theme = cm6BaseTheme();
	assert.equal(typeof theme, 'object');
	assert.ok(theme !== null && !Array.isArray(theme), 'the theme is a plain object, not an array');
	const entries = Object.entries(theme);
	assert.ok(entries.length > 0, 'the theme carries rules');
	for (const [selector, declarations] of entries) {
		assert.ok(selector.length > 0, 'every rule has a selector key');
		assert.equal(typeof declarations, 'string', `"${selector}" maps to a declaration string`);
		assert.ok(declarations.trim().length > 0, `"${selector}" carries declarations`);
		assert.ok(declarations.trimEnd().endsWith(';'), `"${selector}" is a complete declaration list`);
	}
	const gated = Object.keys(theme).filter((selector) => selector.includes('&light') || selector.includes('&dark'));
	assert.deepEqual(gated, [], 'DSH variables switch with the app theme; the theme never gates on CM6 dark/light');
});

test('the theme references only dsw alias and font variables (no shiki vars)', () => {
	const allowed = /^--(?:dsw-alias-[\w-]+|dsw-font-mono|shiki-[\w-]+)$/;
	const declarations = Object.values(cm6BaseTheme()).join('\n');
	const referenced = [...declarations.matchAll(/--[\w-]+/g)].map((match) => match[0]);
	assert.ok(referenced.length > 0, 'the theme references DSH variables');
	for (const name of referenced) {
		assert.match(name, allowed, `"${name}" is not a DSH alias or font variable`);
	}
	assert.doesNotMatch(declarations, /--shiki-/, 'token colours are decoration inline styles, not theme rules');
});

test('the content rule mirrors .dsh-editor-area font metrics and palette', () => {
	const theme = cm6BaseTheme();
	assert.ok('&' in theme, 'the & rule styles the editor wrapper');
	const content = theme['&'];
	assert.match(content, /font-family: var\(--dsw-font-mono/, 'the DSH mono family is the first fallback');
	assert.match(content, /font-size: 13px/, 'the textarea size is mirrored');
	assert.match(content, /line-height: 1\.5/, 'the textarea line height is mirrored');
	assert.match(content, /tab-size: 4/, 'the textarea tab size is mirrored');
	assert.match(content, /background: var\(--dsw-alias-bg-base\)/, 'the editor takes the base background');
	assert.match(content, /color: var\(--dsw-alias-label-primary\)/, 'the editor takes the primary label colour');
});

test('the scroller re-declares the font metrics the CM6 base theme hard-codes', () => {
	// CM6's base theme sets monospace/1.4 on .cm-scroller, which defeats
	// inheritance from `&`; the scroller rule is what actually mirrors the
	// textarea metrics on the code text.
	const scroller = cm6BaseTheme()['.cm-scroller'];
	assert.ok(scroller !== undefined, 'the scroller rule exists');
	assert.match(scroller, /font-family: var\(--dsw-font-mono/, 'the DSH mono family reaches the code text');
	assert.match(scroller, /line-height: 1\.5/, 'the textarea line height reaches the code text');
});

test('the focused editor drops the CM6 base outline', () => {
	const focused = cm6BaseTheme()['&.cm-focused'];
	assert.ok(focused !== undefined, 'the focused wrapper rule exists');
	assert.match(focused, /outline: none/, 'the base theme dotted focus outline is suppressed');
});

test('the selection rules repaint the selection layer with the 30% brand active tint', () => {
	const theme = cm6BaseTheme();
	const mix = 'color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent)';
	assert.ok(theme['.cm-selectionBackground'] !== undefined, 'drawSelection renders the .cm-selectionBackground layer');
	assert.ok(theme['.cm-selectionBackground'].includes(mix), 'the selection layer carries the active-tint brand mix');
	const focused = Object.entries(theme).filter(
		([selector]) => selector.includes('cm-focused') && selector.includes('cm-selectionBackground'),
	);
	assert.equal(focused.length, 1, 'exactly one focused selection variant exists');
	assert.ok(focused[0][1].includes(mix), 'the focused selection variant carries the same brand mix');
});

test('gutter, active line and line number rules use the alias palette', () => {
	const theme = cm6BaseTheme();
	assert.match(theme['.cm-gutters'], /background: var\(--dsw-alias-bg-layer-1\)/, 'the gutter sits on layer 1');
	assert.match(theme['.cm-gutters'], /color: var\(--dsw-alias-label-secondary\)/, 'gutter text uses the secondary label');
	assert.match(theme['.cm-gutters'], /border-right: 1px solid var\(--dsw-alias-border-l1\)/, 'the gutter separator is border-l1');
	assert.equal(
		theme['.cm-activeLine'],
		'background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);',
		'the active line is a faint brand wash',
	);
	assert.match(theme['.cm-lineNumbers'], /color: var\(--dsw-alias-label-secondary\)/, 'line numbers use the secondary label');
});

test('the token fontStyle classes carry their bold, italic and underline styles', () => {
	const theme = cm6BaseTheme();
	assert.match(theme['.dsh-editor-cm6-tok-b'], /font-weight: bold/, 'bold class sets bold weight');
	assert.match(theme['.dsh-editor-cm6-tok-i'], /font-style: italic/, 'italic class sets italic style');
	assert.match(theme['.dsh-editor-cm6-tok-u'], /text-decoration: underline/, 'underline class sets underline');
});
