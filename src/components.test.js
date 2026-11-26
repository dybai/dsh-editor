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
 *
 * The match-highlight feature's layer task pins the same seam set for the
 * match underlay: the prop read, the render order (highlight → match →
 * whitespace), the overlay/bg-carry wiring, the syncMatches guard chain
 * mirrored from syncWhitespace, recomputeMatches' live-textarea source +
 * signature dedupe + throw containment, the two schedules (rAF + timer
 * backstop), the mount effect (the settings-toggle conduit), and the
 * settings-key assembly at the mode mount.
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

/* ------------------------------------------------------ inkless ink -- */

test('the textarea carries the -area-inkless variant only while extra layers are present', () => {
	// 0.17.0 code-highlight: the token layer paints the visible ink UNDER the
	// textarea, so the textarea's own glyphs must go transparent while a token
	// layer is mounted — else they cover the tokens as double-struck
	// label-primary. The variant is tied to the prop-presence condition the
	// seam already owns (the same condition that adds -area-overlay), so
	// plain-text and the legacy layers (active-line/whitespace/ruler without
	// extra layers) keep visible text exactly as before, and the absent-prop
	// class list stays byte-identical to v0.16.0.
	const span = plainTextModeSpan();
	assert.ok(
		span.includes("const baseClassName = wrapEnabled ? `${areaClassName} ${CLASS}-area-wrap` : areaClassName;"),
		'the wrap variant keeps composing over the overlay base class'
	);
	assert.ok(
		span.includes('const textareaClassName = extraLayers.length > 0'),
		'the inkless variant keys off extra-layer presence, not a new prop'
	);
	assert.ok(
		span.includes("extraLayers.length > 0 ? `${baseClassName} ${CLASS}-area-inkless` : baseClassName"),
		'extra layers present → the textarea text goes transparent (token ink shows through)'
	);
	assert.ok(
		span.includes(': baseClassName;'),
		'absent/empty prop → no inkless class (the ignore-safety class list is unchanged)'
	);
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

/* ---------------------------------------------- match highlight -- */

// The match-highlight layer (the `matchHighlight` prop): the windowed
// underlay between the active-line highlight backdrop and the whitespace
// glyphs, fed by src/match-highlight.js (the feature's pure Tasks 1-3).
// Same discipline as the sections above — the wiring whose absence would
// silently degrade (no layer, no repaint, stale matches, a settings toggle
// that never reaches the paint) is pinned as text markers.

test('components.js imports the match-highlight primitives from the pure module', () => {
	assert.ok(
		COMPONENTS_TEXT.includes("from './match-highlight.js'"),
		'the pure module\'s exports are imported alongside the existing module imports'
	);
});

test('PlainTextMode reads the matchHighlight prop and normalizes it defensively', () => {
	const span = plainTextModeSpan();
	assert.ok(span.includes('props.matchHighlight'), 'the matchHighlight prop is read inside PlainTextMode');
	assert.ok(
		span.includes('matchProp.selection === true'),
		'the selection switch reads a literal true only (null/primitive-safe)'
	);
	assert.ok(
		span.includes('matchProp.word === true'),
		'the word switch reads a literal true only (null/primitive-safe)'
	);
});

test('the match layer renders between the highlight backdrop and the whitespace layer', () => {
	// DOM order is stacking order (the render-order discipline above): the
	// match tints paint above the active-line bar, below the whitespace
	// glyphs — all beneath the overlay textarea.
	const highlightAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-highlight`');
	const matchAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-match`');
	const whitespaceAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-whitespace`');
	assert.ok(highlightAt !== -1, 'the highlight backdrop render was found');
	assert.ok(matchAt !== -1, 'the match layer render was found');
	assert.ok(whitespaceAt !== -1, 'the whitespace layer render was found');
	assert.ok(highlightAt < matchAt, 'the match layer renders after the highlight backdrop');
	assert.ok(matchAt < whitespaceAt, 'the match layer renders before the whitespace conditional');
});

test('the overlay treatment accounts for the match layer', () => {
	assert.ok(
		COMPONENTS_TEXT.includes(
			'const overlayNeeded = highlightEnabled || wsAny || rulerEnabled || extraLayers.length > 0 || matchAny;'
		),
		'overlayNeeded includes matchAny (the match underlay counts as a paint surface)'
	);
});

test('the bg-carry rule extends to the match layer', () => {
	// Each underlay is transparent whenever an EARLIER underlay already
	// carries the base background; the match layer sits directly above the
	// highlight backdrop, so it carries the bg when highlighting is off,
	// and the whitespace/ruler layers defer to it in turn.
	const matchAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-match`');
	const whitespaceAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-whitespace`');
	const rulerAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-ruler`');
	assert.ok(matchAt !== -1 && whitespaceAt !== -1 && rulerAt !== -1, 'the three underlay renders were found');
	const matchSpan = COMPONENTS_TEXT.slice(matchAt, matchAt + 600);
	assert.ok(
		matchSpan.includes("highlightEnabled ? 'transparent' : 'var(--dsw-alias-bg-base)'"),
		'the match layer carries the base bg only when the highlight backdrop does not'
	);
	const whitespaceSpan = COMPONENTS_TEXT.slice(whitespaceAt, whitespaceAt + 1200);
	assert.ok(
		whitespaceSpan.includes("highlightEnabled || matchAny ? 'transparent' : 'var(--dsw-alias-bg-base)'"),
		'the whitespace layer goes transparent when the match layer carries the base bg'
	);
	const rulerSpan = COMPONENTS_TEXT.slice(rulerAt, rulerAt + 400);
	assert.ok(
		rulerSpan.includes("highlightEnabled || wsAny || matchAny ? 'transparent' : 'var(--dsw-alias-bg-base)'"),
		'the ruler layer goes transparent when the match layer carries the base bg'
	);
});

test('syncMatches mirrors the syncWhitespace guard chain and paints from the shared window', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncMatches = React.useCallback(');
	assert.ok(span.includes('if (layer === null || area === null) return;'), 'layer+area non-null guard');
	assert.ok(span.includes('if (!matchAny) return;'), 'prop guard (the repaint no-ops while the layer is off)');
	assert.ok(span.includes('if (area.offsetParent === null || area.clientHeight <= 0) return;'), 'measurable-surface guard');
	assert.ok(span.includes("if (state.phase !== 'ready' && state.phase !== 'saving') return;"), 'phase guard (ready|saving only)');
	assert.ok(span.includes('const metrics = metricsOfArea();'), 'metrics come from the shared metricsOfArea');
	assert.ok(span.includes('if (metrics === null) return;'), 'unmeasured area skips the paint');
	assert.ok(span.includes('const paintWindow = paintWindowOf('), 'the window comes from the shared paintWindowOf helper');
	assert.ok(span.includes('lineStartOffsets('), 'document offsets translate through one lineStartOffsets pass');
	assert.ok(span.includes('buildMatchRowFragments('), 'rows build through the pure fragment builder');
	assert.ok(span.includes("layer.textContent = ''"), 'the layer clears fully before the windowed rebuild');
	assert.ok(span.includes('translateX('), 'the layer translates against scrollLeft (wrap-off) and resets (wrap)');
	assert.ok(span.includes('${CLASS}-match-row'), 'each visual row is a -match-row span');
	assert.ok(span.includes('${CLASS}-match-word'), 'a word-only run carries the -match-word class');
	assert.ok(span.includes('${CLASS}-match-selection'), 'a selection-only run carries the -match-selection class');
	assert.ok(span.includes('${CLASS}-match-both'), 'a both-layers run carries the single merged -match-both class');
});

test('recomputeMatches reads the live textarea, dedupes on the signature, and contains throws', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	assert.ok(span.includes('if (area === null || !matchAny) return;'), 'the recompute self-guards on the area and the prop');
	assert.ok(span.includes('area.selectionStart'), 'the selection start comes from the live textarea');
	assert.ok(span.includes('area.selectionEnd'), 'the selection end comes from the live textarea');
	assert.ok(span.includes('matchSignatureRef'), 'the signature dedupe keys on the last { value, start, end }');
	assert.ok(span.includes('computeMatchHighlights('), 'the match math comes from the pure orchestrator');
	assert.ok(span.includes('selectionEnabled: matchSelectionOn'), 'the selection switch rides into the orchestrator');
	assert.ok(span.includes('wordEnabled: matchWordOn'), 'the word switch rides into the orchestrator');
	assert.ok(span.includes('} catch (error) {'), 'the orchestrator call is wrapped in a catch');
	assert.ok(span.includes('match-highlight'), 'a throw logs through the match-highlight scope');
	assert.ok(span.includes("typeof log.warn === 'function'"), 'the log call is shape-guarded (a malformed channel stays silent)');
	assert.ok(span.includes('syncMatches();'), 'every real recompute ends in the layer repaint');
});

test('scheduleMatchRecompute coalesces recomputes onto one animation frame', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const scheduleMatchRecompute = React.useCallback(');
	assert.ok(span.includes('matchFrameRef'), 'the frame handle lives in matchFrameRef');
	assert.ok(span.includes('cancelAnimationFrame('), 'a pending frame is cancelled before a new one is requested');
	assert.ok(span.includes('requestAnimationFrame('), 'the recompute rides the next animation frame');
	assert.ok(span.includes('recomputeMatches();'), 'the frame callback ends in the recompute');
});

test('scheduleMatchRecomputeBackstop arms the 300ms timer backstop', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const scheduleMatchRecomputeBackstop = React.useCallback(');
	assert.ok(span.includes('matchTimerRef'), 'the timer handle lives in matchTimerRef');
	assert.ok(span.includes('clearTimeout('), 'a pending timer is cleared before a new one is armed');
	assert.ok(span.includes('setTimeout('), 'the backstop rides a timer');
	assert.ok(span.includes('300'), 'the backstop window is 300ms');
	assert.ok(span.includes('recomputeMatches();'), 'the timer callback ends in the recompute');
});

test('the mount effect runs the first recompute on mount and every identity re-run', () => {
	// Review Focus #5: the prop switches reach the layer through
	// recomputeMatches' identity (its deps carry the switches), so this
	// effect re-fires on every toggle — and the signature reset is what
	// keeps a re-run from being deduped away on an unchanged
	// { value, start, end } (a toggle would otherwise leave the freshly
	// (re)mounted layer empty or stale).
	assert.ok(
		COMPONENTS_TEXT.includes('matchSignatureRef.current = null;\n\t\tif (!matchAny) return;'),
		'the effect drops the signature before its guard'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('if (!matchAny) return;\n\t\trecomputeMatches();'),
		'the guard is immediately followed by the recompute call'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('}, [matchAny, recomputeMatches]);'),
		'the effect keys on matchAny and the recompute identity'
	);
});

test('the mode mount assembles the matchHighlight prop from the settings keys', () => {
	assert.ok(COMPONENTS_TEXT.includes('matchHighlight: {'), 'the matchHighlight prop is assembled at the mode mount');
	assert.ok(
		COMPONENTS_TEXT.includes('runtime.getSettings().selectionHighlight === true'),
		'the selection switch reads the settings key with === true'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('runtime.getSettings().wordHighlight === true'),
		'the word switch reads the settings key with === true'
	);
});

/* ------------------------------------------------- mode menu anchor -- */

test('the mode indicator and its menu mount in the status bar, opening upward', () => {
	// 0.17.2: the mode indicator is view chrome, not a file lifecycle action —
	// it joins the status bar's right-end control cluster (goto popover, then
	// mode ▾, then the settings gear). The status bar is `position: relative`,
	// and `.dsh-editor-menu` anchors with `bottom: calc(100% + 4px)` so the
	// dropdown opens UPWARD from the bottom edge (the goto popover's exact
	// pattern) — the toolbar variant of this mount was the 0.17.1 anchor fix
	// and is gone. The toolbar keeps file identity + lifecycle actions only.
	const ENTRY_TEXT = readFileSync(path.join(HERE, 'client-entry.js'), 'utf8');
	const toolbarAt = COMPONENTS_TEXT.indexOf('const toolbar = h(');
	const noticeAt = COMPONENTS_TEXT.indexOf('const notice =');
	const statusBarAt = COMPONENTS_TEXT.indexOf('const statusBar = h(');
	const modeBtnAt = COMPONENTS_TEXT.indexOf("key: 'mode',", statusBarAt);
	const modeMenuAt = COMPONENTS_TEXT.indexOf('h(ModeMenu, {', statusBarAt);
	const settingsAt = COMPONENTS_TEXT.indexOf("key: 'settings',", statusBarAt);
	assert.ok(
		[toolbarAt, noticeAt, statusBarAt, modeBtnAt, modeMenuAt, settingsAt].every((at) => at !== -1),
		'the toolbar/notice/statusBar statements and the mode/menu/settings markers were all found'
	);
	assert.ok(
		modeBtnAt > statusBarAt && modeBtnAt < settingsAt,
		'the mode indicator sits inside the status bar construction, left of the settings gear'
	);
	assert.ok(
		modeMenuAt > modeBtnAt && modeMenuAt < settingsAt,
		'the menu mounts beside its button inside the status bar (bottom-anchored ancestor)'
	);
	const toolbarSpan = COMPONENTS_TEXT.slice(toolbarAt, noticeAt);
	assert.ok(
		!toolbarSpan.includes("key: 'mode',") && !toolbarSpan.includes('h(ModeMenu, {'),
		'the toolbar keeps file identity + lifecycle actions only'
	);
	assert.equal(
		COMPONENTS_TEXT.split('h(ModeMenu, {').length - 1,
		1,
		'exactly one ModeMenu mount exists (moved, not copied)'
	);
	assert.ok(
		/menuOpen && valid\s*\?\s*$/.test(COMPONENTS_TEXT.slice(modeMenuAt - 200, modeMenuAt)),
		'the menuOpen && valid gate moved with the mount'
	);
	const menuRule = /(\.dsh-editor-menu\s*\{[^}]*\})/.exec(ENTRY_TEXT);
	assert.ok(menuRule !== null, 'the .dsh-editor-menu rule was found in the stylesheet');
	assert.ok(menuRule[1].includes('bottom: calc(100% + 4px)'), 'the dropdown anchors to the bar TOP edge, opening upward');
	assert.ok(!menuRule[1].includes('top:'), 'no top anchor (a top anchor on a bottom-bar child would drop below the pane)');
});
