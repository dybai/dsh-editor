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

/**
 * Frame the line's glyph ink with the two hairline bands.
 *
 * The DOM layer measures (canvas TextMetrics) how the REAL font stack lays the
 * probe text out: `fontBoundingBoxAscent/Descent` locate the baseline inside
 * the line box (that placement is where the script asymmetry lives — Latin
 * fills the box roughly centered while CJK ideographs hang against the ascent
 * edge), and `actualBoundingBoxAscent/Descent` give the probe text's true ink
 * extents. This function turns those numbers into the two band positions:
 * `top` band's offset from the box top, `bottom` band's inset from the box
 * bottom — each flanking the ink by `padding`, clamped so the bands can never
 * cross, leave the box, or invade adjacent lines.
 *
 * `null` when any input is unusable: the caller keeps its static CSS fallback
 * (symmetric edge insets) instead of painting from a poison measurement.
 *
 * Band placement may extend past the line box into the inter-line whitespace,
 * bounded by `BAND_WINDOW_PX` (the clamp window; CJK lines keep their
 * descender zone empty, so bands up to 8px outside the box still sit between
 * the two text rows).
 * @param {any} metrics - `{ lineHeight, fontAscent, fontDescent, inkAscent,
 *   inkDescent, paddingTop?, paddingBottom?, bandHeight? }` in CSS pixels.
 * @returns {{ top: number, bottom: number } | null}
 */
const BAND_WINDOW_PX = 8;
export function glyphBandOffsets(metrics) {
	const source = metrics !== null && typeof metrics === 'object' ? metrics : {};
	const lineHeight = Number.isFinite(source.lineHeight) && source.lineHeight > 0 ? source.lineHeight : NaN;
	const fontAscent = Number.isFinite(source.fontAscent) ? source.fontAscent : NaN;
	const fontDescent = Number.isFinite(source.fontDescent) ? source.fontDescent : NaN;
	const inkAscent = Number.isFinite(source.inkAscent) && source.inkAscent >= 0 ? source.inkAscent : NaN;
	const inkDescent = Number.isFinite(source.inkDescent) && source.inkDescent >= 0 ? source.inkDescent : NaN;
	if (![lineHeight, fontAscent, fontDescent, inkAscent, inkDescent].every(Number.isFinite)) return null;
	const bandHeight = Number.isFinite(source.bandHeight) && source.bandHeight > 0 ? source.bandHeight : 2;
	const paddingTop = Number.isFinite(source.paddingTop) && source.paddingTop >= 0 ? source.paddingTop : 0;
	const paddingBottom = Number.isFinite(source.paddingBottom) && source.paddingBottom >= 0 ? source.paddingBottom : 0;
	// Bands may extend BEYOND the line box into the inter-line whitespace (a
	// box-edge clamp silently collapsed large paddings into identical paints,
	// making the tuning knobs feel dead). ±BAND_WINDOW_PX is the proven-safe
	// window: CJK lines keep their descender zone empty, so a band up to 8px
	// outside the box still lands between the two text rows.
	const windowFloor = -BAND_WINDOW_PX;
	const windowCeiling = lineHeight - bandHeight;
	const clamp = (value) => Math.max(windowFloor, Math.min(value, windowCeiling));
	const halfLeading = (lineHeight - (fontAscent + fontDescent)) / 2;
	const baseline = halfLeading + fontAscent;
	const inkTop = baseline - inkAscent;
	const inkBottom = baseline + inkDescent;
	return {
		top: clamp(inkTop - paddingTop),
		bottom: clamp(lineHeight - inkBottom - paddingBottom - bandHeight),
	};
}
