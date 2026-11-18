/**
 * Whitespace rendering — the pure building layer behind the "show invisible
 * characters" affordance (spec §7.1): everything the DOM layer paints, it
 * paints from the fragments and numbers this module computes.
 *
 * Four functions, no DOM:
 *
 * - `buildWhitespaceRow({ text, spaces, tabs, newlines, tabSize })` — one
 *   source line as an ordered fragment list (`text` / `glyph` / `pad`), the
 *   glyph forms taken from `WHITESPACE_GLYPHS`, tab stops from `tabAdvance`
 *   over a running column counter that widths each code point via
 *   `codePointColumns` (imported from `wrap-geometry.js`, exported there as
 *   of this task).
 * - `tabAdvance(column, tabSize)` — the columns-to-next-stop arithmetic the
 *   fragment builder (and any tab-width ruler) shares.
 * - `visibleWindow({ scrollTop, paddingTop, lineHeight, clientHeight,
 *   lineCount, marginRows })` — the 0-based run of lines a viewport paints,
 *   margin-widened and clamped into the document.
 * - `showsNewlineGlyph(lines, lineNumber)` — whether a line ends with a real
 *   line break (a file's trailing newline draws no glyph anywhere).
 *
 * Everything normalizes defensively in the house style — no input shape
 * throws, and unusable input degrades to a safe value (an empty fragment
 * list, a full-width tab advance, `false`, the empty window) — so the DOM
 * layer can pipe untrusted switches and measurements straight in and a
 * malformed value can never corrupt a painted row.
 *
 * Pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/whitespace
 */

import { codePointColumns } from './wrap-geometry.js';

/**
 * The glyphs that stand in for invisible characters when whitespace display
 * is on: a middle dot for spaces, a rightwards arrow for tabs, a downwards
 * arrow with corner leftwards for the line break a row ends with. Frozen so
 * a consumer cannot re-point a glyph and corrupt every row painted after it.
 * @type {{space: string, tab: string, newline: string}}
 */
export const WHITESPACE_GLYPHS = Object.freeze({ space: '\u00B7', tab: '\u2192', newline: '\u21B5' });

/**
 * The tab stop width the whitespace layer falls back to when a caller's
 * `tabSize` is unusable — the editor's 4-column tab default.
 * @type {number}
 */
export const WHITESPACE_TAB_SIZE = 4;

/**
 * The value itself when it is a finite number, otherwise the fallback. The
 * one gate every arithmetic input in this module passes through, so DOM
 * measurements (or garbage) can be piped straight in and a `NaN` can never
 * leak into a painted row.
 * @param {any} value - caller-supplied number, maybe unusable.
 * @param {number} fallback - the safe answer for unusable input.
 * @returns {number} a finite number.
 */
function finiteNumberOr(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * How many columns a tab advances from `column` to reach the NEXT `tabSize`
 * stop: a tab sitting exactly on a stop still advances a full width, so the
 * result never stalls. `tabSize` that is not a finite number ≥ 1 falls back
 * to `WHITESPACE_TAB_SIZE`; a non-finite or negative `column` reads as
 * column `0`; a fractional one floors first — the answer is always an
 * integer ≥ 1 and at most the effective stop width.
 * @param {any} column - display columns already consumed on the row.
 * @param {any} tabSize - tab stop width in columns.
 * @returns {number} columns to the next stop, an integer ≥ 1.
 */
export function tabAdvance(column, tabSize) {
	const stops =
		typeof tabSize === 'number' && Number.isFinite(tabSize) && tabSize >= 1 ? Math.floor(tabSize) : WHITESPACE_TAB_SIZE;
	const at = Math.max(0, Math.floor(finiteNumberOr(column, 0)));
	return stops - (at % stops);
}

/**
 * Whether source line `lineNumber` (1-based, from `draft.split('\n')`) ends
 * with a real line break and therefore paints a ↵ glyph when whitespace
 * display is on: every line before the last does, except when the break
 * before a trailing empty last line is the file's trailing newline
 * (`'a\n'` shows no glyph anywhere). An invalid or out-of-range line
 * number — or a non-array `lines` — degrades to `false`, the no-glyph
 * answer, never a throw.
 * @param {any} lines - the split lines of the draft.
 * @param {any} lineNumber - 1-based source line.
 * @returns {boolean} whether the line's break glyph shows.
 */
export function showsNewlineGlyph(lines, lineNumber) {
	if (!Array.isArray(lines)) return false;
	if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length) {
		return false;
	}
	const last = lines.length - 1;
	return lineNumber < lines.length && !(lineNumber === last && lines[last] === '');
}

/**
 * The 0-based run of source lines a viewport should paint: the lines the
 * scroll position covers, widened by `marginRows` beyond each edge so fast
 * scrolling paints a buffer around the visible region, then clamped into
 * the document. The measurements arrive from the DOM layer and normalize
 * defensively: a `lineHeight` that is not a finite number > 0 degrades to
 * the empty window `{ first0: 0, count: 0 }`, unusable numerics read as
 * `0`, a `marginRows` that is not a positive integer reads as `0`, and the
 * run never starts below 0 or runs past `lineCount`.
 * @param {any} options - `{ scrollTop, paddingTop, lineHeight,
 *   clientHeight, lineCount, marginRows }` in px / rows, as measured.
 * @returns {{first0: number, count: number}} 0-based first line to paint
 *   and how many lines to paint.
 */
