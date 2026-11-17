/**
 * Word-wrap setting resolution — the pure policy deciding whether a file
 * opens wrapped.
 *
 * Two exports, no DOM:
 *
 * - `extensionOf(path)` — the lowercase extension of the file's basename,
 *   treating both `/` and `\` as separators. Dotfiles and extensionless
 *   names have no extension (`''`).
 * - `resolveWordWrap(rawSettings, path)` — the user's explicit `wordWrap`
 *   boolean wins when the stored settings own that property with a boolean
 *   value; anything else (unset, non-object, corrupted non-boolean) falls
 *   back to the builtin extension default, so markdown-family files wrap
 *   out of the box and everything else does not.
 *
 * Both are never-throw: any input degrades to a boolean answer (or `''`),
 * so the DOM layer can pipe untrusted stored settings and raw paths
 * straight in without a crash.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/wrap-resolve
 */

/** Extensions wrapped by default when the user has no explicit `wordWrap`
 * setting: the markdown family, where prose wants soft wrapping. */
export const BUILTIN_WRAP_EXTENSIONS = Object.freeze(new Set(['md', 'markdown', 'mdx']));

/**
 * The lowercase extension of a path's basename, with both `/` and `\`
 * treated as separators. Files with no dot in the basename, dotfiles
 * (leading dot), and names ending in a dot have no extension.
 * @param {string} path - the file path (invalid input yields `''`).
 * @returns {string} the extension after the basename's last dot, lowercase;
 *   `''` when there is none.
 */
export function extensionOf(path) {
	if (typeof path !== 'string' || path.length === 0) return '';
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return '';
	return name.slice(dot + 1).toLowerCase();
}

/**
 * Whether the editor opens this file wrapped: the user's explicitly stored
 * `wordWrap` boolean when present, otherwise the builtin extension default.
 * A stored non-boolean (corrupted settings) is not an explicit setting and
 * falls back to the default.
 * @param {any} rawSettings - the user's stored settings, of any shape.
 * @param {string} path - the file path being opened.
 * @returns {boolean} whether the file wraps.
 */
export function resolveWordWrap(rawSettings, path) {
	if (
		typeof rawSettings === 'object' && rawSettings !== null
		&& Object.prototype.hasOwnProperty.call(rawSettings, 'wordWrap')
		&& typeof rawSettings.wordWrap === 'boolean'
	) return rawSettings.wordWrap;
	return BUILTIN_WRAP_EXTENSIONS.has(extensionOf(path));
}
