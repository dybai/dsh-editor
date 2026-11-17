/**
 * The settings center (0.11.0): the application-level singleton modal that
 * replaces the per-tab settings popover.
 *
 * Shell: a backdrop (a click on the backdrop itself closes) hosting a centered
 * panel (`role="dialog"` + `aria-modal`) with a title + close-button header, a
 * LEFT section menu and a RIGHT scrolling content area. Opening focuses the
 * panel; Escape calls `props.onClose`. Focus RETURN to the gear belongs to the
 * caller (Task 7).
 *
 * Registry: `SETTINGS_SECTION_REGISTRY` is a frozen array of
 * `{ id, labelKey, order, render(ctx) }` entries. The dialog sorts it by
 * `order` for the menu and renders the ACTIVE entry through
 * `render({ runtime, t, context })`, so the dialog never touches a section's
 * internals — each section is its own component. `render` returns a subtree
 * (it mounts a section component, which is where that section's hooks live).
 * The keymap section lives in `src/keymap-section.js` (not here and not in
 * components.js): the dialog only references it, keeping the dependency
 * direction dialog -> pure section module (spec §14 isolation).
 *
 * Built-in sections this release ships:
 * - `appearance` (order 1) — the three presentation toggles migrated from the
 *   0.10.0 `SettingsPopover`: highlightActiveLine / showLineNumbers /
 *   scrollBeyondLastLine, in that order;
 * - `behavior` (order 2) — autoReloadClean;
 * - `wrap` (order 3) — the global `wordWrap` row plus the opener file type's
 *   three-state `*.<ext>` override row (follow global / force on / force off),
 *   the settings-center face of the three-layer `resolveWordWrap` chain;
 * - `keymap` (order 4) — the four self-managed bindings' recorder migrated
 *   from the retired status-bar keymap popover (record / restore defaults,
 *   reserved-combo rejection, conflict / write-failure banners).
 *
 * Row semantics are equivalent to the 0.10.0 popover (which Task 7 retires):
 * the on state is the normalized global value (`settings[rowKey] === true`), a
 * click writes `{ [rowKey]: !on }` through `runtime.setSettings`, a pending
 * write disables every row in the section, a failure surfaces
 * `{ kind: 'conflict' | 'write', message }` above the rows, and a row carrying
 * `noteKey` renders the explanation line under itself. Word wrap is NOT one of
 * these rows: the `wrap` section owns BOTH the global row and the per-file-type
 * override row (see `WrapSection`).
 *
 * `props.context.path` is the opener's file path, forwarded verbatim to every
 * section; the appearance/behavior sections ignore it, the wrap section
 * derives its `*.ext` from it. A render with unchanged props performs no
 * side effect (no read, no write, no subscription beyond the section mount).
 *
 * No JSX: `React.createElement` aliased to `h`; `require('react')` is resolved
 * by the bundler's factory scope. The module is INERT this task — nothing
 * opens or renders it until Task 7 mounts the singleton host.
 */

const React = require('react');
const h = React.createElement;

import { extensionOf, resolveWordWrap } from './wrap-resolve.js';
import { KeymapSection } from './keymap-section.js';

/** CSS class prefix: the `dsh-editor-settings-dialog-*` rule group. */
const CLASS = 'dsh-editor-settings-dialog';

/**
 * The appearance section's rows, in display order — the same label/title/note
 * stems the popover used, so the copy and the explanations stay identical.
 */
const APPEARANCE_ROWS = Object.freeze([
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
	},
	{
		key: 'scrollBeyondLastLine',
		labelKey: 'settings.scrollBeyondLastLine',
		titleKey: 'settings.scrollBeyondLastLineTitle'
	}
]);

/** The behavior section's rows, in display order. */
const BEHAVIOR_ROWS = Object.freeze([
	{
		key: 'autoReloadClean',
		labelKey: 'settings.autoReloadClean',
		titleKey: 'settings.autoReloadCleanTitle'
	}
]);

/** The message of a rejected value (mirrors the popover's helper). */
function messageOfError(error) {
	if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
		return error.message;
	}
	return String(error);
}

/**
 * One read/write section over the global settings cache: a vertical list of
 * boolean rows (`props.rows`). Shared by the appearance and behavior built-ins
 * because their interaction is identical; the wrap section brings its own
 * three-state row and is a separate component.
 */
