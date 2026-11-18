/**
 * Indentation detection and unit resolution — the pure decision layer behind
 * the `indentMode` / `indentWidth` settings (0.13.0 "Tab indent").
 *
 * `detectIndentUnit` reads a file's text and answers what indentation the
 * file itself uses: scan the first `SAMPLE_LIMIT` non-blank lines, and any
 * line starting with a tab decides tabs immediately; otherwise the most
 * frequent leading-space count in `1..MAX_COUNTED_LEADING` wins (ties pick
 * the SMALLER width; counts above the cap are treated as alignment noise and
 * skipped, as are blank / whitespace-only lines). No signal at all → `null`.
 *
 * `resolveIndentUnit` turns settings + text into the exact string one Tab
 * press inserts: explicit `tabs` / `spaces` modes win; anything else (auto,
 * or defensively invalid settings) detects from the text and falls back to
 * the valid-width-or-4 spaces when the file carries no signal. It never
 * throws and never returns anything but `'\t'` or a space run.
 *
 * CRLF safety is free: lines are split on `'\n'`, so a trailing `'\r'` sits
 * at line END and can never affect leading-whitespace counting or the
 * `startsWith('\t')` probe.
 *
 * Single import from `./settings.js` (`INDENT_WIDTHS` only; the `indentMode`
 * dispatch uses the literals `'tabs'` / `'spaces'` / else-auto), single-line
 * named import per the bundler's constraints.
 *
 * @module @dybai/dsh-editor/indent
 */

import { INDENT_WIDTHS } from './settings.js';

/** How many non-blank lines are sampled for detection (spec §6.1). */
const SAMPLE_LIMIT = 200;

/** Leading-space counts above this are alignment noise, not indentation (spec §6.1). */
const MAX_COUNTED_LEADING = 16;

/**
 * Detect the indentation unit a text itself uses.
 *
 * Leading whitespace counts are computed as `line.length -
 * line.trimStart().length`, keeping only counts in `1..MAX_COUNTED_LEADING`:
 * zero-length (unindented) lines and over-long runs (>16, alignment noise)
 * never vote. The most frequent surviving count wins; ties pick the SMALLER
 * width. Blank / whitespace-only lines are not samples. A non-string `text`
 * is treated as `''` (no signal).
 * @param {any} text - the file text (any other type is treated as `''`).
 * @returns {{ mode: 'tabs' } | { mode: 'spaces', width: number } | null} the
 * detected unit, or `null` when no line carries any signal.
 */
export function detectIndentUnit(text) {
	const source = typeof text === 'string' ? text : '';
	const counts = new Array(MAX_COUNTED_LEADING + 1).fill(0);
	let samples = 0;
	for (const line of source.split('\n')) {
		if (!line.trim()) continue; // blank / whitespace-only: not a sample
		if (samples >= SAMPLE_LIMIT) break; // only the first 200 samples vote
		samples += 1;
		if (line.startsWith('\t')) return { mode: 'tabs' }; // any tab-prefixed sample decides immediately
		const leading = line.length - line.trimStart().length;
		if (leading >= 1 && leading <= MAX_COUNTED_LEADING) counts[leading] += 1;
	}
	let best = 0;
	for (let width = 1; width <= MAX_COUNTED_LEADING; width += 1) {
		if (counts[width] > counts[best]) best = width; // strict `>` keeps ties on the smaller width
	}
	return best === 0 ? null : { mode: 'spaces', width: best };
}

/**
 * Resolve the exact string one Tab press should insert.
 *
 * Explicit modes win: `tabs` → `'\t'`; `spaces` → `indentWidth` spaces, with
 * an out-of-table width defensively falling back to 4. Anything else (auto,
 * a missing/invalid mode, or a non-object `settings`) detects the unit from
 * the text; when detection finds no signal the configured width — valid per
 * `INDENT_WIDTHS`, else 4 — spaces are used. Never throws: a non-string
 * `text` is treated as `''`, and a non-object `settings` as auto/width-4.
 * @param {any} settings - the settings object (`indentMode`, `indentWidth`).
 * @param {any} text - the current file text (any other type is treated as `''`).
 * @returns {string} `'\t'` or a run of spaces — never anything else.
 */
export function resolveIndentUnit(settings, text) {
	const source = typeof text === 'string' ? text : '';
	const isObject = settings !== null && typeof settings === 'object';
	const mode = isObject ? settings.indentMode : undefined;
	if (mode === 'tabs') return '\t';
	if (mode === 'spaces') {
		const width = INDENT_WIDTHS.includes(settings.indentWidth) ? settings.indentWidth : 4;
		return ' '.repeat(width);
	}
	const detected = detectIndentUnit(source);
	if (detected === null) {
		const fallback = isObject && INDENT_WIDTHS.includes(settings.indentWidth) ? settings.indentWidth : 4;
		return ' '.repeat(fallback);
	}
	return detected.mode === 'tabs' ? '\t' : ' '.repeat(detected.width);
}
