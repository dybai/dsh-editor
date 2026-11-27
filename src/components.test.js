/**
 * Source-level guards for `src/components.js` — the same discipline as
 * `client-entry.test.js`: the module itself is React-requiring and not
 * importable under node:test, so the wiring whose absence would silently
 * degrade (not crash) is pinned as text markers (spec §9's degradation
 * guard convention).
 *
 * Task 11 retired the code-highlight-only backdrop seams: PlainTextMode is
 * the plain-text reference implementation again. The guards below pin the
 * RETIREMENT — the `extraBackdropLayers` prop machinery, the inkless
 * overlay variant, the token-tint match merging and the ungated
 * active-tint cadence are gone (their markers absent from components.js,
 * the seam files absent from the source tree, the token/inkless CSS
 * absent from the entry's STYLES) — and the plain-text ZERO-REGRESSION
 * contract: the match layer's word/selection/both classes and its
 * recompute pipeline, the whitespace glyph layer, the active-line
 * highlight, the ruler, the wrap class and the line numbers all stay,
 * with the native `::selection` path untouched.
 *
 * The match-highlight feature's layer task pins the same seam set for the
 * match underlay: the prop read, the render order (highlight → match →
 * whitespace), the overlay/bg-carry wiring, the syncMatches guard chain
 * mirrored from syncWhitespace, recomputeMatches' live-textarea source +
 * signature dedupe + throw containment, the two schedules (rAF + timer
 * backstop), the mount effect (the settings-toggle conduit), and the
 * settings-key assembly at the mode mount.
 *
 * The Task 10 surface swap pins the mode factory wiring:
 * `CodeHighlightMode` is built by `createCodeMirrorMode`
 * (src/cm6/component.js) with the exact five runtime deps; the retired
 * DOM-seam shell (mode-code-highlight.js and the token-layer import that
 * fed it) is gone for good — Task 11 deleted the seam files themselves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS_TEXT = readFileSync(path.join(HERE, 'components.js'), 'utf8');
const ENTRY_TEXT = readFileSync(path.join(HERE, 'client-entry.js'), 'utf8');

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

/* ---------------------------- code-highlight seam retirement (Task 11) -- */

// Task 11: PlainTextMode is the plain-text reference implementation again.
// The code-highlight-only backdrop seams — the extraBackdropLayers prop
// machinery, the inkless overlay branch, the token-tint match merging and
// the ungated active-tint cadence — must STAY retired: their markers may
// never re-enter components.js, not even inside a comment (a prose mention
// would drift the docs back toward the retired composition).

test('components.js carries no code-highlight-only backdrop seam markers', () => {
	for (const marker of [
		'extraBackdropLayers',
		'NO_EXTRA_LAYERS',
		'extraLayers',
		'syncExtraLayers',
		'extraLayerElementsRef',
		'droppedExtraLayersRef',
		'matchLayerMounted',
		'NO_MATCH_LAYER_ARRAYS',
		'matchTints',
		'area-inkless'
	]) {
		assert.equal(COMPONENTS_TEXT.includes(marker), false, `the retired seam marker "${marker}" is absent from src/components.js`);
	}
});

test('the retired seam files are gone from the source tree', () => {
	for (const retired of [
		'token-rows.js',
		'token-rows.test.js',
		path.join('highlight', 'token-layer.js'),
		path.join('highlight', 'token-layer.test.js')
	]) {
		assert.equal(
			existsSync(path.join(HERE, retired)),
			false,
			`src/${retired} is deleted (the token DOM layer left the module graph with the seam)`
		);
	}
});

test('the entry STYLES carry no token, inkless or active-tint rules', () => {
	for (const marker of ['.dsh-editor-tokens', '.dsh-editor-token-row', '.dsh-editor-area-inkless', '.dsh-editor-match-active']) {
		assert.equal(ENTRY_TEXT.includes(marker), false, `the retired CSS rule block ${marker} is absent from src/client-entry.js`);
	}
	assert.equal(
		(ENTRY_TEXT.match(/::selection/g) || []).length,
		0,
		'no ::selection rule remains — plain-text keeps its native selection (the zero-regression contract)'
	);
	assert.equal(
		(ENTRY_TEXT.match(/caret-color/g) || []).length,
		0,
		'no caret-color pinning remains (it existed only for the inkless transparent text)'
	);
});

