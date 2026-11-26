/**
 * Editor framework UI components — the browser half's React layer.
 *
 * `createEditorComponents(runtime)` builds the component set the client entry
 * wires into sidebar-right:
 *
 * - `EditorTab` — the `sidebar.right.pane.tab` body: owns ONE tab-machine
 *   controller per (sessionId, path, occurrence), registers it with the
 *   dshEditor service keyed by the dockkit tab id (registered once per
 *   mounted tab; visibility/session flips flow through `notifyChange`),
 *   resolves and swaps modes without touching machine state, renders the
 *   three-phase body (loading / failed + retry + `dsh-editor.unavailable`
 *   seat / ready mode component), the toolbar (name · path · mode indicator +
 *   menu · `dsh-editor.actions` seat · dirty · reload · save) and the status
 *   bar (Ln/Col · lines · chars · `dsh-editor.status` seat · notice · the
 *   settings-center gear), follows `navigation.params.file.line`, and
 *   intercepts keydown
 *   on its ROOT element to dispatch the framework's self-managed keymap
 *   actions (save / saveAll / deleteLines — spec §6).
 * - `PlainTextMode` — the built-in `plain-text` mode: one controlled textarea
 *   (`data-dsh-editor-input`) over an active-line highlight backdrop (the
 *   `highlightActiveLine` preference prop, 0.4.0), reporting edits and
 *   selections and serving `controller.onNavigate` line jumps.
 * - `ModeMenu` — the mode indicator's dropdown (spec §5.3).
 * - The status-bar gear is the settings center's only entry (0.11.0):
 *   `runtime.openSettings(path)` opens the APPLICATION-level singleton dialog
 *   owned by the client entry (`src/settings-dialog.js` renders it). The
 *   0.10.0 per-tab `SettingsPopover` is retired — its rows live on as the
 *   dialog's appearance/behavior/wrap sections, so there is no second source
 *   to drift from.
 * - `EditorTabTitle` — the `sidebar.right.pane.tab.title` occupant: paints
 *   a 16px file-type icon (the host's shared `FileTypeIcon`, classified by
 *   its shared `classifyFileType` — the same icon set and parsing the
 *   document preview tab uses) with a 12px white disc badge carrying the
 *   derived 10px edit glyph at its bottom-left (0.16.0 — editor tabs are
 *   distinguishable from preview tabs at a glance), then the file name,
 *   which paints red + strikethrough while the file is externally deleted.
 *   Without the host module (older DSH) the icon, disc and fallback vanish
 *   and the title renders as in 0.14.0.
 * - `EditButton` — the preview-toolbar occupant that opens files into the
 *   editor (the only navigation path into the tab type).
 *
 * Every live-context capability (service facade, mode registry, draft store,
 * file IO, preference bridge) arrives through `runtime`, so this module has no
 * cordis imports. `require('react')` is resolved by the bundler's factory
 * scope. No JSX: `React.createElement` aliased to `h`.
 *
 * Root data markers (`data-dsh-editor-address/session/visible/input`) are
 * debug-only, never a contract (spec §4.6).
 */

const React = require('react');
const h = React.createElement;

import { basenameOf, isEditablePath, parseFileAddress } from './address.js';
import { activeLineBar, glyphBandOffsets, lineHeightPxOf } from './active-line.js';
import { endScrollTarget, scrollBeyondPadding } from './scroll-beyond.js';
import { gutterWidthCh, contentPaddingCh, lineNumbersText } from './line-numbers.js';
import { lineOfOffset, lineOfOffsetFast, caretOffsetOfSelection, offsetOfLine } from './lines.js';
import { indentOp, outdentOp, outdentSplice, resolveIndentUnit } from './indent.js';
import { createTabController } from './tab-machine.js';
import { createDiskWatch } from './disk-watch.js';
import { resolveModeId } from './ranking.js';
import { clampRulerColumnInput, rulerLeftCh } from './ruler.js';
import { matchAction, comboOf } from './keymap.js';
import { parseGotoLine } from './goto-line.js';
import { canApplyScroll, scrollDiffers, selectionFromViewState, selectionRecordFromSnapshot, shouldFocusEditorOnOpen, shouldRestoreViewState, viewStateKey } from './view-state.js';
import { createWrapMeasurer } from './wrap-measure.js';
import { createWrapController } from './wrap-controller.js';
import { resolveWordWrap } from './wrap-resolve.js';
import { buildWhitespaceRow, glyphSvgShape, showsNewlineGlyph, visibleWindow, WHITESPACE_TAB_SIZE } from './whitespace.js';
import { buildMatchRowFragments, computeMatchHighlights, lineStartOffsets } from './match-highlight.js';
import { resolveFileTypeIconApi, tabTitleIconProps, TAB_TITLE_DISC_GLYPH_HTML } from './file-type-icon.js';
import { buildTabTitleChildren } from './tab-title-nodes.js';
// Code-highlight mode (0.17.0): the thin composition shell (Plain-mode props
// + the token-layer descriptor) and the descriptor builder it composes. The
// shell receives PlainTextMode + the builder here rather than importing them,
// keeping the module graph one-directional (components.js owns both halves).
import { createCodeHighlightMode } from './mode-code-highlight.js';
import { createTokenLayerDescriptor } from './highlight/token-layer.js';

/**
 * The host's shared file-type icon API (`FileTypeIcon` + `classifyFileType`
 * from `@deepseek-ai/dsh-client-ui-primitives`), resolved ONCE at module
 * load. The bare require rides the same bundler passthrough as
 * `require('react')` above — the web runtime serves the primitives module
 * from its require table, exactly like react. Any failure (older host
 * without the module, future export reshape) degrades silently to `null`
 * and the tab title falls back to the plain 0.14.0 filename rendering —
 * never a load error, never a log line (spec §5.2/§8).
 */
let FILE_TYPE_ICON_API = null;
try {
	FILE_TYPE_ICON_API = resolveFileTypeIconApi(
		require('@deepseek-ai/dsh-client-ui-primitives')
	);
} catch {
	FILE_TYPE_ICON_API = null;
}

/** CSS class prefix (also the debug-marker prefix). */
const CLASS = 'dsh-editor';

/** SVG namespace for the whitespace glyph shapes (createElementNS target). */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * The normalized "no extra backdrop layers" value, SHARED so the absent
 * prop never allocates: a per-render `[]` fallback would give `extraLayers`
 * a fresh identity every render, churn `syncExtraLayers`'s useCallback
 * identity, and re-run every effect that lists it — repainting the existing
 * glyph layers on renders that changed nothing. The absent prop must add no
 * new work to any repaint path (Task 6's invariant), so it resolves to one
 * frozen array for the module's life. Frozen so an accidental mutation of
 * the shared value throws instead of corrupting every editor after it.
 * @type {readonly []}
 */
const NO_EXTRA_LAYERS = Object.freeze([]);

/** Snapshot served while a tab has no controller yet (mirrors 'loading'). */
const NO_CONTROLLER_SNAPSHOT = Object.freeze({
	phase: 'loading',
	text: '',
	draft: '',
	dirty: false,
	version: '',
	conflict: false,
	saving: false,
	failure: null,
	lastError: null,
	selection: null,
	modeId: undefined,
	external: null,
	externalNotice: null,
});

const getNoControllerSnapshot = () => NO_CONTROLLER_SNAPSHOT;
const subscribeNothing = () => () => {};

/** `React.useSyncExternalStore` when the host React provides it (spec §4.2). */
const useExternalStore = typeof React.useSyncExternalStore === 'function' ? React.useSyncExternalStore : null;

/** Subscribe to a controller's snapshot store (or the loading placeholder). */
function useControllerState(controller) {
	const fallbackSnapshot = useSubscriptionFallback(controller);
	if (useExternalStore !== null) {
		// The branch is decided at module scope, so the hook order is stable.
		return useExternalStore(
			controller === null ? subscribeNothing : controller.subscribe,
			controller === null ? getNoControllerSnapshot : controller.getState
		);
	}
	return fallbackSnapshot;
}

/** useLayoutEffect when the host React provides it (pre-paint positioning). */
const useLayoutEffectSafe = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

/** useState/useEffect subscription fallback for React without the store hook. */
function useSubscriptionFallback(controller) {
	const [snapshot, setSnapshot] = React.useState(() =>
		controller === null ? NO_CONTROLLER_SNAPSHOT : controller.getState()
	);
	React.useEffect(() => {
		if (controller === null) {
			setSnapshot(NO_CONTROLLER_SNAPSHOT);
			return undefined;
		}
		setSnapshot(controller.getState());
		return controller.subscribe(setSnapshot);
	}, [controller]);
	return snapshot;
}

/** Minimal listener set feeding a registration's `notifyChange` hook. */
function createChangeSource() {
	const listeners = new Set();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		fire() {
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					// subscriber isolation
				}
			}
		},
	};
}

function timeNow() {
	try {
		return new Date().toLocaleTimeString();
	} catch {
		return '';
	}
}

/** Map a machine load failure to display text (kind-aware). */
function describeLoadFailure(t, failure) {
	if (failure !== null && typeof failure === 'object') {
		if (failure.kind === 'not-text') return t('error.notText');
		if (failure.kind === 'too-large') return t('error.tooLarge');
		if (typeof failure.message === 'string' && failure.message.length > 0) {
			return `${t('error.loadFailed')}: ${failure.message}`;
		}
	}
	return t('error.loadFailed');
}

/** A mode descriptor's display label (never throws). */
function labelOfMode(entry, fallback) {
	try {
		const label = typeof entry.label === 'function' ? entry.label() : undefined;
		return typeof label === 'string' && label.length > 0 ? label : fallback;
	} catch {
		return fallback;
	}
}

/** The message of a rejected value. */
function messageOfError(error) {
	if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
		return error.message;
	}
	return String(error);
}

/**
 * Keep one broken render from silently deleting the editor: the boundary logs
 * the failure through the injected persistent channel (the `log` prop
 * createEditorComponents threads in, scope 'render') and drops only the body
 * it guards.
 */
const EditorBoundary =
	typeof React.Component === 'function'
		? class EditorBoundary extends React.Component {
				constructor(props) {
					super(props);
					this.state = { failed: false };
				}
				static getDerivedStateFromError() {
					return { failed: true };
				}
				componentDidCatch(error) {
					try {
						this.props.log?.error('render', 'editor body render failed:', error);
					} catch {
						// the boundary itself must never throw
					}
				}
				render() {
					return this.state.failed ? null : this.props.children;
				}
			}
		: function EditorBoundary(props) {
				return props.children;
			};

