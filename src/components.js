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
 *   bar (Ln/Col · lines · chars · `dsh-editor.status` seat · notice · keymap
 *   button), follows `navigation.params.file.line`, and intercepts keydown
 *   on its ROOT element to dispatch the framework's self-managed keymap
 *   actions (save / saveAll / deleteLines — spec §6).
 * - `PlainTextMode` — the built-in `plain-text` mode: one controlled textarea
 *   (`data-dsh-editor-input`) over an active-line highlight backdrop (the
 *   `highlightActiveLine` preference prop, 0.4.0), reporting edits and
 *   selections and serving `controller.onNavigate` line jumps.
 * - `ModeMenu` — the mode indicator's dropdown (spec §5.3).
 * - `KeymapPopover` — the status-bar keyboard button's panel: record /
 *   restore-default for the three self-managed bindings (spec §6).
 * - `SettingsPopover` — the status-bar gear button's panel: the behavior
 *   toggles (v0.3 `autoReloadClean`, v0.4 `highlightActiveLine`, v0.5
 *   `showLineNumbers`), persisted via `dshEditor/get|setSettings`.
 * - `EditorTabTitle` — the `sidebar.right.pane.tab.title` occupant: paints
 *   the tab's file name red + strikethrough while the file is externally
 *   deleted.
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
import { activeLineBar, lineHeightPxOf } from './active-line.js';
import { gutterWidthCh, contentPaddingCh, lineNumbersText } from './line-numbers.js';
import { lineOfOffset, lineOfOffsetFast, caretOffsetOfSelection, offsetOfLine } from './lines.js';
import { createTabController } from './tab-machine.js';
import { createDiskWatch } from './disk-watch.js';
import { resolveModeId } from './ranking.js';
import { matchAction, comboOf, normalizeKeymap, defaultKeymap, isReservedCombo } from './keymap.js';

/** CSS class prefix (also the debug-marker prefix). */
const CLASS = 'dsh-editor';

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
 * the failure and drops only the body it guards.
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
					console.error('[dsh-editor] editor body render failed:', error);
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

