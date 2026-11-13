/**
 * Active-line highlight geometry — the pure math behind the editor's
 * "highlight the line(s) the caret/selection touches" affordance.
 *
 * Two functions, no DOM:
 *
 * - `activeLineRangeOf(selection)` — the CONTRACT's line derivation: the
 *   machine snapshot's `selection` (`{ start, end, lineStart, lineEnd, text }`,
 *   or `null` before the first selection report) maps to the inclusive 1-based
 *   line range the highlight covers. A collapsed selection highlights the
 *   caret line only; a multi-line selection highlights every touched line.
 *   Anything invalid degrades to line 1, so a malformed snapshot can never
 *   crash or hide the editor.
 * - `activeLineBar(range, metrics)` — the bar's content-space geometry:
 *   `top = paddingTop + (lineStart - 1) * lineHeight`,
 *   `height = (lineEnd - lineStart + 1) * lineHeight`. Valid only because the
 *   plain-text textarea never wraps (`wrap: 'off'` + `white-space: pre`), so
 *   every rendered line is exactly one `lineHeight` tall; a wrapping mode must
 *   measure its own geometry and cannot reuse this math.
 *
 * Both normalize defensively (swap reversed bounds, clamp to ≥ 1, ignore
 * non-finite metrics) so the DOM layer can pipe untrusted values straight in.
 *
 * `lineHeightPxOf(rawLineHeight, fontSizePx)` turns the *computed* line-height
 * into the px-per-line number the geometry needs. The trap: CSSOM's resolved
 * value of `line-height` is its computed value, and a unitless specified value
 * (`line-height: 1.5`, this editor's case) stays unitless — `"1.5"`, not
 * `"19.5px"` — for hidden AND rendered elements alike. Parsing it naively
 * yields 1.5 "pixels". The fix is arithmetic on computed values, which do not
 * depend on rendering state: px strings pass through, unitless strings
 * multiply the computed font size (also a px string), `normal` and garbage
 * fail (`null`) so the caller keeps re-measuring instead of caching a poison
 * value.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/active-line
 */

/**
 * Derive the highlighted line range from a machine selection snapshot.
 * @param {any} selection - the snapshot's `selection` value (`null` allowed).
 * @returns {{ lineStart: number, lineEnd: number }} inclusive 1-based range.
 */
export function activeLineRangeOf(selection) {
	const source = selection !== null && typeof selection === 'object' ? selection : {};
	const lineStart = Number.isFinite(source.lineStart) ? Math.max(1, Math.floor(source.lineStart)) : 1;
	const lineEnd = Number.isFinite(source.lineEnd) ? Math.max(1, Math.floor(source.lineEnd)) : 1;
	return lineEnd < lineStart ? { lineStart: lineEnd, lineEnd: lineStart } : { lineStart, lineEnd };
}

/**
 * The content-space geometry of the highlight bar for a line range.
 * @param {any} range - `{ lineStart, lineEnd }` (normalized via
 *   `activeLineRangeOf`, so caller-side preprocessing is optional).
 * @param {any} metrics - `{ paddingTop, lineHeight }` in CSS pixels, as
 *   measured off the textarea's computed style.
 * @returns {{ top: number, height: number }} content-space pixels; apply the
 *   scroll offset at the DOM layer.
 */
export function activeLineBar(range, metrics) {
	const { lineStart, lineEnd } = activeLineRangeOf(range);
	const paddingTop =
		metrics !== null && typeof metrics === 'object' && Number.isFinite(metrics.paddingTop) ? metrics.paddingTop : 0;
	const lineHeight =
		metrics !== null && typeof metrics === 'object' && Number.isFinite(metrics.lineHeight) && metrics.lineHeight > 0
			? metrics.lineHeight
			: 1;
	return {
		top: paddingTop + (lineStart - 1) * lineHeight,
		height: (lineEnd - lineStart + 1) * lineHeight,
	};
}

/**
 * Turn the computed `line-height` (plus the computed `font-size` in px) into
 * the px height of one rendered line.
 * @param {any} rawLineHeight - `getComputedStyle().lineHeight` — a px string
 *   (`"19.5px"`), a unitless multiplier (`"1.5"`), `'normal'`, or garbage.
 * @param {any} fontSizePx - the computed font size in px (`parseFloat` of
 *   `getComputedStyle().fontSize`).
 * @returns {number | null} px per line, or `null` when no trustworthy value
 *   can be derived (the caller must not cache a measurement of `null`).
 */
export function lineHeightPxOf(rawLineHeight, fontSizePx) {
	const fontSize = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : NaN;
	if (!Number.isFinite(fontSize)) return null;
	if (typeof rawLineHeight !== 'string') return null;
	const trimmed = rawLineHeight.trim();
	if (trimmed.endsWith('px')) {
		const px = parseFloat(trimmed);
		return Number.isFinite(px) && px > 0 ? px : null;
	}
	const multiplier = trimmed === '' || trimmed === 'normal' ? NaN : parseFloat(trimmed);
	if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
	const px = multiplier * fontSize;
	return Number.isFinite(px) && px > 0 ? px : null;
}
