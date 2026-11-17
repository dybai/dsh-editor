/**
 * Wrap geometry — the pure math model behind soft-wrapped line layout.
 *
 * When the textarea wraps, one source line renders as `rowsOf(line)` visual
 * rows, so "line N starts at pixel Y" can no longer come from `N × lineHeight`
 * the way it does in the unwrapped model (`scroll-beyond.js`, `active-line.js`).
 * This module owns that replacement math, built from the per-line row counts a
 * measurer supplies: a prefix-sum table answers `rowsOf` / `rowsBefore` /
 * `visualTop` in O(1), and a binary search over the same table maps a pixel
 * offset back to its line. Row estimates (`estimateRows`,
 * `estimateAllRows`) and the line-level text diff (`changedLineRange`) round
 * out what a wrap controller needs to decide which gutter entries to repaint.
 *
 * Boundary rule (viewport semantics): a pixel offset that lands exactly on a
 * row boundary belongs to the NEXT line (`lineAtVisualOffset(visualTop(L))`
 * is `L`), and an offset at or past the content's total height clamps to the
 * last line. Callers probing a viewport's bottom edge therefore use the edge
 * offset itself — a line whose visual extent merely touches the bottom edge
 * counts as visible (overlap ≥ 0), and the answer never exceeds line N the
 * way `visibleLines`-style ranges need.
 *
 * Everything here normalizes defensively in the house style — no input shape
 * throws, and unusable input degrades to a safe value (`null`, `0`, `1`,
 * `{ start: 1, end: 1 }`) — so the DOM layer can pipe untrusted measurements
 * straight in and a malformed count can never corrupt the layout.
 *
 * Zero imports: pure function only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/wrap-geometry
 */

/**
 * Conservative East Asian wide ranges, as `codePointColumns` consumes them:
 * a flat `[start, end, start, end, …]` table of code points rendered two
 * columns wide. Deliberately smaller than Unicode's full East Asian Width
 * tables — the estimate only has to be an upper-ish bound that never
 * undercounts a wrapped row.
 */
const WIDE_CODE_POINTS = [
	0x1100, 0x115f,
	0x2e80, 0x303e,
	0x3041, 0x33ff,
	0x3400, 0x4dbf,
	0x4e00, 0x9fff,
	0xa000, 0xa4cf,
	0xac00, 0xd7a3,
	0xf900, 0xfaff,
	0xfe30, 0xfe4f,
	0xff00, 0xff60,
	0xffe0, 0xffe6,
	0x20000, 0x2fffd,
	0x30000, 0x3fffd
];

/**
 * The column width of one code point: `2` inside the conservative wide table,
 * `1` everywhere else. Surrogate pairs arrive as a single whole code point.
 * @param {number} codePoint - a Unicode code point.
 * @returns {number} `2` for East Asian wide code points, otherwise `1`.
 */
function codePointColumns(codePoint) {
	for (let i = 0; i < WIDE_CODE_POINTS.length; i += 2) {
		if (codePoint >= WIDE_CODE_POINTS[i] && codePoint <= WIDE_CODE_POINTS[i + 1]) return 2;
	}
	return 1;
}

/**
 * The tab stop size to use: `tabColumns` when it is an integer ≥ 1, otherwise
 * the classic default of `8`. Any unusable value (non-number, fractional,
 * `0`, negative, `NaN`) silently falls back rather than throwing.
 * @param {any} tabColumns - caller's tab width in columns.
 * @returns {number} an integer ≥ 1.
 */
function normalizedTabColumns(tabColumns) {
	if (typeof tabColumns !== 'number' || !Number.isInteger(tabColumns) || tabColumns < 1) return 8;
	return tabColumns;
}

