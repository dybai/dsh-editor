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
 * internals — the `wrap` section (Task 6) and the `keymap` section (Task 8)
 * only append an entry here. `render` returns a subtree (it mounts a section
 * component, which is where that section's hooks live).
 *
 * Built-in sections this task ships:
 * - `appearance` (order 1) — the three presentation toggles migrated from the
 *   0.10.0 `SettingsPopover`: highlightActiveLine / showLineNumbers /
 *   scrollBeyondLastLine, in that order;
 * - `behavior` (order 2) — autoReloadClean.
 *
 * Row semantics are equivalent to the 0.10.0 popover (which Task 7 retires):
 * the on state is the normalized global value (`settings[rowKey] === true`), a
 * click writes `{ [rowKey]: !on }` through `runtime.setSettings`, a pending
 * write disables every row in the section, a failure surfaces
 * `{ kind: 'conflict' | 'write', message }` above the rows, and a row carrying
 * `noteKey` renders the explanation line under itself. Word wrap is
 * deliberately absent: the `wrap` section (Task 6) owns BOTH the global row
 * and the per-file-type override row.
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
 * because their interaction is identical; the wrap section (Task 6) brings its
 * own three-state row and is a separate component.
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
 * The section registry, in the fixed contract order (appearance 1, behavior 2;
 * the wrap and keymap tasks append 3/4). Frozen so a render can never mutate
 * the menu out from under itself.
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
	}
]);

/**
 * The settings center modal.
 * @param props.t - the plugin-bound locale lookup.
 * @param props.runtime - the component runtime facade (settings cache only in
 *   this task; Task 6 also reads the wrap cache through it).
 * @param props.context - `{ path }`, the opener tab's file path (Task 6 uses
 *   it to derive the `*.ext` of the per-type override row).
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
