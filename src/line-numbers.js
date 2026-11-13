/**
 * Line-number gutter math — the pure model behind the editor's
 * "show line numbers beside the content" affordance.
 *
 * Three functions, no DOM:
 *
 * - `lineNumbersText(lineCount)` — the gutter's whole content as ONE text
 *   block (`"1\n2\n…\nN"`), rendered into a pre-styled element whose
 *   line-height matches the textarea's. Valid only because the plain-text
 *   textarea never wraps (`wrap: 'off'` + `white-space: pre`), so logical
 *   line k sits exactly k lineHeights down — the same precondition as
 *   src/active-line.js.
 * - `lineNumberDigits(lineCount)` — the widest number's digit count, clamped
 *   to the minimum 2-column gutter so a one-line file doesn't jump width.
 * - `gutterWidthCh(lineCount)` — the gutter's total width in `ch` units
 *   (digits + the inter-column gap), the number the DOM layer applies to
 *   both the gutter element and the textarea's extra `padding-left`. `ch`
 *   is exact here: the editor area is monospace, so one ch is one digit.
 *
 * All three normalize defensively (floor fractional counts, clamp to ≥ 1,
 * degrade invalid input to the one-line / two-column minimum) so the DOM
 * layer can pipe untrusted values straight in — malformed input can never
 * crash or shrink the editor.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/line-numbers
 */

/** Gap between the numbers and the content edge, in `ch` units. MUST stay
 * in sync with `.dsh-editor-gutter-text`'s `padding-right` (src/client-entry.js
 * STYLES) — the CSS value positions the digits inside the gutter, this value
 * sizes the gutter and the textarea's matching `padding-left`. */
const GUTTER_GAP_CH = 2.5;

/** Minimum gutter columns so a short file keeps a stable width. */
const MIN_DIGITS = 2;

/**
 * Normalize a line count into a usable integer (≥ 1); anything invalid
 * degrades to 1.
 * @param {any} lineCount - the caller's count (usually the draft's line total).
 * @returns {number} a positive integer.
 */
function normalizedLineCount(lineCount) {
	const count = typeof lineCount === 'number' && Number.isFinite(lineCount) ? Math.floor(lineCount) : 1;
	return count >= 1 ? count : 1;
}

/**
 * The gutter's content: one number per line, 1 through N.
 * @param {any} lineCount - the draft's line total (invalid degrades to 1).
 * @returns {string} the text block for the pre-styled gutter element.
 */
export function lineNumbersText(lineCount) {
	const count = normalizedLineCount(lineCount);
	if (count === 1) return '1';
	const numbers = new Array(count);
	for (let index = 0; index < count; index += 1) numbers[index] = String(index + 1);
	return numbers.join('\n');
}

/**
 * The widest number's digit count, clamped to the two-column minimum.
 * @param {any} lineCount - the draft's line total (invalid degrades to 1).
 * @returns {number} columns, at least 2.
 */
export function lineNumberDigits(lineCount) {
	const count = normalizedLineCount(lineCount);
	return Math.max(MIN_DIGITS, String(count).length);
}

/**
 * The gutter's total width in `ch` units: the digit columns plus the
 * inter-column gap. The DOM layer applies this to the gutter element AND the
 * textarea's extra `padding-left`, so the content starts right of the gutter.
 * @param {any} lineCount - the draft's line total (invalid degrades to 1).
 * @returns {number} the width in ch units.
 */
export function gutterWidthCh(lineCount) {
	return lineNumberDigits(lineCount) + GUTTER_GAP_CH;
}