/**
 * Counts the display columns of one source line: one column per code point,
 * two for East Asian wide code points, and a tab that advances to the NEXT
 * multiple of `tabColumns` (a tab sitting exactly on a stop still advances a
 * full width, so columns never stall). Fractional nothing: the result is
 * always an integer ≥ 0.
 * @param {any} lineText - one source line, without its newline.
 * @param {any} tabColumns - tab stop width in columns; non-integer or < 1
 *   falls back to `8`.
 * @returns {number} display columns; `0` for unusable input.
 */
export function columnsOf(lineText, tabColumns) {
	if (typeof lineText !== 'string') return 0;
	const stops = normalizedTabColumns(tabColumns);
	let columns = 0;
	for (const character of lineText) {
		if (character === '\t') {
			columns = (Math.floor(columns / stops) + 1) * stops;
			continue;
		}
		columns += codePointColumns(character.codePointAt(0));
	}
	return columns;
}

/**
 * Estimates how many visual rows one source line occupies when wrapped at
 * `charsPerRow` columns per row: `max(1, ceil(columns / charsPerRow))`. A
 * line is always at least one row, and unusable `charsPerRow` degrades the
 * estimate to `1` so a broken measurement can only ever over-count repaint
 * work, never drop a line from the gutter.
 * @param {any} lineText - one source line, without its newline.
 * @param {any} charsPerRow - wrap width in columns; non-finite or ≤ 0
 *   degrades to a single-row estimate.
 * @param {any} tabColumns - tab stop width in columns (see `columnsOf`).
 * @returns {number} estimated visual rows, always ≥ 1.
 */
export function estimateRows(lineText, charsPerRow, tabColumns) {
	if (typeof charsPerRow !== 'number' || !Number.isFinite(charsPerRow) || charsPerRow <= 0) return 1;
	return Math.max(1, Math.ceil(columnsOf(lineText, tabColumns) / charsPerRow));
}

/**
 * Estimates visual rows for a whole document. A document always has at least
 * one line, so unusable `lines` (not an array, or empty) degrades to `[1]`
 * rather than an empty geometry; unusable individual lines degrade to `1` via
 * `estimateRows`.
 * @param {any} lines - source lines, newlines stripped.
 * @param {any} charsPerRow - wrap width in columns (see `estimateRows`).
 * @param {any} tabColumns - tab stop width in columns (see `columnsOf`).
 * @returns {number[]} one estimated row count per line.
 */
export function estimateAllRows(lines, charsPerRow, tabColumns) {
	if (!Array.isArray(lines) || lines.length === 0) return [1];
	return lines.map((lineText) => estimateRows(lineText, charsPerRow, tabColumns));
}

/**
 * The 1-based closed range of lines a text edit touched: the union of the
 * lines that differ between the old and new text, from the first differing
 * line to the last. Texts split on `\n`, then a matching prefix and a
 * matching suffix are peeled off so an edit that only reflows the middle
 * stays as narrow as the real change.
 * @param {any} oldText - the text before the edit.
 * @param {any} newText - the text after the edit.
 * @returns {number | {start: number, end: number}} `null` when the texts are
 *   equal; otherwise `{ start, end }`, 1-based and inclusive. Non-string
 *   input degrades to `{ start: 1, end: 1 }` — the whole-document repaint
 *   a never-throw controller can fall back on.
 */
export function changedLineRange(oldText, newText) {
	if (typeof oldText !== 'string' || typeof newText !== 'string') return { start: 1, end: 1 };
	if (oldText === newText) return null;
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');
	const shared = Math.min(oldLines.length, newLines.length);
	let front = 0;
	while (front < shared && oldLines[front] === newLines[front]) front++;
	let back = 0;
	while (back < shared - front && oldLines[oldLines.length - 1 - back] === newLines[newLines.length - 1 - back]) back++;
	return { start: front + 1, end: Math.max(oldLines.length, newLines.length) - back };
}

