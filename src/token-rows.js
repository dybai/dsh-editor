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
		emitRun(cursor, tokenStart, undefined, 0);
		emitRun(tokenStart, tokenEnd, token.color, token.fontStyle);
		if (tokenEnd > cursor) cursor = tokenEnd;
	}
	emitRun(cursor, to, undefined, 0);
	return fragments;
}
