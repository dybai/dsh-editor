/**
 * Column ruler geometry — the pure math behind the editor's vertical ruler.
 *
 * A ruler line is pinned to the right edge of the Nth character cell, i.e. it
 * sits `bandWidth + N×1ch` from the content origin, where `bandWidth` is the
 * width of the line-number gutter (0 without line numbers) and each character
 * cell is exactly one `ch` wide (the plain-text textarea uses a monospace
 * font, so `ch` is the cell width by definition).
 *
 * Three functions, no DOM:
 *
 * - `isValidRulerColumn(value)` — whether `value` is an accepted column: an
 *   integer from `RULER_COLUMN_MIN` (1) through `RULER_COLUMN_MAX` (999),
 *   mirroring the Host's `rulerColumn` validator.
 * - `clampRulerColumnInput(raw)` — converge a user-typed value to the same
 *   range (rounding to the nearest integer first), or `null` when the input
 *   is not a finite number. Callers use the `null` to reject the keystroke
 *   instead of writing a malformed setting.
 * - `rulerLeftCh(column, bandWidth)` — the line's left edge in `ch` units.
 *   Defense: an invalid column degrades to the default 80 and a non-finite
 *   band width to 0, so untrusted measurements can never produce `NaN`
 *   geometry.
 *
 * Never throws: every input class is checked, not assumed.
 *
 * @module @dybai/dsh-editor/ruler
 */

import { RULER_COLUMN_MAX, RULER_COLUMN_MIN } from './settings.js';

/**
 * Whether the value is a legal ruler column.
 * @param {any} value - the value to check.
 * @returns {boolean} true for an integer from RULER_COLUMN_MIN to
 *   RULER_COLUMN_MAX (inclusive).
 */
export function isValidRulerColumn(value) {
	return typeof value === 'number' && Number.isInteger(value) && value >= RULER_COLUMN_MIN && value <= RULER_COLUMN_MAX;
}

/**
 * Converge a raw ruler-column input to the accepted integer range.
 * @param {any} raw - the user-typed / persisted value.
 * @returns {number | null} the nearest integer clamped to
 *   [RULER_COLUMN_MIN, RULER_COLUMN_MAX], or `null` when the input is not a
 *   finite number.
 */
export function clampRulerColumnInput(raw) {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
	return Math.min(RULER_COLUMN_MAX, Math.max(RULER_COLUMN_MIN, Math.round(raw)));
}

/**
 * The ruler line's left edge in character cells (`ch`) from the content
 * origin: the right edge of the Nth cell, `bandWidth + column` ch.
 * @param {any} column - the 1-based ruler column; invalid values fall back to
 *   the editor default 80.
 * @param {any} bandWidth - the line-number gutter width in `ch`; a
 *   non-finite value falls back to 0 (no gutter).
 * @returns {number} the content-space left offset in `ch`.
 */
export function rulerLeftCh(column, bandWidth) {
	const safeColumn = isValidRulerColumn(column) ? column : 80;
	const safeBandWidth = Number.isFinite(bandWidth) ? bandWidth : 0;
	return safeBandWidth + safeColumn;
}