export function visibleWindow(options) {
	const source = options !== null && typeof options === 'object' ? options : {};
	const lineHeight = source.lineHeight;
	if (typeof lineHeight !== 'number' || !Number.isFinite(lineHeight) || lineHeight <= 0) return { first0: 0, count: 0 };
	const scrollTop = finiteNumberOr(source.scrollTop, 0);
	const paddingTop = finiteNumberOr(source.paddingTop, 0);
	const clientHeight = finiteNumberOr(source.clientHeight, 0);
	const lineCount = Math.max(0, Math.floor(finiteNumberOr(source.lineCount, 0)));
	const margin = Number.isInteger(source.marginRows) && source.marginRows > 0 ? source.marginRows : 0;
	const first0 = Math.min(Math.max(Math.floor((scrollTop - paddingTop) / lineHeight) - margin, 0), lineCount);
	const count = Math.min(Math.max(Math.ceil(clientHeight / lineHeight) + 2 * margin, 0), lineCount - first0);
	return { first0, count };
}

/**
 * Builds one rendered row's fragment list from a source line: plain text
 * stays text, and — per switch — a space becomes a · glyph, a tab becomes a
 * → glyph plus a `pad` covering the rest of its advance to the next stop,
 * and the row's line break becomes a trailing ↵ glyph. Fragments arrive in
 * paint order, each exactly `{ kind: 'text', text }`, `{ kind: 'glyph',
 * glyph }`, or `{ kind: 'pad', count }`, and adjacent text merges into one
 * fragment. Widths come from `codePointColumns` (wide code points count 2)
 * with tabs advancing per `tabAdvance`; the scan walks code points so
 * surrogate pairs survive whole. Unusable input degrades to an empty list —
 * never a throw, never a DOM read.
 * @param {any} options - `{ text, spaces, tabs, newlines, tabSize }`: the
 *   source line and which whitespace kinds render visibly.
 * @returns {Array<{kind: string, text?: string, glyph?: string, count?: number}>}
 *   the ordered fragments to paint.
 */
export function buildWhitespaceRow(options) {
	const source = options !== null && typeof options === 'object' ? options : {};
	const text = typeof source.text === 'string' ? source.text : '';
	const spaces = source.spaces === true;
	const tabs = source.tabs === true;
	const newlines = source.newlines === true;
	const fragments = [];
	let textChunk = '';
	let column = 0;
	const flushText = () => {
		if (textChunk === '') return;
		fragments.push({ kind: 'text', text: textChunk });
		textChunk = '';
	};
	for (const character of text) {
		if (spaces && character === ' ') {
			flushText();
			fragments.push({ kind: 'glyph', glyph: WHITESPACE_GLYPHS.space });
			column += 1;
			continue;
		}
		if (tabs && character === '\t') {
			flushText();
			const advance = tabAdvance(column, source.tabSize);
			fragments.push({ kind: 'glyph', glyph: WHITESPACE_GLYPHS.tab });
			fragments.push({ kind: 'pad', count: advance - 1 });
			column += advance;
			continue;
		}
		textChunk += character;
		column += codePointColumns(character.codePointAt(0));
	}
	flushText();
	if (newlines) fragments.push({ kind: 'glyph', glyph: WHITESPACE_GLYPHS.newline });
	return fragments;
}

/**
 * Vector shape specs for the whitespace glyphs — the font-INDEPENDENT
 * replacement for drawing the literal characters. Rationale (0.12.0 fix):
 * the old rendering put the glyph character inside a 1ch inline-block and
 * trusted `text-align: center`, but a glyph's ink position lives in its
 * FONT: on environments whose resolved monospace lacks U+00B7/U+2192 the
 * browser falls back to full-width CJK glyphs (advance ≈ 2ch) and Chrome
 * left-anchors over-wide line-box content (measured: ink offset 0, ink
 * wider than the box), so the ink landed at font-specific offsets — dots
 * hugging the cell's right edge, arrows hugging the left. Drawing fixed
 * vector shapes removes the font from the equation entirely: every
 * environment paints the same geometry at the same position.
 *
 * Each spec: `viewBox` (a 12×12 design space, stroked/filled with
 * `currentColor` at the layer's opacity), `elements` (tag + SVG attributes
 * verbatim; camelCase attribute keys are kebab-cased by the DOM builder),
 * and `yCenterEm` — the shape's vertical center ABOVE the text baseline in
 * em (the glyph box has zero height, so its bottom edge sits on the
 * baseline; this is the deterministic replacement for the old glyph's
 * baseline-relative ink position).
 * @param {any} glyph - the glyph character (`WHITESPACE_GLYPHS` member).
 * @returns {object | null} `{ viewBox, elements, yCenterEm }`, or `null`
 *   for unknown input (the DOM builder degrades to the literal character).
 */
export function glyphSvgShape(glyph) {
	if (glyph === WHITESPACE_GLYPHS.space) {
		return {
			viewBox: '0 0 12 12',
			yCenterEm: 0.32,
			elements: [{ tag: 'circle', cx: 6, cy: 6, r: 2.2, fill: 'currentColor' }]
		};
	}
	if (glyph === WHITESPACE_GLYPHS.tab) {
		return {
			viewBox: '0 0 12 12',
			yCenterEm: 0.3,
			elements: [{
				tag: 'path',
				d: 'M1.4,6 H10 M7.2,2.9 L10.3,6 L7.2,9.1',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round'
			}]
		};
	}
	if (glyph === WHITESPACE_GLYPHS.newline) {
		return {
			viewBox: '0 0 12 12',
			yCenterEm: 0.3,
			elements: [{
				tag: 'path',
				d: 'M10.6,3.4 H4.3 L2.7,5 V9.2 M1,7.6 L2.7,9.5 L4.4,7.6',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round'
			}]
		};
	}
	return null;
}
