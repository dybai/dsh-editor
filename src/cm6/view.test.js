/**
 * Task 8 guard tests — the CM6 view assembly's source-level contract.
 *
 * view.js requires CodeMirror and the DOM, so it is NOT importable under
 * node:test (the established discipline for React/CM6-requiring modules —
 * components.test.js / mode-code-highlight.test.js): every assertion here
 * reads the assembly's source text and pins the markers the plan's Review
 * Focuses demand, plus the R5-promised facade-symbol net (approved by the
 * controller as REQUIRED): every `cm6.<Symbol>` the assembly references
 * must exist in the vendored record, so a future vendor drift fails loudly
 * here instead of shipping a view built from undefined symbols.
 *
 * Guarded groups (task-8 brief Step 1):
 * - keymap red lines: no 'Mod-s'/'Mod-Shift-s'/'Mod-d'/'Mod-g', no
 *   stopPropagation, explicit Tab/Shift-Tab indent, history/default keymaps
 * - obligation wiring: updateListener → deps.onEdit/deps.onSelection (the
 *   SINGLE onEdit call site — Review Focus 3), passive scrollDOM listener →
 *   deps.onScroll
 * - named compartments: lineNumbers/activeLine/wrap/whitespace/ruler/
 *   scrollBeyond, each re-dispatched by reconfigure(nextPlan)
 * - handle: the five command methods; destroy calls view.destroy() ONLY
 *   (Review Focus 5)
 * - R6: token decoration consumes visibleTokenLineCeiling as an EXCLUSIVE
 *   bound behind the explicit degraded/idle flag gate, never indexing past
 *   session.lines
 * - decoration assembly: one ViewPlugin merges token/match/whitespace
 *   through one RangeSetBuilder; glyph widgets render glyphSvgShape SVG
 *   through the vendored WidgetType; the ruler rides the vendored layer()
 * - thin shell: pure static imports only, CM6 strictly via the factory
 *   parameter, decoration math stays in the injected deps, no YAGNI surface
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = path.join(HERE, 'view.js');

/** The assembly's source — read lazily so each guard reports its own RED until view.js exists. */
function viewText() {
	return readFileSync(VIEW_PATH, 'utf8');
}

/* --------------------------------------------------- keymap red lines -- */

test('keymap red line: the self-managed combos never enter the CM6 keymap', () => {
	const text = viewText();
	for (const combo of ["'Mod-s'", "'Mod-Shift-s'", "'Mod-d'", "'Mod-g'"]) {
		assert.ok(!text.includes(combo), `view.js must not bind ${combo} — the framework root interceptor owns it`);
	}
	assert.ok(!text.includes('stopPropagation'), 'no stopPropagation anywhere — keydown must keep bubbling to the framework root');
});

