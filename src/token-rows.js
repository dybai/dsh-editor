/**
 * Token row fragments — the pure building layer behind the syntax-highlight
 * token backdrop (Task 6): everything the DOM layer paints, it paints from
 * the fragments this module computes.
 *
 * One function, no DOM: `buildTokenRowFragments(lineText, tokens, slice)` —
 * one source line (or one per-visual-row slice of it, wrap mode) as an
 * ordered run list. Token runs carry their token's `color`/`fontStyle`;
 * the gaps BETWEEN tokens are plain text runs with `color: undefined` (the
 * DOM layer renders them bare, so they inherit the textarea's color instead
 * of painting some undefined ink). A token crossing the slice boundary is
 * split EXACTLY at it — the wrap-mode painter places one fragment list per
 * visual row and the slices must concatenate back into the line without
 * duplicating or dropping a character at the seams (review focus #4).
 *
 * Input contract is the engine's `TokenLine` (Task 4): rows of
 * `{ start, end, color, fontStyle }` with line-relative offsets, sorted and
 * non-overlapping as the tokenizer emits them. An over-1000-char line
 * arrives as ONE token with `color: ''` — the builder treats `''` like
 * `undefined`, so such a line paints as a plain run inheriting the
 * textarea's color, never as undefined-colored ink (spec §8's plain
 * rendering must stay plain through this layer).
 *
 * `buildTokenRowFragmentsWithTints(lineText, tokens, slice, tints)` is the
 * same builder with match-highlight tints folded in (0.18.0 token-tint
 * revision): `tints` — LINE-relative labeled ranges (the shape
 * `match-highlight.js` `mergeLayerRanges` produces) sharing the slice's
 * coordinate system — contribute their boundaries as extra split points, and
 * a run falling inside a tint interval carries its label (`'word'` /
 * `'selection'` / `'both'`, else `null`) ON the token run itself. One span
 * then carries the token ink AND the match background — the DOM layer no
 * longer overlays a separate highlight row whose advance can drift from a
 * styled token's. The slice/token/seam contract is mirrored exactly: with
 * unusable or empty tints every run degenerates to `tint: null` and the
 * output is exactly `buildTokenRowFragments`'s plus that field.
 *
 * The active-tint revision (2026-11-26) adds the `'active'` label — the
 * current selection's first-class tint (`mergeLayerRanges`'s third source):
 * it rides the runs under the same folding discipline as the match labels,
 * and the DOM layer paints it as `-match-active` (the replacement for the
 * inkless variant's suppressed native selection background).
 *
 * Everything normalizes defensively in the house style — no input shape
 * throws, and unusable input degrades to a safe value (an empty run list, a
 * skipped token, a whole-line slice) — so the DOM layer can pipe engine
 * output and caller-supplied slices straight in and a malformed value can
 * never corrupt a painted row.
 *
 * Pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/token-rows
 */

/**
 * Builds one rendered row's fragment list from a source line and its token
 * row: the runs cover `slice` (the whole line when `slice` is absent), each
 * run exactly `{ text, color, fontStyle }` — text runs in paint order,
 * token runs carrying the token's color/fontStyle and gaps carrying
 * `color: undefined` with fontStyle 0. Adjacent coverage merges naturally:
 * a gap is emitted only when it has length, and a token with unusable or
 * empty offsets is skipped rather than splitting a run around nothing.
 * An empty string or '' color marks an inherit run; a token fontStyle that
 * is not a finite number degrades to 0 (plain) so the contract's numeric
 * fontStyle holds for every emitted run. Unusable input degrades to an
 * empty list — never a throw, never a DOM read.
 * @param {any} lineText - the source line (or slice's source line) text.
 * @param {any} tokens - the engine's TokenLine row for that line.
 * @param {any} slice - `{ start, end }` offsets into `lineText` covering
 *   one visual row (wrap mode), or absent/null for the whole line. The
 *   slice clamps into the line; an inverted one covers nothing.
 * @returns {Array<{text: string, color: string | undefined, fontStyle: number}>}
 *   the ordered runs to paint.
 */