test('the plain-text match layer survives the retirement verbatim', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncMatches = React.useCallback(');
	for (const cls of ['${CLASS}-match-row', '${CLASS}-match-word', '${CLASS}-match-selection', '${CLASS}-match-both']) {
		assert.ok(span.includes(cls), `syncMatches still paints the ${cls} run class`);
	}
	assert.ok(span.includes('buildMatchRowFragments('), 'rows still build through the pure fragment builder');
	assert.ok(span.includes('layerArraysForWindow('), 'the windowed over-cap scan still feeds the paint');
	const recomputeSpan = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	assert.ok(recomputeSpan.includes('computeMatchHighlights('), 'the recompute pipeline still scans through the pure orchestrator');
	assert.ok(
		COMPONENTS_TEXT.includes('matchSignatureRef.current = null;\n\t\tif (!matchAny) return;'),
		'the mount effect still drops the dedupe signature before its guard'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('if (!matchAny) return;\n\t\trecomputeMatches();'),
		'the match layer mount effect still runs the first recompute'
	);
});

test('the plain-text paint surfaces survive the retirement untouched', () => {
	// Active line: the highlight bar and its painting path.
	assert.ok(COMPONENTS_TEXT.includes('className: `${CLASS}-highlight-bar`'), 'the active-line bar still renders');
	assert.ok(COMPONENTS_TEXT.includes('const paintCaretLine = React.useCallback('), 'the caret-line painting path survives');
	// Whitespace glyph layer.
	assert.ok(COMPONENTS_TEXT.includes('className: `${CLASS}-whitespace`'), 'the whitespace glyph layer still renders');
	assert.ok(COMPONENTS_TEXT.includes('const syncWhitespace = React.useCallback('), 'syncWhitespace survives');
	// Ruler layer.
	assert.ok(COMPONENTS_TEXT.includes('className: `${CLASS}-ruler`'), 'the ruler layer still renders');
	// Wrap: the class composition plus its CSS twin in the entry STYLES.
	const span = plainTextModeSpan();
	assert.ok(
		span.includes("const baseClassName = wrapEnabled ? `${areaClassName} ${CLASS}-area-wrap` : areaClassName;"),
		'the wrap class still composes over the overlay base class'
	);
	assert.ok(ENTRY_TEXT.includes('.dsh-editor-area-wrap {'), 'the wrap class still has its CSS twin');
	// The textarea carries the base class list alone — no inkless twin.
	assert.ok(span.includes('className: baseClassName,'), 'the textarea carries the base class list (no inkless variant)');
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

test('components.js imports the windowed-scan primitives from the pure module', () => {
	// 0.18.0 窗口扫描修订：超限层的逐行扫描与选区排除必须走纯模块，
	// 不得内联匹配数学（spec §3.1 模块边界）。Task 11 退役 token-tint/
	// active-tint 构建后，mergeLayerRanges 与 intersectRangeWithLine 不再
	// 被 components.js 消费（纯模块自身套件继续钉它们）——导入表回到
	// 纯文本的四原语 + 片段构建器。
	assert.ok(
		COMPONENTS_TEXT.includes(
			"import { buildMatchRowFragments, computeMatchHighlights, findLineMatches, lineStartOffsets, subtractRanges } from './match-highlight.js';"
		),
		'the windowed scan consumes findLineMatches and subtractRanges, the paint consumes buildMatchRowFragments — all from the pure module'
	);
	assert.equal(COMPONENTS_TEXT.includes('mergeLayerRanges'), false, 'the retired tint merger import is gone');
	assert.equal(COMPONENTS_TEXT.includes('intersectRangeWithLine'), false, 'the retired active-source intersector import is gone');
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
	// glyphs — all beneath the overlay textarea. Task 11 retired the
	// code-highlight two-shape mount condition: the standalone match div is
	// the ONE shape again, mounted exactly while matchAny (the CM6 surface
	// paints its match washes as decorations instead).
	const highlightAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-highlight`');
	const matchAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-match`');
	const whitespaceAt = COMPONENTS_TEXT.indexOf('className: `${CLASS}-whitespace`');
	assert.ok(highlightAt !== -1, 'the highlight backdrop render was found');
	assert.ok(matchAt !== -1, 'the match layer render was found');
	assert.ok(whitespaceAt !== -1, 'the whitespace layer render was found');
	assert.ok(highlightAt < matchAt, 'the match layer renders after the highlight backdrop');
	assert.ok(matchAt < whitespaceAt, 'the match layer renders before the whitespace conditional');
	assert.ok(
		COMPONENTS_TEXT.includes('matchAny\n\t\t\t? h(\'div\', {'),
		'the match layer mounts on bare matchAny again (the single plain-text shape)'
	);
});

test('the overlay treatment accounts for the match layer', () => {
	assert.ok(
		COMPONENTS_TEXT.includes(
			'const overlayNeeded = highlightEnabled || wsAny || rulerEnabled || matchAny;'
		),
		'overlayNeeded includes matchAny (the match underlay counts as a paint surface; no extra-layer term remains)'
	);
});

test('the bg-carry rule extends to the match layer', () => {
	// Each underlay is transparent whenever an EARLIER underlay already
	// carries the base background; the match layer sits directly above the
	// highlight backdrop, so it carries the bg when highlighting is off,
	// and the whitespace/ruler layers defer to it in turn. Task 11: with
	// the code-highlight shape gone, bare matchAny IS the match div's
	// ACTUAL mount condition, so the later underlays key on it directly.
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
	assert.ok(
		span.includes('layerArraysForWindow('),
		'the layer match arrays come from the shared layerArraysForWindow computation (lineStartOffsets inside it)'
	);
	assert.ok(span.includes('buildMatchRowFragments('), 'rows build through the pure fragment builder');
	assert.ok(span.includes("layer.textContent = ''"), 'the layer clears fully before the windowed rebuild');
	assert.ok(span.includes('translateX('), 'the layer translates against scrollLeft (wrap-off) and resets (wrap)');
	assert.ok(span.includes('${CLASS}-match-row'), 'each visual row is a -match-row span');
	assert.ok(span.includes('${CLASS}-match-word'), 'a word-only run carries the -match-word class');
	assert.ok(span.includes('${CLASS}-match-selection'), 'a selection-only run carries the -match-selection class');
	assert.ok(span.includes('${CLASS}-match-both'), 'a both-layers run carries the single merged -match-both class');
});

test('the windowed layer-array computation branches over-cap layers into a per-visible-line scan', () => {
	// 0.18.0 窗口扫描修订（用户验收反馈）：超限层不再整层跳过——旗标为
	// 真且查询在手时，该层的匹配数组改由逐可视逻辑行的 findLineMatches
	// 扫描供给（wrap 分支按源行号去重、wrap-off 分支逐行），滚动经既有
	// paint-only join 重扫窗口；under-cap 层仍读物化数组（同一引用，片
	// 段逐字节一致）。Task 11 之后该计算只剩 syncMatches 一个消费者
	// （token-tint 构建随缝退役），旗标分支、查询读取与选区排除契约
	// 钉为源标记。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const layerArraysForWindow = React.useCallback(');
	assert.ok(span.includes('findLineMatches('), 'an over-cap layer scans its visible logical lines through the pure per-line scanner');
	assert.ok(span.includes('lineStartOffsets('), 'document offsets translate through one lineStartOffsets pass');
	assert.ok(span.includes('wordOverCap'), 'the word layer branches on its over-cap flag');
	assert.ok(span.includes('selectionOverCap'), 'the selection layer branches on its over-cap flag');
	assert.ok(
		span.includes('matches.wordOverCap === true && queries.word !== null'),
		'the word windowed branch needs BOTH the flag and the stored query'
	);
	assert.ok(
		span.includes('matches.selectionOverCap === true && queries.selection !== null'),
		'the selection windowed branch needs BOTH the flag and the stored query'
	);
	assert.ok(span.includes('matchQueryRef'), 'the windowed scan reads the stored query objects (one derivation, never a second)');
	assert.ok(
		span.includes('subtractRanges('),
		'the windowed selection scan keeps the layer\'s selection-exclusion contract (spec §4: a hit intersecting the selection never paints)'
	);
});

test('recomputeMatches feeds the paint refs without reading the match layer element', () => {
	// 供数链路不依赖 match 层挂载：recompute 只守卫 area（不读
	// matchLayerRef），计算半部在内部自守卫 matchAny，挂载效果直接调
	// recomputeMatches（不经 syncMatches），ref 写入保持原样——设置
	// 开关切换后的重算仍能把新数组落地进 refs。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	assert.ok(!span.includes('matchLayerRef'), 'the recompute never reads the match layer ref');
	assert.ok(span.includes('matchesRef.current = highlights;'), 'the arrays land in matchesRef (the paint\'s source)');
	assert.ok(span.includes('matchQueryRef.current = highlights.queries;'), 'the queries land in matchQueryRef (the windowed scan\'s source)');
	assert.ok(
		COMPONENTS_TEXT.includes('if (!matchAny) return;\n\t\trecomputeMatches();'),
		'the mount effect calls recomputeMatches directly (not via syncMatches)'
	);
});

test('recomputeMatches ends with the match-layer repaint join', () => {
	// 重算的收尾是 match 层重绘：syncMatches();（Task 11 退役了随后的
	// extra-layer tint 重绘，plain-text 单形态下 match 层立即重绘保持
	// 不变）。join 是收尾语句：其后不得再有别的语句。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	const join = 'syncMatches();';
	const joinAt = span.indexOf(join);
	assert.ok(joinAt !== -1, 'every real recompute ends in the match repaint: syncMatches();');
	assert.equal(span.slice(joinAt + join.length).trim(), '', 'the match repaint is the recompute\'s last statement (nothing else follows)');
});

test('recomputeMatches reads the live textarea, dedupes on the signature, and contains throws', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	// The area-only guard: the compute half guards on matchAny inside, and
	// the repaint callee self-guards the same way — a match-off frame costs
	// one dead branch.
	assert.ok(span.includes('if (area === null) return;'), 'the recompute self-guards on the area; the compute half guards on matchAny inside');
	assert.ok(span.includes('area.selectionStart'), 'the selection start comes from the live textarea');
	assert.ok(span.includes('area.selectionEnd'), 'the selection end comes from the live textarea');
	assert.ok(span.includes('matchSignatureRef'), 'the signature dedupe keys on the last { value, start, end }');
	assert.ok(span.includes('computeMatchHighlights('), 'the match math comes from the pure orchestrator');
	assert.ok(span.includes('selectionEnabled: matchSelectionOn'), 'the selection switch rides into the orchestrator');
	assert.ok(span.includes('wordEnabled: matchWordOn'), 'the word switch rides into the orchestrator');
	assert.ok(span.includes('} catch (error) {'), 'the orchestrator call is wrapped in a catch');
	assert.ok(span.includes('match-highlight'), 'a throw logs through the match-highlight scope');
	assert.ok(span.includes("typeof log.warn === 'function'"), 'the log call is shape-guarded (a malformed channel stays silent)');
	assert.ok(span.includes('syncMatches();'), 'every real recompute repaints the match layer');
});

test('recomputeMatches stores the orchestrator result whole: arrays, over-cap flags, queries', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	assert.ok(span.includes('matchQueryRef'), 'the derived queries are stored for the paint-side windowed scan');
	assert.ok(
		span.includes('highlights.queries'),
		'the stored queries come from the orchestrator return — the same source the arrays were scanned with'
	);
	assert.ok(span.includes('wordOverCap: false'), 'the throw containment clears the over-cap flags');
	assert.ok(
		span.includes('matchQueryRef.current = { word: null, selection: null }'),
		'the throw containment clears the stored queries'
	);
});

