/**
 * CodeMirrorMode — the CM6 content surface behind the built-in
 * `code-highlight` mode (Task 9, spec §5.3/§5.4).
 *
 * ALL CodeMirror mechanics live in the lazy chunk (Task 1's loader
 * resolves it) and in `view.js` (Task 8's assembly, minted from the
 * chunk's cm6 record); every piece of decoration MATH lives in the pure
 * cores this module imports and passes through. This component is
 * composition + obligation wiring ONLY:
 *
 * - the async chunk gate: the first code-highlight mount of an activation
 *   pays the chunk transport (concurrent mounts share the loader's
 *   in-flight dedupe); the pending render reuses the framework's loading
 *   visual so the gate reads as an ordinary load. The view factory is
 *   minted ONCE per activation at module level — a second tab mounts
 *   without a second mint.
 * - the mode obligations (contracts §5.5, the CM6 mirror of PlainTextMode):
 *   edits and selections flow ONLY from the view's updateListener into
 *   `controller.applyEdit`/`controller.applySelection` (the exact
 *   reportSelection convention — 1-based line numbers, null text when
 *   collapsed); scroll offsets forward to `props.onScrollChange`;
 *   `controller.onNavigate` line jumps are claimed through the handle;
 *   `initialScroll` applies once the content is mounted; the view takes
 *   focus on first ready.
 * - the machine mirrors with echo suppression: the framework is the
 *   source of truth, so a machine write (`setContent`, a restored or
 *   machine-driven selection) is mirrored into the view through the
 *   handle — and because a CM6 transaction FIRES the updateListener (the
 *   DOM seam's programmatic writes raised no events), each mirror runs
 *   under a mirroring flag so the echo updates the bookkeeping and feeds
 *   the engine session but never re-enters the controller as a user
 *   report. The flag restores the old contract: a machine write reported
 *   back would re-dirty the draft.
 * - the engine session lifecycle: the path's table language is readied,
 *   the tab's session created and fed every doc change (user edits and
 *   machine mirrors alike); a path change disposes the old session
 *   before the new language is readied; the unmount hands the session
 *   back. Progressive files repaint through the engine's progress
 *   channel — each tick dispatches a no-op transaction so the view's
 *   decoration plugin rebuilds against the grown token cache (spec §5.6).
 * - degradation: a blocked loader, a rejected transport, a failed factory
 *   mint or a throwing view assembly — all land in ONE plain-text path:
 *   `log.warn` once, then PlainTextMode with the FULL mode-prop set
 *   forwarded verbatim (a plain-text editor with every preference
 *   honored). Degradation is one-way per component (and per activation,
 *   via the loader's negative cache): no retry storm, ever.
 * - React StrictMode's dev-only simulated unmount+remount runs every
 *   effect cleanup and re-runs the effects on the SAME instance: the
 *   teardowns drop the surface and session refs, so the re-runs rebuild
 *   cleanly (create/destroy/create idempotent — the descriptor.reset()
 *   precedent, mode-code-highlight.js:96-114).
 *
 * React-requiring (the bundler resolves `require('react')` in factory
 * scope, exactly like components.js) — not importable under node:test;
 * the guard test reads this file's text.
 *
 * @module @dybai/dsh-editor/cm6/component
 */

const React = require('react');
const h = React.createElement;

import { createCm6ViewFactory } from './view.js';
import { resolveExtensionPlan } from './view-plan.js';
import { lineTokenDecorations } from './highlight-adapter.js';
import { matchDecorationDescriptors } from './match-decorations.js';
import { whitespaceDecorationDescriptors } from './whitespace-decorations.js';
import { rulerGeometry } from './ruler-layer.js';
import { cm6BaseTheme } from './theme.js';
import { languageOf } from '../highlight/languages.js';
import { detectIndentUnit } from '../indent.js';
import { offsetOfLine } from '../lines.js';
import { activeLineRangeOf } from '../active-line.js';
import { shouldFocusEditorOnOpen } from '../view-state.js';