export function buildTokenRowFragments(lineText, tokens, slice) {
	const text = typeof lineText === 'string' ? lineText : '';
	const fragments = [];
	// One emit gate for every run: zero-length runs never append (an empty
	// span would only churn the layer), inherit runs (undefined or ''
	// color) normalize to `color: undefined` so the DOM layer's
	// fragment.color check stays a single shape.
	const emitRun = (runFrom, runTo, color, fontStyle) => {
		if (runTo <= runFrom) return;
		const inherited = typeof color !== 'string' || color === '';
		fragments.push({
			text: text.slice(runFrom, runTo),
			color: inherited ? undefined : color,
			fontStyle: inherited || typeof fontStyle !== 'number' || !Number.isFinite(fontStyle) ? 0 : fontStyle,
		});
	};
	// The boundary scan itself (slice clamping + token walk) is shared with
	// buildTokenRowFragmentsWithTints — extracted verbatim so both builders
	// cannot drift apart at the seams.
	buildTokenRowFragmentsCore(lineText, tokens, slice, emitRun);
	return fragments;
}

/**
 * The shared token-row boundary scan behind both builders: normalizes the
 * slice window (absent/unusable → the whole line; present → clamped into
 * the line and floored to character indices), then walks the token rows in
 * paint order handing every run — each inter-token gap and each token's
 * window-covered part — to `emit(runFrom, runTo, color, fontStyle)`. A token
 * crossing the slice boundary is handed to `emit` split EXACTLY at it (both
 * edges clamp into the window), so whatever `emit` does with a run, the
 * runs the two builders produce concatenate back into the line without
 * duplicating or dropping a character at the seams. Extracted verbatim from
 * `buildTokenRowFragments` when the tint builder arrived; the base builder's
 * tests are the regression net pinning the extraction behavior-neutral.
 * @param {any} lineText - the source line (or slice's source line) text.
 * @param {any} tokens - the engine's TokenLine row for that line.
 * @param {any} slice - `{ start, end }` offsets into `lineText` covering one
 *   visual row (wrap mode), or absent/null for the whole line.
 * @param {(runFrom: number, runTo: number, color: any, fontStyle: any) => void} emit
 *   the per-run sink; run bounds are character indices into the line with
 *   `runFrom < runTo`.
 * @returns {void}
 */
function buildTokenRowFragmentsCore(lineText, tokens, slice, emit) {
	const text = typeof lineText === 'string' ? lineText : '';
	const rows = Array.isArray(tokens) ? tokens : [];
	// The slice window: absent/unusable → the whole line; present → clamped
	// into the line and floored to character indices (a fractional boundary
	// would otherwise slice mid-surrogate and corrupt the painted text).
	let from = 0;
	let to = text.length;
	if (slice !== null && typeof slice === 'object') {
		const start = typeof slice.start === 'number' && Number.isFinite(slice.start) ? Math.floor(slice.start) : 0;
		const end = typeof slice.end === 'number' && Number.isFinite(slice.end) ? Math.floor(slice.end) : text.length;
		from = Math.min(Math.max(start, 0), text.length);
		to = Math.min(Math.max(end, from), text.length);
	}
	let cursor = from;
	for (const token of rows) {
		if (token === null || typeof token !== 'object') continue;
		const { start, end } = token;
		if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end)) {
			continue;
		}
		// Token ∩ window: both edges clamp into the slice, so a token
		// hanging off either side (or the line) contributes only its
		// covered part — the split at a slice boundary is exact by
		// construction (review focus #4).
		const tokenStart = Math.min(Math.max(Math.floor(start), from), to);
		const tokenEnd = Math.min(Math.max(Math.floor(end), tokenStart), to);
		if (tokenEnd <= tokenStart) continue;
		emit(cursor, tokenStart, undefined, 0);
		emit(tokenStart, tokenEnd, token.color, token.fontStyle);
		if (tokenEnd > cursor) cursor = tokenEnd;
	}
	emit(cursor, to, undefined, 0);
}

/**
 * Builds one rendered row's fragment list exactly as
 * `buildTokenRowFragments` does — same slice clamping, same token runs, the
 * slices still concatenate back into the line without duplicating or
 * dropping a character at the seams — with match-highlight tints folded in:
 * each run additionally carries `tint`, the label of the tint interval
 * covering it (`'word'` / `'selection'` / `'both'` / `'active'`) or `null`
 * when none does. `tints` are LINE-relative labeled `{ start, end, layer }`
 * ranges in the slice's own coordinate system (what `match-highlight.js`
 * `mergeLayerRanges` produces); their boundaries join the token boundaries
 * as split points, so a run crossing a tint edge splits EXACTLY at the edge
 * — even where both sides share one token color, since the DOM layer paints
 * the background class per run. One run may then carry the token ink AND
 * the tint label in the same span, which is what lets the code-highlight
 * paint merge the match background into the token stream. Unusable or empty
 * `tints` — a non-array, or entries that are malformed, zero-length, or
 * carry no recognized layer — degrade to no tint at all: every run gets
 * `tint: null` and the output is exactly `buildTokenRowFragments`'s plus
 * that field. Never a throw, never a DOM read.
 * @param {any} lineText - the source line (or slice's source line) text.
 * @param {any} tokens - the engine's TokenLine row for that line.
 * @param {any} slice - `{ start, end }` offsets into `lineText` covering
 *   one visual row (wrap mode), or absent/null for the whole line. The
 *   slice clamps into the line; an inverted one covers nothing.
 * @param {any} tints - line-relative labeled `{ start, end, layer }` ranges
 *   in the slice's coordinate system; null/absent means no tint.
 * @returns {Array<{text: string, color: string | undefined, fontStyle: number, tint: 'word' | 'selection' | 'both' | 'active' | null}>}
 *   the ordered runs to paint, each carrying its tint label or `null`.
 */
