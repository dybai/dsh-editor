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
 * `indentOp` / `outdentOp` apply one Tab / Shift+Tab press to a selection
 * (spec §6.3/§6.4): a collapsed caret inserts the unit; a single-line
 * selection is replaced by it; a selection whose text spans a `'\n'`
 * block-indents / block-outdents every touched line (`lineOf(start)` ..
 * `lineOf(end − 1)`). `outdentOp` returns `null` when no touched line has
 * anything to remove, so the caller can swallow the key without writing
 * back. Their tiny line-scan helpers are module-local by design: this file
 * imports nothing else from the editor.
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

/**
 * Normalize one selection offset to an integer clamped into `[0, length]`.
 * Non-number input becomes 0; a `NaN` number also becomes 0 (it cannot be
 * clamped), while any other number — including infinities — clamps.
 * @param {any} value - a raw selection offset.
 * @param {number} length - the text length upper bound.
 * @returns {number} a safe integer offset in `[0, length]`.
 */
function clampOffset(value, length) {
	const n = typeof value === 'number' && !Number.isNaN(value) ? Math.trunc(value) : 0;
	return Math.min(Math.max(n, 0), length);
}

/**
 * Index of the first character of the line containing `offset` — a backward
 * scan to the nearest `'\n'` (offset 0 and empty text both yield 0).
 * @param {string} text - the text to scan.
 * @param {number} offset - an offset already clamped into `[0, text.length]`.
 * @returns {number} the offset's line-start index.
 */
function lineStartOfIndex(text, offset) {
	let i = offset - 1;
	while (i >= 0 && text[i] !== '\n') i -= 1;
	return i + 1;
}

/**
 * Zero-based number of the line containing `offset` — a count of `'\n'`
 * characters before it.
 * @param {string} text - the text to scan.
 * @param {number} offset - an offset already clamped into `[0, text.length]`.
 * @returns {number} the offset's line number.
 */
function lineOfOffset(text, offset) {
	let line = 0;
	for (let i = 0; i < offset && i < text.length; i += 1) {
		if (text[i] === '\n') line += 1;
	}
	return line;
}

/**
 * Visit every line touched by a clamped selection `[from, to)` — lines
 * `lineOf(from)` through `lineOf(to − 1)`, so a selection ending at column 0
 * of a line excludes that line — calling `visit(lineStart, lineEnd)` per
 * touched line, where `lineEnd` excludes the terminator. Lines are split on
 * `'\n'`, so a CRLF `'\r'` stays at line END and never counts as indentation.
 * @param {string} text - the text to walk.
 * @param {number} from - clamped selection start.
 * @param {number} to - clamped selection end (`> from` is not required; an
 * empty walk simply never calls `visit`).
 * @param {(lineStart: number, lineEnd: number) => void} visit - per-line callback.
 * @returns {number} the start index of the first touched line.
 */
function eachTouchedLine(text, from, to, visit) {
	const firstLineStart = lineStartOfIndex(text, from);
	const lastLine = lineOfOffset(text, Math.max(0, to - 1));
	let pos = firstLineStart;
	let line = lineOfOffset(text, from);
	while (line <= lastLine) {
		const nl = text.indexOf('\n', pos);
		const lineEnd = nl === -1 ? text.length : nl;
		visit(pos, lineEnd);
		if (nl === -1) break;
		pos = nl + 1;
		line += 1;
	}
	return firstLineStart;
}

/**
 * Leading-whitespace removal for one line (spec §6.4): a `'\t'` unit removes
 * exactly one leading tab and never spaces; a space unit removes up to
 * `unit.length` leading spaces (0 when the line has none).
 * @param {string} line - one line's text without its terminator.
 * @param {string} unit - the indent unit (`'\t'` or a space run).
 * @returns {number} how many leading characters the line loses.
 */
function outdentRemoval(line, unit) {
	if (unit === '\t') return line.startsWith('\t') ? 1 : 0;
	let spaces = 0;
	while (spaces < line.length && line[spaces] === ' ') spaces += 1;
	return Math.min(spaces, unit.length);
}

/**
 * Apply one Tab press to a selection (spec §6.3). A collapsed caret inserts
 * the unit at the caret; a single-line selection is replaced by the unit; a
 * selection whose text spans a `'\n'` block-indents — the unit is inserted at
 * the start of every touched line (`lineOf(start)` .. `lineOf(end − 1)`), so
 * a selection covering `'a\n'` indents its first line only and keeps the
 * newline. The result selection starts after the unit on the first touched
 * line and ends at the old end shifted by every inserted unit. Inputs are
 * defensive: a non-string `text` is `''`, non-number (or `NaN`) offsets
 * become 0, all offsets are clamped into `[0, text.length]` and swapped when
 * `end < start` — never throws.
 * @param {any} text - the current file text (any other type is treated as `''`).
 * @param {any} start - selection start offset (normalized like `end`).
 * @param {any} end - selection end offset (normalized, swapped if `< start`).
 * @param {string} unit - the indent unit (`'\t'` or a space run; anything
 * else is treated as `''`).
 * @returns {{ text: string, start: number, end: number }} the new text and
 * selection.
 */
