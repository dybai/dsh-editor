/**
 * Task 8 view-plan tests — the pure prop → extension-plan normalization,
 * directly testable under node:test (zero CM6, zero React, zero DOM).
 *
 * The plan is the §4 mapping table's props face collapsed into the toggle
 * record the CM6 assembly consumes (Task 8's view.js, Task 9's component):
 * every prop is read ignore-safely (absent / null / primitive / garbage
 * degrades to OFF, the component resolves default-on preferences before
 * calling), booleans coerce with literal `true` only, numbers and strings
 * pass through raw (ruler column convergence belongs to ruler-layer.js,
 * indent width validation to the settings validator), and each call returns
 * a fresh plan so callers never share mutable state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveExtensionPlan } from './view-plan.js';

/** The all-off plan every ignore-unsafe input degrades to. */
const OFF_PLAN = {
	lineNumbers: false,
	activeLine: false,
	wrap: false,
	scrollBeyondLastLine: false,
	whitespace: { spaces: false, tabs: false, newlines: false },
	ruler: { enabled: false, column: undefined },
	indent: { mode: 'auto', width: 4 },
	matchHighlight: { selection: false, word: false },
};

test('resolveExtensionPlan: absent or garbage props degrade to the all-off plan', () => {
	for (const props of [undefined, null, {}, 0, 'text', []]) {
		assert.deepEqual(resolveExtensionPlan(props), OFF_PLAN, `props ${JSON.stringify(props)} must normalize to all-off`);
	}
});

test('resolveExtensionPlan: each boolean prop flips exactly its own field', () => {
	assert.equal(resolveExtensionPlan({ showLineNumbers: true }).lineNumbers, true);
	assert.equal(resolveExtensionPlan({ highlightActiveLine: true }).activeLine, true);
	assert.equal(resolveExtensionPlan({ wordWrap: true }).wrap, true);
	assert.equal(resolveExtensionPlan({ scrollBeyondLastLine: true }).scrollBeyondLastLine, true);
	// One flip leaves every other field at the all-off default.
	assert.deepEqual(resolveExtensionPlan({ showLineNumbers: true }), { ...OFF_PLAN, lineNumbers: true });
	assert.deepEqual(resolveExtensionPlan({ wordWrap: true }), { ...OFF_PLAN, wrap: true });
});

test('resolveExtensionPlan: booleans coerce with literal true only', () => {
	for (const truthy of [1, 'yes', {}, Infinity]) {
		const plan = resolveExtensionPlan({
			showLineNumbers: truthy,
			highlightActiveLine: truthy,
			wordWrap: truthy,
			scrollBeyondLastLine: truthy,
		});
		assert.equal(plan.lineNumbers, false, `showLineNumbers ${String(truthy)} is not a literal true`);
		assert.equal(plan.activeLine, false);
		assert.equal(plan.wrap, false);
		assert.equal(plan.scrollBeyondLastLine, false);
	}
});

test('resolveExtensionPlan: the whitespace trio flips independently', () => {
	assert.deepEqual(
		resolveExtensionPlan({ showWhitespace: { spaces: true } }).whitespace,
		{ spaces: true, tabs: false, newlines: false }
	);
	assert.deepEqual(
		resolveExtensionPlan({ showWhitespace: { tabs: true } }).whitespace,
		{ spaces: false, tabs: true, newlines: false }
	);
	assert.deepEqual(
		resolveExtensionPlan({ showWhitespace: { newlines: true } }).whitespace,
		{ spaces: false, tabs: false, newlines: true }
	);
	assert.deepEqual(
		resolveExtensionPlan({ showWhitespace: { spaces: true, tabs: true, newlines: true } }).whitespace,
		{ spaces: true, tabs: true, newlines: true }
	);
});

test('resolveExtensionPlan: garbage showWhitespace reads as all three off', () => {
	for (const garbage of [null, 0, 'spaces', { spaces: 1, tabs: 'on' }, []]) {
		assert.deepEqual(
			resolveExtensionPlan({ showWhitespace: garbage }).whitespace,
			OFF_PLAN.whitespace,
			`showWhitespace ${JSON.stringify(garbage)} degrades to all-off`
		);
	}
});

