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
 *   (`data-dsh-editor-input`), reporting edits and selections and serving
 *   `controller.onNavigate` line jumps.
 * - `ModeMenu` — the mode indicator's dropdown (spec §5.3).
 * - `KeymapPopover` — the status-bar keyboard button's panel: record /
 *   restore-default for the three self-managed bindings (spec §6).
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
import { lineOfOffset, offsetOfLine } from './lines.js';
import { createTabController } from './tab-machine.js';
import { resolveModeId } from './ranking.js';
import { matchAction, comboOf, normalizeKeymap, defaultKeymap } from './keymap.js';

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

/* ------------------------------------------------------------- modes -- */

/**
 * The built-in `plain-text` mode: one controlled textarea.
 *
 * Obligations (spec §5.5): renders the draft, reports edits via
 * `controller.applyEdit` and selections via `controller.applySelection`
 * (`{start, end, lineStart, lineEnd, text}`, `text` null when collapsed),
 * answers `controller.onNavigate` line jumps (returns true when claimed), and
 * mirrors machine-written selections (framework `setContent` commands) into
 * the DOM. Never reads or writes files itself.
 */
function PlainTextMode(props) {
	const controller = props.controller;
	const state = useControllerState(controller);
	const areaRef = React.useRef(null);

	const reportSelection = React.useCallback(() => {
		const area = areaRef.current;
		if (area === null) return;
		const start = area.selectionStart;
		const end = area.selectionEnd;
		const value = area.value;
		controller.applySelection({
			start,
			end,
			lineStart: lineOfOffset(value, start),
			lineEnd: lineOfOffset(value, end),
			text: start === end ? null : value.slice(start, end)
		});
	}, [controller]);

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
	// DOM; user-driven selections already match, so nothing fights.
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
	}, [state.selection]);

	return h('textarea', {
		className: `${CLASS}-area`,
		value: state.draft,
		spellCheck: false,
		wrap: 'off',
		'aria-label': basenameOf(props.address),
		'data-dsh-editor-input': '',
		onChange: (event) => controller.applyEdit(event.target.value),
		onSelect: reportSelection,
		onClick: reportSelection,
		onKeyUp: reportSelection
	});
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
	// { kind: 'write' | 'conflict' | 'duplicate', message }
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
	React.useEffect(() => {
		if (recording === null || typeof document === 'undefined' || document === null) return undefined;
		const onKeyDown = (event) => {
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
							: `${t('keymap.writeFailed')}: ${error.message}`
				)
			: null,
		recording !== null ? h('div', { key: 'hint', className: `${CLASS}-keymap-hint` }, t('keymap.recording')) : null,
		...rows,
		h(
			'div',
			{ key: 'footer', className: `${CLASS}-keymap-footer` },
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
			signal
		});
		runtime.addLiveController(created);
		setController(created);
		return () => {
			runtime.removeLiveController(created);
			created.destroy();
		};
	}, [runtime, valid, address, sessionId, targetPath, signal]);

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
			notifyChange: (listener) => changeRef.current.subscribe(listener)
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
	const [keymapOpen, setKeymapOpen] = React.useState(false);
	const closeKeymap = React.useCallback(() => setKeymapOpen(false), []);

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
				if (snapshot.dirty === true) runtime.requestSaveTab({ controller }, false);
			} else if (action === 'saveAll') {
				if (sessionId !== null) runtime.saveAllOfSession(sessionId);
			} else if (action === 'deleteLines') {
				if (controller !== null) runtime.deleteLinesFor({ controller });
			}
		},
		[controller, runtime, sessionId]
	);

	// --- machine state + derived chrome values ---
	const state = useControllerState(controller);
	const dirty = state.dirty === true;
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

	const onReload = React.useCallback(() => {
		if (controller !== null) controller.requestReload();
	}, [controller]);
	const onSave = React.useCallback(() => {
		if (controller !== null) controller.requestSave(false);
	}, [controller]);
	const onSaveAnyway = React.useCallback(() => {
		if (controller !== null) controller.requestSave(true);
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
			h(ModeComponent, { key: 'mode', controller, t, address, path: targetPath, sessionId })
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
				className: `${CLASS}-btn primary`,
				type: 'button',
				disabled: controller === null || state.saving || state.phase !== 'ready' || !dirty,
				title: t('action.saveTitle').replace('{combo}', comboOf(runtime.getKeymap().save)),
				onClick: onSave
			},
			state.saving ? t('state.saving') : t('action.save')
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
		keymapOpen ? h(KeymapPopover, { key: 'keymap-popover', t, runtime, onClose: closeKeymap }) : null
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
 *   subscribeKeymap, setKeymap, saveAllOfSession, requestSaveTab, deleteLinesFor }} runtime
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
		EditButton: withRuntime(EditButton),
		EditButtonGuarded: guard(withRuntime(EditButton)),
		PlainTextMode
	};
}
