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
 * - `scrollBeyondLastLine` — keep scrollable blank space past the content end
 *   so the last line can scroll to the viewport top (default `true`, a
 *   presentation affordance; modes honoring it receive the live boolean via
 *   their `scrollBeyondLastLine` component prop).
 * - `wordWrap` — whether the editor area soft-wraps long lines (explicit
 *   default `false`). This default is the fallback for an EXPLICIT setting
 *   only: a file whose stored settings never mention `wordWrap` is resolved
 *   by `resolveWordWrap` (see `wrap-resolve.js`) against the builtin
 *   extension defaults (the markdown family wraps by default), so "unset"
 *   is not the same as "off".
 * - `showWhitespaceSpaces` — draw visible glyphs for space characters
 *   (default `false`: whitespace display is opt-in). Modes honoring the
 *   whitespace-display contract receive the live boolean via their
 *   `showWhitespace` component prop.
 * - `showWhitespaceTabs` — draw visible glyphs for tab characters
 *   (default `false`; delivered via the same `showWhitespace` component
 *   prop).
 * - `showWhitespaceNewlines` — draw a visible glyph at line ends and blank
 *   lines (default `false`; delivered via the same `showWhitespace`
 *   component prop).
 *
 * `normalizeSettings` accepts the wire payload `{ [name]: boolean }` (the
 * Host reports only stored settings) and merges it over the defaults.
 * Unknown keys are IGNORED so a newer Host's extra settings never invalidate
 * this build's read — but a KNOWN key carrying a non-boolean invalidates the
 * whole payload (`undefined`: the caller keeps its current/default values).
 *
 * `buildSettingsWritePayload` is the write-side counterpart: it starts from
 * the RAW stored set (explicit settings only) and merges the caller's change,
 * so a write never materializes the builtin defaults. A key absent from
 * storage stays absent, which is what keeps the builtin per-file defaults
 * (e.g. the markdown family's wrap) reachable after unrelated toggles.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/settings
 */

/** Setting names this build knows (mirrors the Host validator's allow-list). */
export const SETTINGS_KEYS = ['autoReloadClean', 'highlightActiveLine', 'showLineNumbers', 'scrollBeyondLastLine', 'wordWrap', 'showWhitespaceSpaces', 'showWhitespaceTabs', 'showWhitespaceNewlines'];

/**
 * The built-in settings: behavior opt-ins off, presentation defaults on.
 * @returns a fresh settings object (callers may mutate their copy).
 */
export function defaultSettings() {
	return {
		autoReloadClean: false,
		highlightActiveLine: true,
		showLineNumbers: true,
		scrollBeyondLastLine: true,
		wordWrap: false,
		showWhitespaceSpaces: false,
		showWhitespaceTabs: false,
		showWhitespaceNewlines: false
	};
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

/**
 * Build the wire payload for one settings write: the RAW stored set (only
 * explicitly-stored keys) merged with the caller's change. Never fills
 * defaults — absence of a key IS the "never explicitly set" signal the
 * per-file resolution depends on. Returns undefined for any payload that
 * is not an object or carries a key outside SETTINGS_KEYS / a
 * non-boolean value. A non-object `rawSettings` (first frame, failed read)
 * is treated as the empty set, so the write stores exactly the change.
 * @param {any} rawSettings - the raw stored settings payload (`getRawSettings()`).
 * @param {any} input - the caller's change (`{ [knownName]: boolean }`).
 * @returns the complete explicit write payload, or `undefined` when invalid.
 */
export function buildSettingsWritePayload(rawSettings, input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
	const payload = {};
	if (rawSettings !== null && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
		for (const key of Object.keys(rawSettings)) {
			if (!SETTINGS_KEYS.includes(key) || typeof rawSettings[key] !== 'boolean') return undefined;
			payload[key] = rawSettings[key];
		}
	}
	for (const key of Object.keys(input)) {
		if (!SETTINGS_KEYS.includes(key) || typeof input[key] !== 'boolean') return undefined;
		payload[key] = input[key];
	}
	return payload;
}