export function indentOp(text, start, end, unit) {
	const source = typeof text === 'string' ? text : '';
	const fill = typeof unit === 'string' ? unit : '';
	const a = clampOffset(start, source.length);
	const b = clampOffset(end, source.length);
	const from = Math.min(a, b);
	const to = Math.max(a, b);
	if (from === to) {
		// collapsed caret: just insert the unit
		return {
			text: source.slice(0, from) + fill + source.slice(from),
			start: from + fill.length,
			end: from + fill.length,
		};
	}
	if (!source.slice(from, to).includes('\n')) {
		// single-line selection: the selection itself becomes the unit
		return {
			text: source.slice(0, from) + fill + source.slice(to),
			start: from + fill.length,
			end: from + fill.length,
		};
	}
	// block indent: insert the unit at the start of every touched line
	const firstLineStart = lineStartOfIndex(source, from);
	let out = source.slice(0, firstLineStart);
	let prevEnd = firstLineStart;
	let count = 0;
	eachTouchedLine(source, from, to, (lineStart) => {
		out += source.slice(prevEnd, lineStart) + fill;
		prevEnd = lineStart;
		count += 1;
	});
	out += source.slice(prevEnd);
	return {
		text: out,
		start: firstLineStart + fill.length,
		end: to + fill.length * count,
	};
}

/**
 * Apply one Shift+Tab press to a selection (spec §6.4). Touched lines follow
 * the same rule as `indentOp` (`lineOf(start)` .. `lineOf(end − 1)`); each
 * loses one leading tab (for a `'\t'` unit) or up to `unit.length` leading
 * spaces (for a space unit). When every touched line has nothing to remove
 * the text is untouched and `null` is returned — the caller swallows the key
 * without writing back. Otherwise the removals are applied and the selection
 * shrinks by exactly the removed widths, clamped at 0. Same defensive input
 * handling as `indentOp`; never throws.
 * @param {any} text - the current file text (any other type is treated as `''`).
 * @param {any} start - selection start offset (normalized like `end`).
 * @param {any} end - selection end offset (normalized, swapped if `< start`).
 * @param {string} unit - the indent unit (`'\t'` or a space run; anything
 * else is treated as `''`).
 * @returns {{ text: string, start: number, end: number } | null} the new text
 * and selection, or `null` when there is nothing to remove.
 */
export function outdentOp(text, start, end, unit) {
	const source = typeof text === 'string' ? text : '';
	const fill = typeof unit === 'string' ? unit : '';
	const a = clampOffset(start, source.length);
	const b = clampOffset(end, source.length);
	const from = Math.min(a, b);
	const to = Math.max(a, b);
	const firstLineStart = lineStartOfIndex(source, from);
	let out = source.slice(0, firstLineStart);
	let prevEnd = firstLineStart;
	let totalRemoval = 0;
	let removalOnStartLine = 0;
	eachTouchedLine(source, from, to, (lineStart, lineEnd) => {
		out += source.slice(prevEnd, lineStart);
		const removal = outdentRemoval(source.slice(lineStart, lineEnd), fill);
		if (lineStart === firstLineStart) removalOnStartLine = removal;
		totalRemoval += removal;
		out += source.slice(lineStart + removal, lineEnd);
		prevEnd = lineEnd;
	});
	out += source.slice(prevEnd);
	if (totalRemoval === 0) return null;
	return {
		text: out,
		start: Math.max(0, from - removalOnStartLine),
		end: Math.max(0, to - totalRemoval),
	};
}

/**
 * Judge and shape the DOM splice for one Shift+Tab press (spec §6.5). The
 * editor's primary write-back path replaces the source segment
 * `[segStart, to)` with the operator's rewritten text, which reproduces
 * `outdentOp`'s full document byte-identically only while `to` lies beyond
 * every removed run. Removals happen at line STARTS while `outdentOp`
 * reports `end: to − Σremovals`, so a `to` inside the last touched line's
 * removed run would under-replace — silently eating line heads or the
 * selection tail. This helper owns that shape judgment so the keydown
 * wiring stays thin.
 *
 * Runs `outdentOp` first: nothing to remove → `null` (the caller swallows
 * the key without writing back). The only reachable unsafe shape is the
 * LAST touched line's removed run straddling `end` — first and
 * intermediate runs always end before the last line's start, which is
 * itself `< end` — so the guard is `end < lastLineStart + removedLast`.
 * Safe shapes return `{ segStart, segEnd, segText }`: replacing the source
 * segment `[segStart, to)` with `segText` yields `op.text` exactly, with
 * `segStart` the start of `lineOf(start)` and `segEnd = to − Σremovals`
 * equal to `op.end`.
 *
 * Same defensive input handling as `outdentOp`; never throws.
 * @param {any} text - the current file text (any other type is treated as `''`).
 * @param {any} start - selection start offset (normalized like `end`).
 * @param {any} end - selection end offset (normalized, swapped if `< start`).
 * @param {string} unit - the indent unit (`'\t'` or a space run).
 * @returns {{ segStart: number, segEnd: number, segText: string } | null} the
 * splice plan, or `null` when there is nothing to remove or the shape is
 * unsafe for the segment splice.
 */
export function outdentSplice(text, start, end, unit) {
	const source = typeof text === 'string' ? text : '';
	const fill = typeof unit === 'string' ? unit : '';
	const op = outdentOp(source, start, end, fill);
	if (op === null) return null;
	const a = clampOffset(start, source.length);
	const b = clampOffset(end, source.length);
	const from = Math.min(a, b);
	const to = Math.max(a, b);
	const lastLineStart = lineStartOfIndex(source, Math.max(0, to - 1));
	let totalRemoval = 0;
	let removedLast = 0;
	eachTouchedLine(source, from, to, (lineStart, lineEnd) => {
		const removal = outdentRemoval(source.slice(lineStart, lineEnd), fill);
		totalRemoval += removal;
		removedLast = removal; // the walk runs first → last touched line, so this lands on it
	});
	if (to < lastLineStart + removedLast) return null; // unsafe: to inside the last line's removed run
	const segStart = lineStartOfIndex(source, from);
	return {
		segStart,
		segEnd: to - totalRemoval,
		segText: op.text.slice(segStart, op.end)
	};
}
