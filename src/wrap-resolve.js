/**
 * Word-wrap setting resolution — the pure policy deciding whether a file
 * opens wrapped, as a three-layer chain: a matching per-glob override wins,
 * then the user's explicit global `wordWrap` setting, then the builtin
 * extension default.
 *
 * Four exports, no DOM:
 *
 * - `BUILTIN_WRAP_EXTENSIONS` — the frozen plain-data array of extensions that
 *   wrap by default (a module-private Set over it backs the lookups).
 * - `extensionOf(path)` — the lowercase extension of the file's basename,
 *   treating both `/` and `\` as separators. Dotfiles and extensionless
 *   names have no extension (`''`).
 * - `wrapGlobMatches(glob, path)` — whether a `*.<ext>` override glob
 *   matches a path: exact glob shape, lowercased path suffix match,
 *   case-insensitive on the path while the glob itself stays lowercase.
 * - `resolveWordWrap(rawSettings, path, overrides?)` — the override layer
 *   decides first when given: any hit with `enabled: true` wraps, hits that
 *   are all disabled do not, and no hit falls through to the lower layers.
 *   Below it the user's explicit `wordWrap` boolean wins when the stored
 *   settings own that property with a boolean value; anything else (unset,
 *   non-object, corrupted non-boolean) falls back to the builtin extension
 *   default, so markdown-family files wrap out of the box and everything
 *   else does not. Overrides that are missing or not an array skip the
 *   layer entirely, leaving the two-argument semantics untouched.
 *
 * Every function is never-throw: any input degrades to a boolean answer
 * (or `''`), so the DOM layer can pipe untrusted stored settings, raw paths
 * and stored override entries straight in without a crash.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/wrap-resolve
 */

/** The builtin wrap extensions as a frozen plain-data array constant: files
 * with these extensions wrap when the user has no explicit `wordWrap` setting
 * (the markdown family, where prose wants soft wrapping). Plain data, so
 * consumers can read or spread it; frozen, so mutation attempts throw. */
export const BUILTIN_WRAP_EXTENSIONS = Object.freeze(['md', 'markdown', 'mdx']);

/** Module-private lookup Set over the builtin defaults — `resolveWordWrap`
 * checks membership here; the exported constant above stays plain data. */
const BUILTIN_WRAP_SET = new Set(BUILTIN_WRAP_EXTENSIONS);

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

/** The glob shape a wrap override rule must have to be honored: a single
 * `*` prefix, a dot, then 1–16 lowercase letters or digits — byte-identical
 * to the Host-side write validator, so anything the service accepted parses
 * here and anything else (hand-edited storage) is skipped defensively. */
const WRAP_GLOB_SHAPE = /^\*\.[a-z0-9]{1,16}$/;

/**
 * Whether a `*.<ext>` wrap override glob matches a file path: the glob must
 * have the exact `*.<ext>` shape and the lowercased path must end with
 * `.` + the glob's extension, so matching is case-insensitive on the path
 * while the glob itself must already be lowercase (an uppercase glob is an
 * off-shape glob). Never throws: non-string inputs and off-shape globs are
 * simply no match.
 * @param {string} glob - the override glob, e.g. `'*.md'`.
 * @param {string} path - the file path being opened.
 * @returns {boolean} whether the glob matches the path.
 */
export function wrapGlobMatches(glob, path) {
	if (typeof glob !== 'string' || typeof path !== 'string') return false;
	if (!WRAP_GLOB_SHAPE.test(glob)) return false;
	return path.toLowerCase().endsWith('.' + glob.slice(2));
}

/**
 * Whether the editor opens this file wrapped, as a three-layer chain: a
 * matching per-glob override decides first (any `enabled: true` hit wraps;
 * hits that are all disabled do not; no hit falls through), then the user's
 * explicitly stored `wordWrap` boolean when present, then the builtin
 * extension default. Overrides must be an array of `{ glob, enabled }`
 * entries; a non-array overrides argument skips the layer entirely, and
 * malformed entries (non-objects, off-shape or non-string globs, non-boolean
 * `enabled`) are skipped — never throwing, never deciding.
 * @param {any} rawSettings - the user's stored settings, of any shape.
 * @param {string} path - the file path being opened.
 * @param {Array<{glob: string, enabled: boolean}>} [overrides] - the stored
 *   per-glob wrap overrides, the highest-priority layer when present.
 * @returns {boolean} whether the file wraps.
 */
export function resolveWordWrap(rawSettings, path, overrides) {
	if (Array.isArray(overrides)) {
		let hit = false;
		for (const entry of overrides) {
			if (entry === null || typeof entry !== 'object') continue;
			if (typeof entry.enabled !== 'boolean') continue;
			if (!wrapGlobMatches(entry.glob, path)) continue;
			hit = true;
			if (entry.enabled) return true;
		}
		if (hit) return false;
	}
	if (
		typeof rawSettings === 'object' && rawSettings !== null
		&& Object.prototype.hasOwnProperty.call(rawSettings, 'wordWrap')
		&& typeof rawSettings.wordWrap === 'boolean'
	) return rawSettings.wordWrap;
	return BUILTIN_WRAP_SET.has(extensionOf(path));
}