/**
 * Builds the wrap geometry from per-line row counts. `counts[i]` is how many
 * visual rows source line `i + 1` renders; `lineHeightPx` is the rendered
 * height of one visual row. Lines are 1-based throughout. Unusable input
 * yields `null` — the caller keeps its previous geometry rather than laying
 * out against a guess.
 * @param {any} counts - one row count per source line: a non-empty array of
 *   finite integers ≥ 1.
 * @param {any} lineHeightPx - px height of one visual row, finite > 0.
 * @returns {object | null} the geometry — `{ rowsOf, rowsBefore, visualTop,
 *   lineAtVisualOffset, totalRows }` — or `null` for unusable input.
 */
export function buildWrapGeometry(counts, lineHeightPx) {
	const height = typeof lineHeightPx === 'number' ? lineHeightPx : NaN;
	if (!Array.isArray(counts) || counts.length === 0) return null;
	if (!Number.isFinite(height) || height <= 0) return null;
	for (const rows of counts) {
		if (typeof rows !== 'number' || !Number.isFinite(rows) || rows < 1 || Math.floor(rows) !== rows) return null;
	}
	const lineCount = counts.length;
	const prefix = new Array(lineCount + 1);
	prefix[0] = 0;
	for (let i = 0; i < lineCount; i++) prefix[i + 1] = prefix[i] + counts[i];
	const total = prefix[lineCount];
	// 0-based index clamped into [0, lineCount − 1]: unusable or < 1 → first
	// line, > lineCount → last line, a fractional line floors to where it
	// starts.
	const indexOf = (line) => {
		if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return 0;
		if (line > lineCount) return lineCount - 1;
		return Math.floor(line) - 1;
	};
	const rowsBeforeLine = (line) => {
		if (typeof line !== 'number' || !Number.isFinite(line) || line <= 1) return 0;
		if (line > lineCount) return total;
		return prefix[Math.floor(line) - 1];
	};
	return {
		/**
		 * Visual rows the given source line renders, clamped into the
		 * document: `line < 1` reads line 1, `line > N` reads line N.
		 * @param {any} line - 1-based source line.
		 * @returns {number} row count of the clamped line.
		 */
		rowsOf(line) {
			return counts[indexOf(line)];
		},
		/**
		 * Visual rows strictly above the given source line — its `visualTop`
		 * in rows. `line ≤ 1` is `0`; `line ≥ N + 1` is `totalRows()`.
		 * @param {any} line - 1-based source line.
		 * @returns {number} rows above the line.
		 */
		rowsBefore(line) {
			return rowsBeforeLine(line);
		},
		/**
		 * The y offset of the line's first visual row, in px from the top of
		 * the CONTENT — `rowsBefore(line) × lineHeightPx`, deliberately
		 * excluding padding so the caller adds its own box offsets.
		 * @param {any} line - 1-based source line.
		 * @returns {number} content-relative px offset.
		 */
		visualTop(line) {
			return rowsBeforeLine(line) * height;
		},
		/**
		 * The source line whose visual extent covers pixel offset `px`, by
		 * binary search over the prefix sums: the first line `L` with
		 * `visualTop(L + 1) > px`. A pixel exactly on a row boundary lands on
		 * the NEXT line; `px ≥ totalRows() × lineHeightPx` clamps to line N;
		 * `px < 0` (or unusable) lands on line 1. The clamps are what let a
		 * `visibleLines`-style viewport probe use its bottom edge directly:
		 * a line whose extent touches the bottom edge still counts as
		 * visible (overlap ≥ 0), and the answer never runs past line N.
		 * @param {any} px - offset in px from the top of the content.
		 * @returns {number} 1-based source line.
		 */
		lineAtVisualOffset(px) {
			if (typeof px !== 'number' || !Number.isFinite(px) || px < 0) return 1;
			if (px >= total * height) return lineCount;
			let low = 1;
			let high = lineCount;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (prefix[mid] * height > px) high = mid;
				else low = mid + 1;
			}
			return low;
		},
		/**
		 * Total visual rows in the document.
		 * @returns {number} sum of every line's row count.
		 */
		totalRows() {
			return total;
		}
	};
}