/** CSS class prefix (mirrors components.js's CLASS — the loading shape reuses its rules). */
const CLASS = 'dsh-editor';

/**
 * The activation-level view factory: minted ONCE from the first resolved
 * chunk's `cm6` record and shared by every mounted CodeMirrorMode of this
 * activation (the mark decorations and widget classes the factory mints
 * are per-record singletons — a second mint would leak a second set).
 * Module scope, not a ref: the cache outlives component instances the
 * same way the loader's positive cache does.
 * @type {((options: object) => object) | null}
 */
let cm6Factory = null;

/** `React.useSyncExternalStore` when the host React provides it (spec §4.2, the components.js precedent). */
const useExternalStore = typeof React.useSyncExternalStore === 'function' ? React.useSyncExternalStore : null;

/** useLayoutEffect when the host React provides it (pre-paint first-render duties, the components.js precedent). */
const useLayoutEffectSafe = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

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

/** Translation fallback: a mode mounted without `t` still renders its loading label. */
const T_FALLBACK = (key) => key;

/**
 * Subscribe to a controller's snapshot store (or the loading
 * placeholder). `React.useSyncExternalStore` when the host React provides
 * it; otherwise the useState/useEffect fallback. Both hooks always run,
 * so the hook order is stable whichever branch the host takes — the
 * components.js precedent.
 * @param {object | null} controller - the tab controller.
 * @returns {object} the machine snapshot.
 */
function useControllerState(controller) {
	const fallbackSnapshot = useSubscriptionFallback(controller);
	if (useExternalStore !== null) {
		return useExternalStore(
			controller === null ? subscribeNothing : controller.subscribe,
			controller === null ? getNoControllerSnapshot : controller.getState
		);
	}
	return fallbackSnapshot;
}

/** useState/useEffect subscription fallback for React without the store hook. */
function useSubscriptionFallback(controller) {
	const [snapshot, setSnapshot] = React.useState(() =>
		controller === null ? NO_CONTROLLER_SNAPSHOT : controller.getState()
	);
	React.useEffect(() => {
		// The store hook owns the subscription when present — the fallback
		// then stays dormant (one dead branch, zero double subscriptions).
		if (useExternalStore !== null) return undefined;
		if (controller === null) {
			setSnapshot(NO_CONTROLLER_SNAPSHOT);
			return undefined;
		}
		setSnapshot(controller.getState());
		return controller.subscribe(setSnapshot);
	}, [controller]);
	return snapshot;
}

/**
 * Whether the machine's selection diverges from what the view last
 * reported (or mirrored): offsets only — the DOM seam's own comparison
 * (components.js ~2288). The line fields follow from the offsets.
 * @param {object} selection - the machine snapshot's selection.
 * @param {any} last - the last selection the view reported (`null`
 *   before the first report).
 * @returns {boolean}
 */
function selectionDiverges(selection, last) {
	if (last === null || typeof last !== 'object') return true;
	return selection.start !== last.start || selection.end !== last.end;
}

/** Error text for log lines — never throws on a non-Error rejection value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Pre-resolve the indent settings for the plan (the indent 'auto'
 * parity). view.js's indentUnit takes the plan's mode literally, so a
 * raw 'auto' would flatten to spaces while the DOM seam's
 * `resolveIndentUnit` auto-detects the unit from the content. The
 * detection itself is src/indent.js's pure `detectIndentUnit` (never
 * re-implemented here); this helper only folds its answer into the
 * settings shape `resolveExtensionPlan` consumes: a detected unit wins,
 * and a file with no signal falls back to the configured width in spaces
 * (resolveIndentUnit's own fallback shape).
 * @param {object} props - the mode props (`indentSettings`).
 * @param {{ mode: 'tabs' } | { mode: 'spaces', width: number } | null} detected -
 *   `detectIndentUnit`'s answer for the current draft.
 * @returns {object} the effective `{ indentMode, indentWidth }`.
 */
