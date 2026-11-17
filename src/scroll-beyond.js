/**
 * Scroll-beyond-last-line geometry — the pure math behind the textarea's
 * dynamic bottom padding.
 *
 * Writing an inline `padding-bottom = clientHeight − lineHeight` extends the
 * textarea's scrollable extent just enough that the last line can rise to the
 * viewport's top edge. With `N` lines of height `L`, padding top `P`, and
 * client height `C`, the padded box has `scrollHeight = P + N·L + (C − L)`, so
 * the maximum `scrollTop = scrollHeight − C = P + (N − 1)·L` — exactly the
 * content start of line `N`, the last line. A fully scrolled viewport therefore
 * shows only the last line at its top edge, with blank space below it; a
 * single-line file can still rise by exactly `paddingTop`.
 *
 * Valid only because the plain-text textarea never wraps (`wrap: 'off'` +
 * `white-space: pre`, the same precondition as `active-line.js` and
 * `line-numbers.js`), so every rendered line is exactly one `lineHeight` tall.
 * A wrapping mode must measure its own geometry and cannot reuse this math.
 *
 * `scrollBeyondPadding` normalizes defensively — any value that is not a
 * finite number, a negative `clientHeight`, or a `lineHeight <= 0` yields `0`
 * — so the DOM layer can pipe untrusted measurements straight in and a
 * malformed measurement can never throw or corrupt the scroll extent.
 * Fractional results pass through unrounded.
 *
 * Zero imports: pure function only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/scroll-beyond
 */

/**
 * The bottom padding, in CSS pixels, that lets the content scroll past the last
 * line: `max(0, clientHeight − lineHeight)`.
 * @param {any} clientHeight - the textarea's `clientHeight` in CSS pixels.
 * @param {any} lineHeight - px height of one rendered line (see
 *   `lineHeightPxOf` in `active-line.js`).
 * @returns {number} px to write as inline `padding-bottom`; `0` for unusable
 *   input.
 */
export function scrollBeyondPadding(clientHeight, lineHeight) {
	const height = typeof clientHeight === 'number' ? clientHeight : NaN;
	const line = typeof lineHeight === 'number' ? lineHeight : NaN;
	if (!Number.isFinite(height) || height < 0) return 0;
	if (!Number.isFinite(line) || line <= 0) return 0;
	return Math.max(0, height - line);
}

/**
 * The `scrollTop` that lands a jump-to-end with the last line sitting
 * `blankBelowLines` above the viewport's bottom edge, clamped to the real
 * scroll extent — and MONOTONE: the jump only ever advances toward the end.
 *
 * Why this exists: the browser's native end-of-content disclosure lands the
 * viewport at the scroll-extent bottom — with the scroll-beyond padding
 * applied that is the padded extent bottom, leaving the last line at the
 * viewport's TOP edge. End-key jumps are therefore owned by the editor, which
 * lands them here instead: the last line ends near the bottom (a small blank
 * band below it), and reaching the padded extent remains a manual scroll.
 *
 * The monotone rule (the `scrollTop` input): when the viewport is already
 * at-or-past the landing — the last page is on screen with the last line at
 * or above the reserve line — the viewport stays put and only the caret
 * moves. A jump never scrolls BACK toward the text just to enforce the
 * reserve width.
 *
 * `maxScrollTop` is the LIVE extent bottom (`scrollHeight − clientHeight`,
 * whatever padding is actually applied), passed in by the caller so this
 * function never re-derives the box model. Unusable input yields `null` — by
 * then the caller has already owned the jump, so the viewport simply stays
 * where it is rather than guessing (the caret's own minimal reveal still
 * applies).
 *
 * @param {any} input - `{ clientHeight, lineHeight, paddingTop, lineCount,
 *   maxScrollTop, scrollTop, blankBelowLines? }` in CSS pixels / lines /
 *   lines count; `scrollTop` is the viewport's current offset.
 * @returns {number | null} the clamped `scrollTop`, or `null` for unusable
 *   input. Fractional results pass through unrounded.
 */
export function endScrollTarget(input) {
	if (input === null || typeof input !== 'object') return null;
	const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);
	const height = finite(input.clientHeight);
	const line = finite(input.lineHeight);
	const top = finite(input.paddingTop);
	const max = finite(input.maxScrollTop);
	const from = finite(input.scrollTop);
	const blankRaw = input.blankBelowLines === undefined ? 5 : input.blankBelowLines;
	const blank = finite(blankRaw);
	const count = input.lineCount;
	if (!Number.isFinite(height) || height < 0) return null;
	if (!Number.isFinite(line) || line <= 0) return null;
	if (!Number.isFinite(top) || top < 0) return null;
	if (!Number.isFinite(max) || max < 0) return null;
	if (!Number.isFinite(from) || from < 0) return null;
	if (!Number.isFinite(blank) || blank < 0) return null;
	if (typeof count !== 'number' || !Number.isFinite(count) || count < 1 || Math.floor(count) !== count) return null;
	const landing = Math.min(Math.max(0, top + (count + blank) * line - height), Math.max(0, max));
	// Monotone: never scroll back toward the text. A viewport already past the
	// landing (current offset beyond it) keeps its position.
	const at = Math.min(from, Math.max(0, max));
	return Math.max(landing, at);
}
