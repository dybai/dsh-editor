/**
 * Editor behavior settings — the pure model behind the settings panel.
 *
 * One GLOBAL user preference set (cross-tab, cross-mode), persisted through
 * the Host storage RPC bridge (`dshEditor/getSettings` / `dshEditor/setSettings`,
 * KV table `settings`, one record per setting name). The single v0.3 setting:
 *
 * - `autoReloadClean` — when a file WITHOUT unsaved changes is modified
 *   externally, reload it silently instead of asking (default `false`:
 *   默认一律询问, per the feature ruling).
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
export const SETTINGS_KEYS = ['autoReloadClean'];

/**
 * The built-in settings: every toggle off (默认一律询问).
 * @returns a fresh settings object (callers may mutate their copy).
 */
export function defaultSettings() {
	return { autoReloadClean: false };
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