export function buildTokenRowFragmentsWithTints(lineText, tokens, slice, tints) {
	const text = typeof lineText === 'string' ? lineText : '';
	const spans = tintSpansOf(tints);
	const fragments = [];
	const emitRun = (runFrom, runTo, color, fontStyle) => {
		if (runTo <= runFrom) return;
		const inherited = typeof color !== 'string' || color === '';
		const runColor = inherited ? undefined : color;
		const runFontStyle = inherited || typeof fontStyle !== 'number' || !Number.isFinite(fontStyle) ? 0 : fontStyle;
		// The tint boundaries join the split points: only edges strictly
		// inside the run matter (an edge ON a run boundary is already a
		// split; membership there is decided by the coverage test below).
		const bounds = [runFrom, runTo];
		for (const span of spans) {
			if (span[0] > runFrom && span[0] < runTo) bounds.push(span[0]);
			if (span[1] > runFrom && span[1] < runTo) bounds.push(span[1]);
		}
		// Consecutive edges tile the run exactly, and no tint edge lies
		// strictly inside a segment — the segment's first offset decides
		// the whole segment's label, the same per-segment rule the match
		// fragment builder uses.
		const edges = [...new Set(bounds)].sort((a, b) => a - b);
		for (let i = 0; i + 1 < edges.length; i++) {
			fragments.push({
				text: text.slice(edges[i], edges[i + 1]),
				color: runColor,
				fontStyle: runFontStyle,
				tint: tintAt(spans, edges[i]),
			});
		}
	};
	buildTokenRowFragmentsCore(lineText, tokens, slice, emitRun);
	return fragments;
}

/**
 * The usable tint intervals of a tints list, normalized to
 * `[lo, hi, label]` triples: a non-array list is an empty one, entries that
 * are non-objects, lack finite numeric bounds, carry no recognized layer
 * (`'word'` / `'selection'` / `'both'` / `'active'` — the last is the
 * current selection's first-class tint, the active-tint revision's label),
 * or span nothing are skipped, reversed bounds are swapped, fractional
 * bounds floor to character indices. Bounds may reach past the line —
 * out-of-line parts simply tint nothing because no run lives there.
 * @param {any} tints - the caller-supplied labeled ranges.
 * @returns {Array<[number, number, 'word' | 'selection' | 'both' | 'active']>} the
 *   usable `[lo, hi, label]` triples, in input order — the per-run edge
 *   scan is order-agnostic about them.
 */
function tintSpansOf(tints) {
	const spans = [];
	if (!Array.isArray(tints)) return spans;
	for (const tint of tints) {
		if (tint === null || typeof tint !== 'object') continue;
		const { start, end, layer } = tint;
		if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end)) {
			continue;
		}
		if (layer !== 'word' && layer !== 'selection' && layer !== 'both' && layer !== 'active') continue;
		const lo = Math.min(Math.floor(start), Math.floor(end));
		const hi = Math.max(Math.floor(start), Math.floor(end));
		if (hi <= lo) continue;
		spans.push([lo, hi, layer]);
	}
	return spans;
}

/**
 * The label of the tint interval covering offset `at`, or `null` when none
 * does. With no usable tint edge strictly inside a segment (the emitter
 * guarantees it), the segment's first offset decides its whole label.
 * @param {Array<[number, number, 'word' | 'selection' | 'both' | 'active']>} spans -
 *   the normalized tint triples.
 * @param {number} at - the segment's first offset.
 * @returns {'word' | 'selection' | 'both' | 'active' | null} the covering label.
 */
function tintAt(spans, at) {
	for (const span of spans) {
		if (span[0] <= at && at < span[1]) return span[2];
	}
	return null;
}
