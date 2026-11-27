/**
 * CM6 ruler pure core — the 0.14.0 column-guide geometry as a plain number
 * (Task 7).
 *
 * `rulerGeometry({ enabled, column, charWidth, gutterWidth, viewportWidth })`
 * answers the one number the Task 8 view shell positions the 1px guide line
 * at, or `null` when the ruler is off. The column normalizes EXACTLY like
 * the built-in DOM layer (components.js:563): `clampRulerColumnInput` rounds
 * a fractional value to the nearest integer, clamps the result into the
 * accepted 1–999 range, and a non-number / non-finite value falls back to
 * the editor default 80. This core must not invent a different clamp, or the
 * CM6 ruler and the plain-text ruler would sit on different columns for the
 * same setting — so it reuses `clampRulerColumnInput` from `src/ruler.js`
 * rather than re-deriving the 1–999/round/default contract.
 *
 * The geometry is the built-in contract (src/ruler.js, spec §7.2): the guide
 * is pinned to the right edge of the Nth character cell,
 * `gutterWidth + column × charWidth` px, in geometric columns that do not
 * depend on horizontal scroll, wrapping or folding. `viewportWidth` is
 * accepted for the shell's later clipping decisions and deliberately never
 * affects `x`.
 *
 * Defensive in the house style: the only way to get a non-`null` answer is a
 * literal-`true` switch, and an unusable measurement degrades to 0 instead of
 * leaking `NaN` into the geometry.
 *
 * @module @dybai/dsh-editor/cm6/ruler-layer
 */

import { clampRulerColumnInput } from '../ruler.js';

/**
 * The editor's default ruler column — the fallback the built-in layer uses
 * when the setting is absent or malformed (components.js:563).
 * @type {number}
 */
const DEFAULT_RULER_COLUMN = 80;

/**
 * A finite number when the value is one, otherwise 0 — the gate that keeps a
 * pixel measurement (or garbage) from turning `x` into `NaN`.
 * @param {any} value - caller-supplied measurement in px.
 * @returns {number} a finite number.
 */
function finiteNumberOrZero(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The ruler guide's content-space left offset for one editor state.
 *
 * `enabled` must be literally `true` (the DOM layer's gate); any other value
 * — including a truthy non-boolean and a missing input object — answers
 * `null`. With the ruler on, `column` converges through the same
 * `clampRulerColumnInput` the built-in layer calls (1–999, rounded, default
 * 80), and the answer is `{ x: gutterWidth + column × charWidth }` with
 * non-finite measurements reading as 0.
 * @param {any} [input] - the ruler state and the cell measurements.
 * @param {any} [input.enabled] - the ruler switch; only `true` turns it on.
 * @param {any} [input.column] - the configured 1-based column.
 * @param {any} [input.charWidth] - one character cell's width in px.
 * @param {any} [input.gutterWidth] - the line-number gutter's width in px.
 * @param {any} [input.viewportWidth] - the viewport width in px; accepted for
 *   the shell's clipping decisions and unused here.
 * @returns {{ x: number } | null} the guide's left offset in px, or `null`
 *   when the ruler is off.
 */
export function rulerGeometry(input = {}) {
	const source = input !== null && typeof input === 'object' ? input : {};
	// viewportWidth is accepted for the shell's later clipping decisions; the
	// guide is geometric-column semantics, independent of scroll and folding.
	if (source.enabled !== true) return null;
	const normalizedColumn = clampRulerColumnInput(source.column) ?? DEFAULT_RULER_COLUMN;
	const safeCharWidth = finiteNumberOrZero(source.charWidth);
	const safeGutterWidth = finiteNumberOrZero(source.gutterWidth);
	return { x: safeGutterWidth + normalizedColumn * safeCharWidth };
}
