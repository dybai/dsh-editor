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