test('the match refs carry the over-cap flags and the query slots from the start', () => {
	assert.ok(
		COMPONENTS_TEXT.includes('React.useRef({ word: [], selection: [], wordOverCap: false, selectionOverCap: false })'),
		'matchesRef starts with both over-cap flags false (an under-cap editor paints straight from the arrays)'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('React.useRef({ word: null, selection: null })'),
		'matchQueryRef starts with no queries (a null query never feeds the windowed scan)'
	);
});

test('scheduleMatchRecompute coalesces recomputes onto one animation frame', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const scheduleMatchRecompute = React.useCallback(');
	assert.ok(span.includes('matchFrameRef'), 'the frame handle lives in matchFrameRef');
	assert.ok(span.includes('cancelAnimationFrame('), 'a pending frame is cancelled before a new one is requested');
	assert.ok(span.includes('requestAnimationFrame('), 'the recompute rides the next animation frame');
	assert.ok(span.includes('recomputeMatches();'), 'the frame callback ends in the recompute');
	// Final-review #4 + Task 11: the match-off editor is the only one that
	// short-circuits BEFORE any rAF work — the ungated admission (extra
	// layers mounted, the active tint's cadence) retired with the seam.
	assert.ok(
		span.includes('if (!matchAny) return;\n\t\tif (matchFrameRef.current !== null)'),
		'only the match-off editor short-circuits before any frame is scheduled'
	);
	const start = COMPONENTS_TEXT.indexOf('const scheduleMatchRecompute = React.useCallback(');
	const depsAt = COMPONENTS_TEXT.indexOf('\n\t}, [', start);
	assert.ok(
		COMPONENTS_TEXT.slice(depsAt, depsAt + 100).includes('[matchAny, recomputeMatches]'),
		'the guard\'s prop key rides the callback deps'
	);
});

