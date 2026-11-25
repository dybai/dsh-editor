/**
 * Source-level guards for `src/components.js` — the same discipline as
 * `client-entry.test.js`: the module itself is React-requiring and not
 * importable under node:test, so the wiring whose absence would silently
 * degrade (not crash) is pinned as text markers (spec §9's degradation
 * guard convention).
 *
 * Task 6 pins the PlainTextMode extra-backdrop-layer seam: the prop read,
 * the render order (whitespace → extra layers → ruler, all inside
 * `${CLASS}-inputwrap`), the repaint joining (`syncExtraLayers` at every
 * `syncWhitespace` call site), the guard chain mirrored from syncWhitespace,
 * the ignore-safety invariants (nothing new happens when the prop is
 * absent), and the paint containment (a throwing paint is logged and its
 * descriptor dropped for the component's lifetime instead of breaking the
 * tab). A refactor that drops any of these markers fails here first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS_TEXT = readFileSync(path.join(HERE, 'components.js'), 'utf8');

/** The PlainTextMode function body: signature to the first column-0 close. */
function plainTextModeSpan() {
	const start = COMPONENTS_TEXT.indexOf('function PlainTextMode(props) {');
	assert.ok(start !== -1, 'PlainTextMode was found in src/components.js');
	const end = COMPONENTS_TEXT.indexOf('\n}', start);
	assert.ok(end !== -1, 'PlainTextMode body was delimited');
	return COMPONENTS_TEXT.slice(start, end);
}

/** A useCallback const's body: from its declaration to its `\n\t}, [` deps line. */
function useCallbackSpan(source, declaration) {
	const start = source.indexOf(declaration);
	assert.ok(start !== -1, `${declaration} was found in src/components.js`);
	const end = source.indexOf('\n\t}, [', start);
	assert.ok(end !== -1, `${declaration}'s deps array was delimited`);
	return source.slice(start, end);
}

/* ------------------------------------------------------- prop wiring -- */

test('PlainTextMode reads the extraBackdropLayers prop and normalizes it defensively', () => {
	const span = plainTextModeSpan();
	assert.ok(
		span.includes('Array.isArray(props.extraBackdropLayers)'),
		'the extraBackdropLayers prop is read (defensively normalized) inside PlainTextMode'
	);
	assert.ok(
		span.includes('const extraLayers = Array.isArray(props.extraBackdropLayers) ? props.extraBackdropLayers : NO_EXTRA_LAYERS'),
		'an absent or non-array prop normalizes to the SHARED empty active set (a per-render [] would churn the joined effects)'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('const NO_EXTRA_LAYERS = Object.freeze([]);'),
		'the shared empty active set is one frozen module constant'
	);
});

/* ------------------------------------------------------ render order -- */

test('the extra layer divs render after the whitespace layer and before the ruler', () => {
	// Unique render markers (the `-whitespace` / `-ruler` class literals at
	// the two layer conditionals inside `${CLASS}-inputwrap`; the map call
	// is the extra layers' render). DOM order is stacking order, so this
	// sequence IS the paint order: glyph rows < token ink < guide line.
	const whitespaceAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-whitespace`');
	const extraAt = COMPONENTS_TEXT.indexOf('extraLayers.map(');
	const rulerAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-ruler`');
	assert.ok(whitespaceAt !== -1, 'the whitespace layer render was found');
	assert.ok(extraAt !== -1, 'the extra layer render was found');
	assert.ok(rulerAt !== -1, 'the ruler layer render was found');
	assert.ok(whitespaceAt < extraAt, 'extra layers render AFTER the whitespace conditional');
	assert.ok(extraAt < rulerAt, 'extra layers render BEFORE the ruler conditional');
});

test('the extra layers render as a conditional expression on descriptor presence', () => {
	// Ignore-safety, render half: the conditional form pins that an absent
	// prop contributes NO new DOM nodes — the map only runs when the
	// normalized array has descriptors.
	assert.ok(
		COMPONENTS_TEXT.includes('extraLayers.length > 0\n\t\t\t? extraLayers.map('),
		'the extra layer render is a `extraLayers.length > 0 ? extraLayers.map(...) : null` conditional'
	);
	assert.ok(
		COMPONENTS_TEXT.includes("'aria-hidden': true,\n\t\t\t\t\t\t\tref: (element) => {"),
		'each descriptor renders an aria-hidden div registered through a ref callback'
	);
});

/* ------------------------------------------------- repaint joining -- */

