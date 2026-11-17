/**
 * The keymap section of the settings center (0.11.0): the recorder for the
 * four framework self-managed bindings (spec §6), migrated verbatim from the
 * retired status-bar keymap popover (Task 8).
 *
 * Four rows (保存 / 保存全部 / 删行 / 跳转到行), each showing the current combo
 * plus a 「录制」button; recording captures the NEXT keydown at
 * document-capture level (any combination is admissible — the editor root's
 * interception preventDefaults browser-reserved combos like Ctrl+S itself —
 * and composing states are ignored during recording per the task ruling;
 * Escape cancels). The footer restores the default bindings (Ctrl+S /
 * Ctrl+Shift+S / Ctrl+D / Ctrl+G). Writes go through the runtime's
 * `dshEditor/setKeymap` bridge; a successful write updates the shared cache so
 * every mounted editor tab immediately matches the new keys.
 *
 * ESCAPE PRECEDENCE inside the settings center: the dialog host closes on
 * Escape through a document BUBBLE listener. The recorder registers its
 * listener at document CAPTURE level and calls stopPropagation, so while
 * recording the cancel wins and the dialog stays open; when not recording the
 * section never touches the key, so the dialog closes normally.
 *
 * Isolation (spec §14): this module owns the section UI and imports only the
 * pure keymap model — never components.js or settings-dialog.js — so the
 * dialog registry can reference it without a reverse dependency. Like the
 * popover it replaces, the module has no cordis imports; `require('react')`
 * is resolved by the bundler's factory scope. No JSX: `React.createElement`
 * aliased to `h`.
 */

const React = require('react');
const h = React.createElement;

import { comboOf, defaultKeymap, isReservedCombo, normalizeKeymap } from './keymap.js';

/** CSS class prefix: the dialog's `dsh-editor-settings-dialog-*` rule group. */
const CLASS = 'dsh-editor-settings-dialog';

/** Storable `event.code` alphabet for a recorded combo (Key-X / Digit-N). */
const RECORDABLE_CODE_RE = /^(Key[A-Z]|Digit[0-9])$/;

/** The message of a rejected value (the keymap write's error shape). */
function messageOfError(error) {
	if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
		return error.message;
	}
	return String(error);
}

/**
 * The keymap section: record / restore-default over the shared keymap cache.
 * @param props.t - the plugin-bound locale lookup.
 * @param props.runtime - the component runtime facade (keymap cache + writer).
 */
export function KeymapSection(props) {
	const t = props.t;
	const runtime = props.runtime;
	/** The action being re-bound (`'save' | 'saveAll' | 'deleteLines' | null`). */
	const [recording, setRecording] = React.useState(null);
	const [busy, setBusy] = React.useState(false);
	// { kind: 'write' | 'conflict' | 'duplicate' | 'reserved', message }
	const [error, setError] = React.useState(null);

	// Re-render on keymap cache changes (recorder writes, conflict refetches).
	const [, setKeymapTick] = React.useState(0);
	React.useEffect(() => runtime.subscribeKeymap(() => setKeymapTick((count) => count + 1)), [runtime]);

	// The recorder: swallow every keydown at CAPTURE level while armed, so
	// neither the browser default nor the editor root's own keymap dispatch
	// fires mid-recording (e.g. re-binding Ctrl+S must not trigger a save).
	// Capture on `document` also runs BEFORE the settings dialog's bubble
	// Escape listener; stopPropagation keeps a cancel from closing the dialog.
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
		{ action: 'deleteLines', label: t('keymap.deleteLines') },
		{ action: 'gotoLine', label: t('keymap.gotoLine') }
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
		{ className: `${CLASS}-section` },
		error !== null
			? h(
					'div',
					{ key: 'error', className: `${CLASS}-error`, title: error.message },
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