/** The 16px outline pencil for the preview-toolbar edit button. */
const ICON_EDIT = h(
	'svg',
	{ width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
	h('path', {
		d: 'M2.9 13.1l.5-2.3 6.9-6.9a1.2 1.2 0 0 1 1.7 0l.2.2a1.2 1.2 0 0 1 0 1.7l-6.9 6.9-2.4.5Z',
		stroke: 'currentColor',
		strokeWidth: 1.2,
		strokeLinejoin: 'round'
	}),
	h('path', { d: 'M9.8 4.2l2 2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' })
);

/** The 14px gear glyph for the status-bar settings button. */
const ICON_GEAR = h(
	'svg',
	{ width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
	h('circle', { cx: 8, cy: 8, r: 2.1, stroke: 'currentColor', strokeWidth: 1.2 }),
	h('path', {
		d: 'M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5l1.6 1.6M10.9 10.9l1.6 1.6M12.5 3.5l-1.6 1.6M5.1 10.9l-1.6 1.6',
		stroke: 'currentColor',
		strokeWidth: 1.2,
		strokeLinecap: 'round'
	})
);

/* ------------------------------------------------------------- modes -- */

/**
 * The End-key combos the plain-text mode owns (0.9.0 follow-up): primary+End
 * collapses the caret at the content end, primary+shift+End selects to it.
 * Not part of the self-managed user keymap — fixed editor behavior, matched
 * with `matchAction` for isComposing safety and `primary` resolution.
 */
const END_KEYS_KEYMAP = {
	end: { code: 'End', modifiers: ['primary'] },
	selectEnd: { code: 'End', modifiers: ['primary', 'shift'] }
};

/**
 * The Tab-key combos the plain-text mode owns (0.13.0): Tab indents,
 * Shift+Tab outdents. Fixed editor behavior, not user-keymap-bindable;
 * the recorder rejects bare/shifted Tab via isReservedCombo.
 */
const INDENT_KEYS_KEYMAP = {
	indent: { code: 'Tab' },
	outdent: { code: 'Tab', modifiers: ['shift'] }
};

/**
 * The live paint window both glyph-layer repaints read: wrap-on rows from
 * the wrap controller + measurer, wrap-off rows from the one-row
 * `visibleWindow` arithmetic. Extracted from `syncWhitespace`'s two inline
 * branches (0.17.0, Task 6) so the extra-backdrop-layer repaint
 * (`syncExtraLayers`) consumes the SAME window the whitespace rows were
 * painted from — token ink and glyph rows must never disagree about where a
 * visual row sits, and two copies of the arithmetic would drift on the
 * first wrap-geometry change. Both branches of `syncWhitespace` now consume
 * this helper too, so there is exactly one copy: same entries, same
 * per-visual-row slice clamp, same tops, same order (zero behavior change
 * for the existing layer — the caller's append loop is unchanged in what it
 * appends and where).
 *
 * Each wrap row carries everything both consumers need: `line` (1-based
 * source line, the controller's convention), `start`/`end` (the slice's
 * offsets INSIDE the line — derived by accumulating the measurer's slice
 * lengths, since the mirror answers in text, not offsets), `text` (the
 * slice itself, what the whitespace builder paints verbatim),
 * `lastRowOfLine` (the break glyph rides only the line's LAST visual row)
 * and `top` (viewport-relative px, the layer's positioning convention).
 * The wrap-off window answers `firstLine`/`visibleCount` (a 0-based source
 * line run); the wrap-on window answers them from the controller's entries
 * (first entry's 0-based line, entry count) so the shape is uniform even
 * though wrap consumers read the rows instead.
 *
 * Pure over its arguments and the injected controller/measurer (both are
 * ref-resolved at call time by the callers, never captured): safe to call
 * twice per repaint pass, which the extra-layer join does whenever both
 * layers are live.
 * @param {any} area - the mounted textarea.
 * @param {{ paddingTop: number, lineHeight: number }} metrics - the
 *   measured line geometry (non-null; the callers' guard chain settles it).
 * @param {boolean} wrapEnabled - the wrap preference.
 * @param {any} wrapController - the wrap controller (or null).
 * @param {any} wrapMeasurer - the wrap measurer (or null).
 * @returns {{ wrap: boolean, rows: Array<{line: number, start: number, end: number, top: number, text: string, lastRowOfLine: boolean}> | undefined, firstLine: number, visibleCount: number, lines: string[] }}
 *   the window: `wrap` names the branch taken, `rows` the wrap-mode visual
 *   rows (`undefined` wrap-off), `firstLine`/`visibleCount` the source-line
 *   window, `lines` the split draft both consumers share.
 */
function paintWindowOf(area, metrics, wrapEnabled, wrapController, wrapMeasurer) {
	if (wrapEnabled && wrapController !== null && wrapMeasurer !== null) {
		const lines = area.value.split('\n');
		const entries = wrapController.visibleLines(area.scrollTop, area.clientHeight, 2);
		const rows = [];
		for (const entry of entries) {
			const lineText = entry.line >= 1 && entry.line <= lines.length ? lines[entry.line - 1] : '';
			// null = the mirror cannot answer for this text yet (or the line
			// is over the probe cap): skip the line this pass — the next
			// trigger compensates.
			const slices = wrapMeasurer.measureRowSlices(lineText);
			if (slices === null) continue;
			// Viewport slice clamp: a line UNDER the probe cap can still wrap
			// into hundreds of visual rows (a 2000-char line over a ~30-row
			// viewport), and painting every slice would churn hundreds of
			// spans a pass for a few dozen visible ones. Row k of this line
			// sits at paddingTop + contentTop + k·line against scrollTop, so
			// only the k whose row intersects the viewport — widened by the
			// ±2 margin the layer's windowing convention uses — paints. The
			// clamp is viewport math only: `lastRowOfLine` still keys off the
			// LAST slice of the line, so a break glyph outside the window
			// simply waits for the pass that scrolls it in.
			const lineTopContent = metrics.paddingTop + entry.contentTop;
			const firstVisibleRow = Math.max(
				0,
				Math.floor((area.scrollTop - lineTopContent) / metrics.lineHeight) - 2
			);
			const lastVisibleRow = Math.min(
				slices.length - 1,
				Math.ceil((area.scrollTop + area.clientHeight - lineTopContent) / metrics.lineHeight) + 2
			);
			// Slice offsets accumulate — the measurer answers in row text,
			// the token builder cuts by offset, so the builder's slice edges
			// must land exactly where the mirror's rows break.
			let sliceStart = 0;
			for (let k = firstVisibleRow; k <= lastVisibleRow; k++) {
				const sliceText = slices[k];
				rows.push({
					line: entry.line,
					start: sliceStart,
					end: sliceStart + sliceText.length,
					// Viewport-relative top in the wrap gutter layer's
					// convention: the controller's content-relative contentTop
					// against scrollTop, then k rows down inside the line.
					top: metrics.paddingTop + entry.contentTop - area.scrollTop + k * metrics.lineHeight,
					text: sliceText,
					lastRowOfLine: k === slices.length - 1
				});
				sliceStart += sliceText.length;
			}
		}
		return {
			wrap: true,
			rows,
			firstLine: entries.length > 0 ? entries[0].line - 1 : 0,
			visibleCount: entries.length,
			lines
		};
	}
	const lines = area.value.split('\n');
	const win = visibleWindow({
		scrollTop: area.scrollTop,
		paddingTop: metrics.paddingTop,
		lineHeight: metrics.lineHeight,
		clientHeight: area.clientHeight,
		lineCount: lines.length,
		marginRows: 2
	});
	return { wrap: false, rows: undefined, firstLine: win.first0, visibleCount: win.count, lines };
}

/**
 * The built-in `plain-text` mode: one controlled textarea over an
 * active-line highlight backdrop and a line-number gutter.
 *
 * Obligations (spec §5.5): renders the draft, reports edits via
 * `controller.applyEdit` and selections via `controller.applySelection`
 * (`{start, end, lineStart, lineEnd, text}`, `text` null when collapsed),
 * answers `controller.onNavigate` line jumps (returns true when claimed), and
 * mirrors machine-written selections (framework `setContent` commands) into
 * the DOM. Never reads or writes files itself.
 *
 * View-state adapter (0.8.0): `initialScroll` (`{ top, left }` or null) is a
 * one-shot restore target applied once the textarea is attached and sized;
 * `onScrollChange` reports the offsets a visible, loaded textarea actually
 * reaches (user scroll and navigation). Both are optional and absent-safe:
 * without them the mode behaves exactly as before, apart from healing a
 * scroll offset a hidden subtree discarded.
 *
 * Active-line highlight (0.4.0, the `highlightActiveLine` preference): the
 * textarea renders transparent over a backdrop layer that marks the caret
 * line with top/bottom hairlines (VS Code-style line border; a multi-line
 * selection keeps its native paint — no fill to fight future syntax
 * highlighting). The bar's geometry is pure arithmetic (src/active-line.js)
 * against the textarea's measured `paddingTop`/`lineHeight` — exact because
 * the textarea never wraps (`wrap: 'off'` + `white-space: pre`; the wrapped
 * path below measures visual rows instead). Painting is synchronous at the
 * DOM event (select/click/keyup re-derive the lines and
 * paint in-handler) so caret moves land on the next frame; scroll sync and
 * the React effect fallback are the only other writers. The mark stays
 * visible without focus: it shows where the caret is, not where the
 * keyboard is.
 *
 * Line-number gutter (0.5.0, the `showLineNumbers` preference): an
 * absolutely-positioned band beside the content carrying a 1px gray hairline
 * (the boundary rule, ALWAYS painted) and — while the preference is on — ONE
 * text block (`1\n2\n…\nN`, src/line-numbers.js) whose line-height and top
 * padding match the textarea's (exact for the same no-wrap reason the
 * highlight is). Geometry, in exact `ch` of the shared monospace font:
 * [digits] --1.5ch--> [rule] --2ch--> [content]. The band spans the whole
 * reservation and the textarea's matching `padding-left` never changes with
 * the preference, so toggling shows/hides ONLY the numbers — the rule, the
 * band and the content position are constant. The band paints above BOTH
 * the highlight backdrop and the overlay textarea (z-index 2 vs 1 — with
 * wrap:'off' a horizontal scroll would otherwise sweep glyphs across it),
 * and ignores pointer events (clicks fall through to the textarea); the
 * text block follows vertical scroll by translating against `scrollTop` in
 * the same onScroll handler the highlight uses. Width tracks the widest
 * line number so crossing a power of ten reflows once, not per keystroke
 * (the text block memoizes on the line count).
 *
 * Scroll past last line (0.9.0, the `scrollBeyondLastLine` preference): an
 * inline `padding-bottom = clientHeight − lineHeight` keeps scrollable blank
 * space past the content end; the gutter and highlight follow `-scrollTop`
 * unchanged, and disabling the preference restores the stock extent.
 *
 * Word wrap (0.10.0, the `wordWrap` prop): only a literal `true` turns it on
 * (`wrap='soft'` on the textarea + `.dsh-editor-area-wrap`, the CSS twin of
 * `WRAP_LINE_STYLES`) and starts the wrap controller — a per-mount measurer
 * (attached once, its mirror never consulted per read) plus a controller
 * whose `lineHeightPx` port answers from the memoized `wrapMetricsRef`. The
 * draft drives `syncDraft`, the ResizeObserver drives `syncViewport` BEFORE
 * its scroll-beyond/restore/heal steps (measurement basis first, spec §8),
 * and the active-line bar (plus the Task 8 gutter layer) answers from
 * `visualTop`/`visibleLines` instead of the one-row-per-line arithmetic.
 * Every wrap-off path is the 0.9.0 code: no measurer, no mirror, no call.
 *
 * Vertical ruler (0.14.0, the `ruler` prop): one underlay container
 * spanning the input surface holding a single 1px guide line pinned to the
 * right edge of the configured column — `bandWidth + column` ch
 * (src/ruler.js), pure geometric columns in `ch` of the shared monospace
 * font, so the position never measures the DOM. The container carries the
 * base background only when no earlier underlay does (the whitespace
 * layer's bg-carry rule, one layer up), and only the LINE translates
 * against `scrollLeft` — the container stays put as the fixed backdrop
 * (spec §7.2 amendment). Off by default: the layer never mounts and every
 * sync no-ops on the null refs, so a ruler-off editor pays nothing.
 *
 * Extra backdrop layers (0.17.0, the `extraBackdropLayers` prop): the
 * syntax-highlight token layer's seam — an optional array of descriptors
 * `{ key, className, paint }`, each rendered as one absolutely-positioned
 * underlay div between the whitespace layer and the ruler (tokens paint
 * above the glyphs, below the guide line), inside `${CLASS}-inputwrap` and
 * beneath the overlay textarea. The div is empty at render: `syncExtraLayers`
 * — joined at every `syncWhitespace` call site so every repaint path that
 * moves glyph rows moves token ink too — resolves each layer through a
 * per-descriptor ref map and hands its `paint(layer, context)` the live
 * window inputs (`doc`, `area`, `metrics`, `bandWidth`, `wrapEnabled`,
 * `firstLine`, `visibleCount`, `wrapRows`) from the same arithmetic the
 * whitespace layer paints from (`paintWindowOf`, one shared copy). A paint
 * that throws is contained: it logs once through the runtime log and its
 * descriptor is dropped from the active set for the component's lifetime —
 * one broken layer must never break the tab. The prop is optional and
 * ABSENT-SAFE: without it the mode renders no new node, runs no new work in
 * any repaint path, and every sync early-returns (byte-identical
 * v0.16.0 output). The layer never carries the base background — the
 * bg-carry rule stays with the earlier underlays, so token ink can never
 * become the sole backdrop the transparent textarea reads through.
 */
function PlainTextMode(props) {
	const controller = props.controller;
	const highlightEnabled = props.highlightActiveLine !== false;
	const gutterEnabled = props.showLineNumbers !== false;
	const scrollBeyondEnabled = props.scrollBeyondLastLine !== false;
	// Word-wrap (0.10.0): unlike the three preferences above, `wordWrap` has
	// no "default true" semantics — the caller already resolved the effective
	// per-file value, so only a literal `true` turns wrapping on.
	const wrapEnabled = props.wordWrap === true;
	// Whitespace glyphs (0.12.0): three independent booleans, all default
	// false; the prop object is read defensively (null/primitive-safe) so a
	// caller that never assembles it degrades to all-off harmlessly.
	const wsProp = props.showWhitespace;
	const wsSpaces = wsProp !== null && typeof wsProp === 'object' && wsProp.spaces === true;
	const wsTabs = wsProp !== null && typeof wsProp === 'object' && wsProp.tabs === true;
	const wsNewlines = wsProp !== null && typeof wsProp === 'object' && wsProp.newlines === true;
	const wsAny = wsSpaces || wsTabs || wsNewlines;
	// Vertical ruler (0.14.0): the `ruler` prop object is read defensively
	// (null/primitive-safe) exactly like the whitespace trio above, so a
	// caller that never assembles it degrades to no ruler harmlessly. The
	// column converges through the same clamp the settings field uses,
	// falling back to the editor default 80 when absent or malformed.
	const rulerProp = props.ruler;
	const rulerEnabled = rulerProp !== null && typeof rulerProp === 'object' && rulerProp.enabled === true;
	const rulerColumn = rulerEnabled ? (clampRulerColumnInput(rulerProp.column) ?? 80) : 80;
	// Match highlight (the `matchHighlight` prop): two independent layer
	// switches, both read defensively (null/primitive-safe) exactly like
	// the whitespace trio and the ruler above, so a caller that never
	// assembles the prop degrades to no match layer harmlessly — the
	// absent-prop path renders no node, adds no overlay class, and every
	// sync no-ops on the !matchAny guard (byte-identical output).
	const matchProp = props.matchHighlight;
	const matchSelectionOn = matchProp !== null && typeof matchProp === 'object' && matchProp.selection === true;
	const matchWordOn = matchProp !== null && typeof matchProp === 'object' && matchProp.word === true;
	const matchAny = matchSelectionOn || matchWordOn;
	// Extra backdrop layers (0.17.0, Task 6): the token-layer seam, read
	// defensively like the prop objects above — a caller that passes
	// nothing (or garbage) normalizes to the shared empty active set, which
	// renders nothing and early-returns every sync, keeping the absent-prop
	// output byte-identical to v0.16.0. Keys must be stable across renders
	// (they index the ref map AND the lifetime drop set) and the ARRAY
	// should be a stable reference per provider — a rebuilt-per-render
	// array churns this callback's identity and re-runs the joined effects
	// (a correct-but-wasteful repaint; the shared NO_EXTRA_LAYERS fallback
	// keeps the absent case free of it).
	const extraLayers = Array.isArray(props.extraBackdropLayers) ? props.extraBackdropLayers : NO_EXTRA_LAYERS;
	// View-state adapter (0.8.0): the one-shot restore target and the reporter
	// for the offset a user actually reached. `undefined` means "no restore",
	// exactly like `null`; the reporter is optional and type-guarded at every
	// call site so third-party modes are unaffected.
	const initialScroll = props.initialScroll === undefined ? null : props.initialScroll;
	const onScrollChange = props.onScrollChange;
	// The persistent log channel (0.17.0): the paint-containment catch in
	// syncExtraLayers degrades a broken layer through it. Optional by
	// contract — modes rendered without the prop lose only the diagnostics;
	// a missing or method-less channel degrades to silence (the channel's
	// own iron rule, mirrored here so a malformed log can never break a
	// paint path).
	const log = props.log;
	const state = useControllerState(controller);
	// EOL display (0.13.0): the machine probes the file's dominant line
	// ending at load and exposes it in the state; the glyph layer mirrors it
	// so CRLF breaks draw a ␍+↵ pair, CR files a lone ␍. Anything
	// unrecognized degrades to 'lf'.
	const fileEol = state.eol === 'crlf' || state.eol === 'cr' ? state.eol : 'lf';
	// Attached to the textarea below — the single DOM handle every selection
	// path reads (reportSelection, onNavigate, the mirror effect, and the
	// active-line sync). The v0.3.0/0.4.0 builds shipped WITHOUT this ref:
	// selections never reached the machine (caret frozen at Ln 1, deleteLines
	// always hit line 1, line navigation no-op) and the highlight never
	// synced — a latent wiring gap the active-line feature finally exposed.
	const areaRef = React.useRef(null);
	const barRef = React.useRef(null);
	// Whitespace glyph layer (0.12.0): the underlay div syncWhitespace fills
	// with windowed per-line rows. Only mounted while at least one of the
	// three switches is on, so `.current` is null — and every sync no-ops —
	// for editors that keep whitespace display off.
	const whitespaceRef = React.useRef(null);
	// Vertical ruler layer (0.14.0): the full-surface container and the 1px
	// guide line inside it. Only mounted while the ruler is enabled, so
	// `.current` is null — and syncRuler no-ops — for editors that keep the
	// ruler off.
	const rulerRef = React.useRef(null);
	const rulerLineRef = React.useRef(null);
	// Match-highlight layer (the `matchHighlight` prop): the underlay div
	// syncMatches fills with windowed run rows; the last computed match
	// sets ({ word, selection } document-offset ranges — an empty array
	// paints that layer nowhere); the last { value, start, end } signature
	// recomputeMatches dedupes on; and the rAF / timer handles the two
	// schedules coalesce through. All live for the mount. A pending
	// frame/timer firing after the layer unmounted lands in the guarded
	// no-op recompute (null area or layer), never a late paint.
	const matchLayerRef = React.useRef(null);
	const matchesRef = React.useRef({ word: [], selection: [] });
	const matchSignatureRef = React.useRef(null);
	const matchFrameRef = React.useRef(null);
	const matchTimerRef = React.useRef(null);
	// Extra backdrop layers (0.17.0, Task 6): the descriptor divs are a
	// RENDER-TIME list, so no ref-per-layer const is possible — the ref
	// callback registers each mounted element by `descriptor.key` and the
	// sync resolves elements through the map at CALL time (the map may hold
	// stale entries for unmounted keys only briefly; React fires the null
	// detach before the next paint pass reads it). The drop set is the
	// paint-containment memory: a descriptor whose paint threw is removed
	// from the ACTIVE set for the component's lifetime, so a broken layer
	// stops painting (and logging) instead of throwing on every repaint —
	// the set lives in a ref because the sync callbacks are re-created per
	// render while the lifetime is the mount's.
	const extraLayerElementsRef = React.useRef(new Map());
	const droppedExtraLayersRef = React.useRef(null);
	const metricsRef = React.useRef(null);
	// Gutter scroll sync: the inner text block translates against scrollTop.
	const gutterTextRef = React.useRef(null);
	// View-state scroll restoration. `pendingScrollRef` holds the target until
	// the textarea can accept it (attached and, for a non-zero axis, sized);
	// `scrollRestoreConsumedRef` makes `initialScroll` one-shot per mount;
	// `lastVisibleScrollRef` is the last offset a MEASURED, loaded textarea
	// reported (heal source); `wasMeasurableRef` detects the first measurable
	// ResizeObserver notification after a non-measurable one (a hidden subtree
	// can discard scrollTop silently).
	const pendingScrollRef = React.useRef(null);
	const scrollRestoreConsumedRef = React.useRef(false);
	const lastVisibleScrollRef = React.useRef(null);
	const wasMeasurableRef = React.useRef(false);
	// Word-wrap (0.10.0). The measurer and controller live for the mount; both
	// are created lazily on the first wrap-on render, so a wrap-off editor
	// never allocates a mirror. `wrapMetricsRef` memoizes the baseline the
	// measurer attached with (the controller's `lineHeightPx` provider reads
	// it instead of the DOM), `wrapDraftRef` hands the latest committed draft
	// to the DOM-driven observer callback, and `wrapViewportRef` is the
	// ref-indirected viewport sync the restore observer reaches without being
	// rebuilt by a preference toggle.
	const wrapMeasurerRef = React.useRef(null);
	const wrapControllerRef = React.useRef(null);
	const wrapMetricsRef = React.useRef(null);
	const wrapDraftRef = React.useRef(state.draft);
	const wrapViewportRef = React.useRef(null);
	// The wrap-mode gutter LAYER (0.10.0, Task 8): the element the controller
	// paints the windowed per-line number spans into. It only exists while
	// wrapping AND line numbers are on, and the controller is created before
	// React mounts it, so the layer port below reads `.current` at CALL time —
	// never a captured node.
	const wrapGutterRef = React.useRef(null);
	// The latest wrapped-surface repaint (gutter window + caret band), reached
	// by the controller's `onCountsChange` hook. A ref, not a captured closure:
	// the controller outlives the render that created it, while `repaintBar`
	// is re-created when the wrap preference or the metrics change.
	const wrapPaintRef = React.useRef(() => {});

	// The gutter's content and width, re-derived only when the line total
	// actually changes — typing within a line (the common keystroke) reuses
	// the memoized text block even on a 100k-line draft.
	// The reservation is CONSTANT: both widths derive from the line total
	// whether or not the gutter renders, and the textarea keeps its matching
	// padding-left either way — toggling the preference never shifts the
	// content sideways; only the numbers and the boundary rule appear/disappear.
	// Geometry: [digits] --1.5ch--> [rule] --2ch--> [content]; the gutter band
	// spans the WHOLE reservation (digits + both gaps) so its opaque
	// background also covers the rule-to-content strip against glyph sweeps.
	const lineCount = state.draft.length === 0 ? 1 : state.draft.split('\n').length;
	// The document-sized digits block is only ever MOUNTED while wrapping is
	// off (the windowed layer renders the numbers otherwise), so wrapping on
	// skips building the string at all — the memoized wrap-off value is
	// unchanged.
	const gutterText = React.useMemo(
		() => (gutterEnabled && !wrapEnabled ? lineNumbersText(lineCount) : ''),
		[gutterEnabled, wrapEnabled, lineCount]
	);
	const ruleOffset = gutterWidthCh(lineCount);
	const bandWidth = contentPaddingCh(lineCount);

	// Vertical scroll sync for the gutter: translate the text block against
	// the textarea's scrollTop. Same trigger points as the highlight's scroll
	// handling — one onScroll handler drives both.
	const syncGutter = React.useCallback(() => {
		const area = areaRef.current;
		const text = gutterTextRef.current;
		if (area === null || text === null) return;
		text.style.transform = `translateY(${-area.scrollTop}px)`;
	}, []);

	// Horizontal scroll sync for the ruler: translate the LINE against the
	// textarea's scrollLeft — the container stays put as the fixed backdrop
	// (spec §7.2 amendment). Same trigger points as the gutter's scroll
	// handling; guarded so a missing or unmeasurable surface never writes.
	const syncRuler = React.useCallback(() => {
		const area = areaRef.current;
		if (rulerRef.current === null || rulerLineRef.current === null) return;
		if (area === null || area.offsetParent === null) return;
		rulerLineRef.current.style.transform = `translateX(${-area.scrollLeft}px)`;
	}, []);

	/* --------------------------------------- glyph-ink band metrics -- */

	// The probe text measured on the canvas: '中' reaches the CJK ink top
	// (against the ascent edge — the source of the asymmetry), 'g' reaches a
	// Latin descender. The union frames BOTH scripts' glyphs.
	const GLYPH_PROBE_TEXT = '中g';
	// The hairline band geometry — keep in sync with the
	// `.dsh-editor-highlight-bar::before/::after` `height: 2px` CSS rules.
	const GLYPH_BAND_HEIGHT = 2;
	// Whitespace between each band and the glyph ink it frames. The top band
	// hugs the glyph tops; the bottom band sits a step farther below the
	// descender line — tune these two to taste.
	const GLYPH_BAND_PADDING_TOP = 4;
	const GLYPH_BAND_PADDING_BOTTOM = 1.5;

	/**
	 * Canvas TextMetrics probe for the REAL font stack: `fontBoundingBox*`
	 * locate the baseline inside the line box (the script asymmetry lives in
	 * the ascent/descent ratio), `actualBoundingBox*` bound the probe text's
	 * true ink extents. `null` outside a browser, when canvas 2D or the
	 * bounding-box metrics are unavailable, or on any failed read — the
	 * caller then keeps its static CSS fallback.
	 */
	function glyphInkOf(area) {
		if (typeof document === 'undefined' || document === null) return null;
		if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
		try {
			const canvas = document.createElement('canvas');
			const context = canvas.getContext('2d');
			if (context === null || typeof context.measureText !== 'function') return null;
			const style = window.getComputedStyle(area);
			context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const probe = context.measureText(GLYPH_PROBE_TEXT);
			const { fontBoundingBoxAscent, fontBoundingBoxDescent, actualBoundingBoxAscent, actualBoundingBoxDescent } = probe;
			if (
				![fontBoundingBoxAscent, fontBoundingBoxDescent, actualBoundingBoxAscent, actualBoundingBoxDescent].every(
					(value) => typeof value === 'number' && Number.isFinite(value)
				)
			) {
				return null;
			}
			return {
				fontAscent: fontBoundingBoxAscent,
				fontDescent: fontBoundingBoxDescent,
				inkAscent: actualBoundingBoxAscent,
				inkDescent: actualBoundingBoxDescent,
			};
		} catch {
			return null;
		}
	}

	// Measure the textarea's highlight geometry, at most once per rendered
	// mount. Every input is a computed value (rendering-independent — the
	// unitless `line-height: 1.5` computed form is "1.5" hidden AND rendered,
	// which `lineHeightPxOf` turns into real pixels), but measurement only
	// CACHES on a rendered element (`offsetParent !== null`): a hidden mount
	// stays uncached so the next sync re-measures instead of ever keeping a
	// poison value. A failed or odd read also stays uncached.
	const metricsOfArea = React.useCallback(() => {
		if (metricsRef.current !== null) return metricsRef.current;
		const area = areaRef.current;
		if (
			area !== null &&
			area.offsetParent !== null &&
			typeof window !== 'undefined' &&
			typeof window.getComputedStyle === 'function'
		) {
			try {
				const style = window.getComputedStyle(area);
				const paddingTop = parseFloat(style.paddingTop);
				const lineHeight = lineHeightPxOf(style.lineHeight, parseFloat(style.fontSize));
				if (Number.isFinite(paddingTop) && lineHeight !== null) {
					const measured = { paddingTop, lineHeight };
					// Glyph-ink probe (canvas TextMetrics): where the REAL font
					// stack puts the baseline and how far the probe text's ink
					// reaches — the script asymmetry (CJK hugs the ascent edge,
					// Latin centers) lives in exactly these numbers. The band
					// offsets frame the ink symmetrically; without them the
					// static CSS fallback (symmetric edge insets) applies.
					const glyph = glyphInkOf(area);
					if (glyph !== null) {
						const offsets = glyphBandOffsets({
							lineHeight,
							fontAscent: glyph.fontAscent,
							fontDescent: glyph.fontDescent,
							inkAscent: glyph.inkAscent,
							inkDescent: glyph.inkDescent,
							paddingTop: GLYPH_BAND_PADDING_TOP,
							paddingBottom: GLYPH_BAND_PADDING_BOTTOM,
							bandHeight: GLYPH_BAND_HEIGHT,
						});
						if (offsets !== null) {
							measured.bandTop = offsets.top;
							measured.bandBottomInset = offsets.bottom;
						}
					}
					metricsRef.current = measured;
				}
			} catch {
				// detached node: keep measuring lazily
			}
		}
		return metricsRef.current;
	}, []);

	/* ---------------------------------------------------- word-wrap -- */

	// The real wrap-mode gutter layer (Task 8): the controller paints the
	// windowed set of line numbers through this port. Every method
	// LATE-BINDS `wrapGutterRef.current` — the controller is created before
	// React mounts the layer (and the layer only exists while wrapping AND
	// line numbers are on), so a captured node would be null forever, while a
	// missing layer must degrade to a no-op rather than an error.
	//
	// Placement contract: `append` receives the top ALREADY relative to the
	// viewport (`contentTop − scrollTop`), so the layer positions each span at
	// that top verbatim, in a box pinned to the band's top — the scrolling is
	// entirely the controller's business and this layer never reads
	// `scrollTop`. That is also why `translate` is a NO-OP (see below): the
	// offset it carries is already folded into every `topPx`, so applying it
	// again would double the scroll (the plan/spec text describing both was
	// the defect; ledger ruling keeps the per-line offset as the authority).
	const createWrapGutterLayer = React.useCallback(() => {
		/**
		 * The mounted layer element, or `null` while it is not rendered.
		 * @returns {any} the DOM node the controller paints into.
		 */
		const layerOf = () => wrapGutterRef.current;
		return {
			// One span per visible source line: the number text at the px top
			// the controller computed. The span's box/alignment/font come from
			// the `.dsh-editor-gutter-wrap span` rule (client-entry.js), which
			// mirrors the digits sub-band of `.dsh-editor-gutter-text`.
			append(line, topPx) {
				const layer = layerOf();
				if (layer === null) return;
				const doc = layer.ownerDocument;
				if (!doc) return;
				const span = doc.createElement('span');
				span.textContent = String(line);
				span.style.top = `${topPx}px`;
				layer.appendChild(span);
			},
			// Drop the previous window; the controller clears before every
			// render pass, so the layer only ever holds the visible lines.
			clear() {
				const layer = layerOf();
				if (layer === null) return;
				layer.textContent = '';
			},
			// Deliberately a NO-OP, not an oversight: the controller hands the
			// same `−scrollTop` it already subtracted from every `append` top,
			// so the box must NOT be transformed — applying it would move each
			// number a full viewport away (double offset). The method stays in
			// the layer port because the controller calls it on every pass
			// (and on disable/dispose) and a throwing or missing method would
			// make the port contract diverge; there is simply nothing to do.
			translate() {
				// No-op by design — see the comment above.
			}
		};
	}, []);

	// One measurer + one controller per mount, created lazily so wrapping
	// being off (the default until Task 10 feeds the prop) costs nothing.
	// The `lineHeightPx` port is a MEMOIZED provider: the controller asks for
	// it on every geometry query, and the real measurer exposes no
	// line-height property (Task 5's contract), so re-reading the DOM here
	// would be both slow and the only way `visualTop` could keep its 20px
	// placeholder forever. `wrapMetricsRef` is kept current by the sync path
	// below and degrades to 0 (the controller's documented fallback) before
	// the first measurable frame.
	const ensureWrapController = React.useCallback(() => {
		if (wrapControllerRef.current !== null) return wrapControllerRef.current;
		if (wrapMeasurerRef.current === null) wrapMeasurerRef.current = createWrapMeasurer();
		wrapControllerRef.current = createWrapController({
			measurer: wrapMeasurerRef.current,
			lineHeightPx: () => {
				const metrics = wrapMetricsRef.current;
				return metrics === null ? 0 : metrics.lineHeight;
			},
			// Task 8: the real gutter layer. The controller caches this port
			// for the whole mount and only ever paints the visible window; the
			// port itself resolves the (later-mounted) element per call.
			gutterFactory: createWrapGutterLayer,
			// Measurement completion (Fix 1): the estimates that stood in for
			// the row counts are correct only until the async `measureAll`
			// chunks land — no DOM event follows them, so without this hook the
			// gutter spans and caret band would keep their estimate positions
			// indefinitely on an idle reader. Ref-indirected because this
			// controller is created once while `repaintBar` is re-made when the
			// wrap preference or metrics change. The controller wraps this in
			// its own never-throw guard; the catch here keeps the component's
			// half of the promise ("a paint failure never breaks measurement")
			// too.
			onCountsChange: () => {
				try {
					wrapPaintRef.current();
				} catch {
					// a paint failure must never break the measurement
				}
			}
		});
		return wrapControllerRef.current;
	}, [createWrapGutterLayer]);

	// Attach the measurer to the textarea when the layout baseline is new.
	// In practice that is once per mount (the metrics are memoized and the
	// line height only moves with a font change), never once per read — and
	// least of all once per query. A fresh mirror invalidates every row count
	// the controller holds AND silently cancels an in-flight `measureAll`
	// behind the controller's back, so the measurement is restarted here:
	// toggling the enable state drops the controller's width baseline, which
	// makes the following `syncDraft` take the whole-document re-measure path
	// (a pure line-height change would otherwise only dirty the geometry and
	// keep row counts measured against the old mirror).
	// @param {string} text - the committed draft.
	// @returns {boolean} `true` when a fresh mirror was attached.
	const attachAndRestartWrap = React.useCallback(
		(text) => {
			const area = areaRef.current;
			const measurer = wrapMeasurerRef.current;
			if (area === null || measurer === null) return false;
			const metrics = metricsOfArea();
			if (metrics === null) return false;
			const baseline = wrapMetricsRef.current;
			if (baseline !== null && baseline.lineHeight === metrics.lineHeight && measurer.ready()) return false;
			wrapMetricsRef.current = { lineHeight: metrics.lineHeight };
			measurer.attach(area, { lineHeightPx: metrics.lineHeight });
			const wrapController = wrapControllerRef.current;
			if (wrapController === null) return true;
			wrapController.setEnabled(false);
			wrapController.setEnabled(true);
			wrapController.syncDraft(text);
			return true;
		},
		[metricsOfArea]
	);

	// Drive the measurement from the committed draft: the first sync attaches
	// the mirror, later edits re-measure only the changed line range.
	const syncWrapDraft = React.useCallback(
		(text) => {
			if (!wrapEnabled) return;
			const wrapController = ensureWrapController();
			if (attachAndRestartWrap(text)) return;
			wrapController.syncDraft(text);
		},
		[wrapEnabled, ensureWrapController, attachAndRestartWrap]
	);

	// The restore observer's wrap step: called BEFORE the scroll-beyond /
	// restore / heal work so the measurement basis is current before any
	// extent or offset changes. Attaching doubles as the metrics-arrival
	// re-kick (a hidden mount measures nothing until it has a box); an
	// unchanged baseline only asks the controller for its debounced
	// viewport re-measure, so dragging a pane never restarts the full run
	// per notification.
	const syncWrapViewport = React.useCallback(() => {
		if (!wrapEnabled) return;
		const wrapController = ensureWrapController();
		if (attachAndRestartWrap(wrapDraftRef.current)) return;
		wrapController.syncViewport();
	}, [wrapEnabled, ensureWrapController, attachAndRestartWrap]);

	// Placeholder gutter sync for the DOM-driven paint/scroll paths: the
	// controller no-ops until Task 8 attaches a layer, so calling it now is
	// safe and keeps the call site the layer feature needs.
	const syncWrapGutter = React.useCallback(() => {
		const wrapController = wrapControllerRef.current;
		const area = areaRef.current;
		if (wrapController === null || area === null) return;
		wrapController.syncGutter(area.scrollTop, area.clientHeight);
	}, []);

	// Paint the whitespace glyph layer from the LIVE textarea, along two
	// paths that share the guard chain and the row renderer below: wrap-off
	// arithmetic (Task 6) — one absolutely-positioned row span per line
	// inside visibleWindow's margin-widened run — and the wrap-on window
	// (Task 7) — the controller names the visible source lines, the
	// measurer cuts each into its per-visual-row slices, and every slice
	// paints its own row span. Fragments come from buildWhitespaceRow
	// (Task 1's pure geometry) either way. Imperative writes in the
	// paintBar tradition: every caller (scroll handler, syncRef observer
	// path, draft commits, the mount effect) needs the repaint inside its
	// own event or commit, not one React render later.
	const syncWhitespace = React.useCallback(() => {
		const layer = whitespaceRef.current;
		const area = areaRef.current;
		if (layer === null || area === null) return;
		if (!wsAny) return;
		if (area.offsetParent === null || area.clientHeight <= 0) return;
		if (state.phase !== 'ready' && state.phase !== 'saving') return;
		const metrics = metricsOfArea();
		if (metrics === null) return;
		// Full clear, then windowed rebuild: a scroll moves EVERY row, so
		// no incremental patch could beat starting over (the window is tens
		// of rows; the value split below is the only O(document) cost, and
		// the scroll paths already pay the same read for the caret
		// arithmetic).
		const doc = layer.ownerDocument;
		// WHAT a row is, shared by both branches: each branch decides only
		// WHERE its rows sit (its top arithmetic), so the two paint paths
		// render fragments through one code path and cannot drift apart.
		// Every node comes from the layer's own document — never the
		// global — so a detached or foreign-document layer degrades to a
		// paint that simply never shows. A row with no fragments (an empty
		// last line, or a wholly plain line under an all-off pass) never
		// appends — an empty span would only add noise to the layer.
		const appendRow = (topPx, fragments) => {
			if (fragments.length === 0) return;
			const row = doc.createElement('span');
			row.className = `${CLASS}-whitespace-row`;
			row.style.top = `${topPx}px`;
			// Pinned to the band-width left edge the textarea's padding
			// reserves.
			row.style.left = `${bandWidth}ch`;
			for (const fragment of fragments) {
				if (fragment.kind === 'glyph') {
					const glyph = doc.createElement('span');
					glyph.className = `${CLASS}-whitespace-glyph`;
					// 0.12.0 fix: the ink is a fixed vector shape (SVG), never the
					// literal character. The character route depended on the resolved
					// font actually carrying ·/→/↵ with ~1ch advances; environments
					// whose monospace lacks them fall back to full-width CJK glyphs
					// whose ink lands at font-specific offsets inside the 1ch box
					// (dots hugging the cell's right edge — text-align: center cannot
					// rescue over-wide overflow, Chrome left-anchors it). Vector
					// shapes paint the same geometry everywhere. An unknown glyph
					// degrades to the literal character: a font-dependent mark beats
					// a missing one, and the shape table covers everything the
					// builder emits.
					const shape = glyphSvgShape(fragment.glyph);
					if (shape === null) {
						glyph.textContent = fragment.glyph;
					} else {
						const svg = doc.createElementNS(SVG_NAMESPACE, 'svg');
						svg.setAttribute('viewBox', shape.viewBox);
						svg.setAttribute('aria-hidden', 'true');
						for (const elementSpec of shape.elements) {
							const node = doc.createElementNS(SVG_NAMESPACE, elementSpec.tag);
							for (const [attr, value] of Object.entries(elementSpec)) {
								if (attr === 'tag') continue;
								// SVG attribute names are kebab-cased and case-sensitive:
								// the spec's camelCase keys map to stroke-width etc.
								node.setAttribute(attr.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), String(value));
							}
							svg.appendChild(node);
						}
						glyph.appendChild(svg);
						// The box is zero-height with its bottom edge on the text
						// baseline; the shape centers itself on (50%, yCenterEm above
						// that baseline) — the deterministic replacement for the old
						// glyph's baseline-relative ink position.
						svg.style.left = '50%';
						svg.style.top = '0';
						svg.style.transform = `translate(-50%, calc(-50% - ${shape.yCenterEm}em))`;
					}
					row.appendChild(glyph);
				} else if (fragment.kind === 'pad') {
					// count 0 is a tab one column before its stop: nothing
					// to pad, and a zero-length text node would only churn —
					// skip it.
					if (fragment.count > 0) row.appendChild(doc.createTextNode(' '.repeat(fragment.count)));
				} else if (fragment.kind === 'text') {
					row.appendChild(doc.createTextNode(fragment.text));
				}
				// Any OTHER kind is skipped with no output: an unknown
				// fragment must degrade to nothing here, never render its
				// raw fields as the literal string "undefined". No log prop
				// reaches this closure, so the skip is silent.
			}
			layer.appendChild(row);
		};
		// One window computation for BOTH branches (`paintWindowOf`, shared
		// with the extra-backdrop repaint): the wrap branch consumes the
		// per-visual-row slices the helper already clamped to the viewport,
		// the arithmetic branch the firstLine/visibleCount run. The glyph
		// rows and the token ink can no longer disagree about where a row
		// sits, because there is exactly one copy of the arithmetic — and
		// the helper resolves the controller/measurer presence the same way
		// the old inline condition did, so a wrap-on editor whose pair is
		// not created yet still falls through to the one-row arithmetic.
		const paintWindow = paintWindowOf(area, metrics, wrapEnabled, wrapControllerRef.current, wrapMeasurerRef.current);
		if (paintWindow.wrap) {
			layer.textContent = '';
			for (const row of paintWindow.rows) {
				const fragments = buildWhitespaceRow({
					text: row.text,
					spaces: wsSpaces,
					tabs: wsTabs,
					// A line's break glyph shows only when a real break follows
					// it — a file's trailing newline draws no glyph anywhere —
					// and under wrap it rides only the line's LAST visual row
					// (the helper's flag). The newline PROBE stays here, not in
					// the helper: it is glyph semantics, not geometry.
					newlines: wsNewlines && row.lastRowOfLine && showsNewlineGlyph(paintWindow.lines, row.line),
					eol: fileEol,
					// WHITESPACE_TAB_SIZE = the CSS tab-size, as in the
					// arithmetic branch.
					tabSize: WHITESPACE_TAB_SIZE
				});
				// The helper's row top is already viewport-relative (the
				// content-relative contentTop against scrollTop, then k rows
				// down inside the line) — the layer's positioning convention.
				appendRow(row.top, fragments);
			}
			// Wrap never scrolls horizontally (rows reflow instead), so the
			// layer carries no scroll-left translation — and this reset
			// clears whatever a wrap-off pass last left behind when the
			// mode flipped.
			layer.style.transform = 'translateX(0px)';
			return;
		}
		layer.textContent = '';
		const lines = paintWindow.lines;
		for (let i = paintWindow.firstLine; i < paintWindow.firstLine + paintWindow.visibleCount; i++) {
			const fragments = buildWhitespaceRow({
				text: lines[i],
				spaces: wsSpaces,
				tabs: wsTabs,
				// A line's break glyph shows only when a real break follows
				// it — a file's trailing newline draws no glyph anywhere.
				newlines: wsNewlines && showsNewlineGlyph(lines, i + 1),
				eol: fileEol,
				// WHITESPACE_TAB_SIZE = the CSS tab-size on the textarea
				// (and the fallback's own default): the underlay must stop
				// its tabs exactly where the real text does.
				tabSize: WHITESPACE_TAB_SIZE
			});
			// Same coordinate contract as the active-line band: content-box
			// rows against scrollTop, landing at paddingTop + line × height
			// (the left pin lives in appendRow).
			appendRow(metrics.paddingTop + i * metrics.lineHeight - area.scrollTop, fragments);
		}
		// Horizontal half of the scroll sync: rows sit at the content's
		// fixed left edge while the layer translates against scrollLeft —
		// the same translate-against-scroll contract paintBar carries (its
		// two-axis form, minus the axis this layer positions per row).
		layer.style.transform = `translateX(${-area.scrollLeft}px)`;
	}, [wsAny, wsSpaces, wsTabs, wsNewlines, wrapEnabled, fileEol, metricsOfArea, bandWidth, state.phase]);

	// Paint the match-highlight layer from the last computed match sets:
	// one windowed row span per visible line (wrap: per visual row slice),
	// the row's runs carrying the word / selection tints. Imperative
	// writes in the paintBar tradition, and the guard chain mirrors
	// syncWhitespace VERBATIM — layer+area mounted, switches on,
	// measurable surface, ready|saving phase, usable metrics — because the
	// two repaints share the same painting conditions: an unmeasured or
	// hidden surface must skip both or the layers would disagree. The
	// window comes from the same `paintWindowOf` helper (match ink and
	// glyph rows can never disagree about where a row sits), document-
	// offset matches translate through one `lineStartOffsets` pass, and
	// rows build through `buildMatchRowFragments` (src/match-highlight.js)
	// with a wrap row's slice splitting exactly at its boundaries. Full
	// clear + windowed rebuild in the syncWhitespace tradition: a scroll
	// moves every row, so no incremental patch could beat starting over.
	const syncMatches = React.useCallback(() => {
		const layer = matchLayerRef.current;
		const area = areaRef.current;
		if (layer === null || area === null) return;
		if (!matchAny) return;
		if (area.offsetParent === null || area.clientHeight <= 0) return;
		if (state.phase !== 'ready' && state.phase !== 'saving') return;
		const metrics = metricsOfArea();
		if (metrics === null) return;
		const doc = layer.ownerDocument;
		// WHAT a run is, shared by both branches: a plain run is a bare
		// text node (advance only — the row's ink is transparent, the
		// textarea paints the real glyphs), a covered run is a span
		// carrying exactly ONE tint class — 'word', 'selection' or the
		// merged 'both' — never two stacked classes whose backgrounds
		// would cascade into whichever rule won.
		const appendRow = (topPx, fragments) => {
			if (fragments.length === 0) return;
			const row = doc.createElement('span');
			row.className = `${CLASS}-match-row`;
			row.style.top = `${topPx}px`;
			// Pinned to the band-width left edge the textarea's padding
			// reserves (the whitespace rows' pin).
			row.style.left = `${bandWidth}ch`;
			for (const fragment of fragments) {
				if (fragment.layer === 'word' || fragment.layer === 'selection' || fragment.layer === 'both') {
					const run = doc.createElement('span');
					run.className =
						fragment.layer === 'word'
							? `${CLASS}-match-word`
							: fragment.layer === 'selection'
								? `${CLASS}-match-selection`
								: `${CLASS}-match-both`;
					run.textContent = fragment.text;
					row.appendChild(run);
				} else {
					row.appendChild(doc.createTextNode(fragment.text));
				}
			}
			layer.appendChild(row);
		};
		const paintWindow = paintWindowOf(area, metrics, wrapEnabled, wrapControllerRef.current, wrapMeasurerRef.current);
		const lines = paintWindow.lines;
		// One translation pass for the whole window: every row's fragments
		// consume the same line starts.
		const lineStarts = lineStartOffsets(lines);
		const wordMatches = matchesRef.current.word;
		const selectionMatches = matchesRef.current.selection;
		if (paintWindow.wrap) {
			layer.textContent = '';
			for (const row of paintWindow.rows) {
				// `row.line` is 1-based; a controller entry past the
				// document end degrades inside the builder (non-string
				// line → no fragments), the same pass syncWhitespace skips.
				const fragments = buildMatchRowFragments(
					lines[row.line - 1],
					lineStarts[row.line - 1],
					wordMatches,
					selectionMatches,
					{ start: row.start, end: row.end }
				);
				// The helper's row top is already viewport-relative — the
				// layer's positioning convention (syncWhitespace's wrap
				// branch).
				appendRow(row.top, fragments);
			}
			// Wrap never scrolls horizontally (rows reflow instead), so
			// the layer carries no scroll-left translation — and this
			// reset clears whatever a wrap-off pass last left behind when
			// the mode flipped.
			layer.style.transform = 'translateX(0px)';
			return;
		}
		layer.textContent = '';
		for (let i = paintWindow.firstLine; i < paintWindow.firstLine + paintWindow.visibleCount; i++) {
			// slice null = the whole line (one visual row per source line).
			const fragments = buildMatchRowFragments(lines[i], lineStarts[i], wordMatches, selectionMatches, null);
			// Same coordinate contract as the whitespace rows: content-box
			// rows against scrollTop, landing at paddingTop + line ×
			// height (the left pin lives in appendRow).
			appendRow(metrics.paddingTop + i * metrics.lineHeight - area.scrollTop, fragments);
		}
		// Horizontal half of the scroll sync: rows sit at the content's
		// fixed left edge while the layer translates against scrollLeft —
		// the same translate-against-scroll contract syncWhitespace's
		// wrap-off branch carries.
		layer.style.transform = `translateX(${-area.scrollLeft}px)`;
	}, [matchAny, wrapEnabled, metricsOfArea, bandWidth, state.phase]);

	// Recompute the match sets from the LIVE textarea — `area.value` and
	// the raw selection pair, the same source every selection path reads —
	// into matchesRef, then repaint through syncMatches. The signature
	// dedupe ({ value, start, end }) keeps the high-frequency triggers
	// (Task 7: selectionchange storms, scroll-adjacent recomputes) from
	// re-scanning the document when nothing moved; the mount effect below
	// drops the signature so the identity-change path (a layer switch, the
	// wrap preference, the phase, the metrics — all of which re-make
	// recomputeMatches through its deps) always lands a real recompute. A
	// throwing compute degrades to both layers cleared — containment in
	// the syncExtraLayers tradition, logged through the runtime channel
	// (whose malformed shape stays silent, never a second break).
	const recomputeMatches = React.useCallback(() => {
		const area = areaRef.current;
		if (area === null || !matchAny) return;
		const value = area.value;
		const start = area.selectionStart;
		const end = area.selectionEnd;
		const signature = matchSignatureRef.current;
		if (signature !== null && signature.value === value && signature.start === start && signature.end === end) return;
		matchSignatureRef.current = { value, start, end };
		try {
			matchesRef.current = computeMatchHighlights(
				value,
				{ start, end },
				{ selectionEnabled: matchSelectionOn, wordEnabled: matchWordOn }
			);
		} catch (error) {
			matchesRef.current = { word: [], selection: [] };
			if (log !== null && typeof log === 'object' && typeof log.warn === 'function') {
				log.warn('match-highlight', 'match recompute threw — cleared both layers:', error);
			}
		}
		syncMatches();
	}, [matchAny, matchSelectionOn, matchWordOn, syncMatches, log]);

	// rAF-coalesced recompute (Task 7's trigger entry): cancel any pending
	// frame and request a fresh one, so a burst of triggers lands as ONE
	// recompute on the next frame. The matchAny guard short-circuits BEFORE
	// any frame work — the all-off editor pays nothing per trigger.
	const scheduleMatchRecompute = React.useCallback(() => {
		if (!matchAny) return;
		if (matchFrameRef.current !== null) cancelAnimationFrame(matchFrameRef.current);
		matchFrameRef.current = requestAnimationFrame(() => {
			matchFrameRef.current = null;
			recomputeMatches();
		});
	}, [matchAny, recomputeMatches]);

	// 300ms timer backstop: the frame callback rides the browser's frame
	// budget, so a backgrounded or throttled moment would otherwise leave
	// the layers an interaction behind — the timer re-arms on every
	// schedule call and runs the same deduped recompute. The matchAny guard
	// short-circuits BEFORE any timer work, same all-off discipline.
	const scheduleMatchRecomputeBackstop = React.useCallback(() => {
		if (!matchAny) return;
		if (matchTimerRef.current !== null) clearTimeout(matchTimerRef.current);
		matchTimerRef.current = setTimeout(() => {
			matchTimerRef.current = null;
			recomputeMatches();
		}, 300);
	}, [matchAny, recomputeMatches]);

	// Repaint the extra backdrop layers (0.17.0, Task 6): resolve each
	// descriptor's element through the ref map and hand its paint the live
	// window inputs. Joined at EVERY syncWhitespace call site so each
	// repaint path that moves glyph rows moves token ink in the same event
	// or commit — imperative writes in the paintBar tradition, exactly why
	// syncWhitespace is one. The function self-guards on descriptor
	// presence FIRST: the joined call sites cost one dead branch for every
	// editor that passed no descriptors (the absent prop must add no new
	// work to any repaint path).
	//
	// The guard chain below mirrors syncWhitespace verbatim — layer+area
	// mounted, measurable surface, ready|saving phase, usable metrics —
	// because the two repaints share the same painting conditions: an
	// unmeasured or hidden surface must skip BOTH or the layers would
	// disagree (a token row painted from a stale measurement while the
	// glyphs waited for a real one). The paint context is built from the
	// same `paintWindowOf` result discipline syncWhitespace uses, so token
	// ink and glyph rows can never disagree about where a visual row sits.
	//
	// Containment (spec §8 under the imperative-paint refinement): each
	// paint call is wrapped in try/catch — a throwing paint logs ONCE
	// through the runtime log channel and its descriptor is dropped from
	// the active set for the component's lifetime (the set in a ref, so
	// the drop survives every later render's fresh callback). One broken
	// layer must never break the tab: the other descriptors keep painting,
	// and the dropped one stops throwing (and logging) on every subsequent
	// repaint. A missing or method-less log channel degrades to silence —
	// the containment (the drop) is the behavior; the log line is only its
	// diagnostic.
	const syncExtraLayers = React.useCallback(() => {
		if (extraLayers.length === 0) return;
		const dropped = droppedExtraLayersRef.current;
		const active = dropped === null ? extraLayers : extraLayers.filter((descriptor) => !dropped.has(descriptor.key));
		if (active.length === 0) return;
		// Guards mirror syncWhitespace verbatim (see the block comment).
		// `layer` is the first ACTIVE descriptor's element: the registered
		// div proving the layers rendered into a live document — the same
		// role `whitespaceRef.current` plays in syncWhitespace's chain.
		const layer = extraLayerElementsRef.current.get(active[0].key) ?? null;
		const area = areaRef.current;
		if (layer === null || area === null) return;
		if (area.offsetParent === null || area.clientHeight <= 0) return;
		if (state.phase !== 'ready' && state.phase !== 'saving') return;
		const metrics = metricsOfArea();
		if (metrics === null) return;
		const doc = layer.ownerDocument;
		const paintWindow = paintWindowOf(area, metrics, wrapEnabled, wrapControllerRef.current, wrapMeasurerRef.current);
		// Exactly the live window inputs the whitespace paint branches
		// consume (ExtraLayerPaintContext): wrap mode hands the token layer
		// its per-visual-row slices (`wrapRows`), wrap-off the 0-based line
		// run. The rows are narrowed to the documented `{ line, start, end,
		// top }` shape — the slice text and the break-glyph flag are
		// whitespace-layer concerns the token layer must not lean on.
		const context = {
			doc: doc,
			area: area,
			metrics: metrics,
			bandWidth: bandWidth,
			wrapEnabled: wrapEnabled,
			firstLine: paintWindow.firstLine,
			visibleCount: paintWindow.visibleCount,
			wrapRows: paintWindow.wrap
				? paintWindow.rows.map((row) => ({ line: row.line, start: row.start, end: row.end, top: row.top }))
				: undefined
		};
		for (const descriptor of active) {
			const element = extraLayerElementsRef.current.get(descriptor.key) ?? null;
			if (element === null) continue;
			try {
				descriptor.paint(element, context);
			} catch (paintError) {
				// Containment: log once (the drop below makes a second log
				// impossible), then remove the descriptor from the active
				// set for the component's lifetime.
				if (log !== null && typeof log === 'object' && typeof log.warn === 'function') {
					log.warn(
						'highlight',
						`extra backdrop layer "${descriptor.key}" threw — dropped for this editor's lifetime:`,
						paintError
					);
				}
				if (droppedExtraLayersRef.current === null) droppedExtraLayersRef.current = new Set();
				droppedExtraLayersRef.current.add(descriptor.key);
			}
		}
	}, [extraLayers, bandWidth, wrapEnabled, state.phase, metricsOfArea, log]);

	// Paint the bar for an ALREADY-DERIVED line range. Pure imperative style
	// writes (sub-microsecond): the DOM event path (select/click/keyup) calls
	// this synchronously inside the handler, so caret moves land on the next
	// frame instead of trailing by React's async passive-effect scheduling
	// (~100ms — the visible lag this replaces). Under wrap the range no
	// longer decides the height on its own: `caretOffset` names the visual
	// row to cover, so a logical line wrapped over several rows highlights
	// only the one holding the caret (VS Code style). Without a usable
	// offset the wrapped branch keeps the whole-range band as its fallback.
	const paintBar = React.useCallback(
		(range, caretOffset) => {
			const area = areaRef.current;
			const bar = barRef.current;
			if (area === null || bar === null) return;
			const metrics = metricsOfArea();
			const wrapController = wrapControllerRef.current;
			let geometry;
			if (wrapEnabled && metrics !== null && wrapController !== null) {
				if (typeof caretOffset === 'number' && Number.isFinite(caretOffset)) {
					// The caret's own visual row: a one-line-height band at
					// the row's top. `caretVisualRowIndex` is content-relative
					// (a row index, no padding), so the box offset is added
					// explicitly — the same convention as activeLineBar.
					geometry = {
						top: metrics.paddingTop + wrapController.caretVisualRowIndex(caretOffset) * metrics.lineHeight,
						height: metrics.lineHeight
					};
				} else {
					// Fallback: a source line can occupy several visual rows,
					// so the band spans from the range's first row to the row
					// after its last one.
					const top = wrapController.visualTop(range.lineStart);
					geometry = {
						top: metrics.paddingTop + top,
						height: wrapController.visualTop(range.lineEnd + 1) - top
					};
				}
			} else {
				geometry = activeLineBar(range, metrics);
			}
			bar.style.top = `${geometry.top}px`;
			bar.style.height = `${geometry.height}px`;
			bar.style.width = `${Math.max(area.scrollWidth || 0, area.clientWidth || 0)}px`;
			bar.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
			// The glyph-framed band positions (canvas-measured, font-aware).
			// Absent metrics drop the properties so the stylesheet's static
			// symmetric insets take over as the fallback.
			if (metrics !== null && Number.isFinite(metrics.bandTop) && Number.isFinite(metrics.bandBottomInset)) {
				bar.style.setProperty('--dsh-editor-band-top', `${metrics.bandTop}px`);
				bar.style.setProperty('--dsh-editor-band-bottom', `${metrics.bandBottomInset}px`);
			} else {
				bar.style.removeProperty('--dsh-editor-band-top');
				bar.style.removeProperty('--dsh-editor-band-bottom');
			}
		},
		[metricsOfArea, wrapEnabled]
	);

	// Caret-follower state: the previous selection pair drives the anchor
	// check (caretOffsetOfSelection); the signature dedupes paints.
	const selRef = React.useRef(null);
	const lastPaintRef = React.useRef('');

	// Paint the bar on the CARET's line — synchronous, live-DOM. The caret
	// offset comes from anchor tracking (the selection edge that moved since
	// the last observation — textareas normalize start<=end, so the offsets
	// alone cannot say which end the user dragged to), so a drag in EITHER
	// direction lands the mark on the release line, following the moving edge
	// while the drag is live.
	const paintCaretLine = React.useCallback(() => {
		const area = areaRef.current;
		if (area === null) return;
		const start = area.selectionStart;
		const end = area.selectionEnd;
		const caretOffset = caretOffsetOfSelection(selRef.current, start, end);
		selRef.current = { start, end, caret: caretOffset };
		const caretLine = lineOfOffsetFast(area.value, caretOffset);
		// Under wrap the band follows the caret's VISUAL row, so a caret move
		// within the same logical line must repaint too: the raw offset joins
		// the dedupe signature. Wrap-off keeps the original signature (and
		// therefore its exact paint cadence) unchanged.
		const signature = wrapEnabled
			? `${caretLine}:${caretOffset}:${area.scrollLeft}:${area.scrollTop}`
			: `${caretLine}:${area.scrollLeft}:${area.scrollTop}`;
		if (signature === lastPaintRef.current) return;
		lastPaintRef.current = signature;
		paintBar({ lineStart: caretLine, lineEnd: caretLine }, caretOffset);
	}, [paintBar, wrapEnabled]);

	// Repaint the caret-line bar even though the caret line, the selection and
	// the scroll offsets are unchanged. Wrapped geometry moves on its own:
	// enabling, attaching/restarting the measurement, every `syncDraft` (new
	// row counts) and every `syncViewport` (new width) can change the band's
	// extent while the signature above stays identical — the dedupe cannot see
	// any of it, so those paths drop the signature before painting. The
	// measurability guard keeps a hidden mount (no layout box) from painting,
	// and the paint itself only writes styles — no state, no render, no effect
	// re-entry — so calling it from the sync paths cannot loop.
	const repaintBar = React.useCallback(() => {
		const area = areaRef.current;
		if (area === null || area.offsetParent === null) return;
		lastPaintRef.current = '';
		paintCaretLine();
	}, [paintCaretLine]);

	// Refresh the controller's paint hook with THIS render's repaint set. A
	// layout effect (declared before the wrap sync effect below) so the hook is
	// already current when the same commit creates the controller or streams a
	// synchronous completion — and so a wrap-preference flip, which re-makes
	// `repaintBar`, never leaves the hook on the wrap-off arithmetic. All
	// three callees are measurability-guarded DOM writes: no state, no
	// render, no effect re-entry. The whitespace repaint is the async
	// completion's compensation: a measurement chunk landing new row slices
	// moves the glyph rows, and no DOM event follows it.
	useLayoutEffectSafe(() => {
		wrapPaintRef.current = () => {
			syncWrapGutter();
			repaintBar();
			syncWhitespace();
			syncExtraLayers();
			syncMatches();
		};
	}, [syncWrapGutter, repaintBar, syncWhitespace, syncExtraLayers, syncMatches]);

	const reportSelection = React.useCallback(() => {
		scheduleMatchRecompute();
		const area = areaRef.current;
		if (area === null) return;
		const start = area.selectionStart;
		const end = area.selectionEnd;
		const value = area.value;
		const lineStart = lineOfOffset(value, start);
		const lineEnd = lineOfOffset(value, end);
		controller.applySelection({
			start,
			end,
			lineStart,
			lineEnd,
			text: start === end ? null : value.slice(start, end)
		});
		// Synchronous caret-line paint, reusing this handler's DOM event: no
		// machine round-trip, no React involvement, anchor tracking included.
		paintCaretLine();
	}, [controller, paintCaretLine, scheduleMatchRecompute]);

	// Apply the pending restore target as soon as the textarea can take it.
	// `canApplyScroll` is the tested Task-1 decision: the area must be attached,
	// and a non-zero target on an axis needs that axis to have a size. A hidden
	// textarea simply keeps the target pending — the phase/draft layout effect
	// and the ResizeObserver retry. The browser clamps writes, so the value
	// remembered as visible is the ACTUAL post-write offset, never the request.
	const applyPendingScroll = React.useCallback(() => {
		// Short-circuit BEFORE any layout read: this runs on every draft commit,
		// and the common case (no restore pending) must not force a reflow.
		const pending = pendingScrollRef.current;
		if (pending === null) return;
		const area = areaRef.current;
		if (area === null) return;
		const view = {
			attached: area.offsetParent !== null,
			clientHeight: area.clientHeight,
			clientWidth: area.clientWidth
		};
		if (!canApplyScroll(pending, view)) return;
		area.scrollTop = pending.top;
		area.scrollLeft = pending.left;
		lastVisibleScrollRef.current = { top: area.scrollTop, left: area.scrollLeft };
		pendingScrollRef.current = null;
	}, []);

	// Scroll-beyond-last-line (0.9.0, the `scrollBeyondLastLine` preference):
	// keep `padding-bottom = clientHeight − lineHeight` on the textarea so the
	// scroll extent ends exactly at the last line's content start — fully
	// scrolled, only the last line sits at the viewport top (spec §5). Disabled
	// clears the inline padding; unmeasured states skip and wait for the
	// observer retry. Value-unchanged writes short-circuit (no reflow churn).
	const applyScrollBeyond = React.useCallback(() => {
		const area = areaRef.current;
		if (area === null) return;
		if (!scrollBeyondEnabled) {
			if (area.style.paddingBottom !== '') area.style.paddingBottom = '';
			return;
		}
		const metrics = metricsOfArea();
		if (metrics === null) return;
		if (area.offsetParent === null || area.clientHeight <= 0) return;
		const pad = scrollBeyondPadding(area.clientHeight, metrics.lineHeight);
		if (parseFloat(area.style.paddingBottom) === pad) return;
		area.style.paddingBottom = `${pad}px`;
	}, [scrollBeyondEnabled, metricsOfArea]);

	// A hidden subtree can discard scrollTop WITHOUT firing a scroll event, so
	// the first measurable ResizeObserver notification after a non-measurable
	// one is the only chance to put the last visible offset back. Without a
	// remembered offset (nothing scrolled yet, or a never-measured mount) there
	// is nothing to heal.
	const healScrollOnReveal = React.useCallback(() => {
		const area = areaRef.current;
		if (area === null) return;
		const measurable = area.offsetParent !== null && (area.clientHeight > 0 || area.clientWidth > 0);
		if (!measurable) {
			wasMeasurableRef.current = false;
			return;
		}
		if (wasMeasurableRef.current) return;
		wasMeasurableRef.current = true;
		const actual = { top: area.scrollTop, left: area.scrollLeft };
		const lastVisible = lastVisibleScrollRef.current;
		if (lastVisible === null || !scrollDiffers(actual, lastVisible)) return;
		area.scrollTop = lastVisible.top;
		area.scrollLeft = lastVisible.left;
	}, []);

	// The latest sync for passive observers — the ResizeObserver below must
	// not be torn down and rebuilt on every selection change. One sync for
	// every paint surface: the caret-line bar, the gutter's scroll
	// translation, the whitespace rows AND the ruler line (a hidden subtree
	// can discard scrollTop without firing a scroll event on re-show — the
	// observer retry must heal the gutter and the glyph window too).
	const syncRef = React.useRef(paintCaretLine);
	React.useEffect(() => {
		syncRef.current = () => {
			paintCaretLine();
			syncGutter();
			syncWrapGutter();
			syncWhitespace();
			syncExtraLayers();
			syncMatches();
			syncRuler();
		};
	}, [paintCaretLine, syncGutter, syncWrapGutter, syncWhitespace, syncExtraLayers, syncMatches, syncRuler]);

	// Web fonts can land AFTER the first measurement pass, changing the ink
	// extents the bands frame: drop the cache and re-sync once the font set
	// settles. (Guarded — jsdom and older engines have no document.fonts.)
	React.useEffect(() => {
		const fonts = typeof document !== 'undefined' && document !== null ? document.fonts : null;
		if (fonts === null || typeof fonts.ready?.then !== 'function') return undefined;
		let cancelled = false;
		fonts.ready.then(() => {
			if (cancelled) return;
			metricsRef.current = null;
			syncRef.current();
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// The restore observer must not rebuild on preference toggles (its deps stay
	// `[applyPendingScroll, healScrollOnReveal]`), so the padding writer reaches
	// it through the same ref pattern `syncRef` uses for the paint surfaces.
	const scrollBeyondRef = React.useRef(applyScrollBeyond);
	React.useEffect(() => {
		scrollBeyondRef.current = applyScrollBeyond;
	}, [applyScrollBeyond]);

	// The wrap viewport sync reaches that same observer through a ref. The
	// assignment happens in the LAYOUT phase: `observe()`'s initial
	// notification is delivered before paint, so a passive effect could
	// still be pending when the observer's first callback runs. The wrapper
	// repaints right after the width/attach work: a resize changes the wrapped
	// extents without moving the caret, so the observer's own paint
	// (`syncRef`) would dedupe and leave a stale band — and the width
	// re-slices every wrapped row, so the whitespace window repaints from
	// the fresh geometry here too. Both repaints are skipped while wrapping
	// is off, which keeps a wrap-off editor's observer behaviour exactly as
	// it was.
	useLayoutEffectSafe(() => {
		wrapViewportRef.current = () => {
			syncWrapViewport();
			if (wrapEnabled) repaintBar();
			if (wrapEnabled) syncWhitespace();
			// UNCONDITIONAL, unlike the two calls above: the observer fires
			// on width/attach changes the extra layers must follow even
			// while wrapping is off, and the sync self-guards on descriptor
			// presence (the wrap-off editor pays one dead branch).
			syncExtraLayers();
			syncMatches();
		};
	}, [syncWrapViewport, repaintBar, wrapEnabled, syncWhitespace, syncExtraLayers, syncMatches]);

	// One measurer and one controller per mount; both go with the component.
	// The controller's own `dispose()` deliberately leaves the measurer alone,
	// so the owner releases it explicitly (a leaked mirror + observer would
	// otherwise outlive every closed tab). The memoized baseline goes too: a
	// fresh measurer must be attached before its line height can be trusted.
	React.useEffect(() => {
		return () => {
			if (wrapControllerRef.current !== null) {
				wrapControllerRef.current.dispose();
				wrapControllerRef.current = null;
			}
			if (wrapMeasurerRef.current !== null) {
				wrapMeasurerRef.current.dispose();
				wrapMeasurerRef.current = null;
			}
			wrapMetricsRef.current = null;
		};
	}, []);

	// Reposition in the LAYOUT phase on mount/toggle only. Deliberately NOT
	// re-keyed on machine selection publishes: state.selection is normalized
	// (start = the TOP line of any range), so repainting from the snapshot
	// here would stamp the selection's top line right over the caret-line
	// paint the DOM-event and selectionchange paths just made — the "bar
	// jumps back to the top line" regression. Machine writes (deleteLines,
	// navigation) reach the bar through the mirror effect, which paints AFTER
	// applying the DOM selection, plus selectionchange itself.
	useLayoutEffectSafe(() => {
		if (!highlightEnabled) return;
		paintCaretLine();
	}, [highlightEnabled, paintCaretLine]);

	// The gutter mounts (or re-mounts on toggle-on) against a possibly
	// already-scrolled textarea: land its transform on the CURRENT scrollTop
	// in the layout phase, before the first paint shows stale numbers.
	useLayoutEffectSafe(() => {
		if (!gutterEnabled) return;
		syncGutter();
	}, [gutterEnabled, syncGutter]);

	// The ruler layer mounts (or re-mounts on the preference toggle) against
	// a possibly already-scrolled textarea: land the line's transform on the
	// CURRENT scrollLeft in the layout phase — the same first-paint duty the
	// gutter mount effect above carries. The callback's own guard chain
	// no-ops every non-ready state, so mounting early costs one guarded call.
	useLayoutEffectSafe(() => {
		if (!rulerEnabled) return;
		syncRuler();
	}, [rulerEnabled, syncRuler]);

	// The whitespace layer mounts (or re-mounts on a switch toggle) against
	// a possibly already-scrolled, already-loaded textarea: paint its first
	// window in the layout phase, before the first paint shows an empty
	// underlay — the same first-paint duty the gutter mount effect above
	// carries. The callback's own guard chain no-ops every non-ready state,
	// so mounting early costs one guarded call.
	useLayoutEffectSafe(() => {
		if (!wsAny) return;
		syncWhitespace();
		// Joined right after the whitespace repaint (the joining contract);
		// while whitespace is off this effect skips both, and the extra
		// layers' first paint rides the draft effect and the observer
		// instead — their own mounts need no separate effect because the
		// divs render empty and every paint is a full window rebuild.
		syncExtraLayers();
	}, [wsAny, syncWhitespace, syncExtraLayers]);

	// The match layer mounts (or re-mounts on a switch toggle) against a
	// possibly already-loaded textarea: run the first recompute in the
	// layout phase, before the first paint shows an empty underlay — the
	// same first-paint duty the whitespace mount effect above carries.
	// The signature reset is what makes the identity-change re-runs real:
	// recomputeMatches is re-made whenever a layer switch, the wrap
	// preference, the phase or the metrics moves (its deps chain through
	// syncMatches), and a re-run that deduped on an unchanged
	// { value, start, end } would leave the freshly (re)mounted layer
	// empty or stale — the settings toggles reach the paint exactly
	// through this path (Review Focus #5).
	useLayoutEffectSafe(() => {
		matchSignatureRef.current = null;
		if (!matchAny) return;
		recomputeMatches();
	}, [matchAny, recomputeMatches]);

	// Apply (or clear) the scroll-beyond padding in the layout phase on mount
	// and whenever the preference flips, before the first paint shows the old
	// extent.
	useLayoutEffectSafe(() => {
		applyScrollBeyond();
	}, [scrollBeyondEnabled, applyScrollBeyond]);

	// One-shot view-state restore. The target is consumed exactly once per
	// mount and then held in the ref until the textarea can accept it; a late
	// `initialScroll` can never override an explicit navigation because
	// `onNavigate` consumes and clears it before moving the caret. Layout
	// phase: the textarea's value is already committed, so a hidden mount
	// leaves the target pending for the phase/draft effect or the observer.
	useLayoutEffectSafe(() => {
		if (initialScroll === null || scrollRestoreConsumedRef.current) return;
		scrollRestoreConsumedRef.current = true;
		pendingScrollRef.current = { top: initialScroll.top, left: initialScroll.left };
		applyPendingScroll();
	}, [initialScroll, applyPendingScroll]);

	// Draft/phase commits are the moments the pending target may have become
	// applicable: the loaded text is in the textarea and the box has a size.
	useLayoutEffectSafe(() => {
		applyPendingScroll();
	}, [state.phase, state.draft, applyPendingScroll]);

	// Wrap measurement follows two inputs: the enable prop and the committed
	// draft. Either one can change the row counts every wrapped paint
	// surface is drawn from — and neither moves the caret — so each path
	// ends by repainting them from the fresh geometry: `syncWrapGutter()`
	// (the windowed line-number layer, Task 8), `repaintBar()` (the
	// active-line band) and `syncWhitespace()` (the glyph underlay, Task 7
	// — a no-op while every whitespace switch is off). Those are the only
	// writers that can follow a geometry-only change:
	//
	// - off → on: the controller resets, the first sync attaches the mirror,
	//   restarts the measurement the attach cancelled (the width baseline was
	//   just dropped, so `syncDraft` takes its whole-document path) and drives
	//   it from the draft. The layer element mounts in THIS commit, so the
	//   gutter sync below paints its first window right away instead of
	//   waiting for the passive ResizeObserver's initial notification (one
	//   blank frame — and no paint at all until a scroll on a host without
	//   ResizeObserver);
	// - on → off: the measured state is released, the wrapped gutter layer is
	//   emptied (the port no-ops once the element is unmounted) and the band
	//   returns to the one-row arithmetic;
	// - draft changed: only the edited line range is re-measured, but the row
	//   counts can still move (a line wrapping/unwrapping, or Enter adding a
	//   last line) — without the gutter sync here the spans would keep their
	//   pre-edit tops and the new line's number would be missing until the
	//   next scroll.
	//
	// `wrapDraftRef` records the same value for the DOM-driven observer
	// callback, whose closure cannot carry the latest render. Repainting here
	// is loop-safe: `syncWrapGutter`, `repaintBar` and `syncWhitespace`
	// write DOM styles only, so they cannot re-trigger this effect's
	// dependencies. Order is syncDraft → syncWrapGutter → repaintBar →
	// syncWhitespace: the gutter is painted from the geometry the sync just
	// produced, and the bar (whose dedupe signature `repaintBar` resets)
	// keeps its place before the glyph repaint — the three touch disjoint
	// nodes, so the order carries no semantics beyond that. Both branches
	// close with the glyph writer: `syncWhitespace` rebuilds the glyph
	// window from the fresh draft — typing is the most common way glyphs
	// appear and vanish, and under wrap a row-count move is a glyph move
	// too (the controller block is skipped entirely on an editor that
	// never wrapped).
	useLayoutEffectSafe(() => {
		wrapDraftRef.current = state.draft;
		if (!wrapEnabled) {
			const wrapController = wrapControllerRef.current;
			if (wrapController !== null) {
				wrapController.setEnabled(false);
				wrapController.syncGutter(0, 0);
				repaintBar();
			}
			syncWhitespace();
			syncExtraLayers();
			scheduleMatchRecomputeBackstop();
			return;
		}
		ensureWrapController().setEnabled(true);
		syncWrapDraft(state.draft);
		// Repaint the windowed layers from the geometry just synced: a
		// row-count change would otherwise leave the previous spans in
		// place until the next scroll, and the enable path would wait for
		// the observer.
		syncWrapGutter();
		repaintBar();
		syncWhitespace();
		syncExtraLayers();
		scheduleMatchRecomputeBackstop();
	}, [state.draft, wrapEnabled, ensureWrapController, syncWrapDraft, syncWrapGutter, repaintBar, syncWhitespace, syncExtraLayers, scheduleMatchRecomputeBackstop]);

	// Scroll restore/heal observer — deliberately INDEPENDENT of the
	// highlight/gutter observer above (that one is preference-gated and
	// repaints). `observe()` dispatches an initial notification, which doubles
	// as the post-layout retry for a target that was not applicable yet.
	React.useEffect(() => {
		const area = areaRef.current;
		if (area === null || typeof ResizeObserver !== 'function') return undefined;
		// The wrap step goes FIRST: it rewrites the row-count basis (and may
		// start/refresh the measurement) that the scroll-beyond extent and the
		// restore/heal offsets below are judged against — measurement basis
		// before extent changes (spec §8). The ref keeps this observer from
		// rebuilding on a preference toggle.
		const observer = new ResizeObserver(() => {
			if (wrapViewportRef.current !== null) wrapViewportRef.current();
			scrollBeyondRef.current();
			applyPendingScroll();
			healScrollOnReveal();
		});
		observer.observe(area);
		return () => observer.disconnect();
	}, [applyPendingScroll, healScrollOnReveal]);

	// Size/visibility restoration: an editor mounted (or toggled on) inside a
	// hidden session subtree caches no metrics (the guard above), so the
	// observer fires the retry the moment the textarea gains a real box —
	// session switch, sidebar reveal, pane resize — with no interaction.
	// observe() also dispatches an initial notification, doubling as a
	// post-layout resync on the very first mount. Wrapping and whitespace
	// need the same retry, hence the extra gate terms (and deps, so a
	// wrap-only or whitespace-only editor still installs the observer).
	React.useEffect(() => {
		if (!highlightEnabled && !gutterEnabled && !wrapEnabled && !wsAny && !matchAny) return undefined;
		const area = areaRef.current;
		if (area === null || typeof ResizeObserver !== 'function') return undefined;
		const observer = new ResizeObserver(() => syncRef.current());
		observer.observe(area);
		return () => observer.disconnect();
	}, [highlightEnabled, gutterEnabled, wrapEnabled, wsAny, matchAny]);

	// THE caret-follower: document-level `selectionchange` fires synchronously
	// with EVERY caret move — arrow keys included. The element-level events
	// cannot do this job: `select` never fires for a collapsed caret, so
	// key-driven moves used to wait for keyup (the visible ~100ms trail).
	// The focused-area check keeps hidden tabs' bars motionless. The gate
	// admits a match-only editor too (active line off, word layer on):
	// paintCaretLine self-guards on the unmounted bar ref there (paintBar's
	// null check), while the word layer still needs the recompute on every
	// keyboard caret move.
	React.useEffect(() => {
		if ((!highlightEnabled && !matchAny) || typeof document === 'undefined') return undefined;
		const onSelectionChange = () => {
			const area = areaRef.current;
			if (area === null || document.activeElement !== area) return;
			paintCaretLine();
			scheduleMatchRecompute();
		};
		document.addEventListener('selectionchange', onSelectionChange);
		return () => document.removeEventListener('selectionchange', onSelectionChange);
	}, [highlightEnabled, matchAny, paintCaretLine, scheduleMatchRecompute]);

	// Deliver framework line navigation into the textarea.
	React.useEffect(() => {
		return controller.onNavigate((line) => {
			const area = areaRef.current;
			if (area === null) return false;
			const target = Math.max(1, Math.floor(Number(line)));
			const offset = offsetOfLine(area.value, target);
			// An explicit jump owns the caret AND the scroll position from this
			// point on: consume the one-shot restore and drop any still-pending
			// target BEFORE moving, so a late `initialScroll` (or a queued
			// observer retry) cannot drag the viewport back.
			scrollRestoreConsumedRef.current = true;
			pendingScrollRef.current = null;
			area.focus();
			area.setSelectionRange(offset, offset);
			const landed = lineOfOffset(area.value, offset);
			// Wrapped layout lands the SAME six rows above the target, but rows
			// come from the wrapped geometry: `visualTop` is content-space px
			// WITHOUT the box's paddingTop, so it is added here explicitly (the
			// paintBar wrap branch follows the same convention — do not double
			// it). A controller or metrics that are not ready, and the whole
			// wrap-off path, take the 0.9.0 line below unchanged (a spec
			// non-goal to change).
			const wrapController = wrapEnabled ? wrapControllerRef.current : null;
			const metrics = wrapEnabled ? metricsOfArea() : null;
			if (metrics !== null && wrapController !== null)
				area.scrollTop = Math.max(0, metrics.paddingTop + wrapController.visualTop(landed) - 6 * metrics.lineHeight);
			else area.scrollTop = Math.max(0, (landed - 6) * 20);
			// The jump is a legitimate visible scroll: remember and report it the
			// same way a user scroll does — but only from a measured, loaded
			// textarea. A hidden or still-loading textarea reads back 0/0, and
			// storing that would poison the heal source and persist scrollTop 0.
			if ((state.phase === 'ready' || state.phase === 'saving') && area.offsetParent !== null) {
				const next = { top: area.scrollTop, left: area.scrollLeft };
				lastVisibleScrollRef.current = next;
				if (typeof onScrollChange === 'function') onScrollChange(next);
			}
			reportSelection();
			return true;
		});
		// `state.phase` is read by the guard above: re-subscribe when it changes
		// so the handler cannot act on a stale phase (loading vs ready/saving).
	}, [controller, reportSelection, onScrollChange, state.phase]);

	// A machine selection is only VISIBLE once the textarea owns focus:
	// setSelectionRange on an unfocused textarea paints the active-line bar but
	// leaves the caret invisible and routes typing elsewhere. Focus on the
	// editor's first ready render (below), not on every selection change, so
	// programmatic writes never steal focus from a field the user is using.
	const focusAreaIfAllowed = React.useCallback(() => {
		const area = areaRef.current;
		if (area === null) return;
		const active = typeof document !== 'undefined' ? document.activeElement : null;
		const activeIsSelf = active === area;
		const activeIsTextEntry =
			active !== null &&
			!activeIsSelf &&
			(active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable === true);
		const attached = area.offsetParent !== null;
		if (!shouldFocusEditorOnOpen({ attached, activeIsSelf, activeIsTextEntry })) return;
		try {
			area.focus({ preventScroll: true });
		} catch {
			try {
				area.focus();
			} catch {
				// detached node
			}
		}
	}, []);

	// Mirror machine-written selections (deleteLines and friends) into the
	// DOM; user-driven selections already match, so nothing fights. Painting
	// here (AFTER applying the DOM selection — never from the normalized
	// snapshot) keeps exactly ONE paint semantic: the bar always shows the
	// caret line, programmatic writes included.
	React.useEffect(() => {
		const area = areaRef.current;
		const selection = state.selection;
		if (area === null || selection === null) return;
		if (area.selectionStart !== selection.start || area.selectionEnd !== selection.end) {
			try {
				area.setSelectionRange(selection.start, selection.end);
			} catch {
				// detached node
			}
		}
		paintCaretLine();
	}, [state.selection, paintCaretLine]);

	// Focus the editor once it is loaded and visible. Opening a file should
	// leave the caret ready for typing; a restored selection makes the old
	// unfocused state especially confusing (the line is highlighted but the
	// editor is dead). Never steal focus from the chat composer or another
	// text entry, and never focus a hidden tab.
	const readyFocusRef = React.useRef(false);
	useLayoutEffectSafe(() => {
		if (readyFocusRef.current) return;
		if (state.phase !== 'ready' && state.phase !== 'saving') return;
		if (areaRef.current === null) return;
		readyFocusRef.current = true;
		focusAreaIfAllowed();
	}, [state.phase, focusAreaIfAllowed]);

	// End-key jumps are editor-owned (0.9.0 follow-up): the browser's native
	// end-of-content disclosure lands the viewport at the scroll-extent bottom,
	// and the scroll-beyond padding moved that bottom to "last line at the TOP
	// edge". Own primary+End / primary+shift+End at the textarea: move the
	// caret here and land via endScrollTarget — the last line ends five lines
	// above the bottom, and the landing is MONOTONE: already on the last page
	// with the last line at-or-above that reserve (or anywhere inside the
	// padded extent), the viewport stays put and only the caret moves; reaching
	// the padded extent remains a manual scroll.
	// matchAction brings isComposing safety and the `primary` resolution for
	// free; nothing in the self-managed keymap binds End, so the root handler
	// (which sees this event after us — preventDefault does not stop
	// propagation) still matches nothing and ignores it.
	const onAreaKeyDown = (event) => {
		const indentAction = matchAction(event, INDENT_KEYS_KEYMAP);
		if (indentAction !== undefined) {
			event.preventDefault(); // 任何相位都吞键：焦点永不逃逸
			if (state.phase !== 'ready' && state.phase !== 'saving') return;
			const area = areaRef.current;
			if (area === null) return;
			const from = area.selectionStart;
			const to = area.selectionEnd;
			const unit = resolveIndentUnit(props.indentSettings, area.value);
			// 主路径轨迹：indent 恒可拼接（插入点全部位于触及行行首、严格先于 to）；
			// outdent 交给 outdentSplice 裁决（spec §6.5）——op 无可删 → 吞键；形状
			// 不安全（拼接会少替换）→ fallback 机器写回。
			let plan = null;
			if (indentAction === 'indent') {
				const op = indentOp(area.value, from, to, unit);
				const segStart = offsetOfLine(area.value, lineOfOffset(area.value, from));
				plan = { op, segStart, segEnd: op.end, segText: op.text.slice(segStart, op.end) };
			} else {
				const op = outdentOp(area.value, from, to, unit);
				if (op === null) return; // 无可删：键已吞，无任何写回
				const splice = outdentSplice(area.value, from, to, unit);
				plan = splice === null
					? { op, fallback: true } // 不安全形状（拼接会少替换）→ 直接走机器回退，行为符合 spec §6.5
					: { op, segStart: splice.segStart, segEnd: splice.segEnd, segText: splice.segText };
			}
			const useExec = plan.fallback !== true &&
				typeof document !== 'undefined' && typeof document.execCommand === 'function';
			if (useExec) {
				try { area.setSelectionRange(plan.segStart, to); } catch { /* detached node */ }
			}
			let applied = false;
			if (useExec) {
				try { applied = document.execCommand('insertText', false, plan.segText) === true; } catch { applied = false; }
			}
			if (applied !== true) {
				// 回退：execCommand 不可用/失败、或 outdent 形状不安全（拼接会少替换）——
				// 同 deleteLinesFor 模式（原生撤销失效，功能可用）。setContent 已把新选区
				// 提交给机器，镜像 effect 会在重渲染时落 DOM；此刻 DOM 仍是旧值/旧选区，
				// 绝不能 reportSelection()（会用旧偏移覆盖刚提交的选区）。
				const lineStart = lineOfOffset(plan.op.text, plan.op.start);
				const lineEnd = lineOfOffset(plan.op.text, plan.op.end);
				controller.setContent(plan.op.text, {
					start: plan.op.start,
					end: plan.op.end,
					lineStart,
					lineEnd,
					text: plan.op.start === plan.op.end ? null : plan.op.text.slice(plan.op.start, plan.op.end)
				});
			} else {
				try { area.setSelectionRange(plan.op.start, plan.op.end); } catch { /* detached node */ }
				reportSelection(); // 仅主路径：DOM 已是新值/新选区
			}
			return;
		}
		const action = matchAction(event, END_KEYS_KEYMAP);
		const area = areaRef.current;
		if (action === undefined || area === null) return;
		event.preventDefault();
		// An explicit jump owns the viewport from this point on: consume the
		// one-shot restore and drop any still-pending target BEFORE moving, so
		// a late `initialScroll` (or a queued observer retry) cannot drag the
		// viewport back while the caret sits at EOF — same as the goto-line
		// jump below.
		scrollRestoreConsumedRef.current = true;
		pendingScrollRef.current = null;
		const end = area.value.length;
		if (action === 'selectEnd') {
			// Native shift-extend keeps the STATIONARY edge; caretOffsetOfSelection
			// returns the moving edge, so the anchor is the other one.
			const caret = caretOffsetOfSelection(selRef.current, area.selectionStart, area.selectionEnd);
			const anchor = caret === area.selectionStart ? area.selectionEnd : area.selectionStart;
			area.setSelectionRange(anchor, end);
		} else {
			area.setSelectionRange(end, end);
		}
		const metrics = metricsOfArea();
		if (wrapEnabled) {
			// Wrapped landing: the controller measures the wrapped content
			// extent itself — `endLandingInputs()` returns null while the
			// controller is disabled, disposed, or not yet measurable — so the
			// legacy lineCount arithmetic below must not run: one source line
			// can span several visual rows. A null controller or an unusable
			// reading keeps the existing guard behavior: skip the scroll
			// assignment and let the caret's minimal reveal apply.
			const wrapController = wrapControllerRef.current;
			const inputs = wrapController !== null ? wrapController.endLandingInputs() : null;
			if (inputs !== null && metrics !== null && area.offsetParent !== null && area.clientHeight > 0) {
				const target = endScrollTarget({
					clientHeight: area.clientHeight,
					lineHeight: inputs.lineHeight,
					paddingTop: metrics.paddingTop,
					contentHeight: inputs.contentHeight,
					maxScrollTop: area.scrollHeight - area.clientHeight,
					scrollTop: area.scrollTop
				});
				if (target !== null) area.scrollTop = target;
			}
		} else if (metrics !== null && area.offsetParent !== null && area.clientHeight > 0) {
			const lineCount = area.value.length === 0 ? 1 : area.value.split('\n').length;
			const target = endScrollTarget({
				clientHeight: area.clientHeight,
				lineHeight: metrics.lineHeight,
				paddingTop: metrics.paddingTop,
				lineCount,
				maxScrollTop: area.scrollHeight - area.clientHeight,
				scrollTop: area.scrollTop
			});
			if (target !== null) area.scrollTop = target;
		}
		// The jump moved the caret AND the viewport: report both the way the
		// goto-line jump does — same guarded idiom (a hidden or still-loading
		// textarea must not poison the heal source or persist scrollTop 0).
		if ((state.phase === 'ready' || state.phase === 'saving') && area.offsetParent !== null) {
			const next = { top: area.scrollTop, left: area.scrollLeft };
			lastVisibleScrollRef.current = next;
			if (typeof onScrollChange === 'function') onScrollChange(next);
		}
		reportSelection();
	};

	// The overlay treatment (transparent textarea above an underlay) is
	// needed when ANY paint surface below the textarea is active: the
	// active-line highlight backdrop, the match-highlight layer, the
	// whitespace glyph layer, the ruler underlay OR an extra backdrop
	// layer (0.17.0 — token ink hides behind an opaque textarea just as
	// surely as a glyph would, so its descriptors count as underlays here
	// too; with the prop absent this expression — and therefore the class
	// list — stays byte-identical to v0.16.0, and the match twin holds for
	// a mode that never passes `matchHighlight`). When none is — and
	// wrapping is off — the class string
	// stays exactly the historic `${CLASS}-area`, so the class list (and
	// every rule keyed off `.dsh-editor-area` / `-area-overlay`) is
	// byte-identical for every editor that paints no underlay.
	const overlayNeeded = highlightEnabled || wsAny || rulerEnabled || extraLayers.length > 0 || matchAny;
	const areaClassName = overlayNeeded ? `${CLASS}-area ${CLASS}-area-overlay` : `${CLASS}-area`;
	// Inkless overlay (0.17.0 code-highlight): the token layer paints the
	// VISIBLE ink under the overlay textarea, so while extra layers are
	// mounted the textarea's own glyphs go transparent — opaque text would
	// cover the tokens as double-struck label-primary. The variant keys off
	// the SAME presence condition that adds `-area-overlay` (they compose),
	// so plain-text and the legacy layers (active-line/whitespace/ruler
	// without extra layers) keep visible text exactly as before and the
	// absent-prop class list stays byte-identical to v0.16.0. The caret keeps
	// its color via an explicit `caret-color` (it follows currentColor), and
	// selection/IME stay textarea-drawn (composition text renders
	// underline-only in Chrome/Firefox — the transparent-overlay tradeoff,
	// Task 8's manual checklist verifies it).
	const baseClassName = wrapEnabled ? `${areaClassName} ${CLASS}-area-wrap` : areaClassName;
	const textareaClassName = extraLayers.length > 0 ? `${baseClassName} ${CLASS}-area-inkless` : baseClassName;

	return h(
		'div',
		{ className: `${CLASS}-inputwrap` },
		highlightEnabled
			? h(
					'div',
					{ className: `${CLASS}-highlight`, 'aria-hidden': true },
					h('div', { className: `${CLASS}-highlight-bar`, ref: barRef })
				)
			: null,
		// Match-highlight layer (the `matchHighlight` prop): the windowed
		// underlay syncMatches fills with one row span per visible line,
		// each row's runs carrying the word / selection tints. DOM order is
		// its stacking order — directly above the active-line highlight
		// backdrop, below the whitespace glyphs and every later underlay,
		// all beneath the overlay textarea (z-index 1) — so the tinted runs
		// land under their characters. Mounted only while any switch is on;
		// unmounting clears the layer wholesale and every sync no-ops on
		// the null ref. The bg-carry rule: with the active-line highlight
		// off this layer is the bottom-most underlay, so it carries the
		// base background the transparent textarea reads through.
		matchAny
			? h('div', {
					className: `${CLASS}-match`,
					'aria-hidden': true,
					ref: matchLayerRef,
					style: { background: highlightEnabled ? 'transparent' : 'var(--dsw-alias-bg-base)' }
				})
			: null,
		// Whitespace glyph layer (0.12.0, Task 6): the viewport-sized underlay
		// syncWhitespace fills with windowed rows. DOM order is its stacking
		// order — after the highlight backdrop, before the gutter band, and
		// all beneath the overlay textarea (z-index 1) — so its rows keep the
		// textarea's exact metrics and the glyphs land under their characters.
		// Mounted only while any switch is on; unmounting clears the layer
		// wholesale and every sync no-ops on the null ref.
		wsAny
			? h('div', {
					className: `${CLASS}-whitespace`,
					'aria-hidden': true,
					ref: whitespaceRef,
					// The active-line bar lives in the highlight backdrop BELOW
					// this layer, and the match layer below this one carries the
					// base background when highlighting is off — so an opaque
					// background here would cover either — transparent whenever
					// either earlier underlay is live. Only when whitespace is
					// the sole underlay does this layer carry the base
					// background: it is then the bottom backdrop the
					// transparent textarea reads through.
					style: { background: highlightEnabled || matchAny ? 'transparent' : 'var(--dsw-alias-bg-base)' }
				})
			: null,
		// Extra backdrop layers (0.17.0, Task 6): the token-layer seam — one
		// absolutely-positioned container per descriptor, EMPTY at render.
		// DOM order is stacking order: after the whitespace glyph layer,
		// before the ruler (tokens paint above the glyphs, below the guide
		// line), all beneath the overlay textarea (z-index 1). The div stays
		// empty until syncExtraLayers — joined at every syncWhitespace call
		// site — hands each paint the live window inputs; the layer fills
		// itself. Transparent background ALWAYS: the bg-carry rule stays
		// with the earlier underlays, so token ink can never become the sole
		// backdrop carrying the base background. Mounted only while a
		// provider passed descriptors — the absent prop renders nothing, and
		// every sync early-returns (byte-identical v0.16.0 output). The
		// ref callback registers/unregisters each element by descriptor key:
		// the sync resolves layers through that map at CALL time, never a
		// captured node.
		extraLayers.length > 0
			? extraLayers.map((descriptor) =>
					h(
						'div',
						{
							key: descriptor.key,
							className: descriptor.className,
							'aria-hidden': true,
							ref: (element) => {
								if (element === null) extraLayerElementsRef.current.delete(descriptor.key);
								else extraLayerElementsRef.current.set(descriptor.key, element);
							}
						}
					)
				)
			: null,
		// Vertical ruler layer (0.14.0): the full-surface container holding
		// the 1px guide line at the configured column. DOM order is its
		// stacking order — after the whitespace layer, before the gutter
		// band, all beneath the overlay textarea. The container carries the
		// base background only when no earlier underlay does (the whitespace
		// layer's bg-carry rule, one layer up), so the transparent textarea
		// always reads through exactly one painted backdrop. The line's
		// `left` is content-space geometry (`bandWidth + column`, src/ruler.js)
		// set once at render; syncRuler translates only the LINE against
		// scrollLeft — the container never moves. Mounted only while the
		// ruler is enabled; unmounting removes the whole underlay and every
		// sync no-ops on the null refs.
		rulerEnabled
			? h(
					'div',
					{
						className: `${CLASS}-ruler`,
						'aria-hidden': true,
						ref: rulerRef,
						style: { background: highlightEnabled || wsAny || matchAny ? 'transparent' : 'var(--dsw-alias-bg-base)' }
					},
					h('div', {
						className: `${CLASS}-ruler-line`,
						ref: rulerLineRef,
						style: { left: `${rulerLeftCh(rulerColumn, bandWidth)}ch` }
					})
				)
			: null,
		// The band ALWAYS paints — opaque cover + boundary rule persist
		// regardless of the preference, so toggling shows/hides ONLY the
		// numbers and never moves the layout. The band paints above the
		// highlight backdrop AND the overlay textarea (z-index 2 vs 1) so
		// horizontally-scrolled glyphs cannot sweep across it; pointer-events
		// none keeps clicks falling through to the textarea's padding region.
		// The rule sits INSIDE the band at the digits+gap offset, so the
		// strip right of it stays covered background too.
		h(
			'div',
			{
				className: `${CLASS}-gutter`,
				'aria-hidden': true,
				style: { width: `${bandWidth}ch` }
			},
			h('div', {
				className: `${CLASS}-gutter-rule`,
				'aria-hidden': true,
				style: { left: `${ruleOffset}ch` }
			}),
			// One renderer per mode, never both: with wrapping ON the
			// controller paints the windowed layer below, so the memoized
			// document-sized text block (0.5.0) stays the SOLE renderer exactly
			// while wrapping is off — the wrap-off DOM is byte-identical.
			gutterEnabled && !wrapEnabled
				? h(
						'div',
						{
							className: `${CLASS}-gutter-text`,
							ref: gutterTextRef,
							// The digits' sub-band: border-box width = ruleOffset so
							// the CSS padding-right (1.5ch) sits INSIDE the box and
							// the right-aligned digits end exactly GUTTER_GAP_CH
							// left of the rule. (Content-box would push the digits'
							// right edge TO the rule — width + padding, not width.)
							style: { width: `${ruleOffset}ch`, boxSizing: 'border-box' }
						},
						gutterText
					)
				: null,
			// Wrap-mode layer (0.10.0, Task 8): the controller appends one
			// absolutely-positioned span per VISIBLE line here, so a wrapped
			// document never materializes a document-sized number block. The
			// band is the same digits sub-band as the block above (border-box
			// ruleOffset ch; its CSS padding-right ends the digits 1.5ch left
			// of the rule), so switching wrapping on/off never moves the
			// numbers sideways. Only mounted while both wrapping AND line
			// numbers are on; the controller's port no-ops when it is absent.
			wrapEnabled && gutterEnabled
				? h('div', {
						key: 'gutter-wrap',
						className: `${CLASS}-gutter-wrap`,
						ref: wrapGutterRef,
						'aria-hidden': true,
						style: { width: `${ruleOffset}ch`, boxSizing: 'border-box' }
					})
				: null
		),
		h('textarea', {
			ref: areaRef,
			className: textareaClassName,
			style: { paddingLeft: `${bandWidth}ch` },
			value: state.draft,
			spellCheck: false,
			// `soft` adds the browser's own soft-wrap rendering; the CSS class
			// carries the same rules the measurement mirror uses (same-source
			// contract, src/wrap-measure.js).
			wrap: wrapEnabled ? 'soft' : 'off',
			'aria-label': basenameOf(props.address),
			'data-dsh-editor-input': '',
			onKeyDown: onAreaKeyDown,
			onChange: (event) => controller.applyEdit(event.target.value),
			onSelect: reportSelection,
			onClick: reportSelection,
			onKeyUp: reportSelection,
			onScroll: () => {
				paintCaretLine();
				syncGutter();
				syncWrapGutter();
				syncRuler();
				// Whitespace rows reposition per scroll pixel like the gutter
				// band does; the callback's own guards no-op it while the
				// layer is off, unmounted, or wrapping.
				syncWhitespace();
				syncExtraLayers();
				syncMatches();
				// Report only a MEASURED, loaded textarea. While loading (or
				// hidden) the DOM offset is meaningless and must not overwrite
				// the last visible value the heal path depends on.
				const area = areaRef.current;
				if (area === null) return;
				if (state.phase !== 'ready' && state.phase !== 'saving') return;
				if (area.offsetParent === null) return;
				const next = { top: area.scrollTop, left: area.scrollLeft };
				lastVisibleScrollRef.current = next;
				if (typeof onScrollChange === 'function') onScrollChange(next);
			}
		})
	);
}

/* ---------------------------------------------------------- mode menu -- */

/**
 * The mode indicator's dropdown (spec §5.3): candidates are `entries()` whose
 * `matches` accepts the path; the effective mode is checked; every item
 * carries the two verbs "本次用 X 打开" (transient pin) and "设为默认"
 * (persisted association written from the mode's `globs`); the footer
 * restores ranking defaults by deleting the associations matching this path.
 * Preferences are refetched on open and written through the runtime's
 * `dshEditor/get|setModePreferences` bridge.
 */
function ModeMenu(props) {
	const t = props.t;
	const runtime = props.runtime;
	const targetPath = props.path;
	const panelRef = React.useRef(null);
	const [loading, setLoading] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	// { kind: 'load' | 'write' | 'conflict', message }
	const [error, setError] = React.useState(null);

	// Preferences are refetched on every menu open (spec ruling Q2.1=A).
	React.useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		runtime
			.refreshAssociations()
			.catch((refreshError) => {
				if (!cancelled) setError({ kind: 'load', message: messageOfError(refreshError) });
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [runtime]);

	// Close on outside pointer-down and on Escape.
	React.useEffect(() => {
		if (typeof document === 'undefined' || document === null) return undefined;
		const onPointerDown = (event) => {
			const panel = panelRef.current;
			if (panel === null || event.target === null || event.target === undefined) return;
			if (!panel.contains(event.target)) props.onClose();
		};
		const onKeyDown = (event) => {
			if (event.key === 'Escape') props.onClose();
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [props.onClose]);

	const entries = React.useMemo(() => {
		const all = runtime.modeRegistry.entries();
		return all.filter((entry) => {
			try {
				return typeof entry.matches !== 'function' || entry.matches(targetPath) === true;
			} catch {
				return false;
			}
		});
	}, [runtime, targetPath, props.registryTick]);

	const runPersist = async (action) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (persistError) {
			setError({
				kind: persistError !== null && typeof persistError === 'object' && persistError.conflict === true ? 'conflict' : 'write',
				message: messageOfError(persistError)
			});
		} finally {
			setBusy(false);
		}
	};

	const rows = entries.map((entry) => {
		const label = labelOfMode(entry, String(entry.id));
		const active = props.currentModeId === entry.id;
		return h(
			'div',
			{
				key: String(entry.id),
				className: `${CLASS}-menu-item`,
				role: 'menuitemcheckbox',
				'aria-checked': active ? 'true' : 'false'
			},
			h('span', { className: `${CLASS}-menu-check` }, active ? '✓' : ''),
			h('span', { className: `${CLASS}-menu-label`, title: label }, label),
			h(
				'button',
				{
					className: `${CLASS}-menu-action`,
					type: 'button',
					disabled: busy || loading,
					title: `${t('mode.transientTitle')} — ${label}`,
					onClick: () => props.onUseOnce(entry.id)
				},
				t('mode.transient')
			),
			h(
				'button',
				{
					className: `${CLASS}-menu-action`,
					type: 'button',
					disabled: busy || loading,
					title: `${t('mode.setDefaultTitle')} — ${label}`,
					onClick: () =>
						runPersist(async () => {
							await runtime.setDefaultMode(entry);
							props.onClearPin();
						})
				},
				t('mode.setDefault')
			)
		);
	});

	return h(
		'div',
		{ className: `${CLASS}-menu`, ref: panelRef, role: 'menu' },
		loading ? h('div', { key: 'loading', className: `${CLASS}-menu-note` }, t('mode.loading')) : null,
		error !== null
			? h(
					'div',
					{ key: 'error', className: `${CLASS}-menu-error`, title: error.message },
					error.kind === 'conflict'
						? t('mode.conflict')
						: `${t(error.kind === 'load' ? 'mode.loadFailed' : 'mode.writeFailed')}: ${error.message}`
				)
			: null,
		rows.length === 0 && !loading
			? h('div', { key: 'empty', className: `${CLASS}-menu-note` }, t('mode.none'))
			: null,
		...rows,
		h(
			'div',
			{ key: 'footer', className: `${CLASS}-menu-footer` },
			h(
				'button',
				{
					className: `${CLASS}-menu-reset`,
					type: 'button',
					disabled: busy || loading,
					title: t('mode.resetTitle'),
					onClick: () =>
						runPersist(async () => {
							await runtime.resetAssociationsFor(targetPath);
							props.onClearPin();
						})
				},
				t('mode.reset')
			)
		)
	);
}

/* ------------------------------------------------------ goto panel -- */

/**
 * The go-to-line popover (v0.6.0): opened by the `gotoLine` self-managed
 * binding (default Ctrl+G, recordable in the settings center's keymap
 * section). Anchored to the status bar's LEFT edge above the Ln/Col
 * indicator (the settings gear stays on the right edge). The input starts
 * EMPTY and is focused on open; Enter or the jump button parse it through
 * `parseGotoLine` (out-of-range clamps to the nearest existing line;
 * empty/non-numeric shows the inline range error instead of jumping) and
 * deliver the jump via
 * `controller.requestNavigate` — which lands the caret at the TARGET LINE'S
 * START (offsetOfLine semantics) and returns focus to the textarea. During
 * `loading` the jump stays enabled (the machine defers delivery to after
 * ready); `failed`/no-controller disables it. A repeat Ctrl+G while open
 * re-focuses the input (`focusTick`). Every open/close/parse/jump step
 * emits a `[dsh-editor] goto-line` debug trace (src/debug-log.js) so the
 * hotkey path's state is diagnosable from the verbose console.
 */
function GoToLinePopover(props) {
	const t = props.t;
	const controller = props.controller;
	const navable = props.navable === true; // controller present and not failed
	const loading = props.phase === 'loading';
	const lineCount = typeof props.lineCount === 'number' && props.lineCount >= 1 ? props.lineCount : 1;
	const currentLine = typeof props.currentLine === 'number' && props.currentLine >= 1 ? props.currentLine : 1;
	const panelRef = React.useRef(null);
	const inputRef = React.useRef(null);
	const [value, setValue] = React.useState('');
	const [invalid, setInvalid] = React.useState(false);

	// Open (and repeat-Ctrl+G refocus) lands the caret in the input at the
	// layout phase, pre-paint; select() so typing replaces any previous value.
	useLayoutEffectSafe(() => {
		const input = inputRef.current;
		if (input === null) return;
		input.focus();
		input.select();
	}, [props.focusTick]);

	// Close on outside pointer-down and on Escape — same surface rules as the
	// other popovers, each close carrying its reason in the debug trace.
	React.useEffect(() => {
		if (typeof document === 'undefined' || document === null) return undefined;
		const onPointerDown = (event) => {
			const panel = panelRef.current;
			if (panel === null || event.target === null || event.target === undefined) return;
			if (!panel.contains(event.target)) {
				props.log?.debug('goto-line', 'close (outside click)');
				props.onClose();
			}
		};
		const onKeyDown = (event) => {
			if (event.key === 'Escape') {
				props.log?.debug('goto-line', 'close (escape)');
				props.onClose();
			}
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [props.onClose]);

	const jump = () => {
		if (!navable) return;
		const parsed = parseGotoLine(value, lineCount);
		if (!parsed.ok) {
			setInvalid(true);
			props.log?.debug('goto-line', 'invalid input', JSON.stringify(value));
			return;
		}
		const accepted = controller.requestNavigate(parsed.line);
		props.log?.debug('goto-line', 'jump', parsed.line, accepted ? 'accepted' : 'rejected');
		if (accepted) props.onClose();
	};

	const maxText = String(lineCount);
	return h(
		'div',
		{ className: `${CLASS}-goto`, ref: panelRef, role: 'group', 'aria-label': t('goto.title') },
		h(
			'div',
			{ key: 'head', className: `${CLASS}-goto-head` },
			h('span', { key: 'title', className: `${CLASS}-goto-title` }, t('goto.title')),
			h(
				'span',
				{ key: 'ctx', className: `${CLASS}-goto-context`, title: t('goto.context').replace('{line}', String(currentLine)).replace('{max}', maxText) },
				t('goto.context').replace('{line}', String(currentLine)).replace('{max}', maxText)
			)
		),
		h(
			'div',
			{ key: 'row', className: `${CLASS}-goto-row` },
			h('input', {
				key: 'input',
				ref: inputRef,
				className: `${CLASS}-goto-input`,
				type: 'text',
				inputMode: 'numeric',
				value,
				placeholder: t('goto.placeholder').replace('{max}', maxText),
				'aria-label': t('goto.title'),
				spellCheck: false,
				onChange: (event) => {
					setValue(event.target.value);
					setInvalid(false); // typing clears the error
				},
				onKeyDown: (event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						jump();
					}
				}
			}),
			h(
				'button',
				{
					key: 'jump',
					className: `${CLASS}-goto-jump`,
					type: 'button',
					disabled: !navable,
					title: t('goto.jumpTitle'),
					onClick: jump
				},
				t('goto.jump')
			)
		),
		loading ? h('div', { key: 'loading', className: `${CLASS}-goto-note` }, t('goto.loading')) : null,
		invalid
			? h('div', { key: 'error', className: `${CLASS}-goto-note ${CLASS}-goto-error` }, t('goto.invalid').replace('{max}', maxText))
			: null
	);
}

/* --------------------------------------------------------- editor tab -- */

/**
 * The editor tab body for `sidebar.right.pane.tab`.
 *
 * Phase render (spec §5.4): `loading` by the framework (mode not mounted),
 * `failed` with retry + the `dsh-editor.unavailable` seat, `ready`/`saving`
 * with the mounted mode component (a conflict banner sits above it). Mode
 * switches re-resolve and swap the mode component only — draft, version and
 * dirty live in the machine and survive untouched.
 *
 * View state (0.8.0): every committed selection is persisted into the shared
 * runtime view-state store keyed by workspace root + path; the first loaded
 * render restores that caret and the remembered scroll once. An explicit
 * navigation suppresses the restore (it owns the caret); a mode switch instead
 * repositions the new mode from the last offset the previous mode reported,
 * without ever re-applying the caret.
 */
function EditorTab(props) {
	const t = props.t;
	const runtime = props.runtime;
	const renderSlot = typeof props.renderSlot === 'function' ? props.renderSlot : null;
	const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : { tab: {} };
	const tab = tabInfo.tab ?? {};
	const address = tab.contentId;
	const parsed = React.useMemo(() => parseFileAddress(address), [address]);
	const sessionId = parsed !== undefined && parsed.scope === 'session' ? parsed.sessionId : null;
	const targetPath = sessionId !== null ? parsed.path : null;
	const signal = tab.signal;
	const visible = tab.visible === true;
	const tabKey = tab.id;
	const valid = sessionId !== null && targetPath !== null;

	// --- controller lifecycle: one machine per (session, path, occurrence) ---
	const [controller, setController] = React.useState(null);
	React.useEffect(() => {
		if (!valid) return undefined;
		try {
			runtime.draftStore.prune();
			runtime.viewStateStore.prune();
		} catch {
			// best-effort LRU/expiry housekeeping
		}
		const created = createTabController({
			address,
			sessionId,
			path: targetPath,
			load: () => runtime.loadFile(sessionId, targetPath, signal),
			write: (content, baseVersion) => runtime.writeFile(sessionId, targetPath, content, baseVersion, signal),
			draftStore: runtime.draftStore,
			signal,
			autoReloadClean: () => runtime.getSettings().autoReloadClean === true
		});
		runtime.addLiveController(created);
		setController(created);
		return () => {
			runtime.removeLiveController(created);
			created.destroy();
		};
	}, [runtime, valid, address, sessionId, targetPath, signal]);

	// --- disk watch: external-change detection for THIS tab. The watch
	// reports facts (`{ version }` / `{ absent: true }`) into the machine,
	// which owns every bit of policy (dedup, asks, settings). Streaming comes
	// from the Host's `workspaceFiles/changes` push when the remote face
	// supports `$stream`; otherwise (or after a stream failure) the watch
	// degrades to manual mode and the entry's focus/visibility sweep calls
	// `checkNow()` — see the registration's `checkDisk` below. ---
	const watchRef = React.useRef(null);
	React.useEffect(() => {
		if (!valid || controller === null) return undefined;
		const watch = createDiskWatch({
			signal,
			openChanges: () => runtime.openChanges(sessionId, targetPath),
			stat: () => runtime.statFile(sessionId, targetPath),
			onNotice: (notice) => controller.notifyDiskState(notice)
		});
		watchRef.current = watch;
		return () => {
			if (watchRef.current === watch) watchRef.current = null;
			watch.dispose();
		};
	}, [runtime, valid, controller, sessionId, targetPath, signal]);

	// --- service registration: once per mounted tab; visibility flips and
	// sidebar-right session changes flow through the notifyChange source. ---
	const visibleRef = React.useRef(visible);
	visibleRef.current = visible;
	const changeRef = React.useRef(null);
	if (changeRef.current === null) changeRef.current = createChangeSource();

	React.useEffect(() => {
		changeRef.current.fire();
	}, [visible]);

	React.useEffect(() => {
		if (!valid || controller === null || tabKey === undefined || tabKey === null) return undefined;
		const detachMounted = runtime.subscribeMounted(() => changeRef.current.fire());
		const dispose = runtime.registerTab(tabKey, {
			sessionId,
			address,
			controller,
			isVisible: () => visibleRef.current,
			notifyChange: (listener) => changeRef.current.subscribe(listener),
			checkDisk: () => {
				const watch = watchRef.current;
				if (watch !== null) watch.checkNow();
			}
		});
		return () => {
			detachMounted();
			dispose();
		};
	}, [runtime, valid, controller, tabKey, sessionId, address]);

	// --- mode resolution: transient pin > persisted associations > ranking;
	// re-resolved when the registry, the associations cache or the pin change.
	// The machine only records modeId — the swap below remounts the component.
	const [transientPin, setTransientPin] = React.useState(undefined);
	const [registryTick, setRegistryTick] = React.useState(0);
	const [associationsTick, setAssociationsTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeModes(() => setRegistryTick((count) => count + 1)), [runtime]);
	React.useEffect(() => runtime.subscribeAssociations(() => setAssociationsTick((count) => count + 1)), [runtime]);

	React.useEffect(() => {
		if (!valid || controller === null) return;
		let modeId;
		try {
			modeId = resolveModeId(runtime.modeRegistry.entries(), targetPath, runtime.getAssociations(), transientPin);
		} catch {
			modeId = undefined;
		}
		controller.attachMode(modeId);
	}, [runtime, valid, controller, targetPath, transientPin, registryTick, associationsTick]);

	// --- navigation params: navigation.params.file.line → requestNavigate
	// (the machine defers during loading and delivers once after ready). ---
	const navigationLine = React.useMemo(() => {
		const params = tab.navigation !== undefined && tab.navigation !== null ? tab.navigation.params : undefined;
		const file = params !== undefined && params !== null ? params.file : undefined;
		return file !== undefined && file !== null && typeof file.line === 'number' && file.line >= 1 ? file.line : null;
	}, [tab.navigation]);

	React.useEffect(() => {
		if (controller === null || navigationLine === null) return;
		controller.requestNavigate(navigationLine);
	}, [controller, navigationLine]);

	// --- mode-menu plumbing: the visible tab exposes its opener so the
	// keyless `dshEditor.modeMenu` command can open the foreground menu. ---
	const [menuOpen, setMenuOpen] = React.useState(false);
	const closeMenu = React.useCallback(() => setMenuOpen(false), []);
	React.useEffect(() => {
		if (!visible || tabKey === undefined || tabKey === null) return undefined;
		return runtime.registerModeMenuOpener(tabKey, () => setMenuOpen(true));
	}, [runtime, visible, tabKey]);

	// --- self-managed keymap (spec §6): the ROOT element intercepts keydown
	// and dispatches against the shared keymap cache; a page-level
	// preventDefault works for ANY combo, so the natural keys survive the
	// web shortcuts whitelist. Re-render on keymap changes (the handler
	// itself always reads the live cache, never a stale closure). ---
	const [, setKeymapTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeKeymap(() => setKeymapTick((count) => count + 1)), [runtime]);
	// Re-render on settings changes too: the mounted mode component reads the
	// global preferences at render time (the active-line contract's
	// `highlightActiveLine` prop below), so a settings toggle lands on every
	// mounted editor tab immediately.
	const [, setSettingsTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeSettings(() => setSettingsTick((count) => count + 1)), [runtime]);
	// The wordWrap prop (0.11.0) is a THREE-layer resolution whose top layer is
	// the per-file-type override cache, so an override written by the settings
	// center — in this window or another one — must re-resolve the prop on
	// every mounted tab immediately (same subscription pattern as the settings
	// cache above).
	const [, setWrapOverridesTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeWrapOverrides(() => setWrapOverridesTick((count) => count + 1)), [runtime]);

	// The go-to-line popover (v0.6.0, the `gotoLine` binding): `gotoFocusTick`
	// bumps on a repeat Ctrl+G while open so the panel re-focuses its input.
	const [gotoOpen, setGotoOpen] = React.useState(false);
	const closeGoto = React.useCallback(() => setGotoOpen(false), []);
	const [gotoFocusTick, setGotoFocusTick] = React.useState(0);

	// The settings center (0.11.0) is an APPLICATION-level singleton owned by
	// the client entry, not a per-tab popover: the gear in the status bar only
	// calls `runtime.openSettings(path)` and renders nothing for it here. The
	// subscription tracks the singleton's open/close state so the tab that
	// OPENED the dialog can return focus to its gear when it closes (the
	// dialog's focus-on-open effect re-runs on every open because closing
	// unmounts the dialog component).
	const [, setSettingsDialogTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeSettingsDialog(() => setSettingsDialogTick((count) => count + 1)), [runtime]);
	const gearRef = React.useRef(null);
	const settingsDialog = runtime.getSettingsDialog();
	const settingsDialogWasOpenRef = React.useRef(false);
	React.useEffect(() => {
		const wasOpen = settingsDialogWasOpenRef.current;
		settingsDialogWasOpenRef.current = settingsDialog.open === true;
		if (!wasOpen || settingsDialog.open === true) return; // only the close edge
		if (tabKey === undefined || tabKey === null) return;
		if (settingsDialog.openerTabKey !== tabKey) return; // another tab opened it
		const gear = gearRef.current;
		if (gear !== null && typeof gear.focus === 'function') gear.focus();
	}, [settingsDialog.open, settingsDialog.openerTabKey, tabKey]);

	// --- 删除后原样保存的两段式确认：干净草稿 + 已删除文件时，保存的首次
	// 触发（按钮或 Ctrl+S）只布防确认，再次触发才执行重建；任何语义状态
	// 变化（编辑、外部状态翻转、相位变化）自动解除布防。重置效应挂在下方
	// machine state 派生区。 ---
	const [confirmRecreate, setConfirmRecreate] = React.useState(false);

	// The go-to-line popover is per-tab chrome and this tab stays mounted while
	// hidden (keepMounted): leaving it open across a visibility flip would show
	// a stale popover above a hidden tab, so a hidden tab always drops it. (The
	// keymap recorder moved to the application-level settings dialog in 0.11.0,
	// so it is not affected by this tab's visibility.)
	React.useEffect(() => {
		if (!visible) setGotoOpen(false);
	}, [visible]);

	const onRootKeyDown = React.useCallback(
		(event) => {
			if (event.isComposing === true) return; // IME composition is never ours
			const action = matchAction(event, runtime.getKeymap());
			if (action === undefined) return; // unmatched: browser default untouched
			// The framework claims the combo INSIDE the editor root — the
			// preventDefault suppresses the browser default for any
			// combination (Ctrl+S page save, Ctrl+D bookmark, …) even when
			// the business action below gates itself out.
			event.preventDefault();
			runtime.log?.debug('keymap', 'dispatch', action, comboOf(runtime.getKeymap()[action]));
			if (action === 'save') {
				if (controller === null) return; // no-op, combo still suppressed
				const snapshot = controller.getState();
				if (snapshot.phase !== 'ready' && snapshot.phase !== 'saving') return; // not ready: no-op
				if (snapshot.dirty === true) {
					setConfirmRecreate(false);
					runtime.requestSaveTab({ controller }, false);
					return;
				}
				// 干净草稿 + 已删除文件：首次触发只布防确认，再次触发才执行
				// （机器对已删除文件自动无版本意图写，干净草稿原样重建）。
				if (snapshot.external === 'deleted') {
					if (!confirmRecreate) setConfirmRecreate(true);
					else {
						setConfirmRecreate(false);
						runtime.requestSaveTab({ controller }, false);
					}
				}
			} else if (action === 'saveAll') {
				if (sessionId !== null) runtime.saveAllOfSession(sessionId);
			} else if (action === 'deleteLines') {
				if (controller !== null) runtime.deleteLinesFor({ controller });
			} else if (action === 'gotoLine') {
				if (controller === null) {
					runtime.log?.debug('goto-line', 'bail: no controller');
					return;
				}
				const snapshot = controller.getState();
				if (snapshot.phase === 'failed') {
					runtime.log?.debug('goto-line', 'bail: phase=failed');
					return; // no draft to navigate; combo still suppressed
				}
				if (gotoOpen) {
					setGotoFocusTick((tick) => tick + 1); // already open: re-focus the input
					return;
				}
				runtime.log?.debug('goto-line', 'open', `phase=${snapshot.phase}`, comboOf(runtime.getKeymap().gotoLine));
				setGotoOpen(true);
			}
		},
		[controller, runtime, sessionId, confirmRecreate, gotoOpen]
	);

	// --- machine state + derived chrome values ---
	const state = useControllerState(controller);
	const dirty = state.dirty === true;
	const deleted = state.external === 'deleted';

	// --- view state (0.8.0): the identity, persistence and one-shot restore of
	// this tab's remembered caret + scroll. One store instance lives on the
	// runtime (single localStorage key); every read/write path here is
	// best-effort and must never disturb the editor. ---
	const resolveViewStateKey = React.useCallback(() => {
		// Defensive on purpose: `sessionCwdOf` is optional runtime surface and
		// may legitimately be absent, throw, or only become available after
		// load — any of those must leave the session-id fallback in place.
		try {
			if (sessionId === null || targetPath === null) return undefined;
			const sessionCwd =
				typeof runtime.sessionCwdOf === 'function' ? runtime.sessionCwdOf(sessionId) : undefined;
			return viewStateKey(sessionCwd, sessionId, targetPath);
		} catch {
			return undefined;
		}
	}, [runtime, sessionId, targetPath]);
	const viewStateKeyValue = React.useMemo(() => resolveViewStateKey(), [resolveViewStateKey]);

	// The FIRST resolved mode is the baseline; any later change marks a mode
	// switch (the one event that asks for a remembered view even while
	// navigation owns the caret). These refs are updated during render BEFORE
	// the memos below so the switch render already sees `modeSwitched`.
	const firstModeIdRef = React.useRef(undefined);
	const hasModeSwitchedRef = React.useRef(false);
	if (state.modeId !== undefined) {
		if (firstModeIdRef.current === undefined) firstModeIdRef.current = state.modeId;
		else if (state.modeId !== firstModeIdRef.current) hasModeSwitchedRef.current = true;
	}
	const modeSwitched = hasModeSwitchedRef.current;

	const loaded = state.phase === 'ready' || state.phase === 'saving';
	const restoreViewState = shouldRestoreViewState({ loaded, navigationLine, modeSwitched });

	// The remembered record, re-read whenever the mode changes (a switch must
	// see what the previously mounted mode reported) and null while the tab is
	// loading, has no key, or navigation owns the caret.
	const initialViewState = React.useMemo(() => {
		if (!restoreViewState || viewStateKeyValue === undefined) return null;
		try {
			return runtime.viewStateStore.get(viewStateKeyValue) ?? null;
		} catch {
			return null;
		}
	}, [restoreViewState, viewStateKeyValue, state.modeId, runtime]);

	// The last offset a mounted mode reported; after a mode switch the new
	// mode's initial position comes from this live value, not the stale record.
	const lastKnownScrollRef = React.useRef(null);
	const initialScroll = React.useMemo(() => {
		if (!restoreViewState) return null;
		if (modeSwitched) {
			if (lastKnownScrollRef.current !== null) return lastKnownScrollRef.current;
			// Explicit navigation owns the viewport: when no visible scroll
			// report was observed, a remembered offset must not be re-applied
			// over the jump when the mode switches.
			if (navigationLine !== null) return null;
			return initialViewState === null
				? null
				: { top: initialViewState.scrollTop, left: initialViewState.scrollLeft };
		}
		if (initialViewState === null) return null;
		const target = { top: initialViewState.scrollTop, left: initialViewState.scrollLeft };
		// Seed the heal source before the mode reports a real offset, so a
		// hidden subtree that discards scrollTop can be restored on reveal.
		if (lastKnownScrollRef.current === null) lastKnownScrollRef.current = target;
		return target;
	}, [restoreViewState, modeSwitched, initialViewState, navigationLine]);

	// Selection persistence: every committed, loaded selection is mirrored into
	// the shared store, deduped on the four offset fields. The key is resolved
	// INSIDE the handler (never from the memo) so a late-arriving workspace
	// root is honored instead of a stale key.
	const lastPersistedSelectionRef = React.useRef(null);
	React.useEffect(() => {
		if (controller === null) return undefined;
		lastPersistedSelectionRef.current = null;
		const persistSelection = (snapshot) => {
			if (snapshot.phase !== 'ready' && snapshot.phase !== 'saving') return;
			const selection = snapshot.selection;
			if (selection === null || typeof selection !== 'object') return;
			const last = lastPersistedSelectionRef.current;
			if (
				last !== null &&
				last.start === selection.start &&
				last.end === selection.end &&
				last.lineStart === selection.lineStart &&
				last.lineEnd === selection.lineEnd
			) {
				return; // same caret/range already persisted: nothing to write
			}
			const key = resolveViewStateKey();
			if (key === undefined) return;
			const record = selectionRecordFromSnapshot(snapshot.draft, selection);
			if (record === null) return;
			try {
				runtime.viewStateStore.update(key, { selection: record });
			} catch {
				// best-effort: persistence never blocks the editor
			}
			lastPersistedSelectionRef.current = {
				start: selection.start,
				end: selection.end,
				lineStart: selection.lineStart,
				lineEnd: selection.lineEnd
			};
		};
		persistSelection(controller.getState());
		return controller.subscribe(persistSelection);
	}, [controller, resolveViewStateKey, runtime]);

	// Selection restore: exactly once per tab, on the first loaded render. A
	// mode switch never re-applies it (the mode component mirrors the machine
	// selection), and an explicit navigation already suppressed the restore by
	// that render, so this never fights a jump. Layout phase: the caret lands
	// before the first paint, alongside the scroll the mode restores.
	const selectionRestoredRef = React.useRef(false);
	useLayoutEffectSafe(() => {
		if (!loaded || selectionRestoredRef.current) return;
		selectionRestoredRef.current = true;
		if (!restoreViewState || controller === null || initialViewState === null) return;
		const record = initialViewState.selection;
		if (record === null || record === undefined) return;
		const selection = selectionFromViewState(state.draft, record);
		if (selection === null) return;
		controller.applySelection(selection);
	}, [loaded, restoreViewState, controller, initialViewState, state.draft]);

	// Scroll reporting: the mounted mode reports the offset it actually
	// reached. Only a loaded machine writes (a loading or hidden textarea reads
	// 0/0), and only the two validated fields go into the patch — an explicit
	// `undefined` own property would be rejected by the store.
	const onScrollChange = React.useCallback(
		(next) => {
			if (controller === null) return;
			const snapshot = controller.getState();
			if (snapshot.phase !== 'ready' && snapshot.phase !== 'saving') return;
			if (next === null || typeof next !== 'object') return;
			const top = next.top;
			const left = next.left;
			if (!Number.isFinite(top) || top < 0 || !Number.isFinite(left) || left < 0) return;
			lastKnownScrollRef.current = { top, left };
			const key = resolveViewStateKey();
			if (key === undefined) return;
			try {
				runtime.viewStateStore.update(key, { scrollTop: top, scrollLeft: left });
			} catch {
				// best-effort: persistence never blocks scrolling
			}
		},
		[controller, resolveViewStateKey, runtime]
	);

	// 布防解除：任何语义状态变化（编辑、外部状态翻转、相位变化）都让两段式
	// 确认回到初始态。
	React.useEffect(() => {
		setConfirmRecreate(false);
	}, [dirty, state.external, state.phase, state.saving]);
	const modeEntry = React.useMemo(() => {
		const all = runtime.modeRegistry.entries();
		return all.find((entry) => entry.id === state.modeId);
	}, [runtime, state.modeId, registryTick]);
	const modeLabel = modeEntry !== undefined ? labelOfMode(modeEntry, t('mode.none')) : t('mode.none');

	const caret = React.useMemo(() => {
		const selection = state.selection;
		if (selection === null || typeof selection.start !== 'number') return { line: 1, column: 1 };
		const line = lineOfOffset(state.draft, selection.start);
		return { line, column: selection.start - offsetOfLine(state.draft, line) + 1 };
	}, [state.selection, state.draft]);
	const lineCount = state.draft.length === 0 ? 1 : state.draft.split('\n').length;
	const chars = state.draft.length;

	// "Saved HH:MM" notice: fired when the draft settles clean after dirty.
	const [savedAt, setSavedAt] = React.useState(null);
	const wasDirtyRef = React.useRef(false);
	React.useEffect(() => {
		const wasDirty = wasDirtyRef.current;
		wasDirtyRef.current = state.dirty;
		if (state.dirty) {
			if (savedAt !== null) setSavedAt(null);
			return;
		}
		if (wasDirty && state.conflict !== true && state.phase === 'ready') setSavedAt(timeNow());
	}, [state.dirty, state.conflict, state.phase, savedAt]);

	const title = React.useMemo(() => basenameOf(address), [address]);

	// 保存按钮可用性：ready 相位且非保存中，dirty（常规）或已删除（原样重建）
	// 均可保存——文件被删除后保留的页签不再要求先修改内容。
	const saveEnabled = controller !== null && !state.saving && state.phase === 'ready' && (dirty || deleted);

	const onReload = React.useCallback(() => {
		if (controller !== null) controller.requestReload();
	}, [controller]);
	const onSave = React.useCallback(() => {
		if (controller === null) return;
		// 干净草稿 + 已删除文件：首次点击只布防确认（按钮变"确认重建"），
		// 再次点击才执行重建；其余情形（dirty、或文件未删除）直接进保存队列。
		if (!dirty && deleted && !confirmRecreate) {
			setConfirmRecreate(true);
			return;
		}
		setConfirmRecreate(false);
		controller.requestSave(false);
	}, [controller, dirty, deleted, confirmRecreate]);
	const onSaveAnyway = React.useCallback(() => {
		if (controller !== null) controller.requestSave(true);
	}, [controller]);
	const onCloseTab = React.useCallback(() => {
		const actions = tab.actions;
		if (actions !== undefined && actions !== null && typeof actions.close === 'function') actions.close();
	}, [tab.actions]);
	const onDismissExternal = React.useCallback(() => {
		if (controller !== null) controller.dismissExternalNotice();
	}, [controller]);
	const onSuppressExternal = React.useCallback(() => {
		if (controller !== null) controller.suppressExternalNotice();
	}, [controller]);

	// --- seats (spec §4.1): occupants receive the owner props plus the
	// session standard props, exactly like the shipped seats. ---
	const actionsSeat =
		renderSlot !== null && valid
			? h(
					'div',
					{ key: 'actions-seat', className: `${CLASS}-seat` },
					renderSlot('dsh-editor.actions', { address, path: targetPath, sessionId })
				)
			: null;
	const statusSeat =
		renderSlot !== null && valid
			? h(
					'span',
					{ key: 'status-seat', className: `${CLASS}-seat ${CLASS}-seat-status` },
					renderSlot('dsh-editor.status', {
						address,
						path: targetPath,
						sessionId,
						snapshot: {
							phase: state.phase === 'saving' ? 'ready' : state.phase,
							dirty,
							saving: state.saving,
							conflict: state.conflict,
							external: state.external,
							caret: { line: caret.line, column: caret.column },
							lineCount,
							chars
						}
					})
				)
			: null;
	const unavailableSeat = (failureMessage) =>
		renderSlot !== null
			? h(
					'div',
					{ key: 'unavailable-seat', className: `${CLASS}-seat ${CLASS}-seat-column` },
					renderSlot('dsh-editor.unavailable', {
						address,
						path: targetPath,
						sessionId,
						failure: failureMessage
					})
				)
			: null;

	// --- body by phase ---
	let body;
	if (!valid) {
		body = h(
			'div',
			{ key: 'unsupported', className: `${CLASS}-center` },
			h('div', { className: `${CLASS}-center-stack` }, h('div', null, t('error.unsupported')), unavailableSeat(t('error.unsupported')))
		);
	} else if (state.phase === 'failed') {
		body = h(
			'div',
			{ key: 'failed', className: `${CLASS}-center` },
			h(
				'div',
				{ className: `${CLASS}-center-stack` },
				h('div', null, describeLoadFailure(t, state.failure)),
				h(
					'button',
					{ className: `${CLASS}-btn`, type: 'button', title: t('action.reloadTitle'), onClick: onReload },
					t('action.reload')
				),
				unavailableSeat(
					state.failure !== null && typeof state.failure.message === 'string' ? state.failure.message : null
				)
			)
		);
	} else if (state.phase === 'loading') {
		body = h(
			'div',
			{ key: 'loading', className: `${CLASS}-center` },
			h(
				'div',
				{ className: `${CLASS}-center-stack` },
				h('span', { className: `${CLASS}-spinner`, 'aria-hidden': true }),
				h('div', null, t('state.loading'))
			)
		);
	} else {
		const ModeComponent =
			modeEntry !== undefined && typeof modeEntry.component === 'function' ? modeEntry.component : PlainTextMode;
		body = [
			// 外部修改询问（浅黄悬浮条）：是[重新加载] / 否[放弃更新] / 否[不再询问]
			state.externalNotice === 'modified'
				? h(
						'div',
						{ key: 'external', className: `${CLASS}-banner ${CLASS}-banner-external` },
						h('span', { key: 'text', className: `${CLASS}-banner-text` }, t('external.modified')),
						h(
							'button',
							{
								key: 'reload',
								className: `${CLASS}-btn`,
								type: 'button',
								disabled: state.saving,
								title: t('external.reloadTitle'),
								onClick: onReload
							},
							t('external.reload')
						),
						h(
							'button',
							{
								key: 'dismiss',
								className: `${CLASS}-btn`,
								type: 'button',
								disabled: state.saving,
								title: t('external.dismissTitle'),
								onClick: onDismissExternal
							},
							t('external.dismiss')
						),
						h(
							'button',
							{
								key: 'suppress',
								className: `${CLASS}-btn`,
								type: 'button',
								disabled: state.saving,
								title: t('external.suppressTitle'),
								onClick: onSuppressExternal
							},
							t('external.suppress')
						)
					)
				: null,
			// 外部删除询问（浅黄悬浮条 + 页签红字删除线）：[关闭页签] / [保留]
			state.externalNotice === 'deleted'
				? h(
						'div',
						{ key: 'external', className: `${CLASS}-banner ${CLASS}-banner-external` },
						h('span', { key: 'text', className: `${CLASS}-banner-text` }, t('external.deleted')),
						h(
							'button',
							{
								key: 'close',
								className: `${CLASS}-btn`,
								type: 'button',
								title: t('external.closeTabTitle'),
								onClick: onCloseTab
							},
							t('external.closeTab')
						),
						h(
							'button',
							{
								key: 'keep',
								className: `${CLASS}-btn`,
								type: 'button',
								title: t('external.keepTitle'),
								onClick: onDismissExternal
							},
							t('external.keep')
						)
					)
				: null,
			state.conflict
				? h(
						'div',
						{ key: 'conflict', className: `${CLASS}-banner` },
						h('span', { key: 'text', className: `${CLASS}-banner-text` }, t('conflict.banner')),
						h(
							'button',
							{
								key: 'reload',
								className: `${CLASS}-btn`,
								type: 'button',
								disabled: state.saving,
								title: t('action.reloadTitle'),
								onClick: onReload
							},
							t('action.reloadDiscard')
						),
						h(
							'button',
							{
								key: 'force',
								className: `${CLASS}-btn`,
								type: 'button',
								disabled: state.saving,
								onClick: onSaveAnyway
							},
							t('action.saveAnyway')
						)
					)
				: null,
			h(ModeComponent, {
				key: 'mode',
				controller,
				t,
				address,
				path: targetPath,
				sessionId,
				// The active-line contract (0.4.0): the global preference is
				// handed to every mounted mode; modes that declared
				// `activeLine` (contracts §5.1) draw the highlight, others
				// ignore the prop harmlessly.
				highlightActiveLine: runtime.getSettings().highlightActiveLine !== false,
				// The line-numbers contract (0.5.0): same shape, same reach —
				// modes honoring the preference draw the gutter, others ignore.
				showLineNumbers: runtime.getSettings().showLineNumbers !== false,
				// The scroll-beyond contract (0.9.0): same shape, same reach —
				// modes honoring the preference pad the scroll extent, others ignore.
				scrollBeyondLastLine: runtime.getSettings().scrollBeyondLastLine !== false,
				// The word-wrap contract (0.10.0, three layers since 0.11.0):
				// the CURRENT FILE's effective value — a matching `*.<ext>`
				// override wins, then the explicit stored setting, then the
				// builtin extension default (md-like files on). Modes that wrap
				// honor a literal `props.wordWrap === true`; others ignore the
				// prop harmlessly.
				wordWrap: resolveWordWrap(runtime.getRawSettings(), targetPath, runtime.getWrapOverrides()),
				// The whitespace-glyph contract (0.12.0): three independent global
				// booleans, all default false; modes honoring them draw the glyph layer,
				// others ignore the prop harmlessly.
				showWhitespace: {
					spaces: runtime.getSettings().showWhitespaceSpaces === true,
					tabs: runtime.getSettings().showWhitespaceTabs === true,
					newlines: runtime.getSettings().showWhitespaceNewlines === true
				},
				// The indentation contract (0.13.0): the two indent settings ride to every
				// mounted mode as one additive prop; the built-in plain-text mode resolves
				// the unit at keypress, others ignore the prop harmlessly.
				indentSettings: {
					indentMode: runtime.getSettings().indentMode,
					indentWidth: runtime.getSettings().indentWidth
				},
				// The ruler contract (0.14.0): the `showRuler` toggle plus the
				// `rulerColumn` position; modes honoring them draw the guide line,
				// others ignore the prop harmlessly.
				ruler: {
					enabled: runtime.getSettings().showRuler === true,
					column: runtime.getSettings().rulerColumn
				},
				// The match-highlight contract: the two layer toggles from the
				// settings center (word / selection), both read with the
				// `=== true` convention the settings keys' absence-safe default
				// demands; modes honoring them paint the match underlay, others
				// ignore the prop harmlessly.
				matchHighlight: {
					selection: runtime.getSettings().selectionHighlight === true,
					word: runtime.getSettings().wordHighlight === true
				},
				// The view-state adapter (0.8.0): the framework's read-once
				// restore target and the best-effort scroll reporter. Both are
				// optional; modes that ignore them are unaffected.
				initialScroll,
				onScrollChange,
				// The persistent log channel (0.17.0): the extra-backdrop-layer
				// paint containment degrades a broken descriptor through it.
				// Additive by contract — modes that ignore the prop are
				// unaffected (the same reach every preference prop has).
				log: runtime.log
			})
		];
	}

	const toolbar = h(
		'div',
		{ className: `${CLASS}-toolbar` },
		h('span', { key: 'name', className: `${CLASS}-name` }, title),
		h('span', { key: 'path', className: `${CLASS}-path`, title: targetPath ?? '' }, targetPath ?? ''),
		actionsSeat,
		dirty
			? h(
					'span',
					{ key: 'dirty', className: `${CLASS}-dirty`, title: t('state.dirty') },
					h('span', { key: 'dot', className: `${CLASS}-dirty-dot` }),
					t('state.dirty')
				)
			: null,
		h(
			'button',
			{
				key: 'reload',
				className: `${CLASS}-btn`,
				type: 'button',
				disabled: controller === null || state.saving,
				title: t('action.reloadTitle'),
				onClick: onReload
			},
			t('action.reload')
		),
		h(
			'button',
			{
				key: 'save',
				className: confirmRecreate ? `${CLASS}-btn warn` : `${CLASS}-btn primary`,
				type: 'button',
				disabled: !saveEnabled,
				title: confirmRecreate
					? t('action.recreateConfirmTitle')
					: t('action.saveTitle').replace('{combo}', comboOf(runtime.getKeymap().save)),
				onClick: onSave
			},
			state.saving ? t('state.saving') : confirmRecreate ? t('action.recreateConfirm') : t('action.save')
		)
	);

	const notice =
		state.lastError !== null
			? { tone: 'error', text: `${t('error.saveFailed')}: ${state.lastError}` }
			: savedAt !== null
				? { tone: 'ok', text: `${t('state.saved')} ${savedAt}` }
				: null;
	const statusBar = h(
		'div',
		{ className: `${CLASS}-status` },
		h(
			'span',
			{ key: 'meta', className: `${CLASS}-status-meta` },
			`Ln ${caret.line}, Col ${caret.column} · ${lineCount} ${t('status.lines')} · ${chars} ${t('status.chars')}`
		),
		statusSeat,
		notice !== null
			? h(
					'span',
					{
						key: 'notice',
						className:
							notice.tone === 'error'
								? `${CLASS}-status-notice ${CLASS}-notice-error`
								: `${CLASS}-status-notice ${CLASS}-notice-ok`,
						title: notice.text
					},
					notice.text
				)
			: null,
		gotoOpen
			? h(GoToLinePopover, {
					key: 'goto-popover',
					t,
					controller,
					log: runtime.log,
					navable: controller !== null && state.phase !== 'failed',
					phase: state.phase,
					currentLine: caret.line,
					lineCount,
					focusTick: gotoFocusTick,
					onClose: closeGoto
				})
			: null,
		// The mode indicator is view chrome and joins the status bar's
		// right-end control cluster (0.17.2). The bar is the positioned
		// ancestor (`position: relative`) and `.dsh-editor-menu` anchors with
		// `bottom: calc(100% + 4px)` — the dropdown opens UPWARD from the bar's
		// top edge, the goto popover's exact pattern. (0.17.1 had anchored it
		// inside the toolbar with a `top` anchor — on a bottom-bar child that
		// drops below the pane clip, the same invisible-dropdown class as the
		// original `-root` bug it fixed.)
		h(
			'button',
			{
				key: 'mode',
				className: `${CLASS}-mode-btn`,
				type: 'button',
				title: t('mode.indicatorTitle'),
				'aria-haspopup': 'menu',
				'aria-expanded': menuOpen ? 'true' : 'false',
				'data-dsh-editor-mode': state.modeId === undefined ? '' : state.modeId,
				onClick: () => setMenuOpen((open) => !open)
			},
			modeLabel,
			h('span', { key: 'caret-glyph', className: `${CLASS}-mode-caret`, 'aria-hidden': true }, '▾')
		),
		menuOpen && valid
			? h(ModeMenu, {
					key: 'mode-menu',
					t,
					runtime,
					path: targetPath,
					currentModeId: state.modeId,
					registryTick,
					onClose: closeMenu,
					onUseOnce: (id) => {
						setTransientPin(id);
						setMenuOpen(false);
					},
					onClearPin: () => setTransientPin(undefined)
				})
			: null,
		h(
			'button',
			{
				key: 'settings',
				className: `${CLASS}-status-btn`,
				type: 'button',
				title: t('settings.buttonTitle'),
				'aria-label': t('settings.buttonTitle'),
				ref: gearRef,
				onClick: () => runtime.openSettings(targetPath)
			},
			ICON_GEAR
		)
	);

	return h(
		'div',
		{
			className: `${CLASS}-root`,
			'data-dsh-editor-address': address ?? '',
			'data-dsh-editor-session': sessionId ?? '',
			'data-dsh-editor-visible': visible ? 'true' : 'false',
			onKeyDown: onRootKeyDown
		},
		toolbar,
		body,
		statusBar
	);
}

/* ---------------------------------------------------- tab title seat -- */

/**
 * The `sidebar.right.pane.tab.title` occupant for THIS framework's editor
 * tabs (same key dispatch as the body). Renders a 16px file-type icon (the
 * host's shared `FileTypeIcon`, classified by its shared `classifyFileType`
 * so the basename and final-dot parsing match the document preview tab byte
 * for byte) before the file name — like the host's fallback chip
 * (`display: contents`, so the strip keeps its own layout) — and paints the
 * name red with a strikethrough while the tab's machine reports an
 * externally deleted file (`state.external === 'deleted'`) — the durable
 * marker that survives the ask's dismissal. The red + strikethrough live on
 * a TEXT-ONLY inner span — never on the icon-bearing title span — because
 * CSS color inherits through `display: contents` and the host draws
 * monochrome icon kinds with `currentColor`: styling the title span itself
 * would tint the icon error-red while the file is deleted. The badge — a
 * 12px white disc carrying the derived 10px edit glyph at the icon's
 * bottom-left (0.16.0) — rides the same gate as the icon and is
 * theme-invariant by ruling: a white disc reads on both themes, so there is
 * deliberately no dark-theme override. Without the resolved host module
 * (`FILE_TYPE_ICON_API === null`) the icon, disc and title all fall back to
 * the plain name, as in 0.14.0.
 */
function EditorTabTitle(props) {
	const runtime = props.runtime;
	const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : { tab: {} };
	const tab = tabInfo.tab ?? {};
	const name = basenameOf(typeof tab.contentId === 'string' ? tab.contentId : '');
	const registration = runtime.getRegistration(tab.id);
	const controller =
		registration !== undefined && registration !== null && registration.controller !== undefined
			? registration.controller
			: null;
	const state = useControllerState(controller);
	const deleted = controller !== null && state.external === 'deleted';
	const iconProps = tabTitleIconProps(name, FILE_TYPE_ICON_API);
	/* The children (iconwrap + badge disc, filename text span) are built by
	 * the pure `buildTabTitleChildren` (see `tab-title-nodes.js`) so
	 * `node --test` can assert the element tree with a fake `h` — the 0.16.0
	 * review's mutation test showed source-text guards miss an empty-disc
	 * substitution. */
	const iconNode = iconProps !== null ? h(FILE_TYPE_ICON_API.FileTypeIcon, iconProps) : null;
	const children = buildTabTitleChildren({ h, iconNode, glyphHtml: TAB_TITLE_DISC_GLYPH_HTML, deleted, name });
	return h(
		'span',
		{
			className: `${CLASS}-tabtitle`,
			'data-dsh-editor-tabtitle': ''
		},
		...children
	);
}

/* ------------------------------------------------- preview edit button -- */

/**
 * Toolbar occupant for `sidebar.right.tab.document.actions`.
 *
 * Owner props: `{ absolutePath }`; session standard props supply `sessionId`
 * and `t`. Renders nothing for files the editor cannot edit, so image and PDF
 * previews stay untouched. Clicking opens the file in the editor tab type
 * through `openResource(address, { kind })` — the ONLY way files enter the
 * editor (the tab type claims no patterns).
 */
function EditButton(props) {
	const t = props.t;
	const runtime = props.runtime;
	const absolutePath = props.absolutePath;
	const sessionId = props.sessionId;
	const editable =
		typeof absolutePath === 'string' &&
		absolutePath.length > 0 &&
		sessionId !== undefined &&
		sessionId !== null &&
		isEditablePath(absolutePath.replace(/\\/g, '/'));
	if (!editable) return null;
	return h(
		'button',
		{
			className: `${CLASS}-tool-btn`,
			type: 'button',
			title: t('action.editTitle'),
			'aria-label': t('action.edit'),
			onClick: () => runtime.openFromPreview(sessionId, absolutePath)
		},
		ICON_EDIT
	);
}

/* ------------------------------------------------------------- export -- */

/** Wrap one component with the render boundary (logging through `log`). */
function guard(Component, log) {
	return function Guarded(props) {
		return h(EditorBoundary, { log }, h(Component, props));
	};
}

/**
 * Build the component set for one plugin activation. `runtime` is injected
 * into the tab/edit-button components' props here (the framework supplies
 * only its own standard props when rendering them).
 * @param {{ draftStore, viewStateStore, sessionCwdOf, log, loadFile, writeFile,
 *   modeRegistry, subscribeModes,
 *   getAssociations, subscribeAssociations, refreshAssociations, setDefaultMode,
 *   resetAssociationsFor, registerTab, subscribeMounted, registerModeMenuOpener,
 *   addLiveController, removeLiveController, openFromPreview, getKeymap,
 *   subscribeKeymap, setKeymap, getSettings, getRawSettings, subscribeSettings,
 *   setSettings, getWrapOverrides, subscribeWrapOverrides, openSettings,
 *   closeSettings, getSettingsDialog, subscribeSettingsDialog,
 *   saveAllOfSession, requestSaveTab, deleteLinesFor, highlightEngine }} runtime
 *   the live-context capabilities owned by the client entry; `log` is the
 *   persistent log channel (scope-tagged debug/warn/error calls);
 *   `highlightEngine` is the Task 7 engine singleton the code-highlight
 *   mode's token layer drives (absent → the mode degrades to plain text).
 */
export function createEditorComponents(runtime) {
	const log = runtime.log;
	const withRuntime = (Component) =>
		function WithRuntime(props) {
			return h(Component, { ...props, runtime });
		};
	return {
		EditorTab: withRuntime(EditorTab),
		EditorTabGuarded: guard(withRuntime(EditorTab), log),
		EditorTabTitle: withRuntime(EditorTabTitle),
		EditorTabTitleGuarded: guard(withRuntime(EditorTabTitle), log),
		EditButton: withRuntime(EditButton),
		EditButtonGuarded: guard(withRuntime(EditButton), log),
		PlainTextMode,
		// Code-highlight mode (0.17.0): PlainTextMode + the token backdrop.
		// Built ONCE per activation from the runtime's engine — the descriptor
		// itself is created per mounted component (a ref inside the shell).
		CodeHighlightMode: createCodeHighlightMode({
			engine: runtime.highlightEngine,
			PlainTextMode,
			createTokenLayerDescriptor,
			// 0.18.0: progressive files advance across background frames — the
			// descriptor subscribes here and repaints on every advance.
			subscribeProgress: runtime.onHighlightProgress
		})
	};
}