function BooleanSettingsSection(props) {
	const t = props.t;
	const runtime = props.runtime;
	const rows = props.rows;
	const [busy, setBusy] = React.useState(false);
	// { kind: 'write' | 'conflict', message }
	const [error, setError] = React.useState(null);

	// Re-render on settings cache changes (toggle writes, conflict refetches,
	// cross-window announcements) — the same subscription the popover used.
	const [, setSettingsTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeSettings(() => setSettingsTick((count) => count + 1)), [runtime]);

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
		{ className: `${CLASS}-section` },
		error !== null
			? h(
					'div',
					{ key: 'error', className: `${CLASS}-error`, title: error.message },
					error.kind === 'conflict'
						? t('settings.conflict')
						: `${t('settings.writeFailed')}: ${error.message}`
				)
			: null,
		rows.flatMap((row) => {
			const on = settings[row.key] === true;
			const cells = [
				h(
					'div',
					{ key: row.key, className: `${CLASS}-row` },
					h('span', { className: `${CLASS}-label`, title: t(row.titleKey) }, t(row.labelKey)),
					h(
						'button',
						{
							className: `${CLASS}-toggle${on ? ' on' : ''}`,
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
				cells.push(h('div', { key: `${row.key}-note`, className: `${CLASS}-note` }, t(row.noteKey)));
			}
			return cells;
		})
	);
}

/**
 * The wrap section: the GLOBAL `wordWrap` row plus the opener file type's
 * three-state override row.
 *
 * The global row shows the user's EXPLICIT stored value —
 * `runtime.getRawSettings().wordWrap`; a missing (or non-boolean) key reads as
 * `false`, exactly like the 0.10.0 popover's negated toggle, and the row's
 * note explains that an unset key falls back to the per-extension default (the
 * markdown family wraps). A click writes `{ wordWrap: !explicit }` through
 * `runtime.setSettings`, the delta-preserving write: an unset key becomes an
 * explicit boolean, so the builtin extension default stops applying to every
 * file.
 *
 * The per-type row overrides the global value for ONE `*.<ext>` glob — the
 * highest-priority layer of `resolveWordWrap`. It names the opener's
 * `context.path` as `*.<ext>（basename）` and cycles three states on click:
 * follow global -> force on -> force off -> follow global. The button text
 * pairs the current state label with the EFFECTIVE value (the three-layer
 * resolution's boolean rendered as on/off), so a forced override is
 * distinguishable from the global value it overrides. Every write replaces the
 * complete override set through `runtime.setWrapOverrides`: follow global
 * drops the glob's record, force on/off upserts `{ glob: '*.<ext>', enabled }`.
 *
 * A file with no extension (dotfiles included) has no `*.<ext>` to target, so
 * its row renders the no-extension context and the three-state button is
 * disabled — following the global is the only state it could express, and that
 * is already in effect.
 *
 * Both rows share one pending-write guard and one `{ kind, message }` error
 * banner, mirroring the boolean sections. The component subscribes to BOTH
 * caches (settings + wrap overrides): the effective value reads each of them.
 */

/** The three override states, in cycle order, with their button label stems. */
const WRAP_OVERRIDE_STATES = Object.freeze([
	{ state: 'follow', labelKey: 'settingsCenter.wrapOverrideFollow' },
	{ state: 'on', labelKey: 'settingsCenter.wrapOverrideOn' },
	{ state: 'off', labelKey: 'settingsCenter.wrapOverrideOff' }
]);

/** The basename of a path, treating both separators like `extensionOf`. */
function basenameOfPath(path) {
	if (typeof path !== 'string' || path.length === 0) return '';
	return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** The explicit global word-wrap value: a missing/non-boolean key is `false`. */
function explicitWordWrap(rawSettings) {
	return rawSettings !== null && typeof rawSettings === 'object' && rawSettings.wordWrap === true;
}

/**
 * The stored override state of one glob: `'follow'` when the set has no record
 * for it, otherwise `'on'`/`'off'` from its `enabled` flag.
 */
function overrideStateOf(overrides, glob) {
	if (Array.isArray(overrides)) {
		for (const entry of overrides) {
			if (entry === null || typeof entry !== 'object' || entry.glob !== glob) continue;
			return entry.enabled === true ? 'on' : 'off';
		}
	}
	return 'follow';
}

/** The override set with `glob` following the global (its record removed). */
function withoutOverride(overrides, glob) {
	const current = Array.isArray(overrides) ? overrides : [];
	return current.filter((entry) => !(entry !== null && typeof entry === 'object' && entry.glob === glob));
}

/** The override set with `glob` forced on/off (any old record replaced). */
function withOverride(overrides, glob, enabled) {
	return [...withoutOverride(overrides, glob), { glob, enabled }];
}

function WrapSection(props) {
	const t = props.t;
	const runtime = props.runtime;
	const path = props.path;
	const [busy, setBusy] = React.useState(false);
	// { kind: 'write' | 'conflict', message }
	const [error, setError] = React.useState(null);

	// Re-render on either cache: the global row reads the raw settings and the
	// per-type row's effective value reads BOTH layers.
	const [, setTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeSettings(() => setTick((count) => count + 1)), [runtime]);
	React.useEffect(() => runtime.subscribeWrapOverrides(() => setTick((count) => count + 1)), [runtime]);

	const rawSettings = runtime.getRawSettings();
	const overrides = runtime.getWrapOverrides();
	const globalOn = explicitWordWrap(rawSettings);
	const extension = extensionOf(path);
	const glob = extension === '' ? null : `*.${extension}`;
	const overrideState = glob === null ? 'follow' : overrideStateOf(overrides, glob);
	const overrideStateEntry = WRAP_OVERRIDE_STATES.find((entry) => entry.state === overrideState) ?? WRAP_OVERRIDE_STATES[0];
	// The effective value is the FULL three-layer answer, not the override cell:
	// a forced override and a followed global that happens to wrap both show 开.
	const effective = resolveWordWrap(rawSettings, path, overrides) === true;
	const contextText =
		glob === null ? t('settingsCenter.wrapOverrideNoExtension') : `${glob}（${basenameOfPath(path)}）`;
	const overrideLabel = `${t('settingsCenter.wrapOverrideLabel')} · ${contextText}`;

	const runWrite = (write) => {
		setBusy(true);
		setError(null);
		write()
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

	const toggleGlobal = () => {
		// Read the raw cache at click time so the negation is against what is
		// stored NOW (a double click cannot replay a stale render's value).
		runWrite(() => runtime.setSettings({ wordWrap: !explicitWordWrap(runtime.getRawSettings()) }));
	};

	const cycleOverride = () => {
		if (glob === null) return;
		const currentOverrides = runtime.getWrapOverrides();
		const currentState = overrideStateOf(currentOverrides, glob);
		if (currentState === 'follow') {
			runWrite(() => runtime.setWrapOverrides(withOverride(currentOverrides, glob, true)));
		} else if (currentState === 'on') {
			runWrite(() => runtime.setWrapOverrides(withOverride(currentOverrides, glob, false)));
		} else {
			runWrite(() => runtime.setWrapOverrides(withoutOverride(currentOverrides, glob)));
		}
	};

	return h(
		'div',
		{ className: `${CLASS}-section` },
		error !== null
			? h(
					'div',
					{ key: 'error', className: `${CLASS}-error`, title: error.message },
					error.kind === 'conflict'
						? t('settings.conflict')
						: `${t('settings.writeFailed')}: ${error.message}`
				)
			: null,
		h(
			'div',
			{ key: 'wordWrap', className: `${CLASS}-row` },
			h('span', { className: `${CLASS}-label`, title: t('settings.wordWrapTitle') }, t('settings.wordWrap')),
			h(
				'button',
				{
					className: `${CLASS}-toggle${globalOn ? ' on' : ''}`,
					type: 'button',
					disabled: busy,
					title: t('settings.wordWrapTitle'),
					'aria-pressed': globalOn ? 'true' : 'false',
					onClick: toggleGlobal
				},
				globalOn ? t('settings.on') : t('settings.off')
			)
		),
		h('div', { key: 'wordWrap-note', className: `${CLASS}-note` }, t('settingsCenter.wordWrapGlobalNote')),
		h(
			'div',
			{ key: 'wrapOverride', className: `${CLASS}-row` },
			h('span', { className: `${CLASS}-label`, title: overrideLabel }, overrideLabel),
			h(
				'button',
				{
					className: `${CLASS}-toggle${effective ? ' on' : ''}`,
					type: 'button',
					disabled: busy || glob === null,
					title: overrideLabel,
					'aria-pressed': effective ? 'true' : 'false',
					onClick: cycleOverride
				},
				`${t(overrideStateEntry.labelKey)} · ${effective ? t('settings.on') : t('settings.off')}`
			)
		)
	);
}

/**
 * The section registry, in the fixed contract order (appearance 1, behavior 2,
 * wrap 3, keymap 4). Frozen so a render can never mutate the menu out from
 * under itself.
 */
export const SETTINGS_SECTION_REGISTRY = Object.freeze([
	{
		id: 'appearance',
		labelKey: 'settingsCenter.section.appearance',
		order: 1,
		render: (ctx) => h(BooleanSettingsSection, { key: 'appearance', runtime: ctx.runtime, t: ctx.t, rows: APPEARANCE_ROWS })
	},
	{
		id: 'behavior',
		labelKey: 'settingsCenter.section.behavior',
		order: 2,
		render: (ctx) => h(BooleanSettingsSection, { key: 'behavior', runtime: ctx.runtime, t: ctx.t, rows: BEHAVIOR_ROWS })
	},
	{
		id: 'wrap',
		labelKey: 'settingsCenter.section.wrap',
		order: 3,
		render: (ctx) => h(WrapSection, { key: 'wrap', runtime: ctx.runtime, t: ctx.t, path: ctx.context.path })
	},
	{
		id: 'keymap',
		labelKey: 'settingsCenter.section.keymap',
		order: 4,
		render: (ctx) => h(KeymapSection, { key: 'keymap', runtime: ctx.runtime, t: ctx.t })
	}
]);

/**
 * The settings center modal.
 * @param props.t - the plugin-bound locale lookup.
 * @param props.runtime - the component runtime facade: the settings cache, the
 *   raw settings payload and the wrap-override cache.
 * @param props.context - `{ path }`, the opener tab's file path (the wrap
 *   section derives its `*.ext` from it).
 * @param props.onClose - called by the backdrop, the close button and Escape.
 */
export function SettingsDialog(props) {
	const t = props.t;
	const runtime = props.runtime;
	const context = props.context !== null && typeof props.context === 'object' ? props.context : {};
	const panelRef = React.useRef(null);

	// The registry is frozen: sorting a copy once is enough for the lifetime of
	// this mount.
	const sections = React.useMemo(
		() => SETTINGS_SECTION_REGISTRY.slice().sort((left, right) => left.order - right.order),
		[]
	);
	const [activeId, setActiveId] = React.useState(() => (sections.length > 0 ? sections[0].id : null));

	// Focus the panel when the dialog opens (the close/focus-return half lives
	// in the opener, Task 7).
	React.useEffect(() => {
		const panel = panelRef.current;
		if (panel !== null && typeof panel.focus === 'function') panel.focus();
	}, []);

	// Escape closes. Listener on the document (bubble phase) like the popover:
	// a section that must own Escape (the Task 8 keymap recorder) can stop the
	// synthetic event's propagation before it reaches here.
	React.useEffect(() => {
		if (typeof document === 'undefined' || document === null) return undefined;
		const onKeyDown = (event) => {
			if (event.key === 'Escape') props.onClose();
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [props.onClose]);

	const active = sections.find((section) => section.id === activeId) ?? sections[0] ?? null;

	return h(
		'div',
		{
			className: `${CLASS}-backdrop`,
			// A mouse-down that starts ON the backdrop (not inside the panel)
			// closes; using the press start keeps a drag out of the panel from
			// being mistaken for an outside click.
			onMouseDown: (event) => {
				if (event.target === event.currentTarget) props.onClose();
			}
		},
		h(
			'div',
			{
				className: `${CLASS}-panel`,
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': t('settingsCenter.title'),
				tabIndex: -1,
				ref: panelRef
			},
			h(
				'div',
				{ className: `${CLASS}-header` },
				h('div', { className: `${CLASS}-title` }, t('settingsCenter.title')),
				h(
					'button',
					{
						className: `${CLASS}-close`,
						type: 'button',
						title: t('settingsCenter.close'),
						'aria-label': t('settingsCenter.close'),
						onClick: () => props.onClose()
					},
					'×'
				)
			),
			h(
				'div',
				{ className: `${CLASS}-body` },
				// The section switcher is a persistent tab list, not a transient
				// ARIA menu (a menu is expected to close on activation; this one
				// stays open and just swaps the right pane). Arrow-key navigation
				// is not implemented — every tab is a plain focusable button.
				h(
					'div',
					{
						className: `${CLASS}-menu`,
						role: 'tablist',
						'aria-label': t('settingsCenter.title'),
						'aria-orientation': 'vertical'
					},
					sections.map((section) =>
						h(
							'button',
							{
								key: section.id,
								className: `${CLASS}-menu-item${active !== null && section.id === active.id ? ' active' : ''}`,
								type: 'button',
								role: 'tab',
								'aria-selected': active !== null && section.id === active.id ? 'true' : 'false',
								onClick: () => setActiveId(section.id)
							},
							t(section.labelKey)
						)
					)
				),
				h(
					'div',
					{
						className: `${CLASS}-content`,
						role: 'tabpanel',
						'aria-label': active === null ? undefined : t(active.labelKey)
					},
					active === null ? null : active.render({ runtime, t, context })
				)
			)
		)
	);
}