function resolvedIndentSettings(props, detected) {
	const settings = props.indentSettings !== null && typeof props.indentSettings === 'object' ? props.indentSettings : {};
	if (settings.indentMode === 'auto') {
		if (detected !== null && detected.mode === 'tabs') {
			return { indentMode: 'tabs', indentWidth: settings.indentWidth };
		}
		if (detected !== null && detected.mode === 'spaces') {
			return { indentMode: 'spaces', indentWidth: detected.width };
		}
		return { indentMode: 'spaces', indentWidth: settings.indentWidth };
	}
	return settings;
}

/**
 * Focus the mounted view on first ready — PlainTextMode's discipline
 * (components.js ~2257): never steal focus from another text entry (the
 * chat composer), never focus a hidden view. `shouldFocusEditorOnOpen`
 * owns the verdict (the shared pure helper).
 * @param {object} surface - the mounted CM6 surface ({ view, handle }).
 */
function focusViewIfAllowed(surface) {
	const view = surface.view;
	const active = typeof document !== 'undefined' ? document.activeElement : null;
	const activeIsSelf = active === view.contentDOM;
	const activeIsTextEntry =
		active !== null &&
		!activeIsSelf &&
		(active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable === true);
	const attached = view.dom.offsetParent !== null;
	if (!shouldFocusEditorOnOpen({ attached, activeIsSelf, activeIsTextEntry })) return;
	try {
		view.focus();
	} catch {
		// detached view
	}
}

/**
 * Build the CodeMirrorMode component for one plugin activation.
 *
 * @param {object} deps - injected collaborators (Task 10's entry wiring):
 * - `cm6Loader`: the Task 1 chunk loader (`loadCm6()`, `isBlocked()`).
 * - `engine`: the highlight engine singleton
 *   (`ready`/`createSession`/`update`/`dispose`).
 * - `PlainTextMode`: the built-in mode component the degradation path
 *   renders (passed rather than imported to keep the module graph
 *   one-directional — components.js owns both halves).
 * - `subscribeProgress`: the engine's progress subscription.
 * - `log`: the leveled log channel (`log.warn(scope, text)`).
 * @returns {(props: any) => any} the CodeMirrorMode component.
 */
