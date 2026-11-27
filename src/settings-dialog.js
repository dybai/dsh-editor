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
 * or a KEYED ARRAY of subtrees (each mounts a section component, which is
 * where that section's hooks live; the appearance entry is the one array).
 * The keymap section lives in `src/keymap-section.js` (not here and not in
 * components.js): the dialog only references it, keeping the dependency
 * direction dialog -> pure section module (spec §14 isolation).
 *
 * Built-in sections this release ships:
 * - `appearance` (order 1) — the three presentation toggles migrated from the
 *   0.10.0 `SettingsPopover` (highlightActiveLine / showLineNumbers /
 *   scrollBeyondLastLine, in that order) plus the 0.12.0 whitespace trio
 *   (spaces / tabs / newlines) under one `showWhitespaceGroup` group title,
 *   the 0.14.0 ruler toggle (`showRuler` under `showRulerGroup`) and the
 *   match-highlight pair (`wordHighlight` / `selectionHighlight` under
 *   `matchHighlightGroup`); after those rows the entry's array renders
 *   `RulerPositionSection`, the numeric `rulerColumn` field (see below);
 * - `behavior` (order 2) — autoReloadClean;
 * - `indent` (order 3) — the 0.13.0 indentation rows: the `indentMode`
 *   segmented control (auto detect / tabs / spaces) plus the `indentWidth`
 *   segmented control (2/4/8, enabled in spaces mode) and its note;
 * - `wrap` (order 4) — the global `wordWrap` row plus the opener file type's
 *   three-state `*.<ext>` override row (follow global / force on / force off),
 *   the settings-center face of the three-layer `resolveWordWrap` chain;
 * - `keymap` (order 5) — the four self-managed bindings' recorder migrated
 *   from the retired status-bar keymap popover (record / restore defaults,
 *   reserved-combo rejection, conflict / write-failure banners).
 *
 * Not a registry entry: the render TAIL of the content pane carries a
 * non-interactive About group (0.19.0) — the group title
 * (`settings.buildInfoGroup`) plus one label/value row reading
 * `runtime.buildInfo` (`<version>+<stamp>`), so the user can tell WHICH
 * build is running (same version number, different builds).
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
import { clampRulerColumnInput } from './ruler.js';

/** CSS class prefix: the `dsh-editor-settings-dialog-*` rule group. */
const CLASS = 'dsh-editor-settings-dialog';

/**
 * The appearance section's rows, in display order — the same label/title/note
 * stems the popover used, so the copy and the explanations stay identical.
 * The 0.12.0 whitespace trio appends after them; its FIRST entry carries
 * `groupTitleKey`, which `BooleanSettingsSection` renders as a group title
 * line before that row. The ruler row and the match-highlight pair open
 * their own groups through the same field.
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
	},
	{
		groupTitleKey: 'settings.showWhitespaceGroup',
		key: 'showWhitespaceSpaces',
		labelKey: 'settings.showWhitespaceSpaces',
		titleKey: 'settings.showWhitespaceSpacesTitle',
		noteKey: 'settings.showWhitespaceSpacesNote'
	},
	{
		key: 'showWhitespaceTabs',
		labelKey: 'settings.showWhitespaceTabs',
		titleKey: 'settings.showWhitespaceTabsTitle',
		noteKey: 'settings.showWhitespaceTabsNote'
	},
	{
		key: 'showWhitespaceNewlines',
		labelKey: 'settings.showWhitespaceNewlines',
		titleKey: 'settings.showWhitespaceNewlinesTitle',
		noteKey: 'settings.showWhitespaceNewlinesNote'
	},
	{
		groupTitleKey: 'settings.showRulerGroup',
		key: 'showRuler',
		labelKey: 'settings.showRuler',
		titleKey: 'settings.showRulerTitle',
		noteKey: 'settings.showRulerNote'
	},
	{
		groupTitleKey: 'settings.matchHighlightGroup',
		key: 'wordHighlight',
		labelKey: 'settings.wordHighlight',
		titleKey: 'settings.wordHighlightTitle',
		noteKey: 'settings.wordHighlightNote'
	},
	{
		key: 'selectionHighlight',
		labelKey: 'settings.selectionHighlight',
		titleKey: 'settings.selectionHighlightTitle',
		noteKey: 'settings.selectionHighlightNote'
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
			// An optional non-empty `groupTitleKey` renders a group title line
			// before its row (0.12.0 whitespace trio); rows without the field
			// render exactly as before.
			const cells = [];
			if (typeof row.groupTitleKey === 'string' && row.groupTitleKey.length > 0) {
				cells.push(
					h('div', { key: `${row.key}-group-title`, className: `${CLASS}-group-title` }, t(row.groupTitleKey))
				);
			}
			cells.push(
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
			);
			if (typeof row.noteKey === 'string') {
				cells.push(h('div', { key: `${row.key}-note`, className: `${CLASS}-note` }, t(row.noteKey)));
			}
			return cells;
		})
	);
}

/**
 * The indentation section (0.13.0): two segmented controls over the global
 * indent settings, written through the typed settings cache.
 *
 * The mode row offers `auto` (detect the open file's leading indentation),
 * `tabs` and `spaces`; the selected state is the normalized global value
 * (`settings.indentMode`, always present after Task 1's defaults merge). The
 * width row offers 2/4/8 spaces per level; its buttons are enabled only when
 * the mode is `spaces` — the note under the row explains the width still
 * serves as the fallback when auto detect has no signal. A click writes the
 * single typed delta (`{ indentMode }` / `{ indentWidth }`) through
 * `runtime.setSettings`, a pending write disables every button in the
 * section, and a failure surfaces the shared
 * `{ kind: 'conflict' | 'write', message }` banner above the rows — the same
 * anatomy as the boolean sections.
 */

/** The mode segmented control's options, in display order. */
const INDENT_MODE_OPTIONS = Object.freeze([
	{ value: 'auto', labelKey: 'settings.indentModeAuto' },
	{ value: 'tabs', labelKey: 'settings.indentModeTabs' },
	{ value: 'spaces', labelKey: 'settings.indentModeSpaces' }
]);

/** The width segmented control's options (spaces per level), in display order. */
const INDENT_WIDTH_OPTIONS = Object.freeze([2, 4, 8]);

function IndentSettingsSection(props) {
	const t = props.t;
	const runtime = props.runtime;
	const [busy, setBusy] = React.useState(false);
	// { kind: 'write' | 'conflict', message }
	const [error, setError] = React.useState(null);

	// Re-render on settings cache changes (segment writes, conflict refetches,
	// cross-window announcements) — the same subscription the boolean sections
	// use.
	const [, setSettingsTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeSettings(() => setSettingsTick((count) => count + 1)), [runtime]);

	const settings = runtime.getSettings();
	const runWrite = (delta) => {
		setBusy(true);
		setError(null);
		runtime
			.setSettings(delta)
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
		h(
			'div',
			{ key: 'indentMode', className: `${CLASS}-row` },
			h('span', { className: `${CLASS}-label`, title: t('settings.indentModeTitle') }, t('settings.indentMode')),
			h(
				'div',
				{ className: `${CLASS}-seg`, role: 'group', 'aria-label': t('settings.indentMode') },
				INDENT_MODE_OPTIONS.map((mode) =>
					h(
						'button',
						{
							key: mode.value,
							className: `${CLASS}-seg-btn${settings.indentMode === mode.value ? ' on' : ''}`,
							type: 'button',
							disabled: busy,
							title: t('settings.indentModeTitle'),
							'aria-pressed': settings.indentMode === mode.value ? 'true' : 'false',
							onClick: () => runWrite({ indentMode: mode.value })
						},
						t(mode.labelKey)
					)
				)
			)
		),
		h(
			'div',
			{ key: 'indentWidth', className: `${CLASS}-row` },
			h('span', { className: `${CLASS}-label`, title: t('settings.indentWidthTitle') }, t('settings.indentWidth')),
			h(
				'div',
				{ className: `${CLASS}-seg`, role: 'group', 'aria-label': t('settings.indentWidth') },
				INDENT_WIDTH_OPTIONS.map((width) =>
					h(
						'button',
						{
							key: width,
							className: `${CLASS}-seg-btn${settings.indentWidth === width ? ' on' : ''}`,
							type: 'button',
							disabled: busy || settings.indentMode !== 'spaces',
							title: t('settings.indentWidthTitle'),
							'aria-pressed': settings.indentWidth === width ? 'true' : 'false',
							onClick: () => runWrite({ indentWidth: width })
						},
						String(width)
					)
				)
			)
		),
		h('div', { key: 'indentWidth-note', className: `${CLASS}-note` }, t('settings.indentWidthNote'))
	);
}

/**
 * The ruler position section (0.14.0): the numeric `rulerColumn` input the
 * appearance entry renders AFTER its boolean rows.
 *
 * The field is controlled by a DRAFT string while the user types — React's
 * onChange only records the draft, no write happens on a keystroke. The
 * commit paths are the native `change` event (blur and the spinner arrows,
 * which React's onChange cannot tell from typing) and the Enter key. Both
 * land in `commitDraft`: it reads the field's `valueAsNumber`, converges it
 * through `clampRulerColumnInput` (Task 2), and reverts WITHOUT a write when
 * the field is empty/invalid or already equal to the cached column;
 * otherwise it writes `{ rulerColumn }` through `runtime.setSettings`. When
 * the write settles — success OR failure — the draft clears so the field
 * mirrors the cache again; a failure additionally raises the shared
 * `{ kind: 'conflict' | 'write', message }` banner above the row, the same
 * anatomy as the other sections. The row is deliberately NOT gated on
 * `showRuler` (spec §5.1: the column can be set before the ruler is on).
 */
function RulerPositionSection(props) {
	const t = props.t;
	const runtime = props.runtime;
	const [busy, setBusy] = React.useState(false);
	// { kind: 'write' | 'conflict', message }
	const [error, setError] = React.useState(null);
	// The in-progress field text, or null when the field mirrors the cache.
	const [draft, setDraft] = React.useState(null);
	const inputRef = React.useRef(null);

	// Re-render on settings cache changes (ruler writes, conflict refetches,
	// cross-window announcements) — the same subscription the other sections
	// use.
	const [, setSettingsTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeSettings(() => setSettingsTick((count) => count + 1)), [runtime]);

	const settings = runtime.getSettings();

	const commitDraft = React.useCallback(() => {
		const input = inputRef.current;
		if (input === null) return;
		const column = clampRulerColumnInput(input.valueAsNumber);
		// Empty / invalid field, or no change against the cache: revert, no
		// write (a double commit finds the value equal — idempotent).
		if (column === null || column === settings.rulerColumn) {
			setDraft(null);
			return;
		}
		setBusy(true);
		setError(null);
		runtime
			.setSettings({ rulerColumn: column })
			.catch((writeError) => {
				setError({
					kind:
						writeError !== null && typeof writeError === 'object' && writeError.conflict === true
							? 'conflict'
							: 'write',
					message: messageOfError(writeError)
				});
			})
			.finally(() => {
				setBusy(false);
				setDraft(null);
			});
	}, [runtime, settings.rulerColumn]);

	// The native change listener (blur + spinner clicks); the memoized
	// commit keeps it current, the cleanup drops the old one.
	React.useEffect(() => {
		const input = inputRef.current;
		if (input === null) return undefined;
		input.addEventListener('change', commitDraft);
		return () => input.removeEventListener('change', commitDraft);
	}, [commitDraft]);

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
			{ key: 'rulerColumn', className: `${CLASS}-row` },
			h('span', { className: `${CLASS}-label`, title: t('settings.rulerColumnTitle') }, t('settings.rulerColumn')),
			h('input', {
				className: `${CLASS}-number`,
				type: 'number',
				min: 1,
				max: 999,
				step: 1,
				value: draft === null ? String(settings.rulerColumn) : draft,
				disabled: busy,
				ref: inputRef,
				onChange: (event) => setDraft(event.target.value),
				onKeyDown: (event) => {
					if (event.key === 'Enter') commitDraft();
				}
			})
		),
		h('div', { key: 'rulerColumn-note', className: `${CLASS}-note` }, t('settings.rulerColumnNote'))
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
 * indent 3, wrap 4, keymap 5). Frozen so a render can never mutate the menu
 * out from under itself.
 */
