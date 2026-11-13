/**
 * Editor behavior settings — the pure model behind the settings panel.
 *
 * One GLOBAL user preference set (cross-tab, cross-mode), persisted through
 * the Host storage RPC bridge (`dshEditor/getSettings` / `dshEditor/setSettings`,
 * KV table `settings`, one record per setting name). The settings:
 *
 * - `autoReloadClean` — when a file WITHOUT unsaved changes is modified
 *   externally, reload it silently instead of asking (default `false`:
 *   默认一律询问, per the feature ruling);
 * - `highlightActiveLine` — draw an active-line highlight behind the caret
 *   (default `true`: a presentation affordance, on unless the user turns it
 *   off). Modes honoring the active-line contract (descriptor `activeLine`,
 *   contracts §5.1) read the same preference via their `highlightActiveLine`
 *   component prop.
 * - `showLineNumbers` — render the line-number gutter beside the content
 *   (default `true`: a presentation affordance, on unless the user turns it
 *   off). Modes honoring the line-numbers contract (contracts §5.1) read the
 *   same preference via their `showLineNumbers` component prop.
 *
 * `normalizeSettings` accepts the wire payload `{ [name]: boolean }` (the
 * Host reports only stored settings) and merges it over the defaults.
 * Unknown keys are IGNORED so a newer Host's extra settings never invalidate
 * this build's read — but a KNOWN key carrying a non-boolean invalidates the
 * whole payload (`undefined`: the caller keeps its current/default values).
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/settings
 */

/** Setting names this build knows (mirrors the Host validator's allow-list). */
export const SETTINGS_KEYS = ['autoReloadClean', 'highlightActiveLine', 'showLineNumbers'];

/**
 * The built-in settings: behavior opt-ins off, presentation defaults on.
 * @returns a fresh settings object (callers may mutate their copy).
 */
export function defaultSettings() {
	return { autoReloadClean: false, highlightActiveLine: true, showLineNumbers: true };
}

/**
 * Validate and normalize a settings payload (defaults merged).
 * @param {any} raw - the wire payload `{ [name]: boolean }`.
 * @returns the complete settings object, or `undefined` when the payload is
 * not an object or a known key carries a non-boolean value.
 */
export function normalizeSettings(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const normalized = defaultSettings();
	for (const key of SETTINGS_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
		if (typeof raw[key] !== 'boolean') return undefined;
		normalized[key] = raw[key];
	}
	return normalized;
}
