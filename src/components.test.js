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
 *
 * The Task 10 surface swap pins the mode factory wiring:
 * `CodeHighlightMode` is built by `createCodeMirrorMode`
 * (src/cm6/component.js) with the exact five runtime deps, and the
 * retired DOM-seam shell (mode-code-highlight.js and the token-layer
 * import that fed it) is absent from this module.
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

test('components.js imports the windowed-scan primitives from the pure module', () => {
	// 0.18.0 窗口扫描修订：超限层的逐行扫描与选区排除必须走纯模块，
	// 不得内联匹配数学（spec §3.1 模块边界）。token-tint 修订追加
	// mergeLayerRanges：matchTints 的区间合并同样必须走纯模块。
	// 2026-11-26 active-tint 修订追加 intersectRangeWithLine：当前选区
	// 按可视逻辑行的裁剪同为纯模块原语。
	assert.ok(
		COMPONENTS_TEXT.includes(
			"import { buildMatchRowFragments, computeMatchHighlights, findLineMatches, intersectRangeWithLine, lineStartOffsets, mergeLayerRanges, subtractRanges } from './match-highlight.js';"
		),
		'the windowed scan consumes findLineMatches and subtractRanges; the token-tint build consumes mergeLayerRanges; the active source consumes intersectRangeWithLine — all from the pure module'
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
	// 0.18.0 token-tint 修订：挂载条件改为两形态——matchAny 且无 extra
	// backdrop layers（round-1 提取为 matchLayerMounted 局部常量）。code-
	// highlight 形态（extraLayers 挂载）不再挂独立 match 层（tint 改随
	// token 片段流绘制），仅 plain-text 形态挂载。
	assert.ok(
		COMPONENTS_TEXT.includes('matchLayerMounted\n\t\t\t? h(\'div\', {'),
		'the match layer mounts only in the plain-text shape: matchAny AND no extra backdrop layers (the matchLayerMounted const)'
	);
});

test('the overlay treatment accounts for the match layer', () => {
	assert.ok(
		COMPONENTS_TEXT.includes(
			'const overlayNeeded = highlightEnabled || wsAny || rulerEnabled || extraLayers.length > 0 || matchAny;'
		),
		'overlayNeeded includes matchAny (the match underlay counts as a paint surface)'
	);
});

test('the bg-carry rule extends to the match layer (keyed on its ACTUAL mount)', () => {
	// Each underlay is transparent whenever an EARLIER underlay already
	// carries the base background; the match layer sits directly above the
	// highlight backdrop, so it carries the bg when highlighting is off,
	// and the whitespace/ruler layers defer to it in turn. Round-1 fix
	// (0.18.0 token-tint 修订): the later underlays key on the match
	// layer's ACTUAL mount condition (matchLayerMounted — the two-shape
	// form), not bare matchAny — in the code-highlight shape the match div
	// never mounts, so deferring to it would leave NO underlay carrying
	// the base background (active-line off + whitespace off + ruler on:
	// the ruler must carry it).
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
		whitespaceSpan.includes("highlightEnabled || matchLayerMounted ? 'transparent' : 'var(--dsw-alias-bg-base)'"),
		'the whitespace layer goes transparent when the (mounted) match layer carries the base bg'
	);
	const rulerSpan = COMPONENTS_TEXT.slice(rulerAt, rulerAt + 400);
	assert.ok(
		rulerSpan.includes("highlightEnabled || wsAny || matchLayerMounted ? 'transparent' : 'var(--dsw-alias-bg-base)'"),
		'the ruler layer goes transparent when the (mounted) match layer carries the base bg'
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
	// 段逐字节一致）。token-tint 修订把该计算从 syncMatches 提取为
	// layerArraysForWindow 局部函数（供 syncMatches 与 syncExtraLayers 的
	// matchTints 构建共用），行为不变——旗标分支、查询读取与选区排除
	// 契约钉为源标记。
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

test('syncExtraLayers attaches matchTints: the per-line merged tint intervals for the visible window', () => {
	// 0.18.0 token-tint 修订：code-highlight 形态下 match 底色改随 token
	// 片段流绘制——syncExtraLayers 构造的 context 携带 matchTints
	// （Map<lineIndex, 行相对带标签区间>），数据来自 matchesRef/
	// matchQueryRef 经 layerArraysForWindow（与 syncMatches 共用）+
	// mergeLayerRanges（行相对平移）。钉为源标记。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncExtraLayers = React.useCallback(');
	assert.ok(span.includes('layerArraysForWindow('), 'the tint build consumes the SAME layer-array computation syncMatches paints from');
	assert.ok(span.includes('mergeLayerRanges('), 'the per-line tint intervals come from the pure range merger');
	assert.ok(span.includes('lineStarts[lineIndex]'), 'the merged document ranges translate to line-relative through the line starts');
	assert.ok(span.includes('matchTints'), 'the context carries the per-line tint Map');
	assert.ok(span.includes('matchAny'), 'the build is gated on the match switches (match-off editors skip it entirely)');
	assert.ok(
		span.includes('wordOverCap') && span.includes('selectionOverCap'),
		'the build also runs while a layer is over-cap (its tints come from the windowed scan)'
	);
	assert.ok(
		span.includes('if (matchTints !== null) context.matchTints = matchTints;'),
		'matchTints attaches only when built — it stays ABSENT otherwise (the token paint takes the old path)'
	);
	const start = COMPONENTS_TEXT.indexOf('const syncExtraLayers = React.useCallback(');
	const depsAt = COMPONENTS_TEXT.indexOf('\n\t}, [', start);
	assert.ok(
		COMPONENTS_TEXT.slice(depsAt, depsAt + 120).includes('matchAny'),
		'the callback re-makes when matchAny flips (a stale closure would freeze the tints on a settings toggle)'
	);
});

test('syncExtraLayers merges the live selection as the active tint source (the third mergeLayerRanges source)', () => {
	// 2026-11-26 active-tint 修订：inkless 形态抑制原生选区背景后，当前
	// 选区的可见视觉是 -match-active tint——per-line tint 构建扩第三源：
	// live 选区经 intersectRangeWithLine 按可视逻辑行裁剪，经
	// mergeLayerRanges 三参形态并入（标签优先级 active 最高）。构建对
	// 非折叠选区独立于匹配层数据开门（跨行选区丢弃两个查询、匹配数组
	// 为空时活动 tint 仍须绘制）；选区层 subtractRanges 排除照旧
	// （-match-selection 只画其它匹配，当前选区由 -match-active 呈现）。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncExtraLayers = React.useCallback(');
	assert.ok(
		span.includes('intersectRangeWithLine(area.selectionStart, area.selectionEnd, lineStarts[lineIndex], lines[lineIndex])'),
		'the live selection is clipped per visible logical line through the pure intersector'
	);
	assert.ok(
		span.includes('mergeLayerRanges(arrays.word, arrays.selection, activeRange === null ? undefined : [activeRange])'),
		'the merger call passes the clipped active range as the third source (label precedence active > both > selection > word)'
	);
	assert.ok(
		span.includes('hasActiveSelection'),
		'the build runs for a non-collapsed selection alone — the match arrays may be empty (a cross-line selection drops both queries) while the active tint must still paint'
	);
	const arraysSpan = useCallbackSpan(COMPONENTS_TEXT, 'const layerArraysForWindow = React.useCallback(');
	assert.ok(
		arraysSpan.includes('subtractRanges('),
		'the selection layer still excludes the live selection via subtractRanges (the active tint covers the selection itself; -match-selection paints other matches only)'
	);
});

test('the active tint source builds ungated by the match switches (a match-off inkless editor keeps its selection visual)', () => {
	// Review round 1（active-tint 修订裁定）：inkless 形态的 ::selection 抑制
	// 是无条件的，所以 -match-active tint 是原生选区的【替代】——基线编辑
	// 器 affordance，不属于可选的 match-highlight 功能。两个匹配开关全关
	// （matchAny=false）时 tint 构建仍须对非折叠选区开门：匹配层在那里
	// 贡献【零】（保持 matchAny 门控——包括会话中途关开关后留在
	// matchesRef 里的陈旧数组），mergeLayerRanges 对空匹配层照常给出
	// active-only 覆盖（纯模块已钉：
	// 'mergeLayerRanges emits active-only coverage when no match layer has
	// content'）。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const syncExtraLayers = React.useCallback(');
	assert.ok(
		span.includes('hasLayerContent || hasActiveSelection'),
		'the tint build opens for the active source ALONE — the gate is match-layer content OR a non-collapsed live selection, never the match switches'
	);
	const verdictAt = span.indexOf('const hasLayerContent =');
	assert.ok(verdictAt !== -1, 'the match-layer content verdict is its own named local, so the gate cannot silently re-widen to matchAny');
	assert.ok(
		span.slice(verdictAt, verdictAt + 200).includes('matchAny'),
		'the match-layer content verdict stays matchAny-gated (stale arrays from before a settings flip must not paint)'
	);
	assert.ok(
		span.includes('matchAny ? arraysByLine(lineIndex) : NO_MATCH_LAYER_ARRAYS'),
		'a match-off build feeds the merger NO match layers — the active range is the only source'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('const NO_MATCH_LAYER_ARRAYS = Object.freeze({ word: [], selection: [] });'),
		'the match-off layer pair is one frozen module constant (the NO_EXTRA_LAYERS discipline)'
	);
});

test('a match-off code-highlight editor still repaints the active tint on selection moves (the ungated cadence)', () => {
	// Review round 1 的另一半：只解构建的门，纯选区手势（拖选、
	// shift+方向键）在 match-off inkless 编辑器里依旧不会重绘——重绘节
	// 奏原本也是 matchAny 门控的（scheduleMatchRecompute 的守卫、
	// recomputeMatches 的守卫、selectionchange 效应的挂载门），活动 tint
	// 会死在它要拯救的屏幕上。所有选区路径（selectionchange、经
	// reportSelection 的 onSelect/onClick/onKeyUp）都汇入
	// scheduleMatchRecompute 一个合流点：守卫改为放行「关匹配但挂了
	// extra layers」的编辑器（帧的重绘半部承载活动 tint；计算半部在
	// recomputeMatches 内部自守卫 matchAny）。
	const scheduleSpan = useCallbackSpan(COMPONENTS_TEXT, 'const scheduleMatchRecompute = React.useCallback(');
	assert.ok(
		scheduleSpan.includes('if (!matchAny && extraLayers.length === 0) return;'),
		'the schedule guard admits a match-off editor with extra layers mounted — only the all-off editor (no match, no extra layers) short-circuits'
	);
	const recomputeSpan = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	assert.ok(
		recomputeSpan.includes('if (area === null) return;'),
		'the recompute self-guards on the area alone — the repaint join runs with the match switches off'
	);
	const computeGateAt = recomputeSpan.indexOf('if (matchAny) {');
	assert.ok(
		computeGateAt !== -1 && recomputeSpan.indexOf('computeMatchHighlights(') > computeGateAt,
		'the compute half (scan + signature dedupe) keeps its matchAny gating inside — a match-off frame only repaints'
	);
	assert.ok(
		COMPONENTS_TEXT.includes(
			"if ((!highlightEnabled && !matchAny && extraLayers.length === 0) || typeof document === 'undefined') return undefined;"
		),
		'the selectionchange follower mounts for a match-off code-highlight editor (the ungated active tint follows every caret move)'
	);
});

test('the match layer mount condition is two-shape: no standalone div under extra backdrop layers', () => {
	// 0.18.0 token-tint 修订：code-highlight 形态（extraLayers 挂载）的
	// match 底色由 token 层携带，独立 match 层 div 不挂载——syncMatches
	// 对 null ref 天然 no-op；overlayNeeded 不变（token 层已是 underlay）。
	// Round-1 fix：两形态条件提取为 matchLayerMounted 局部常量，挂载门、
	// 空白层与标尺层的底色三元共用同一真值（与实际挂载一致）。
	assert.ok(
		COMPONENTS_TEXT.includes('const matchLayerMounted = matchAny && extraLayers.length === 0;'),
		'the two-shape mount condition is one local const (matchLayerMounted = matchAny && extraLayers.length === 0)'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('matchLayerMounted\n\t\t\t? h(\'div\', {'),
		'the match div render gate is matchLayerMounted (the code-highlight shape mounts NO standalone match layer)'
	);
	assert.ok(
		COMPONENTS_TEXT.includes(
			'const overlayNeeded = highlightEnabled || wsAny || rulerEnabled || extraLayers.length > 0 || matchAny;'
		),
		'overlayNeeded keeps its existing form (unchanged by the revision)'
	);
});

test('recomputeMatches keeps feeding the refs with the match layer unmounted (code-highlight shape)', () => {
	// 0.18.0 token-tint 修订：code-highlight 形态下 match div 不挂载、
	// syncMatches 对 null ref no-op，但 matchTints 构建读物 matchesRef/
	// matchQueryRef——供数链路必须不依赖 match 层挂载：recompute 只守卫
	// area+matchAny（不读 matchLayerRef），挂载效果直接调 recomputeMatches
	// （不经 syncMatches），ref 写入保持原样。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	assert.ok(!span.includes('matchLayerRef'), 'the recompute never reads the match layer ref — it still runs with the div unmounted');
	assert.ok(span.includes('matchesRef.current = highlights;'), 'the arrays land in matchesRef (the tint build\'s source)');
	assert.ok(span.includes('matchQueryRef.current = highlights.queries;'), 'the queries land in matchQueryRef (the windowed scan\'s source)');
	assert.ok(
		COMPONENTS_TEXT.includes('if (!matchAny) return;\n\t\trecomputeMatches();'),
		'the mount effect calls recomputeMatches directly (not via syncMatches), so the supply chain fires regardless of the mount shape'
	);
});

test('recomputeMatches ends with the join pair: the match paint followed by the extra-layer tint repaint', () => {
	// Round-1 fix (0.18.0 token-tint 修订，评审裁定)：recompute 的收尾从
	// 单独 syncMatches() 扩为 join 对——syncMatches(); syncExtraLayers();
	// code-highlight 形态下选区/光标移动（selectionchange → rAF recompute）
	// 后 tints 立即随 token 层重绘（syncMatches 对未挂载的 match div 是
	// no-op，syncExtraLayers 读 refs 构建新 matchTints 并重绘 token 层）；
	// plain-text 形态下 syncExtraLayers 是既有 join 的死分支（一次早退，
	// 文档化的 join 模式），match 层立即重绘保持不变。
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	const join = 'syncMatches();\n\t\tsyncExtraLayers();';
	const joinAt = span.indexOf(join);
	assert.ok(joinAt !== -1, 'every real recompute ends in the joined repaint: syncMatches(); then syncExtraLayers();');
	assert.equal(span.slice(joinAt + join.length).trim(), '', 'the join pair is the recompute\'s last statement (nothing else follows)');
	const start = COMPONENTS_TEXT.indexOf('const recomputeMatches = React.useCallback(');
	const depsAt = COMPONENTS_TEXT.indexOf('\n\t}, [', start);
	assert.ok(
		COMPONENTS_TEXT.slice(depsAt, depsAt + 120).includes('syncExtraLayers'),
		'the recompute re-makes when the extra-layer sync identity moves (a stale closure would paint stale tints)'
	);
});

test('syncExtraLayers is declared before recomputeMatches — the eager deps reference must stay initialized', () => {
	// Round-2 fix (评审关键发现)：recomputeMatches 的 deps 数组是
	// React.useCallback(...) 的实参，组件函数体求值期间被【急切求值】——
	// 而 const 声明存在暂时性死区：若 syncExtraLayers 声明在 recomputeMatches
	// 之后，deps 里的同步引用会在每次渲染抛 ReferenceError（闭包体内的
	// 调用是调用期求值、不受影响——round-1 的 TDZ 分析只覆盖了后者）。
	// 这类 bug 全套源标记测试不可见（components.js 仅作文本解析，组件体
	// 从不执行），钉住声明顺序让该 bug 类无法再悄然过绿。
	const syncExtraAt = COMPONENTS_TEXT.indexOf('const syncExtraLayers = React.useCallback');
	assert.ok(syncExtraAt !== -1, 'the syncExtraLayers useCallback was found');
	const recomputeAt = COMPONENTS_TEXT.indexOf('const recomputeMatches = React.useCallback');
	assert.ok(recomputeAt !== -1, 'the recomputeMatches useCallback was found');
	assert.ok(
		syncExtraAt < recomputeAt,
		'syncExtraLayers is declared BEFORE recomputeMatches (its deps array references it eagerly — a later declaration crashes every render)'
	);
});

test('recomputeMatches reads the live textarea, dedupes on the signature, and contains throws', () => {
	const span = useCallbackSpan(COMPONENTS_TEXT, 'const recomputeMatches = React.useCallback(');
	// Review round 1: the area-only guard — the repaint join must run with
	// the match switches off (the ungated active tint), while the compute
	// half keeps its matchAny gating inside.
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
	assert.ok(span.includes('syncMatches();'), 'every real recompute repaints the match layer (and joins the extra-layer tint repaint after it)');
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
	// Final-review #4: the all-off editor short-circuits BEFORE any rAF work.
	// Review round 1: "all-off" now includes extra layers — a match-off
	// code-highlight editor still schedules (the frame's repaint half carries
	// the ungated active tint).
	assert.ok(
		span.includes('if (!matchAny && extraLayers.length === 0) return;\n\t\tif (matchFrameRef.current !== null)'),
		'only the all-off editor (no match, no extra layers) short-circuits before any frame is scheduled'
	);
	const start = COMPONENTS_TEXT.indexOf('const scheduleMatchRecompute = React.useCallback(');
	const depsAt = COMPONENTS_TEXT.indexOf('\n\t}, [', start);
	assert.ok(
		COMPONENTS_TEXT.slice(depsAt, depsAt + 100).includes('[matchAny, extraLayers, recomputeMatches]'),
		'the guard\'s prop keys ride the callback deps (extraLayers re-makes the schedule when layers mount)'
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
			"if ((!highlightEnabled && !matchAny && extraLayers.length === 0) || typeof document === 'undefined') return undefined;"
		),
		'the gate admits a match-only editor (highlighting off, word layer on) AND a match-off code-highlight editor (the ungated active tint needs the follower)'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('}, [highlightEnabled, matchAny, extraLayers, paintCaretLine, scheduleMatchRecompute]);'),
		'the listener re-subscribes when the recompute identity, the layers, or the props move'
	);
});

test('the syncRef composite repaints the match layer after the extra layers', () => {
	// The observer composite is the passive repaint path (hidden-subtree
	// retries, initial notification): paint-only, never a re-scan.
	const start = COMPONENTS_TEXT.indexOf('syncRef.current = () => {');
	assert.ok(start !== -1, 'the syncRef composite was found');
	const end = COMPONENTS_TEXT.indexOf('};', start);
	const composite = COMPONENTS_TEXT.slice(start, end);
	assert.ok(
		/syncExtraLayers\(\);\s*syncMatches\(\);/.test(composite),
		'the composite joins the match repaint right after syncExtraLayers'
	);
	assert.ok(
		COMPONENTS_TEXT.includes(
			'}, [paintCaretLine, syncGutter, syncWrapGutter, syncWhitespace, syncExtraLayers, syncMatches, syncRuler]);'
		),
		'the composite re-arms when the sync identity moves'
	);
});

test('the textarea onScroll handler repaints the match layer (never recomputes)', () => {
	const onScrollMatch = /onScroll: \(\) => \{[\s\S]*?\n\t\t\t\}/.exec(COMPONENTS_TEXT);
	assert.ok(onScrollMatch !== null, 'the textarea onScroll handler was found');
	assert.ok(
		/syncExtraLayers\(\);\s*syncMatches\(\);/.test(onScrollMatch[0]),
		'the scroll handler joins the match repaint right after syncExtraLayers'
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
		/syncExtraLayers\(\);\s*syncMatches\(\);/.test(callback),
		'the wrap-flip/resize callback joins the match repaint right after syncExtraLayers'
	);
	assert.ok(
		COMPONENTS_TEXT.includes(
			'}, [syncWrapViewport, repaintBar, wrapEnabled, syncWhitespace, syncExtraLayers, syncMatches]);'
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
		/syncExtraLayers\(\);\s*syncMatches\(\);/.test(composite),
		'the counts-correction composite joins the match repaint right after syncExtraLayers'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('}, [syncWrapGutter, repaintBar, syncWhitespace, syncExtraLayers, syncMatches]);'),
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
		COMPONENTS_TEXT.includes('syncExtraLayers, scheduleMatchRecomputeBackstop]);'),
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

/* --------------------------- cm6 content-surface swap (Task 10) -- */

/**
 * The code-highlight mode's factory wiring (Task 10): the descriptor
 * registration keeps pointing at `editorComponents.CodeHighlightMode`
 * (pinned field-for-field in client-entry.test.js), but the component it
 * names is now the CM6 mode — `createCodeMirrorMode` (src/cm6/component.js)
 * built with the exact five deps the entry's runtime owns. The retired
 * DOM-seam shell (`mode-code-highlight.js` + the token-layer import that
 * fed it) is gone from this module; Task 11 retires the seam files
 * themselves, which stay alive but unreferenced until then.
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
	assert.equal(COMPONENTS_TEXT.includes("from './highlight/token-layer.js'"), false, 'the token-layer import is gone (the seam stays alive but unreferenced until Task 11)');
	assert.equal(COMPONENTS_TEXT.includes('createTokenLayerDescriptor'), false, 'the token-layer builder is no longer referenced');
});