/** The 14px keyboard glyph for the status-bar keymap button. */
const ICON_KEYBOARD = h(
	'svg',
	{ width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
	h('rect', {
		x: 1.5,
		y: 4,
		width: 13,
		height: 8,
		rx: 1.5,
		stroke: 'currentColor',
		strokeWidth: 1.2
	}),
	h('path', {
		d: 'M4 7h.01M6.3 7h.01M8.6 7h.01M10.9 7h.01M13 9.8H3',
		stroke: 'currentColor',
		strokeWidth: 1.2,
		strokeLinecap: 'round'
	})
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
 * Active-line highlight (0.4.0, the `highlightActiveLine` preference): the
 * textarea renders transparent over a backdrop layer that marks the caret
 * line with top/bottom hairlines (VS Code-style line border; a multi-line
 * selection keeps its native paint — no fill to fight future syntax
 * highlighting). The bar's geometry is pure arithmetic (src/active-line.js)
 * against the textarea's measured `paddingTop`/`lineHeight` — exact because
 * the textarea never wraps (`wrap: 'off'` + `white-space: pre`). Painting is
 * synchronous at the DOM event (select/click/keyup re-derive the lines and
 * paint in-handler) so caret moves land on the next frame; scroll sync and
 * the React effect fallback are the only other writers. The mark stays
 * visible without focus: it shows where the caret is, not where the
 * keyboard is.
 *
 * Line-number gutter (0.5.0, the `showLineNumbers` preference): an
 * absolutely-positioned column of numbers beside the content, ONE text block
 * (`1\n2\n…\nN`, src/line-numbers.js) whose line-height and top padding match
 * the textarea's — exact for the same no-wrap reason the highlight is — plus
 * a 1px gray hairline at the gutter's right edge marking the boundary
 * between the numbers and the content. The textarea gains a matching
 * `padding-left` (digits + gap, in exact `ch` of the shared monospace font)
 * so content never slides under the numbers; the reservation is CONSTANT —
 * the padding stays whether or not the gutter renders, so toggling the
 * preference never shifts the content sideways. The column paints above
 * BOTH the highlight backdrop and the overlay textarea (z-index 2 vs 1 —
 * with wrap:'off' a horizontal scroll would otherwise sweep glyphs across
 * the numbers), ignores pointer events (clicks fall through to the
 * textarea), and follows vertical scroll by translating against `scrollTop`
 * in the same onScroll handler the highlight uses. Width tracks the widest
 * line number so crossing a power of ten reflows once, not per keystroke
 * (the text block memoizes on the line count).
 */
function PlainTextMode(props) {
	const controller = props.controller;
	const highlightEnabled = props.highlightActiveLine !== false;
	const gutterEnabled = props.showLineNumbers !== false;
	const state = useControllerState(controller);
	// Attached to the textarea below — the single DOM handle every selection
	// path reads (reportSelection, onNavigate, the mirror effect, and the
	// active-line sync). The v0.3.0/0.4.0 builds shipped WITHOUT this ref:
	// selections never reached the machine (caret frozen at Ln 1, deleteLines
	// always hit line 1, line navigation no-op) and the highlight never
	// synced — a latent wiring gap the active-line feature finally exposed.
	const areaRef = React.useRef(null);
	const barRef = React.useRef(null);
	const metricsRef = React.useRef(null);
	// Gutter scroll sync: the inner text block translates against scrollTop.
	const gutterTextRef = React.useRef(null);

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
	const gutterText = React.useMemo(() => (gutterEnabled ? lineNumbersText(lineCount) : ''), [gutterEnabled, lineCount]);
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
					metricsRef.current = { paddingTop, lineHeight };
				}
			} catch {
				// detached node: keep measuring lazily
			}
		}
		return metricsRef.current;
	}, []);

	// Paint the bar for an ALREADY-DERIVED line range. Pure imperative style
	// writes (sub-microsecond): the DOM event path (select/click/keyup) calls
	// this synchronously inside the handler, so caret moves land on the next
	// frame instead of trailing by React's async passive-effect scheduling
	// (~100ms — the visible lag this replaces).
	const paintBar = React.useCallback(
		(range) => {
			const area = areaRef.current;
			const bar = barRef.current;
			if (area === null || bar === null) return;
			const geometry = activeLineBar(range, metricsOfArea());
			bar.style.top = `${geometry.top}px`;
			bar.style.height = `${geometry.height}px`;
			bar.style.width = `${Math.max(area.scrollWidth || 0, area.clientWidth || 0)}px`;
			bar.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
		},
		[metricsOfArea]
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
		const signature = `${caretLine}:${area.scrollLeft}:${area.scrollTop}`;
		if (signature === lastPaintRef.current) return;
		lastPaintRef.current = signature;
		paintBar({ lineStart: caretLine, lineEnd: caretLine });
	}, [paintBar]);

	const reportSelection = React.useCallback(() => {
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
	}, [controller, paintCaretLine]);

	// The latest sync for passive observers — the ResizeObserver below must
	// not be torn down and rebuilt on every selection change. One sync for
	// both paint surfaces: the caret-line bar AND the gutter's scroll
	// translation (a hidden subtree can discard scrollTop without firing a
	// scroll event on re-show — the observer retry must heal the gutter too).
	const syncRef = React.useRef(paintCaretLine);
	React.useEffect(() => {
		syncRef.current = () => {
			paintCaretLine();
			syncGutter();
		};
	}, [paintCaretLine, syncGutter]);

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

	// Size/visibility restoration: an editor mounted (or toggled on) inside a
	// hidden session subtree caches no metrics (the guard above), so the
	// observer fires the retry the moment the textarea gains a real box —
	// session switch, sidebar reveal, pane resize — with no interaction.
	// observe() also dispatches an initial notification, doubling as a
	// post-layout resync on the very first mount.
	React.useEffect(() => {
		if (!highlightEnabled && !gutterEnabled) return undefined;
		const area = areaRef.current;
		if (area === null || typeof ResizeObserver !== 'function') return undefined;
		const observer = new ResizeObserver(() => syncRef.current());
		observer.observe(area);
		return () => observer.disconnect();
	}, [highlightEnabled, gutterEnabled]);

	// THE caret-follower: document-level `selectionchange` fires synchronously
	// with EVERY caret move — arrow keys included. The element-level events
	// cannot do this job: `select` never fires for a collapsed caret, so
	// key-driven moves used to wait for keyup (the visible ~100ms trail).
	// The focused-area check keeps hidden tabs' bars motionless.
	React.useEffect(() => {
		if (!highlightEnabled || typeof document === 'undefined') return undefined;
		const onSelectionChange = () => {
			const area = areaRef.current;
			if (area === null || document.activeElement !== area) return;
			paintCaretLine();
		};
		document.addEventListener('selectionchange', onSelectionChange);
		return () => document.removeEventListener('selectionchange', onSelectionChange);
	}, [highlightEnabled, paintCaretLine]);

	// Deliver framework line navigation into the textarea.
	React.useEffect(() => {
		return controller.onNavigate((line) => {
			const area = areaRef.current;
			if (area === null) return false;
			const target = Math.max(1, Math.floor(Number(line)));
			const offset = offsetOfLine(area.value, target);
			area.focus();
			area.setSelectionRange(offset, offset);
			const landed = lineOfOffset(area.value, offset);
			area.scrollTop = Math.max(0, (landed - 6) * 20);
			reportSelection();
			return true;
		});
	}, [controller, reportSelection]);

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
		// The gutter paints above the highlight backdrop AND the overlay
		// textarea (z-index 2 vs 1) so horizontally-scrolled glyphs cannot
		// sweep across the numbers; pointer-events none keeps clicks falling
		// through to the textarea's padding region. The band spans the WHOLE
		// reservation; the rule sits INSIDE it at the digits+gap offset, so
		// the strip right of the rule stays covered background too.
		gutterEnabled
			? h(
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
					h(
						'div',
						{ className: `${CLASS}-gutter-text`, ref: gutterTextRef },
						gutterText
					)
				)
			: null,
		h('textarea', {
			ref: areaRef,
			className: highlightEnabled ? `${CLASS}-area ${CLASS}-area-overlay` : `${CLASS}-area`,
			style: { paddingLeft: `${bandWidth}ch` },
			value: state.draft,
			spellCheck: false,
			wrap: 'off',
			'aria-label': basenameOf(props.address),
			'data-dsh-editor-input': '',
			onChange: (event) => controller.applyEdit(event.target.value),
			onSelect: reportSelection,
			onClick: reportSelection,
			onKeyUp: reportSelection,
			onScroll: () => {
				paintCaretLine();
				syncGutter();
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

/* ------------------------------------------------------ keymap panel -- */

/** Storable `event.code` alphabet for a recorded combo (Key-X / Digit-N). */
const RECORDABLE_CODE_RE = /^(Key[A-Z]|Digit[0-9])$/;

/**
 * The keymap popover (spec §6): opens from the status-bar keyboard icon.
 * Three rows (保存 / 保存全部 / 删行), each showing the current combo plus a
 * 「录制」button; recording captures the NEXT keydown at document-capture
 * level (any combination is admissible — the root-element interception
 * preventDefaults browser-reserved combos like Ctrl+S itself — and composing
 * states are ignored during recording per the task ruling; Escape cancels).
 * The footer restores the default bindings (Ctrl+S / Ctrl+Shift+S / Ctrl+D).
 * Writes go through the runtime's `dshEditor/setKeymap` bridge; a successful
 * write updates the shared cache so every mounted editor tab immediately
 * matches the new keys.
 */
function KeymapPopover(props) {
	const t = props.t;
	const runtime = props.runtime;
	const panelRef = React.useRef(null);
	/** The action being re-bound (`'save' | 'saveAll' | 'deleteLines' | null`). */
	const [recording, setRecording] = React.useState(null);
	const [busy, setBusy] = React.useState(false);
	// { kind: 'write' | 'conflict' | 'duplicate' | 'reserved', message }
	const [error, setError] = React.useState(null);

	// Re-render on keymap cache changes (recorder writes, conflict refetches).
	const [, setKeymapTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeKeymap(() => setKeymapTick((count) => count + 1)), [runtime]);

	// Close on outside pointer-down; Escape closes when not recording.
	React.useEffect(() => {
		if (typeof document === 'undefined' || document === null) return undefined;
		const onPointerDown = (event) => {
			const panel = panelRef.current;
			if (panel === null || event.target === null || event.target === undefined) return;
			if (!panel.contains(event.target)) props.onClose();
		};
		const onKeyDown = (event) => {
			if (event.key === 'Escape' && recording === null) props.onClose();
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [props.onClose, recording]);

	// The recorder: swallow every keydown at CAPTURE level while armed, so
	// neither the browser default nor the editor root's own keymap dispatch
	// fires mid-recording (e.g. re-binding Ctrl+S must not trigger a save).
	// BROWSER-RESERVED lifecycle combos (Ctrl+W closing the tab was observed
	// live) are REJECTED with a visible error — a page-level preventDefault
	// cannot reliably suppress those, so swallowing-and-hoping is not an
	// option; recording exits so the user is never stuck in a hidden
	// key-blackhole.
	React.useEffect(() => {
		if (recording === null || typeof document === 'undefined' || document === null) return undefined;
		const onKeyDown = (event) => {
			if (isReservedCombo(event)) {
				event.preventDefault();
				event.stopPropagation();
				setRecording(null);
				setError({ kind: 'reserved', message: t('keymap.reserved') });
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (event.key === 'Escape') {
				setRecording(null);
				return;
			}
			if (!RECORDABLE_CODE_RE.test(event.code)) return; // bare modifiers etc.: keep listening
			// The web runtime is Ctrl-based (task ruling): ctrlKey records as
			// the abstract 'primary', metaKey as the literal 'meta' modifier.
			const modifiers = [];
			if (event.ctrlKey) modifiers.push('primary');
			if (event.shiftKey) modifiers.push('shift');
			if (event.altKey) modifiers.push('alt');
			if (event.metaKey) modifiers.push('meta');
			if (modifiers.length === 0) return; // a bare key is not a combo; keep listening
			const action = recording;
			const candidate = { code: event.code, modifiers };
			const next = { ...runtime.getKeymap(), [action]: candidate };
			setRecording(null);
			if (normalizeKeymap(next) === undefined) {
				setError({ kind: 'duplicate', message: t('keymap.duplicate') });
				return;
			}
			setError(null);
			setBusy(true);
			runtime
				.setKeymap(next)
				.catch((writeError) => {
					setError({
						kind:
							writeError !== null && typeof writeError === 'object' && writeError.conflict === true
								? 'conflict'
								: 'write',
						message: messageOfError(writeError)
					});
				})
				.finally(() => setBusy(false));
		};
		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
		};
	}, [recording, runtime, t]);

	const runReset = () => {
		setBusy(true);
		setError(null);
		runtime
			.setKeymap(defaultKeymap())
			.catch((resetError) => {
				setError({
					kind:
						resetError !== null && typeof resetError === 'object' && resetError.conflict === true
							? 'conflict'
							: 'write',
					message: messageOfError(resetError)
				});
			})
			.finally(() => setBusy(false));
	};

	const rows = [
		{ action: 'save', label: t('keymap.save') },
		{ action: 'saveAll', label: t('keymap.saveAll') },
		{ action: 'deleteLines', label: t('keymap.deleteLines') }
	].map(({ action, label }) => {
		const binding = runtime.getKeymap()[action];
		const isRecording = recording === action;
		return h(
			'div',
			{ key: action, className: `${CLASS}-keymap-row` },
			h('span', { className: `${CLASS}-keymap-label` }, label),
			h(
				'span',
				{ className: `${CLASS}-keymap-combo`, title: isRecording ? t('keymap.recording') : comboOf(binding) },
				isRecording ? t('keymap.recording') : comboOf(binding)
			),
			h(
				'button',
				{
					className: `${CLASS}-keymap-record${isRecording ? ' recording' : ''}`,
					type: 'button',
					disabled: busy || (recording !== null && !isRecording),
					title: t('keymap.record'),
					onClick: () => {
						setError(null);
						setRecording(isRecording ? null : action);
					}
				},
				isRecording ? '✕' : t('keymap.record')
			)
		);
	});

	return h(
		'div',
		{ className: `${CLASS}-keymap`, ref: panelRef, role: 'menu' },
		error !== null
			? h(
					'div',
					{ key: 'error', className: `${CLASS}-keymap-error`, title: error.message },
					error.kind === 'conflict'
						? t('keymap.conflict')
						: error.kind === 'duplicate'
							? t('keymap.duplicate')
							: error.kind === 'reserved'
								? t('keymap.reserved')
								: `${t('keymap.writeFailed')}: ${error.message}`
				)
			: null,
		recording !== null ? h('div', { key: 'hint', className: `${CLASS}-keymap-hint` }, t('keymap.recording')) : null,
		...rows,
		h(
			'div',
			{ key: 'footer', className: `${CLASS}-keymap-footer` },
			h('span', { key: 'note', className: `${CLASS}-keymap-note` }, t('keymap.reservedHint')),
			h(
				'button',
				{
					className: `${CLASS}-keymap-reset`,
					type: 'button',
					disabled: busy || recording !== null,
					title: t('keymap.resetTitle'),
					onClick: runReset
				},
				t('keymap.reset')
			)
		)
	);
}

/* ----------------------------------------------------- settings panel -- */

/**
 * The settings popover (the status-bar gear icon's panel): behavior toggles
 * as a global user preference, persisted through the runtime's
 * `dshEditor/get|setSettings` bridge (Host KV table `settings`, SHARED
 * `updatedAt` CAS token — a conflicting write refetches and surfaces the
 * retry notice, exactly like the keymap recorder). One row per known setting
 * (`SETTINGS_ROWS`); a row may carry its own explanatory note (`noteKey`,
 * rendered under it — currently the one setting whose reach crosses modes).
 */

/** The popover's rows, in display order: setting key + locale stems. */
const SETTINGS_ROWS = [
	{ key: 'autoReloadClean', labelKey: 'settings.autoReloadClean', titleKey: 'settings.autoReloadCleanTitle' },
	{
		key: 'highlightActiveLine',
		labelKey: 'settings.highlightActiveLine',
		titleKey: 'settings.highlightActiveLineTitle',
		noteKey: 'settings.highlightActiveLineNote'
	},
	{
		key: 'showLineNumbers',
		labelKey: 'settings.showLineNumbers',
		titleKey: 'settings.showLineNumbersTitle'
	}
];

function SettingsPopover(props) {
	const t = props.t;
	const runtime = props.runtime;
	const panelRef = React.useRef(null);
	const [busy, setBusy] = React.useState(false);
	// { kind: 'write' | 'conflict', message }
	const [error, setError] = React.useState(null);

	// Re-render on settings cache changes (toggle writes, conflict refetches).
	const [, setSettingsTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeSettings(() => setSettingsTick((count) => count + 1)), [runtime]);

	// Close on outside pointer-down; Escape closes.
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

	const settings = runtime.getSettings();
	const runToggle = (key, current) => {
		setBusy(true);
		setError(null);
		runtime
			.setSettings({ [key]: !current })
			.catch((writeError) => {
				setError({
					kind:
						writeError !== null && typeof writeError === 'object' && writeError.conflict === true
							? 'conflict'
							: 'write',
					message: messageOfError(writeError)
				});
			})
			.finally(() => setBusy(false));
	};

	return h(
		'div',
		{ className: `${CLASS}-settings`, ref: panelRef, role: 'menu' },
		error !== null
			? h(
					'div',
					{ key: 'error', className: `${CLASS}-settings-error`, title: error.message },
					error.kind === 'conflict'
						? t('settings.conflict')
						: `${t('settings.writeFailed')}: ${error.message}`
				)
			: null,
		SETTINGS_ROWS.flatMap((row) => {
			const on = settings[row.key] === true;
			const cells = [
				h(
					'div',
					{ key: row.key, className: `${CLASS}-settings-row` },
					h('span', { className: `${CLASS}-settings-label`, title: t(row.titleKey) }, t(row.labelKey)),
					h(
						'button',
						{
							className: `${CLASS}-settings-toggle${on ? ' on' : ''}`,
							type: 'button',
							disabled: busy,
							title: t(row.titleKey),
							'aria-pressed': on ? 'true' : 'false',
							onClick: () => runToggle(row.key, on)
						},
						on ? t('settings.on') : t('settings.off')
					)
				)
			];
			if (typeof row.noteKey === 'string') {
				cells.push(h('div', { key: `${row.key}-note`, className: `${CLASS}-settings-note` }, t(row.noteKey)));
			}
			return cells;
		})
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
	const [keymapOpen, setKeymapOpen] = React.useState(false);
	const closeKeymap = React.useCallback(() => setKeymapOpen(false), []);

	// The settings popover (gear icon) follows the same visibility rule as the
	// keymap popover: a hidden tab always drops it (outside-click handlers
	// belong to the visible surface only).
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	const closeSettings = React.useCallback(() => setSettingsOpen(false), []);
	React.useEffect(() => {
		if (!visible) setSettingsOpen(false);
	}, [visible]);

	// --- 删除后原样保存的两段式确认：干净草稿 + 已删除文件时，保存的首次
	// 触发（按钮或 Ctrl+S）只布防确认，再次触发才执行重建；任何语义状态
	// 变化（编辑、外部状态翻转、相位变化）自动解除布防。重置效应挂在下方
	// machine state 派生区。 ---
	const [confirmRecreate, setConfirmRecreate] = React.useState(false);

	// The recorder arms a DOCUMENT-level capture listener, and this tab stays
	// mounted while hidden (keepMounted). Leaving the popover open across a
	// visibility flip would keep swallowing every keystroke on the page with
	// no visible cue — so a hidden tab always drops the popover (unmounting
	// it disarms the recorder through its effect cleanup).
	React.useEffect(() => {
		if (!visible) setKeymapOpen(false);
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
			}
		},
		[controller, runtime, sessionId, confirmRecreate]
	);

	// --- machine state + derived chrome values ---
	const state = useControllerState(controller);
	const dirty = state.dirty === true;
	const deleted = state.external === 'deleted';

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
				showLineNumbers: runtime.getSettings().showLineNumbers !== false
			})
		];
	}

	const toolbar = h(
		'div',
		{ className: `${CLASS}-toolbar` },
		h('span', { key: 'name', className: `${CLASS}-name` }, title),
		h('span', { key: 'path', className: `${CLASS}-path`, title: targetPath ?? '' }, targetPath ?? ''),
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
		h(
			'button',
			{
				key: 'keymap',
				className: `${CLASS}-keymap-btn`,
				type: 'button',
				title: t('keymap.buttonTitle'),
				'aria-label': t('keymap.buttonTitle'),
				'aria-haspopup': 'menu',
				'aria-expanded': keymapOpen ? 'true' : 'false',
				onClick: () => setKeymapOpen((open) => !open)
			},
			ICON_KEYBOARD
		),
		keymapOpen ? h(KeymapPopover, { key: 'keymap-popover', t, runtime, onClose: closeKeymap }) : null,
		h(
			'button',
			{
				key: 'settings',
				className: `${CLASS}-keymap-btn`,
				type: 'button',
				title: t('settings.buttonTitle'),
				'aria-label': t('settings.buttonTitle'),
				'aria-haspopup': 'menu',
				'aria-expanded': settingsOpen ? 'true' : 'false',
				onClick: () => setSettingsOpen((open) => !open)
			},
			ICON_GEAR
		),
		settingsOpen ? h(SettingsPopover, { key: 'settings-popover', t, runtime, onClose: closeSettings }) : null
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
		body,
		statusBar
	);
}

/* ---------------------------------------------------- tab title seat -- */

/**
 * The `sidebar.right.pane.tab.title` occupant for THIS framework's editor
 * tabs (same key dispatch as the body). Renders the file name like the
 * host's fallback chip (`display: contents`, so the strip keeps its own
 * layout), but paints it red with a strikethrough while the tab's machine
 * reports an externally deleted file (`state.external === 'deleted'`) —
 * the durable marker that survives the ask's dismissal.
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
	return h(
		'span',
		{
			className: deleted ? `${CLASS}-tabtitle ${CLASS}-tabtitle-deleted` : `${CLASS}-tabtitle`,
			'data-dsh-editor-tabtitle': ''
		},
		name
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

/** Wrap one component with the render boundary. */
function guard(Component) {
	return function Guarded(props) {
		return h(EditorBoundary, null, h(Component, props));
	};
}

/**
 * Build the component set for one plugin activation. `runtime` is injected
 * into the tab/edit-button components' props here (the framework supplies
 * only its own standard props when rendering them).
 * @param {{ draftStore, loadFile, writeFile, modeRegistry, subscribeModes,
 *   getAssociations, subscribeAssociations, refreshAssociations, setDefaultMode,
 *   resetAssociationsFor, registerTab, subscribeMounted, registerModeMenuOpener,
 *   addLiveController, removeLiveController, openFromPreview, getKeymap,
 *   subscribeKeymap, setKeymap, getSettings, subscribeSettings, setSettings,
 *   saveAllOfSession, requestSaveTab, deleteLinesFor }} runtime
 *   the live-context capabilities owned by the client entry.
 */
export function createEditorComponents(runtime) {
	const withRuntime = (Component) =>
		function WithRuntime(props) {
			return h(Component, { ...props, runtime });
		};
	return {
		EditorTab: withRuntime(EditorTab),
		EditorTabGuarded: guard(withRuntime(EditorTab)),
		EditorTabTitle: withRuntime(EditorTabTitle),
		EditorTabTitleGuarded: guard(withRuntime(EditorTabTitle)),
		EditButton: withRuntime(EditButton),
		EditButtonGuarded: guard(withRuntime(EditButton)),
		PlainTextMode
	};
}