test('resolveExtensionPlan: ruler.enabled gates on literal true, column passes through raw', () => {
	assert.deepEqual(resolveExtensionPlan({ ruler: { enabled: true, column: 100 } }).ruler, { enabled: true, column: 100 });
	// The column passes through even while disabled — convergence is ruler-layer's job.
	assert.deepEqual(resolveExtensionPlan({ ruler: { enabled: false, column: 100 } }).ruler, { enabled: false, column: 100 });
	// Invalid columns pass through untouched (0/-5/NaN/1000/'80'/null/undefined).
	for (const column of [0, -5, NaN, 1000, '80', null, undefined]) {
		assert.deepEqual(
			resolveExtensionPlan({ ruler: { enabled: true, column } }).ruler,
			{ enabled: true, column },
			`column ${String(column)} passes through raw`
		);
	}
	// A non-object ruler degrades to off with no column.
	assert.deepEqual(resolveExtensionPlan({ ruler: null }).ruler, OFF_PLAN.ruler);
});

test('resolveExtensionPlan: indentSettings passes mode/width through', () => {
	assert.deepEqual(
		resolveExtensionPlan({ indentSettings: { indentMode: 'auto', indentWidth: 4 } }).indent,
		{ mode: 'auto', width: 4 }
	);
	assert.deepEqual(
		resolveExtensionPlan({ indentSettings: { indentMode: 'tabs', indentWidth: 2 } }).indent,
		{ mode: 'tabs', width: 2 }
	);
	assert.deepEqual(
		resolveExtensionPlan({ indentSettings: { indentMode: 'spaces', indentWidth: 8 } }).indent,
		{ mode: 'spaces', width: 8 }
	);
	// Values outside the valid enums pass through raw — sanitization is upstream.
	assert.deepEqual(
		resolveExtensionPlan({ indentSettings: { indentMode: 'weird', indentWidth: 3 } }).indent,
		{ mode: 'weird', width: 3 }
	);
	// Partial objects: a missing field falls back to the framework default.
	assert.deepEqual(resolveExtensionPlan({ indentSettings: { indentWidth: 8 } }).indent, { mode: 'auto', width: 8 });
	assert.deepEqual(resolveExtensionPlan({ indentSettings: { indentMode: 'tabs' } }).indent, { mode: 'tabs', width: 4 });
});

test('resolveExtensionPlan: a non-string mode or non-finite width falls back to auto/4', () => {
	assert.deepEqual(resolveExtensionPlan({ indentSettings: { indentMode: 42, indentWidth: 8 } }).indent, { mode: 'auto', width: 8 });
	assert.deepEqual(
		resolveExtensionPlan({ indentSettings: { indentMode: 'spaces', indentWidth: Number.NaN } }).indent,
		{ mode: 'spaces', width: 4 }
	);
	// Absent or garbage indentSettings → the framework defaults (auto detect, width 4).
	for (const garbage of [undefined, null, 0, 'tabs', []]) {
		assert.deepEqual(resolveExtensionPlan({ indentSettings: garbage }).indent, OFF_PLAN.indent);
	}
});

test('resolveExtensionPlan: the matchHighlight pair flips independently', () => {
	assert.deepEqual(
		resolveExtensionPlan({ matchHighlight: { selection: true } }).matchHighlight,
		{ selection: true, word: false }
	);
	assert.deepEqual(
		resolveExtensionPlan({ matchHighlight: { word: true } }).matchHighlight,
		{ selection: false, word: true }
	);
	for (const garbage of [null, 5, 'word', { word: 1, selection: 'on' }]) {
		assert.deepEqual(
			resolveExtensionPlan({ matchHighlight: garbage }).matchHighlight,
			OFF_PLAN.matchHighlight,
			`matchHighlight ${JSON.stringify(garbage)} degrades to both off`
		);
	}
});

test('resolveExtensionPlan: unknown props are ignored', () => {
	assert.deepEqual(resolveExtensionPlan({ somethingElse: true, another: { nested: true } }), OFF_PLAN);
});

test('resolveExtensionPlan: every call returns a fresh plan (no shared mutable state)', () => {
	const a = resolveExtensionPlan({});
	const b = resolveExtensionPlan({});
	assert.notEqual(a, b);
	assert.notEqual(a.whitespace, b.whitespace);
	assert.notEqual(a.ruler, b.ruler);
	assert.notEqual(a.indent, b.indent);
	assert.notEqual(a.matchHighlight, b.matchHighlight);
	a.whitespace.spaces = true;
	a.ruler.column = 42;
	assert.equal(b.whitespace.spaces, false);
	assert.equal(b.ruler.column, undefined);
});