export const SETTINGS_SECTION_REGISTRY = Object.freeze([
	{
		id: 'appearance',
		labelKey: 'settingsCenter.section.appearance',
		order: 1,
		render: (ctx) => [
			h(BooleanSettingsSection, { key: 'appearance', runtime: ctx.runtime, t: ctx.t, rows: APPEARANCE_ROWS }),
			h(RulerPositionSection, { key: 'ruler-position', runtime: ctx.runtime, t: ctx.t })
		]
	},
	{
		id: 'behavior',
		labelKey: 'settingsCenter.section.behavior',
		order: 2,
		render: (ctx) => h(BooleanSettingsSection, { key: 'behavior', runtime: ctx.runtime, t: ctx.t, rows: BEHAVIOR_ROWS })
	},
	{
		id: 'indent',
		labelKey: 'settingsCenter.section.indent',
		order: 3,
		render: (ctx) => h(IndentSettingsSection, { key: 'indent', runtime: ctx.runtime, t: ctx.t })
	},
	{
		id: 'wrap',
		labelKey: 'settingsCenter.section.wrap',
		order: 4,
		render: (ctx) => h(WrapSection, { key: 'wrap', runtime: ctx.runtime, t: ctx.t, path: ctx.context.path })
	},
	{
		id: 'keymap',
		labelKey: 'settingsCenter.section.keymap',
		order: 5,
		render: (ctx) => h(KeymapSection, { key: 'keymap', runtime: ctx.runtime, t: ctx.t })
	}
]);

/**
 * The settings center modal.
 * @param props.t - the plugin-bound locale lookup.
 * @param props.runtime - the component runtime facade: the settings cache, the
 *   raw settings payload, the wrap-override cache and the build info
 *   (`buildInfo`, read by the About tail).
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
					active === null ? null : active.render({ runtime, t, context }),
					// The About tail (0.19.0 build fingerprint): a non-interactive
					// group AFTER the registry content, on every section pane — the
					// one place the user can tell WHICH build is running. The row
					// reuses the boolean rows' classes (label span; the value is
					// plain textContent where their toggle button sits — no
					// control, no new CSS).
					h(
						'div',
						{ className: `${CLASS}-section` },
						h('div', { className: `${CLASS}-group-title` }, t('settings.buildInfoGroup')),
						h(
							'div',
							{ className: `${CLASS}-row` },
							h('span', { className: `${CLASS}-label` }, t('settings.buildInfo')),
							h('span', null, `${runtime.buildInfo.version}+${runtime.buildInfo.stamp}`)
						)
					)
				)
			)
		)
	);
}