test('syncExtraLayers is defined and joined right after every syncWhitespace call site', () => {
	assert.ok(
		COMPONENTS_TEXT.includes('const syncExtraLayers = React.useCallback('),
		'syncExtraLayers is a useCallback const like its sibling syncs'
	);
	// Call-statement occurrences only (`syncWhitespace();`): a prose mention
	// inside a comment (backticked, no semicolon) must not count as a site.
	const whitespaceCalls = COMPONENTS_TEXT.match(/syncWhitespace\(\);/g) || [];
	assert.equal(whitespaceCalls.length, 7, 'the seven syncWhitespace call sites are all still present');
	// Each repaint path that refreshes the whitespace layer must refresh the
	// extra layers too — adjacency (immediately after, same statement run)
	// is the joining contract, and a call site that loses its follower
	// leaves stale token ink on that path.
	const extraCalls = COMPONENTS_TEXT.match(/syncExtraLayers\(\);/g) || [];
	assert.ok(extraCalls.length >= 7, `syncExtraLayers is invoked at every site (found ${extraCalls.length})`);
	// Adjacency: between the two calls only comments and whitespace may sit
	// — any other statement would order a paint between the glyph rebuild
	// and the token repaint on that path.
	const joinedPattern = /syncWhitespace\(\);(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*syncExtraLayers\(\);/g;
	const joined = (COMPONENTS_TEXT.match(joinedPattern) || []).length;
	assert.equal(joined, 7, 'all 7 syncWhitespace call sites carry the extra-layer repaint');
});

/* --------------------------------------------------- ignore-safety -- */

test('ignore-safety: syncExtraLayers early-returns while the prop is absent', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncExtraLayers = React.useCallback(');
	assert.ok(
		span.includes('if (extraLayers.length === 0) return;'),
		'the repaint self-guards on descriptor presence, so the seven joined call sites cost nothing without the prop'
	);
});

/* ------------------------------------------------------ guard chain -- */

test('syncExtraLayers mirrors the syncWhitespace guard chain verbatim', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncExtraLayers = React.useCallback(');
	assert.ok(span.includes('if (layer === null || area === null) return;'), 'layer+area non-null guard');
	assert.ok(
		span.includes('if (area.offsetParent === null || area.clientHeight <= 0) return;'),
		'measurable-surface guard (hidden or zero-height area skips the paint)'
	);
	assert.ok(
		span.includes("if (state.phase !== 'ready' && state.phase !== 'saving') return;"),
		'phase guard (ready|saving only)'
	);
	assert.ok(span.includes('const metrics = metricsOfArea();'), 'metrics come from the shared metricsOfArea');
	assert.ok(span.includes('if (metrics === null) return;'), 'unmeasured area skips the paint');
});

test('the paint context is built from the shared live window computation', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncExtraLayers = React.useCallback(');
	// The window inputs must come from the same arithmetic the whitespace
	// layer consumes (the extracted paintWindowOf helper), never a private
	// re-derivation that could drift from the glyph rows it aligns with.
	assert.ok(
		span.includes('const paintWindow = paintWindowOf('),
		'the context window comes from the shared paintWindowOf helper'
	);
	for (const field of ['doc', 'area', 'metrics', 'bandWidth', 'wrapEnabled', 'firstLine', 'visibleCount', 'wrapRows']) {
		assert.ok(span.includes(`${field}:`), `the paint context carries ${field}`);
	}
});

/* -------------------------------------------------- paint containment -- */

test('a throwing paint is contained: logged once and the descriptor dropped', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncExtraLayers = React.useCallback(');
	const paintAt = span.indexOf('descriptor.paint(element, context)');
	const catchAt = span.indexOf('} catch (paintError) {');
	// The log call is wrapped across lines in the source, so the scope and
	// the method are asserted as two markers, both INSIDE the catch branch
	// and before the drop.
	const logAt = span.indexOf('log.warn(');
	const scopeAt = span.indexOf("'highlight'");
	const dropAt = span.indexOf('droppedExtraLayersRef.current.add(');
	assert.ok(paintAt !== -1, 'each descriptor paint is invoked with (element, context)');
	assert.ok(catchAt !== -1, 'the paint call sits in a try/catch');
	assert.ok(paintAt < catchAt, 'the catch wraps the paint call');
	assert.ok(logAt !== -1 && catchAt < logAt, 'the catch logs through the runtime log channel');
	assert.ok(scopeAt !== -1 && catchAt < scopeAt, 'the log line carries the highlight scope');
	assert.ok(dropAt !== -1 && logAt < dropAt, 'the catch drops the descriptor from the active set');
	assert.ok(
		span.includes('if (dropped.has(descriptor.key))') || span.includes('!dropped.has(descriptor.key)'),
		'dropped descriptors are filtered out of every later pass (lifetime removal)'
	);
});