test('keymap: exactly the Tab/Shift-Tab indent bindings plus the vendored history/default keymaps', () => {
	const text = viewText();
	assert.ok(text.includes("key: 'Tab'"), 'an explicit Tab indent binding exists');
	assert.ok(text.includes("key: 'Shift-Tab'"), 'an explicit Shift-Tab outdent binding exists');
	const literalBindings = (text.match(/key: '/g) || []).length;
	assert.equal(literalBindings, 2, `only the two indent bindings are literal (found ${literalBindings}) — history and editing keys come from the vendored keymaps`);
	assert.ok(text.includes('...cm6.historyKeymap'), 'the history keys are spread in');
	assert.ok(text.includes('...cm6.defaultKeymap'), 'the standard editing keys are spread in');
});

test('indent: tabs mode inserts a literal tab; auto/spaces indent through indentMore under indentUnit', () => {
	const text = viewText();
	assert.ok(text.includes("insert: '\\t'"), "tabs-mode Tab inserts a literal tab via an insertText-style transaction");
	assert.ok(text.includes('cm6.indentMore(view)'), 'auto/spaces Tab goes through indentMore');
	assert.ok(text.includes('cm6.indentLess(view)'), 'Shift+Tab goes through indentLess');
	assert.ok(text.includes('cm6.indentUnit.of('), 'indentUnit rides the plan indent slice');
});

/* --------------------------------------------- obligation wiring -- */

test('updateListener: docChanged reports edits and selectionSet reports normalized selections', () => {
	const text = viewText();
	assert.ok(text.includes('cm6.EditorView.updateListener.of'), 'the obligation listener is a CM6 updateListener');
	assert.ok(text.includes('docChanged'), 'the listener branches on docChanged');
	assert.ok(text.includes('selectionSet'), 'the listener branches on selectionSet');
	const onEditCalls = (text.match(/deps\.onEdit\(/g) || []).length;
	assert.equal(onEditCalls, 1, `deps.onEdit has exactly ONE call site — the updateListener docChanged branch (IME single-report pin; found ${onEditCalls})`);
	assert.ok(text.includes('deps.onSelection('), 'selection changes reach deps.onSelection');
});

test('scroll wiring: a passive scrollDOM listener reports {top, left}', () => {
	const text = viewText();
	assert.ok(text.includes("scrollDOM.addEventListener('scroll'"), 'the scrollDOM gets a scroll listener');
	assert.ok(text.includes('{ passive: true }'), 'the scroll listener is passive');
	assert.ok(text.includes('view.scrollDOM.scrollTop') && text.includes('view.scrollDOM.scrollLeft'), 'the report reads the scrollDOM offsets');
	assert.ok(text.includes('deps.onScroll('), 'scroll offsets reach deps.onScroll');
});

/* --------------------------------------------- named compartments -- */

test('named compartments: the six live-toggle families each own a Compartment', () => {
	const text = viewText();
	for (const family of ['lineNumbers', 'activeLine', 'wrap', 'whitespace', 'ruler', 'scrollBeyond']) {
		assert.ok(
			text.includes(`const ${family}Comp = new cm6.Compartment()`),
			`the ${family} family has a named Compartment`
		);
	}
});

test('reconfigure(nextPlan) re-dispatches every compartment so prop flips apply live', () => {
	const text = viewText();
	assert.ok(text.includes('function reconfigure(nextPlan)'), 'reconfigure(nextPlan) is the live-toggle entry point');
	for (const comp of ['lineNumbersComp', 'activeLineComp', 'wrapComp', 'whitespaceComp', 'rulerComp', 'scrollBeyondComp', 'indentComp']) {
		assert.ok(text.includes(`${comp}.reconfigure(`), `${comp} is re-dispatched by reconfigure`);
	}
});

/* ------------------------------------------------------ the handle -- */

test('handle.destroy is pure: only view.destroy(), no obligations, no writes', () => {
	const text = viewText();
	const start = text.indexOf('destroy() {');
	assert.ok(start !== -1, 'the handle owns a destroy method');
	const end = text.indexOf('},', start);
	assert.ok(end !== -1, 'the destroy method is delimited');
	const body = text.slice(start, end);
	assert.ok(body.includes('view.destroy()'), 'destroy calls view.destroy()');
	for (const banned of ['onEdit', 'onSelection', 'onScroll', 'setContent', 'mirrorMachineSelection', 'dispatch']) {
		assert.ok(!body.includes(banned), `destroy must not touch ${banned} (Review Focus 5 pin)`);
	}
});

test('handle surface: the five command methods with their pinned semantics', () => {
	const text = viewText();
	assert.ok(text.includes('applyInitialScroll(') && text.includes('scrollTo('), 'applyInitialScroll scrolls once');
	const nav = text.indexOf('navigateToLine(line)');
	assert.ok(nav !== -1, 'navigateToLine(line) exists');
	const navEnd = text.indexOf('},', nav);
	assert.ok(text.slice(nav, navEnd).includes('return true'), 'navigateToLine claims the navigation (returns true)');
	assert.ok(text.includes('cm6.EditorView.scrollIntoView('), 'navigation scrolls the target line in');
	assert.ok(text.includes('changes: { from: 0, to: view.state.doc.length'), 'setContent replaces the whole document');
	assert.ok(text.includes('mirrorMachineSelection('), 'mirrorMachineSelection dispatches the machine selection');
});

test('machine writes stay out of the undo history: both mirror dispatches annotate addToHistory(false) (M1)', () => {
	const text = viewText();
	const setContentAt = text.indexOf('setContent(text, selection) {');
	assert.ok(setContentAt !== -1, 'the setContent handle method was found');
	const setContent = text.slice(setContentAt, text.indexOf('\n\t\t\t},', setContentAt));
	assert.ok(
		setContent.includes('cm6.Transaction.addToHistory.of(false)'),
		'setContent dispatches outside the history — Ctrl+Z reverts a user edit, never a machine write'
	);
	const mirrorAt = text.indexOf('mirrorMachineSelection(selection) {');
	assert.ok(mirrorAt !== -1, 'the mirrorMachineSelection handle method was found');
	const mirror = text.slice(mirrorAt, text.indexOf('\n\t\t\t},', mirrorAt));
	assert.ok(
		mirror.includes('cm6.Transaction.addToHistory.of(false)'),
		'mirrorMachineSelection dispatches outside the history too'
	);
	const annotations = (text.match(/addToHistory\.of\(false\)/g) || []).length;
	assert.equal(
		annotations,
		2,
		`exactly the two machine-write dispatches carry the annotation (found ${annotations}) — user transactions keep their history`
	);
});

/* --------------------------------------- R6 progressive cutoff -- */

test('R6: token decorations consume the ceiling as an EXCLUSIVE bound behind the explicit flag gate', () => {
	const text = viewText();
	assert.ok(text.includes('visibleTokenLineCeiling('), 'the cutoff call pins the decoration line range');
	assert.ok(text.includes('line < ceiling'), 'the token loop treats the ceiling as exclusive — [fromLine, ceiling)');
	assert.ok(text.includes('session.degraded') && text.includes('session.idle'), 'degraded/idle sessions are gated explicitly before any token decoration work');
	assert.ok(text.includes('session.lines.length'), 'the token loop never indexes past session.lines (Task 5 handoff)');
});

/* ------------------------------------------ decoration assembly -- */

test('decoration assembly: one ViewPlugin merges token/match/whitespace through one RangeSetBuilder', () => {
	const text = viewText();
	assert.ok(text.includes('cm6.ViewPlugin.fromClass'), 'the decoration work lives in a ViewPlugin');
	assert.ok(text.includes('cm6.RangeSetBuilder'), 'the three layers merge through one RangeSetBuilder');
	for (const family of ['cm6.Decoration.mark', 'cm6.Decoration.widget', 'cm6.Decoration.replace', 'cm6.Decoration.line', 'cm6.Decoration.set']) {
		assert.ok(text.includes(family), `${family} builds its decoration family`);
	}
});

test('whitespace glyph widgets render glyphSvgShape SVG through the vendored WidgetType', () => {
	const text = viewText();
	assert.ok(text.includes('extends cm6.WidgetType'), 'the glyph widget subclasses the vendored WidgetType');
	assert.ok(text.includes('toDOM(view)'), 'the widget implements toDOM');
	assert.ok(text.includes('glyphSvgShape('), 'the SVG shapes come from the whitespace pure core');
	assert.ok(text.includes('viewBox') && text.includes('yCenterEm'), 'the SVG spec geometry (viewBox, yCenterEm) is honored');
});

test('whitespace: the scan is WINDOWED to the viewport ± 2 lines, never a whole-document materialization (I1)', () => {
	const text = viewText();
	assert.ok(
		text.includes('function whitespaceWindow('),
		"the windowing helper exists (the DOM layer's visibleWindow margin convention)"
	);
	assert.ok(text.includes('doc.lineAt(view.viewport.from).number - 2'), 'the window widens the viewport by 2 lines above');
	assert.ok(text.includes('doc.lineAt(view.viewport.to).number + 2'), 'the window widens the viewport by 2 lines below');
	const wsAt = text.indexOf('function whitespaceEntries(');
	assert.ok(wsAt !== -1, 'the whitespace entry builder was found');
	// Both functions are nested inside the factory (tab-indented closing
	// braces) — slice to the two-tab close, not a column-0 one.
	const ws = text.slice(wsAt, text.indexOf('\n\t\t}\n', wsAt));
	assert.ok(ws.includes('doc.line(line).text'), 'the scan iterates the doc line API per visible line');
	assert.ok(!ws.includes('view.state.doc.toString()'), 'the whitespace scan never materializes the whole document');
	assert.ok(
		ws.includes('descriptor.from + base'),
		'slice-local offsets shift back into document coordinates (the descriptor math stays in the core)'
	);
	// Rebuild when the viewport OR the doc changes: the ws cache keys on
	// the window too, not just the doc identity.
	const rebuildAt = text.indexOf('function rebuildDecorations(');
	const rebuild = text.slice(rebuildAt, text.indexOf('\n\t\t}\n', rebuildAt));
	assert.ok(
		rebuild.includes('plugin.wsWindowKey !== wsWindowKey'),
		'the whitespace cache re-keys on the window — a viewport move rescans the visible slice'
	);
});

test('the ruler rides the vendored layer() primitive with the measured char width and its fallback', () => {
	const text = viewText();
	assert.ok(text.includes('cm6.layer('), 'the ruler is a cm6.layer extension (R8)');
	assert.ok(text.includes('measureCharWidth'), 'the hidden measurer measures the character cell');
	assert.ok(text.includes('13 * 0.6'), 'the measurer falls back to 13px × 0.6 when measurement fails');
	assert.ok(text.includes('deps.rulerGeometry('), 'the geometry itself stays in the injected dep');
});

test('match layers: per-layer dirty — a viewport change recomputes only a viewport-restricted layer (I2)', () => {
	const text = viewText();
	// The conservative viewport-restriction verdict: the core's return
	// carries the descriptor arrays only (its cap flags are internal),
	// so the shell infers the restriction from the cached result's own
	// geometry.
	assert.ok(text.includes('function viewportRestricted('), 'the viewport-restriction verdict helper exists');
	const verdictAt = text.indexOf('function viewportRestricted(');
	const verdict = text.slice(verdictAt, text.indexOf('\n}\n', verdictAt));
	assert.ok(
		verdict.includes('entries.length === 0'),
		'an empty cached result conservatively counts as viewport-restricted (never a skipped repaint)'
	);
	assert.ok(
		verdict.includes('entry.from < span.from || entry.to > span.to'),
		'a result reaching outside its span proves the layer ignored the viewport (doc-global, under cap)'
	);
	// The per-layer signature cache — the DOM seam's discipline: inputs
	// compared, not events.
	const updateAt = text.indexOf('update(update) {');
	assert.ok(updateAt !== -1, 'the decoration plugin update was found');
	const updateBody = text.slice(updateAt, text.indexOf('rebuildDecorations(update.view', updateAt));
	assert.ok(updateBody.includes('this.matchDoc !== doc'), 'the signature compares the doc identity');
	assert.ok(
		updateBody.includes('this.matchStart !== start') && updateBody.includes('this.matchEnd !== end'),
		'the signature compares the selection bounds'
	);
	assert.ok(
		updateBody.includes('viewportRestricted(this.matchWordEntries, this.matchWordSpan)'),
		'the word layer recomputes on a viewport change only when its cached result is viewport-restricted'
	);
	assert.ok(
		updateBody.includes('viewportRestricted(this.matchSelectionEntries, this.matchSelectionSpan)'),
		'the selection layer recomputes on a viewport change only when its cached result is viewport-restricted'
	);
	assert.ok(
		!updateBody.includes('update.viewportChanged ||'),
		'viewportChanged no longer dirties the match layers unconditionally — the per-scroll full-document rescan is gone'
	);
	// Per-layer core calls: each dirty layer scans alone.
	const matchAt = text.indexOf('function matchEntries(');
	assert.ok(matchAt !== -1, 'the match entry builder was found');
	const match = text.slice(matchAt, text.indexOf('\n\t\t}\n', matchAt));
	assert.ok(match.includes('selectionEnabled: false,'), 'the word layer call runs with the selection layer off (its scan is never paid)');
	assert.ok(match.includes('wordEnabled: false,'), 'the selection layer call runs with the word layer off');
	assert.ok(match.includes('plugin.matchWordSpan = span'), 'the word layer caches the viewport span its result was sliced to');
	assert.ok(match.includes('plugin.matchSelectionSpan = span'), 'the selection layer caches the viewport span its result was sliced to');
	assert.ok(match.includes('plugin.matchWordEntries = matchEntriesOf('), 'the word entries cache per layer');
	assert.ok(match.includes('plugin.matchSelectionEntries = matchEntriesOf('), 'the selection entries cache per layer');
});

test('decoration sources are injected deps, never re-implemented in the shell', () => {
	const text = viewText();
	for (const dep of [
		'deps.lineTokenDecorations(',
		'deps.matchDecorationDescriptors(',
		'deps.whitespaceDecorationDescriptors(',
		'deps.rulerGeometry(',
		'deps.cm6BaseTheme(',
		'deps.activeLineRanges',
	]) {
		assert.ok(text.includes(dep), `${dep} is consumed`);
	}
	// The pure cores arrive as deps — their modules are never statically imported.
	assert.ok(!text.includes("from './highlight-adapter.js'"), 'the highlight adapter is not statically imported');
	assert.ok(!text.includes("from './whitespace-decorations.js'"), 'the whitespace core is not statically imported');
	assert.ok(!text.includes("from './ruler-layer.js'"), 'the ruler core is not statically imported');
	assert.ok(!text.includes("from './theme.js'"), 'the theme core is not statically imported');
});

/* ------------------------------------------------ thin-shell pins -- */

test('view.js is a main-bundle module: three pure imports, CM6 strictly via the factory parameter', () => {
	const text = viewText();
	const imports = text.match(/^import .*$/gm) || [];
	assert.equal(imports.length, 3, `exactly the three pure imports are allowed (found ${imports.length})`);
	assert.ok(text.includes("import { visibleTokenLineCeiling } from './match-decorations.js'"), 'the R6 cutoff is a pure static import');
	assert.ok(text.includes("import { glyphSvgShape } from '../whitespace.js'"), 'the glyph SVG spec is a pure static import');
	assert.ok(text.includes("import { scrollBeyondPadding } from '../scroll-beyond.js'"), 'the scroll-beyond pad math is a pure static import');
	assert.ok(!text.includes('@codemirror/'), 'no static @codemirror import');
	assert.ok(!text.includes('vendor/cm6-core'), 'the vendored facade is never statically imported');
	assert.ok(text.includes('createCm6ViewFactory(cm6)'), 'the cm6 record arrives as the factory parameter');
	assert.ok(text.includes('createCm6View({ plan, deps, docText, host })'), 'the view factory signature matches the Task 9 seam');
});

test('scrollBeyond: the pad is measured from the PANE height, not the viewport height (fix round 1)', () => {
	const text = viewText();
	assert.ok(!text.includes('100vh'), 'the 100vh overshoot literal is gone');
	assert.ok(text.includes('--dsh-editor-cm6-scroll-past'), 'the pad rides the CSS custom property');
	assert.ok(text.includes('var(--dsh-editor-cm6-scroll-past, 19.5px)'), 'the scrollBeyond theme rule consumes the property with the 1.5em fallback');
	assert.ok(text.includes('view.scrollDOM.clientHeight'), 'the pad is measured from the scroller pane');
	assert.ok(text.includes('scrollBeyondPadding('), 'the pad math is the pure core (max(0, clientHeight − lineHeight)), not re-derived');
	assert.ok(text.includes('update.geometryChanged'), 'geometry changes re-measure the pad (the existing measure cycle)');
});

test('base extension set: the plan-pinned unconditional extensions and theme seams', () => {
	const text = viewText();
	for (const marker of [
		'cm6.drawSelection()',
		'cm6.dropCursor()',
		'cm6.rectangularSelection()',
		'cm6.crosshairCursor()',
		'cm6.history()',
		'cm6.lineNumbers()',
		'cm6.EditorView.lineWrapping',
		'cm6.EditorView.theme(',
		'cm6.EditorView.baseTheme(',
	]) {
		assert.ok(text.includes(marker), `${marker} is part of the base set`);
	}
});

test('YAGNI: no search/autocomplete/fold extensions, no localStorage persistence', () => {
	const text = viewText();
	for (const banned of [
		'localStorage',
		'foldGutter',
		'autocompletion',
		'highlightSelectionMatches',
		'bracketMatching',
		'indentOnInput',
		'syntaxHighlighting',
		'highlightActiveLineGutter',
	]) {
		assert.ok(!text.includes(banned), `${banned} is out of scope for the assembly`);
	}
});

/* -------------------------------------------- facade symbol net -- */

test('facade symbol net (R5 promise, controller-required): every cm6.<Symbol> in view.js exists in the vendored record', async () => {
	const { cm6 } = await import('../vendor/cm6-core.js');
	const text = viewText();
	const used = new Set();
	for (const match of text.matchAll(/\bcm6\.([A-Za-z_$][\w$]*)/g)) used.add(match[1]);
	assert.ok(used.size > 0, 'view.js actually consumes facade symbols');
	const vendored = new Set(Object.keys(cm6));
	assert.equal(vendored.size, 35, 'the vendored record carries the 35 whitelisted symbols');
	const missing = [...used].filter((name) => !vendored.has(name));
	assert.deepEqual(missing, [], `view.js references symbols missing from the vendored cm6 record: ${missing.join(', ')}`);
});
