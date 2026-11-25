/**
 * Language table — the single source of truth mapping a file extension to a
 * Shiki language id and to the lazy chunk group that ships that grammar.
 *
 * `warmup` languages are bundled into the main chunk so the first editor
 * open highlights with zero load; the four lazy groups (web / script /
 * system / data) each ship as one `require.async` chunk, loaded the first
 * time any of its languages is needed. Later tasks derive registration
 * globs with `deriveGlobs()` (one glob per extension: the extension pattern — the repo glob
 * translator has no brace expansion) and lazily load a whole group via
 * `groupOfLanguage(languageOf(path))`.
 *
 * Path semantics mirror the preview engine's language detection: basename
 * after the last `/` or `\`, suffix after the last dot (a leading dot still
 * separates, so `.env` → `dotenv`), lowercased, Map lookup; no dot, an
 * unknown suffix, or an empty suffix → undefined → plain text. There is no
 * content sniffing: `Makefile`, `Dockerfile` and `.gitignore` stay plain.
 *
 * Zero imports: pure data plus pure functions, unit-testable without DOM,
 * React or transport code.
 *
 * @module @dybai/dsh-editor/highlight/languages
 */

/** A frozen table row (the array and its extensions are frozen too). */
function row(language, group, extensions) {
	return Object.freeze({ language, group, extensions: Object.freeze(extensions) });
}

/** One row per language: its chunk group and its file extensions. */
export const LANGUAGE_TABLE = Object.freeze([
	// warmup — bundled into the main chunk, no load wait on first open
	row('javascript', 'warmup', ['js', 'mjs', 'cjs', 'jsx']),
	row('typescript', 'warmup', ['ts', 'mts', 'cts', 'tsx']),
	row('json', 'warmup', ['json', 'jsonc']),
	// web
	row('html', 'web', ['html', 'htm']),
	row('css', 'web', ['css']),
	row('scss', 'web', ['scss']),
	row('less', 'web', ['less']),
	row('vue', 'web', ['vue']),
	row('svelte', 'web', ['svelte']),
	// script
	row('shellscript', 'script', ['sh', 'bash', 'zsh', 'fish']),
	row('python', 'script', ['py', 'pyi']),
	row('ruby', 'script', ['rb']),
	row('php', 'script', ['php']),
	row('perl', 'script', ['pl', 'pm']),
	row('lua', 'script', ['lua']),
	row('powershell', 'script', ['ps1', 'psm1', 'psd1']),
	// system
	row('c', 'system', ['c', 'h']),
	row('cpp', 'system', ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx']),
	row('csharp', 'system', ['cs']),
	row('go', 'system', ['go']),
	row('java', 'system', ['java']),
	row('kotlin', 'system', ['kt', 'kts']),
	row('rust', 'system', ['rs']),
	row('swift', 'system', ['swift']),
	// data
	row('yaml', 'data', ['yaml', 'yml']),
	row('toml', 'data', ['toml']),
	row('ini', 'data', ['ini', 'properties', 'cfg', 'conf']),
	row('xml', 'data', ['xml', 'plist']),
	row('sql', 'data', ['sql']),
	row('markdown', 'data', ['md', 'markdown']),
	row('diff', 'data', ['diff', 'patch']),
	row('dotenv', 'data', ['env'])
]);

/** extension → language id, built once at module init from LANGUAGE_TABLE. */
const LANGUAGE_BY_EXTENSION = new Map();
/** language id → chunk group, built once at module init from LANGUAGE_TABLE. */
const GROUP_BY_LANGUAGE = new Map();
for (const tableRow of LANGUAGE_TABLE) {
	GROUP_BY_LANGUAGE.set(tableRow.language, tableRow.group);
	for (const extension of tableRow.extensions) LANGUAGE_BY_EXTENSION.set(extension, tableRow.language);
}

/**
 * Detect a path's language id from its extension. The basename is what
 * follows the last `/` or `\`; the suffix is what follows the last dot in
 * that basename (a leading dot still separates, so `.env` → `dotenv`), and
 * the lookup is case-insensitive. No dot, an unknown suffix, or an empty
 * suffix (a trailing dot) yields undefined — the file renders as plain text.
 * Never throws: a non-string input is undefined.
 * @param {any} path - the file's decoded path.
 * @returns {string | undefined} the table language id, or undefined.
 */
export function languageOf(path) {
	if (typeof path !== 'string') return undefined;
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const basename = path.slice(slash + 1);
	const dot = basename.lastIndexOf('.');
	if (dot < 0) return undefined;
	const suffix = basename.slice(dot + 1);
	if (suffix === '') return undefined;
	return LANGUAGE_BY_EXTENSION.get(suffix.toLowerCase());
}

/**
 * Every extension's glob, one per extension across all rows, deduped in
 * table order. Each glob is the extension pattern with a leading
 * recursive-directory `**` segment: the repo glob translator anchors
 * patterns over the full path and has no brace expansion, so that prefix is
 * what lets a nested file match (being bounded, it matches zero segments, so
 * root files match too).
 * @returns {string[]} a fresh array of extension globs with the `**` prefix.
 */
export function deriveGlobs() {
	const globs = [];
	const seen = new Set();
	for (const tableRow of LANGUAGE_TABLE) {
		for (const extension of tableRow.extensions) {
			if (seen.has(extension)) continue;
			seen.add(extension);
			globs.push(`**/*.${extension}`);
		}
	}
	return globs;
}

/**
 * The lazy chunk group a language id belongs to.
 * @param {any} language - a table language id (e.g. 'python').
 * @returns {'warmup' | 'web' | 'script' | 'system' | 'data' | undefined}
 *   the group, or undefined for a language outside the table.
 */
export function groupOfLanguage(language) {
	return GROUP_BY_LANGUAGE.get(language);
}
