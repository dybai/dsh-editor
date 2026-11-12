/**
 * Editor mode ranking and association resolution.
 *
 * Given a decoded file path, choose which registered editor mode
 * implementation handles it. Precedence:
 *
 * 1. `transientPin` — highest, returned directly and exempt from the
 *    `matches` veto.
 * 2. Persisted `associations` (`[{ glob, modeId }]`) — the first record
 *    whose glob hits wins; exempt from the `matches` veto.
 * 3. Ranking over `entries` — priority band (`extension` > `builtin` >
 *    `fallback`), then glob specificity (longest matched pattern), then
 *    registration order.
 * 4. `matches(path)` veto — removes ranked candidates (only for
 *    non-pinned resolution).
 *
 * Pure functions only; no candidates resolve to `undefined`, which is a
 * normal state — the caller decides what fallback to show.
 */

/** Priority bands, best first. Unknown or missing bands rank as `fallback`. */
const BAND_ORDER = { extension: 0, builtin: 1, fallback: 2 };

/** Characters with special meaning in a RegExp, to be escaped literally. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Translate a file-pattern glob into an anchored, case-insensitive RegExp:
 * `**` as a whole segment matches zero or more path segments (minimatch
 * convention — `a` + `/**` also matches `a` itself), `*` matches any
 * characters except `/`, `?` matches one character except `/`; a `**` not
 * bounded by slashes falls back to `.*`; everything else is literal.
 * @param {string} glob - pattern like `*.js` or `src` + `/**` + `*.ts` (segment wildcards).
 * @returns {RegExp} a fresh RegExp anchored to the full path.
 */
export function globToRegExp(glob) {
	let pattern = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				let j = i + 2;
				while (glob[j] === '*') j++;
				const bounded = (i === 0 || glob[i - 1] === '/') && (j === glob.length || glob[j] === '/');
				if (!bounded) {
					pattern += '.*';
					i = j - 1;
				} else if (j === glob.length) {
					// trailing `/**` keeps the slash inside the optional group
					pattern += i === 0 ? '.*' : '(?:/.*)?';
					i = j;
				} else {
					// leading or mid `**/` matches zero or more whole segments
					pattern += '(?:.*/)?';
					i = j;
				}
			} else {
				pattern += '[^/]*';
			}
		} else if (ch === '/') {
			// a slash followed only by stars at the end is a trailing `/**`
			let k = i + 1;
			while (glob[k] === '*') k++;
			if (k > i + 1 && k === glob.length) {
				pattern += '(?:/.*)?';
				i = k;
			} else {
				pattern += '/';
			}
		} else if (ch === '?') {
			pattern += '[^/]';
		} else {
			pattern += ch.replace(REGEX_SPECIAL, '\\$&');
		}
	}
	return new RegExp(`^${pattern}$`, 'i');
}

/**
 * Whether a glob matches a decoded file path (anchored, case-insensitive).
 * @param {string} glob - pattern like `*.js` or `docs` + `**` + `*.md` (segment wildcards).
 * @param {string} path - `/`-separated decoded path.
 * @returns {boolean}
 */
export function globMatches(glob, path) {
	return globToRegExp(glob).test(path);
}

/**
 * The longest matched glob of an entry, its specificity. An entry with no
 * `globs` matches every path with specificity 0.
 * @param {{ globs?: string[] }} entry
 * @param {string} path
 * @returns {number | undefined} the specificity, or undefined when no glob hits.
 */
function specificityOf(entry, path) {
	const globs = entry.globs;
	if (!Array.isArray(globs) || globs.length === 0) return 0;
	let best;
	for (const glob of globs) {
		if (typeof glob === 'string' && globMatches(glob, path) && (best === undefined || glob.length > best)) {
			best = glob.length;
		}
	}
	return best;
}

/**
 * Resolve which registered editor mode handles a path.
 * @param {Array<{ id: string, priority?: string, globs?: string[], matches?: (path: string) => boolean }>} entries
 *   registered mode descriptors in registration order.
 * @param {string} path - the file's decoded, `/`-separated path.
 * @param {Array<{ glob: string, modeId: string }> | undefined} associations
 *   persisted glob associations; array order is priority order.
 * @param {string | undefined} transientPin - pinned mode id, returned as-is.
 * @returns {string | undefined} the effective implementation id, or
 *   undefined when nothing matches.
 */
export function resolveModeId(entries, path, associations, transientPin) {
	if (transientPin != null) return transientPin;
	if (Array.isArray(associations)) {
		for (const association of associations) {
			if (typeof association.glob === 'string' && globMatches(association.glob, path)) return association.modeId;
		}
	}
	if (!Array.isArray(entries)) return undefined;
	let best;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (typeof entry.matches === 'function' && !entry.matches(path)) continue;
		const specificity = specificityOf(entry, path);
		if (specificity === undefined) continue;
		const band = BAND_ORDER[entry.priority] ?? BAND_ORDER.fallback;
		// strict comparisons keep the earliest entry on every tie: registration order
		const outranks =
			best === undefined ||
			band < best.band ||
			(band === best.band && specificity > best.specificity);
		if (outranks) best = { id: entry.id, band, specificity };
	}
	return best?.id;
}