test('scheduleMatchRecomputeBackstop arms the 300ms timer backstop', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const scheduleMatchRecomputeBackstop = React.useCallback(');
	assert.ok(span.includes('matchTimerRef'), 'the timer handle lives in matchTimerRef');
	assert.ok(span.includes('clearTimeout('), 'a pending timer is cleared before a new one is armed');
	assert.ok(span.includes('setTimeout('), 'the backstop rides a timer');
	assert.ok(span.includes('300'), 'the backstop window is 300ms');
	assert.ok(span.includes('recomputeMatches();'), 'the timer callback ends in the recompute');
	// Final-review #4: the all-off editor short-circuits BEFORE any timer work.
	assert.ok(
		span.includes('if (!matchAny) return;\n\t\tif (matchTimerRef.current !== null)'),
		'the all-off editor short-circuits before any timer is armed'
	);
	const start = COMPONENTS_TEXT.indexOf('const scheduleMatchRecomputeBackstop = React.useCallback(');
	const depsAt = COMPONENTS_TEXT.indexOf('\n\t}, [', start);
	assert.ok(
		COMPONENTS_TEXT.slice(depsAt, depsAt + 80).includes('[matchAny, recomputeMatches]'),
		'the guard\'s prop key rides the callback deps'
	);
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

/* ------------------------------------ match trigger wiring (Task 7) -- */

// Task 7: every trigger point joins its Task-6 callback. The split is
// load-bearing: value/selection paths recompute (rAF-coalesced, or the
// 300ms timer backstop for pure draft writes that fire no selection
// event), while geometry-only paths (scroll, wrap flip, observer
// retries) call syncMatches DIRECTLY — recomputeMatches' signature
// dedupe would early-return before the repaint and leave the layer
// stale. The wiring is pinned as source markers, the same discipline
// as the joins above.

test('reportSelection schedules the rAF recompute as its first statement', () => {
	// 体首行 per the brief: the schedule leads the body so the DOM-event
	// paths (select/click/keyup) and the machine navigation mirror all
	// funnel through the coalesced recompute.
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const reportSelection = React.useCallback');
	const scheduleAt = span.indexOf('scheduleMatchRecompute();');
	const areaAt = span.indexOf('const area = areaRef.current;');
	assert.ok(scheduleAt !== -1, 'reportSelection schedules the match recompute');
	assert.ok(areaAt !== -1 && scheduleAt < areaAt, 'the schedule is the body\'s first line, before the area read');
	assert.ok(
		COMPONENTS_TEXT.includes('}, [controller, paintCaretLine, scheduleMatchRecompute]);'),
		'the callback re-makes when the recompute identity moves (a settings toggle must not leave a stale-switch closure)'
	);
});

test('the selectionchange caret follower schedules the recompute after the caret paint', () => {
	// A collapsed caret move fires selectionchange (never `select`), and the
	// follower must recompute matches in the same guarded handler. The gate
	// admits a match-only editor (active line off, word layer on): the word
	// layer needs the recompute on every keyboard caret move too, while
	// paintCaretLine self-guards on the unmounted bar ref.
	const handlerAt = COMPONENTS_TEXT.indexOf('const onSelectionChange = () => {');
	const listenerAt = COMPONENTS_TEXT.indexOf("document.addEventListener('selectionchange'");
	assert.ok(handlerAt !== -1 && listenerAt !== -1 && handlerAt < listenerAt, 'the selectionchange handler was found');
	const handler = COMPONENTS_TEXT.slice(handlerAt, listenerAt);
	const paintAt = handler.indexOf('paintCaretLine();');
	const scheduleAt = handler.indexOf('scheduleMatchRecompute();');
	assert.ok(paintAt !== -1, 'the handler paints the caret line');
	assert.ok(scheduleAt !== -1, 'the handler schedules the match recompute');
	assert.ok(paintAt < scheduleAt, 'the schedule joins after paintCaretLine, inside the focused-area guard');
	assert.ok(
		COMPONENTS_TEXT.includes(
			"if ((!highlightEnabled && !matchAny) || typeof document === 'undefined') return undefined;"
		),
		'the gate admits a match-only editor (highlighting off, word layer on) — the extra-layer admission retired with the active tint'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('}, [highlightEnabled, matchAny, paintCaretLine, scheduleMatchRecompute]);'),
		'the listener re-subscribes when the recompute identity or the props move'
	);
});

test('the syncRef composite repaints the match layer after the whitespace repaint', () => {
	// The observer composite is the passive repaint path (hidden-subtree
	// retries, initial notification): paint-only, never a re-scan.
	const start = COMPONENTS_TEXT.indexOf('syncRef.current = () => {');
	assert.ok(start !== -1, 'the syncRef composite was found');
	const end = COMPONENTS_TEXT.indexOf('};', start);
	const composite = COMPONENTS_TEXT.slice(start, end);
	assert.ok(
		/syncWhitespace\(\);\s*syncMatches\(\);\s*syncRuler\(\);/.test(composite),
		'the composite joins the match repaint after the whitespace repaint, before the ruler'
	);
	assert.ok(
		COMPONENTS_TEXT.includes(
			'}, [paintCaretLine, syncGutter, syncWrapGutter, syncWhitespace, syncMatches, syncRuler]);'
		),
		'the composite re-arms when the sync identity moves'
	);
});

test('the textarea onScroll handler repaints the match layer (never recomputes)', () => {
	const onScrollMatch = /onScroll: \(\) => \{[\s\S]*?\n\t\t\t\}/.exec(COMPONENTS_TEXT);
	assert.ok(onScrollMatch !== null, 'the textarea onScroll handler was found');
	assert.ok(
		/syncWhitespace\(\);\s*syncMatches\(\);/.test(onScrollMatch[0]),
		'the scroll handler joins the match repaint right after the whitespace repaint'
	);
	assert.ok(
		!onScrollMatch[0].includes('scheduleMatchRecompute'),
		'scrolling changes neither value nor selection: the paint-only join, no re-scan'
	);
});

test('the wrapViewportRef layout callback repaints the match layer', () => {
	// Wrap flips and resizes change geometry only: paint from matchesRef,
	// never a re-scan (the signature dedupe would skip the stale band).
	const start = COMPONENTS_TEXT.indexOf('wrapViewportRef.current = () => {');
	assert.ok(start !== -1, 'the wrap viewport callback was found');
	const end = COMPONENTS_TEXT.indexOf('};', start);
	const callback = COMPONENTS_TEXT.slice(start, end);
	assert.ok(
		/syncWhitespace\(\);\s*syncMatches\(\);/.test(callback),
		'the wrap-flip/resize callback joins the match repaint after the whitespace repaint'
	);
	assert.ok(
		COMPONENTS_TEXT.includes(
			'}, [syncWrapViewport, repaintBar, wrapEnabled, syncWhitespace, syncMatches]);'
		),
		'the layout callback re-arms when the sync identity moves'
	);
});

test('the wrapPaintRef counts-correction composite repaints the match layer', () => {
	// onCountsChange lands async measurement chunks that replace estimated
	// row counts — no DOM event follows them, so every row-positioned layer
	// must repaint in the composite itself. The match rows position from
	// the controller's visual-row map too: without this join the ink stays
	// at estimate positions until the next scroll/caret/draft trigger.
	const start = COMPONENTS_TEXT.indexOf('wrapPaintRef.current = () => {');
	assert.ok(start !== -1, 'the wrap paint composite was found');
	const end = COMPONENTS_TEXT.indexOf('};', start);
	const composite = COMPONENTS_TEXT.slice(start, end);
	assert.ok(
		/syncWhitespace\(\);\s*syncMatches\(\);/.test(composite),
		'the counts-correction composite joins the match repaint after the whitespace repaint'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('}, [syncWrapGutter, repaintBar, syncWhitespace, syncMatches]);'),
		'the composite re-arms when the sync identity moves'
	);
});

test('the draft effect arms the 300ms backstop in both branches', () => {
	// Pure content writes carry no selection event: the backstop guarantees
	// the layers are at most one backstop window behind the edit.
	const start = COMPONENTS_TEXT.indexOf('wrapDraftRef.current = state.draft;');
	assert.ok(start !== -1, 'the draft layout effect was found');
	const end = COMPONENTS_TEXT.indexOf('}, [state.draft, wrapEnabled,', start);
	assert.ok(end !== -1, 'the draft effect was delimited');
	const effect = COMPONENTS_TEXT.slice(start, end);
	const backstops = effect.match(/scheduleMatchRecomputeBackstop\(\);/g) || [];
	assert.equal(backstops.length, 2, 'both the wrap-off early return and the main branch arm the backstop');
	const wrapOffAt = effect.indexOf('if (!wrapEnabled) {');
	const returnAt = effect.indexOf('return;', wrapOffAt);
	assert.ok(wrapOffAt !== -1 && returnAt !== -1, 'the wrap-off early return was found');
	assert.ok(
		effect.slice(wrapOffAt, returnAt).includes('scheduleMatchRecomputeBackstop();'),
		'the wrap-off branch arms the backstop before its return'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('syncWhitespace, scheduleMatchRecomputeBackstop]);'),
		'the draft effect re-arms when the backstop identity moves'
	);
});

test('the ResizeObserver gate admits a match-only editor and re-arms on matchAny', () => {
	assert.ok(
		COMPONENTS_TEXT.includes(
			'if (!highlightEnabled && !gutterEnabled && !wrapEnabled && !wsAny && !matchAny) return undefined;'
		),
		'the observer gate admits a match-only editor (hidden-mount retries reach the layer)'
	);
	const gateAt = COMPONENTS_TEXT.indexOf('!wsAny && !matchAny) return undefined;');
	const depsAt = COMPONENTS_TEXT.indexOf(
		'}, [highlightEnabled, gutterEnabled, wrapEnabled, wsAny, matchAny]);',
		gateAt
	);
	assert.ok(depsAt !== -1, 'the observer effect re-arms when matchAny flips');
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

/* --------------------------- cm6 content-surface swap (Task 10) -- */

/**
 * The code-highlight mode's factory wiring (Task 10): the descriptor
 * registration keeps pointing at `editorComponents.CodeHighlightMode`
 * (pinned field-for-field in client-entry.test.js), but the component it
 * names is now the CM6 mode — `createCodeMirrorMode` (src/cm6/component.js)
 * built with the exact five deps the entry's runtime owns. The retired
 * DOM-seam shell (`mode-code-highlight.js` + the token-layer import that
 * fed it) is gone from this module, and Task 11 deleted the seam files
 * themselves (pinned by the retirement guards above).
 */
test('createEditorComponents builds CodeHighlightMode from the CM6 component with the exact five deps', () => {
	assert.ok(
		COMPONENTS_TEXT.includes("import { createCodeMirrorMode } from './cm6/component.js'"),
		'components.js imports the CM6 mode factory from src/cm6/component.js'
	);
	const start = COMPONENTS_TEXT.indexOf('CodeHighlightMode: createCodeMirrorMode(');
	assert.ok(start !== -1, 'the factory call marker is present');
	const end = COMPONENTS_TEXT.indexOf('\n\t\t})', start);
	assert.ok(end !== -1, 'the factory call is delimited');
	const span = COMPONENTS_TEXT.slice(start, end);
	assert.ok(span.includes('cm6Loader: runtime.cm6Loader'), 'the cm6 chunk loader rides the runtime (the entry owns the transport)');
	assert.ok(span.includes('engine: runtime.highlightEngine'), 'the highlight engine singleton rides the runtime');
	assert.ok(span.includes('PlainTextMode'), 'PlainTextMode is passed (the degradation surface)');
	assert.ok(span.includes('subscribeProgress: runtime.onHighlightProgress'), 'the engine progress subscription rides the runtime');
	assert.ok(span.includes('log'), 'the log channel is passed');
	// The retired DOM-seam wiring is gone from this module.
	assert.equal(COMPONENTS_TEXT.includes('createCodeHighlightMode'), false, 'the retired shell factory is no longer called');
	assert.equal(COMPONENTS_TEXT.includes("from './highlight/token-layer.js'"), false, 'the token-layer import is gone (retired with Task 11)');
	assert.equal(COMPONENTS_TEXT.includes('createTokenLayerDescriptor'), false, 'the token-layer builder is no longer referenced');
});