export function createCodeMirrorMode({ cm6Loader, engine, PlainTextMode, subscribeProgress, log }) {
	const logSource = log === null || log === undefined ? {} : log;
	const logWarn = typeof logSource.warn === 'function' ? logSource.warn.bind(logSource) : () => {};

	return function CodeMirrorMode(props) {
		const controller = props.controller;
		const state = useControllerState(controller);
		const t = typeof props.t === 'function' ? props.t : T_FALLBACK;

		// The surface phase: 'pending' (the chunk gate is open, the loading
		// shape shows), 'ready' (the view is mounted) or 'degraded' (the
		// plain-text fallback owns this tab for good).
		const [phase, setPhase] = React.useState('pending');

		/* ---- refs: the live values the effects and callbacks read ---- */
		const hostRef = React.useRef(null);
		const surfaceRef = React.useRef(null);
		const sessionRef = React.useRef(null);
		// THE echo-suppression flag: armed around every machine-mirror
		// dispatch so the updateListener's reports never re-enter the
		// controller as user edits/selections.
		const mirroringRef = React.useRef(false);
		const lastTextRef = React.useRef(null);
		const lastSelectionRef = React.useRef(null);
		const degradedRef = React.useRef(false);
		const initialScrollAppliedRef = React.useRef(false);
		const focusedRef = React.useRef(false);

		// Ref-during-render (the mode-code-highlight.js:74 pattern): the
		// async continuations and per-dispatch callbacks read the LIVE
		// values, never a stale closure.
		const pathRef = React.useRef(null);
		pathRef.current = props.path;
		const draftText = typeof state.draft === 'string' ? state.draft : '';
		const draftRef = React.useRef('');
		draftRef.current = draftText;
		const selectionSnapshotRef = React.useRef(null);
		selectionSnapshotRef.current = state.selection;
		const controllerRef = React.useRef(null);
		controllerRef.current = controller;
		const onScrollChangeRef = React.useRef(null);
		onScrollChangeRef.current = props.onScrollChange;

		/** Feed the engine session a doc change (idempotent for unchanged text). */
		const feedSession = React.useCallback(
			(text) => {
				const session = sessionRef.current;
				if (session === null || engine === null || engine === undefined) return;
				try {
					engine.update(session, text);
				} catch {
					// a throwing engine degrades to plain ink — never breaks the edit
				}
			},
			[engine]
		);

		/** Degradation is one-way per component: log once, leave the CM6 path. */
		const degrade = React.useCallback(
			(reason, error) => {
				if (degradedRef.current) return;
				degradedRef.current = true;
				logWarn('cm6', `code-highlight degraded to plain text — ${reason} (${error === undefined ? 'no error detail' : messageOf(error)})`);
				setPhase('degraded');
			},
			[logWarn]
		);

		/**
		 * A no-op transaction: the decoration plugin's update rebuilds the
		 * decoration set on every dispatch, so an empty-effects dispatch is
		 * THE repaint signal — progress ticks and session installs ride it.
		 */
		const repaint = React.useCallback(() => {
			const surface = surfaceRef.current;
			if (surface === null) return;
			try {
				surface.view.dispatch({ effects: [] });
			} catch {
				// a destroyed or mid-teardown view is skipped
			}
		}, []);

		// The extension plan (Task 8's pure normalizer), with the indent
		// 'auto' pre-resolution: the detection memoizes on the draft (its
		// only input), and the reconfigure effect below keys on the plan's
		// SERIALIZED shape — a draft edit that moves neither the detected
		// unit nor any preference costs no transaction.
		const detectedIndent = React.useMemo(() => detectIndentUnit(draftText), [draftText]);
		const plan = resolveExtensionPlan({
			showLineNumbers: props.showLineNumbers,
			highlightActiveLine: props.highlightActiveLine,
			wordWrap: props.wordWrap,
			scrollBeyondLastLine: props.scrollBeyondLastLine,
			showWhitespace: props.showWhitespace,
			ruler: props.ruler,
			indentSettings: resolvedIndentSettings(props, detectedIndent),
			matchHighlight: props.matchHighlight,
		});
		const planKey = JSON.stringify(plan);

		/* ---- the async chunk gate ---- */
		// The first code-highlight mount of an activation pays the chunk
		// transport; concurrent mounts share the loader's in-flight
		// dedupe. A blocked loader (a previously failed transport — the
		// negative cache) degrades BEFORE any transport call, and a
		// degraded component never re-tries: the render has already left
		// the CM6 path for this tab's lifetime.
		React.useEffect(() => {
			if (degradedRef.current) return undefined;
			if (cm6Loader === null || typeof cm6Loader !== 'object' || typeof cm6Loader.loadCm6 !== 'function') {
				degrade('the cm6 loader is missing');
				return undefined;
			}
			if (typeof cm6Loader.isBlocked === 'function' && cm6Loader.isBlocked()) {
				degrade('the cm6 chunk is blocked after a failed load');
				return undefined;
			}
			let cancelled = false;
			cm6Loader.loadCm6().then(
				(chunkExports) => {
					if (cancelled) return;
					try {
						// The activation-level mint: ONE factory per
						// activation, shared by every later mount.
						if (cm6Factory === null) {
							cm6Factory = createCm6ViewFactory(chunkExports.cm6);
						}
					} catch (error) {
						degrade('the view factory mint failed', error);
						return;
					}
					setPhase('ready');
				},
				(error) => {
					if (!cancelled) degrade('the cm6 chunk load failed', error);
				}
			);
			return () => {
				cancelled = true;
			};
		}, [cm6Loader, degrade]);

		/* ---- the view assembly + the obligation wiring ---- */
		// Runs when the chunk gate flips the phase to 'ready' (layout
		// phase: the editor's DOM lands in the same paint as the loading
		// shape's disappearance). The view is created ONCE per surface —
		// preference flips re-dispatch through reconfigure below, never a
		// rebuild. StrictMode's simulated unmount+remount runs the cleanup
		// and re-runs THIS effect on the same instance: the cleanup drops
		// the surface ref first, so the re-run rebuilds cleanly
		// (create/destroy/create idempotent).
		useLayoutEffectSafe(() => {
			if (phase !== 'ready') return undefined;
			const host = hostRef.current;
			if (host === null || cm6Factory === null) return undefined;
			const docText = draftText;

			// The obligation seam: the ten pinned members (R9). The
			// callbacks read refs — never the closure's render snapshot —
			// so a controller or reporter identity change never leaves the
			// wired view stale.
			const deps = {
				onEdit: (text) => {
					// The session eats every doc change — user edits AND
					// machine mirrors alike (update is idempotent for
					// unchanged text, and a machine-written document must
					// tokenize too).
					feedSession(text);
					lastTextRef.current = text;
					// Echo suppression: a machine mirror's transaction fires
					// this listener. The DOM seam's programmatic writes
					// raised no events; the flag restores that contract —
					// the machine's own write must never be re-reported as
					// a user edit.
					if (mirroringRef.current === true) return;
					const live = controllerRef.current;
					if (live !== null) live.applyEdit(text);
				},
				onSelection: (selection) => {
					lastSelectionRef.current = selection;
					// Same echo contract as onEdit: a machine-driven
					// selection transaction never re-enters the controller.
					if (mirroringRef.current === true) return;
					const live = controllerRef.current;
					if (live === null) return;
					// PlainTextMode's reportSelection convention
					// (normative, components.js ~1808): normalized offsets,
					// the 1-based line numbers the view derives, null text
					// when collapsed.
					live.applySelection({
						start: selection.start,
						end: selection.end,
						lineStart: selection.lineStart,
						lineEnd: selection.lineEnd,
						text: selection.start === selection.end ? null : selection.text,
					});
				},
				onScroll: (offset) => {
					// Scroll reports ride the framework's best-effort
					// channel — only when the mode actually provided one.
					const report = onScrollChangeRef.current;
					if (typeof report !== 'function') return;
					report({ top: offset.top, left: offset.left });
				},
				// Live accessor: the session is created asynchronously and
				// re-created per path; a value captured here would freeze
				// the null of the creation moment forever.
				get session() {
					return sessionRef.current;
				},
				// The pure cores, passed through verbatim — the decoration
				// math never lives in this component.
				lineTokenDecorations,
				matchDecorationDescriptors,
				whitespaceDecorationDescriptors,
				rulerGeometry,
				cm6BaseTheme,
				// R9: the active-line ranges derive from the controller's
				// selection snapshot — 1-based inclusive lines (the
				// active-line core's own normalization) translated to
				// document offsets.
				activeLineRanges: () => {
					const selection = selectionSnapshotRef.current;
					if (selection === null || typeof selection !== 'object') return [];
					const text = draftRef.current;
					const { lineStart, lineEnd } = activeLineRangeOf(selection);
					const ranges = [];
					for (let line = lineStart; line <= lineEnd; line += 1) {
						ranges.push({ from: offsetOfLine(text, line), to: offsetOfLine(text, line) });
					}
					return ranges;
				},
			};

			let surface = null;
			try {
				surface = cm6Factory({ plan, deps, docText, host });
			} catch (error) {
				// A throwing assembly degrades to the plain-text path
				// (spec §8.3) — the guard-pinned destroy-only teardown
				// needs nothing here; the degrading render unmounts the
				// host div (and any half-built DOM with it).
				degrade('the view assembly failed', error);
				return undefined;
			}
			surfaceRef.current = surface;
			// The fresh view shows exactly the machine draft — the mirror
			// effect re-applies any machine selection on top of it.
			lastTextRef.current = docText;
			return () => {
				// Unmount / phase change / StrictMode re-run: drop the
				// surface ref FIRST (every later path no-ops on null), then
				// destroy the view. The handle's teardown is view.destroy()
				// only (Task 8's Review Focus 5) — no obligation reports, no
				// content writes, ever. Dropping the last selection report
				// re-arms the mirror effect's next run: the remounted view
				// (StrictMode) starts at cursor 0, so the machine selection
				// must mirror onto it afresh instead of being deduped away.
				surfaceRef.current = null;
				lastSelectionRef.current = null;
				try {
					surface.handle.destroy();
				} catch {
					// teardown never breaks unmount
				}
			};
		}, [phase]);

		/* ---- the engine session lifecycle ---- */
		// After the view is ready: resolve the path's table language, ready
		// it (the lazy-group transport — ready never rejects), then create
		// the tab's session and feed it the draft. A PATH change (session
		// move, rename) re-runs the effect: the cleanup hands the old
		// session back to the engine before the new language is readied
		// (the token-layer discipline). A path outside the table never
		// creates a session — the view's token layer renders plain ink,
		// exactly like the DOM seam.
		React.useEffect(() => {
			if (phase !== 'ready') return undefined;
			if (engine === null || engine === undefined) return undefined;
			const lang = languageOf(pathRef.current);
			if (lang === undefined) return undefined;
			let cancelled = false;
			let session = null;
			const arm = async () => {
				// ready() never rejects — unknown languages and failed
				// group loads resolve false (the engine logs them itself).
				await engine.ready(lang);
				if (cancelled) return;
				try {
					session = engine.createSession(lang);
				} catch {
					session = null;
					return;
				}
				sessionRef.current = session;
				feedSession(draftRef.current);
				// The decoration plugin rebuilds on transactions only —
				// dispatch one so the fresh session's token rows paint
				// without waiting for a user event.
				repaint();
			};
			arm();
			return () => {
				cancelled = true;
				if (session !== null) {
					try {
						engine.dispose(session);
					} catch {
						// teardown never breaks unmount
					}
				}
				if (sessionRef.current === session) sessionRef.current = null;
			};
		}, [phase, props.path, engine, feedSession]);

		/* ---- the machine mirror (echo-suppressed) ---- */
		// THE framework-is-source-of-truth seam (spec §5.4): a machine
		// write — setContent (delete-lines, reload, the recreate flow), a
		// machine selection (restored caret, navigation) — must land in
		// the view. The DOM seam got this for free: its CONTROLLED
		// textarea re-rendered `value`, and its programmatic selection
		// writes raised no report events. A CM6 transaction is needed
		// instead, and every transaction fires the updateListener — so
		// each mirror runs under the mirroring flag: the echo updates the
		// bookkeeping refs and feeds the session, but never re-enters the
		// controller as a user report.
		React.useEffect(() => {
			if (phase !== 'ready') return;
			const surface = surfaceRef.current;
			if (surface === null) return;
			const text = draftText;
			const selection = state.selection;
			if (text !== lastTextRef.current) {
				mirroringRef.current = true;
				try {
					surface.handle.setContent(text, selection);
					lastTextRef.current = text;
				} catch {
					// a failing machine mirror never breaks the component
				} finally {
					mirroringRef.current = false;
				}
			}
			if (selection === null || typeof selection !== 'object') return;
			if (selectionDiverges(selection, lastSelectionRef.current)) {
				mirroringRef.current = true;
				try {
					surface.handle.mirrorMachineSelection(selection);
					lastSelectionRef.current = selection;
				} catch {
					// a failing machine mirror never breaks the component
				} finally {
					mirroringRef.current = false;
				}
			}
		}, [state.draft, state.selection, phase]);

		/* ---- live preference flips ---- */
		// The plan re-derives per render (a handful of literals plus the
		// memoized detection); the view re-dispatches only when its
		// SERIALIZED shape moves.
		React.useEffect(() => {
			if (phase !== 'ready') return;
			const surface = surfaceRef.current;
			if (surface === null) return;
			try {
				surface.reconfigure(plan);
			} catch {
				// a failed re-dispatch keeps the last good configuration
			}
		}, [phase, planKey]);

		/* ---- the one-shot view-state restore + the first-ready focus ---- */
		useLayoutEffectSafe(() => {
			if (phase !== 'ready') return;
			const surface = surfaceRef.current;
			if (surface === null) return;
			if (initialScrollAppliedRef.current !== true) {
				initialScrollAppliedRef.current = true;
				// One-shot: applied once the content is mounted and the
				// scroller exists; a late target never overrides an
				// explicit navigation (the framework's own restore
				// discipline).
				surface.handle.applyInitialScroll(props.initialScroll);
			}
			// PlainTextMode focuses on first ready (components.js ~2298) —
			// mirror it: never steal focus from a text entry, never focus a
			// hidden view.
			if (focusedRef.current !== true) {
				focusedRef.current = true;
				focusViewIfAllowed(surface);
			}
		}, [phase]);

		/* ---- the progressive repaint channel ---- */
		// Engine progress alone produces no CM6 update: a grown token
		// cache repaints only when a transaction re-runs the decoration
		// plugin. Every progress tick dispatches one — this is what makes
		// 0.19.0's progressive coloring paint (spec §5.6).
		React.useEffect(() => {
			if (phase !== 'ready') return undefined;
			if (typeof subscribeProgress !== 'function') return undefined;
			return subscribeProgress(repaint);
		}, [phase, subscribeProgress, repaint]);

		/* ---- the onNavigate claim ---- */
		// The framework's line jumps route through the controller; the
		// first mode to claim one wins. PlainTextMode returns false while
		// its textarea is unmounted — this component returns false while
		// the chunk gate is still pending, and claims by handing the jump
		// to the handle (cursor to the line start, the line scrolled in —
		// Task 8's semantics). The jump's own transaction then reports the
		// new selection through the ordinary updateListener path and its
		// scroll through the ordinary scroll listener: no special-cased
		// reporting here.
		React.useEffect(() => {
			if (controller === null || typeof controller.onNavigate !== 'function') return undefined;
			return controller.onNavigate((line) => {
				const surface = surfaceRef.current;
				if (surface === null) return false;
				surface.handle.navigateToLine(line);
				return true;
			});
		}, [controller]);

		/* ---- the render ---- */
		// Degraded: the full mode-prop set forwarded verbatim to
		// PlainTextMode — a plain-text editor with every preference
		// honored (the same shape the absent-engine degradation of the DOM
		// seam renders). Pending: the framework's loading visual,
		// components.js's loading body byte for byte, so the async gate
		// reads as an ordinary load. Ready: the host div the view mounted
		// into (the view owns its DOM from here).
		if (phase === 'degraded') {
			return h(PlainTextMode, {
				controller: props.controller,
				t: props.t,
				address: props.address,
				path: props.path,
				sessionId: props.sessionId,
				highlightActiveLine: props.highlightActiveLine,
				showLineNumbers: props.showLineNumbers,
				scrollBeyondLastLine: props.scrollBeyondLastLine,
				wordWrap: props.wordWrap,
				showWhitespace: props.showWhitespace,
				indentSettings: props.indentSettings,
				ruler: props.ruler,
				matchHighlight: props.matchHighlight,
				initialScroll: props.initialScroll,
				onScrollChange: props.onScrollChange,
				log: props.log,
			});
		}
		return h(
			'div',
			{ className: `${CLASS}-cm6` },
			phase === 'pending'
				? h(
						'div',
						{ key: 'loading', className: `${CLASS}-center` },
						h(
							'div',
							{ className: `${CLASS}-center-stack` },
							h('span', { className: `${CLASS}-spinner`, 'aria-hidden': true }),
							h('div', null, t('state.loading'))
						)
					)
				: null,
			h('div', { key: 'host', ref: hostRef, className: `${CLASS}-cm6-host` })
		);
	};
}
