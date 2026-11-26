/**
 * Match-highlight query primitives — the pure text math behind the editor's
 * VS Code-style double-layer match highlight (word layer + selection layer).
 *
 * Word extraction mirrors VS Code's usual word definition: a word is the
 * longest run of non-separator, non-whitespace characters (letters — a CJK
 * run counts as one word — digits and `_`), bounded by the fixed
 * `WORD_SEPARATORS` set. `wordAt` resolves the word an offset belongs to
 * with VS Code's `_findRegexMatchEnclosingPosition` semantics: a caret
 * hugging a word's RIGHT edge — mid-text or at the document end — resolves
 * that word, while an offset with no word character on either side never
 * resolves.
 *
 * On top of extraction, two query builders shape the layers' search terms:
 *
 * - `wordQueryOf(selection)` — the word layer: the whole word under a
 *   collapsed caret, or the whole word containing an in-word selection.
 * - `selectionQueryOf(selection)` — the selection layer: the selection's
 *   literal slice, dropped (`null`) when it is empty, spans lines, exceeds
 *   `MAX_SELECTION_QUERY_LENGTH`, or is pure spaces/tabs.
 *
 * On top of the query builders, the scan layer turns a query into the
 * `{ start, end }` ranges a paint pipeline consumes: `findMatches` scans a
 * document literal- / case-insensitive- / whole-word-wise under the
 * per-layer cap, `findMatchesDetailed` adds the over-cap verdict an array
 * return alone cannot express (an over-cap scan materializes no ranges —
 * the CALLER switches such a layer to visible-window scanning instead of
 * disabling it; frequency never turns a highlight off), `findLineMatches`
 * scans ONE logical line and maps its hits to document offsets for exactly
 * that windowed path, and `subtractRanges` carves an excluded span — the
 * selection itself — out of a match list. `computeMatchHighlights`
 * orchestrates the two layers end to end: the word layer keeps the
 * selection's own span, the selection layer never highlights the selection
 * itself, and each layer's over-cap flag plus the queries the arrays came
 * from ride along for the paint-side windowed scan.
 *
 * On top of the scan layer, the paint-prep layer bridges document offsets to
 * visual rows for the DOM paint task: `lineStartOffsets` turns
 * `value.split('\n')` into each line's document start offset, and
 * `buildMatchRowFragments` builds one visual row's `{ text, layer }` run list
 * under the same slice-clamping discipline as `token-rows.js`
 * `buildTokenRowFragments` — runs cover the slice exactly, a match crossing a
 * slice boundary splits EXACTLY at it, and the slices' runs concatenate back
 * into the line without duplicating or dropping a character at the seams —
 * with each run's layer set by the matches covering it (`'plain'` /
 * `'word'` / `'selection'` / `'both'`).
 *
 * Everything normalizes defensively and never throws: unusable input degrades
 * to `null` / `false`, so event handlers can pipe raw editor state straight
 * in without shape checks.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/match-highlight
 */

/**
 * The fixed word-separator set, verbatim from the CONTRACT (VS Code's usual
 * word separators): every character listed here bounds a word. Whitespace is
 * not part of the literal — it counts as a separator via `isSeparatorChar`.
 */
export const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

/**
 * Per-layer match cap: the materialization ceiling for a layer's
 * full-document scan. A layer that would produce more than this many
 * matches materializes none and reports itself over-cap
 * (`findMatchesDetailed`); the paint side then scans that layer's visible
 * window line-by-line (`findLineMatches`) instead of disabling it — a
 * layer never turns off on match frequency.
 */
export const MAX_MATCHES_PER_LAYER = 500;

/**
 * Selection-query length cap: a selection longer than this many characters
 * never becomes the selection layer's search term.
 */
export const MAX_SELECTION_QUERY_LENGTH = 200;

/**
 * Whether the character is a word separator.
 * @param {any} ch - the character to check.
 * @returns {boolean} true for a single character from `WORD_SEPARATORS` or
 *   any whitespace character (whitespace counts as a separator even though it
 *   is not part of the literal set); everything else is false.
 */
export function isSeparatorChar(ch) {
	return typeof ch === 'string' && ch.length === 1 && (WORD_SEPARATORS.includes(ch) || /\s/.test(ch));
}

/**
 * Whether the character belongs to a word.
 * @param {any} ch - the character to check.
 * @returns {boolean} true for a single non-separator character — letters
 *   (CJK included), digits and `_`; the empty string, multi-character input
 *   and separators (whitespace included) are all false.
 */
export function isWordChar(ch) {
	return typeof ch === 'string' && ch.length === 1 && !isSeparatorChar(ch);
}

/**
 * The word an offset belongs to. Offsets are 0-based character positions into
 * `text` — the caret sits before character `offset`.
 *
 * Hit rule (VS Code `wordHelper.ts` `_findRegexMatchEnclosingPosition`
 * semantics): the word spans `[start, end)` and an offset hits when
 * `start ≤ offset ≤ end`, where an end-hug (`offset === end`) resolves the
 * word ENDING at offset — mid-text and at the document end alike, so a
 * caret hugging a word's right edge anywhere in the document still hits.
 * An offset misses only when NEITHER neighbor is a word character: the
 * interior of a separator run, or the document's leading/trailing
 * separator run.
 * @param {any} text - the document text.
 * @param {any} offset - the caret offset; non-finite or non-integer values
 *   miss, as do offsets outside `[0, text.length]`.
 * @returns {{ start: number, end: number, word: string } | null} the word's
 *   `[start, end)` span and its literal text, or `null` when no word hits.
 */
export function wordAt(text, offset) {
	if (typeof text !== 'string' || !Number.isInteger(offset)) return null;
	if (offset < 0 || offset > text.length) return null;
	const onWordChar = offset < text.length && isWordChar(text[offset]);
	const huggingWordEnd = offset > 0 && isWordChar(text[offset - 1]);
	if (!onWordChar && !huggingWordEnd) return null;
	const anchor = onWordChar ? offset : offset - 1;
	let start = anchor;
	while (start > 0 && isWordChar(text[start - 1])) start--;
	let end = anchor + 1;
	while (end < text.length && isWordChar(text[end])) end++;
	return { start, end, word: text.slice(start, end) };
}

/**
 * Normalize a raw selection to ordered caret bounds inside `text`.
 *
 * Shared by both query builders so their defenses cannot drift apart:
 * non-object selections, non-integer fields and bounds outside the document
 * all degrade to `null`; reversed `start > end` bounds are swapped.
 * @param {string} text - the document text (validated as a string by the
 *   caller).
 * @param {any} selection - `{ start, end }` caret offsets.
 * @returns {{ lo: number, hi: number } | null} ordered bounds with
 *   `0 ≤ lo ≤ hi ≤ text.length`, or `null` when the selection is unusable.
 */
function selectionBoundsInText(text, selection) {
	if (selection === null || typeof selection !== 'object') return null;
	const start = selection.start;
	const end = selection.end;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	const lo = Math.min(start, end);
	const hi = Math.max(start, end);
	if (lo < 0 || hi > text.length) return null;
	return { lo, hi };
}

/**
 * The word layer's search query for a selection: the whole word under the
 * caret (collapsed selection) or the whole word containing the selection.
 * @param {any} text - the document text; a non-string value degrades to
 *   `null`.
 * @param {any} selection - `{ start, end }` caret offsets; reversed bounds
 *   are swapped, non-object selections or non-integer fields degrade to
 *   `null`, as do offsets outside the document.
 * @returns {{ text: string, caseSensitive: true, wholeWord: true } | null}
 *   the whole-word query, or `null` when no word underlies the selection or a
 *   non-empty selection reaches past the word end (`end > word.end`) or spans
 *   a newline — the layer degrades to off instead of half-matching.
 */
export function wordQueryOf(text, selection) {
	if (typeof text !== 'string') return null;
	const bounds = selectionBoundsInText(text, selection);
	if (bounds === null) return null;
	const { lo, hi } = bounds;
	const word = wordAt(text, lo);
	if (word === null) return null;
	if (lo !== hi) {
		if (hi > word.end) return null;
		// Defense-in-depth: a word never contains '\n', so this is unreachable
		// by construction — kept because the CONTRACT mandates the condition.
		if (text.slice(lo, hi).includes('\n')) return null;
	}
	return { text: word.word, caseSensitive: true, wholeWord: true };
}

/**
 * The selection layer's search query: the selection's literal slice, matched
 * case-insensitively as a plain substring.
 * @param {any} text - the document text; a non-string value degrades to
 *   `null`.
 * @param {any} selection - `{ start, end }` caret offsets; reversed bounds
 *   are swapped, non-object selections or non-integer fields degrade to
 *   `null`, as do offsets outside the document.
 * @returns {{ text: string, caseSensitive: false, wholeWord: false } | null}
 *   the literal-slice query, or `null` when the selection is empty, spans a
 *   newline, exceeds `MAX_SELECTION_QUERY_LENGTH`, or is pure spaces/tabs
 *   (whitespace-only selections are never a useful search term).
 */
export function selectionQueryOf(text, selection) {
	if (typeof text !== 'string') return null;
	const bounds = selectionBoundsInText(text, selection);
	if (bounds === null) return null;
	const { lo, hi } = bounds;
	if (lo === hi) return null;
	const slice = text.slice(lo, hi);
	if (slice.includes('\n')) return null;
	if (slice.length > MAX_SELECTION_QUERY_LENGTH) return null;
	if (/^[ \t]+$/.test(slice)) return null;
	return { text: slice, caseSensitive: false, wholeWord: false };
}

/**
 * Normalize a `{ start, end }` span to ordered integer bounds. Shared by
 * `subtractRanges` for both sides so malformed entries cannot sneak a throw
 * into the subtraction loop: non-object spans and non-integer fields degrade
 * to `null`, reversed `start > end` bounds are swapped.
 * @param {any} range - the span to normalize.
 * @returns {{ lo: number, hi: number } | null} ordered bounds, or `null`
 *   when the span is unusable.
 */
function spanBounds(range) {
	if (range === null || typeof range !== 'object') return null;
	const start = range.start;
	const end = range.end;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	return { lo: Math.min(start, end), hi: Math.max(start, end) };
}

/**
 * The layer's full-document scan with its over-cap verdict: every
 * occurrence of the query text in the document, in ascending document
 * order, non-overlapping (scanning resumes past a hit). Case-insensitive
 * queries fold with `toLowerCase`; when that fold changes a length (e.g.
 * `İ` folds to the two characters `i` + combining dot), a per-character
 * fallback keeps offsets mapped back to the original text. Whole-word
 * queries keep only hits whose both sides are a separator or the document
 * boundary — so a word-end hugging the document end still counts. The
 * scan is cap-aware: the cap (and, for whole-word queries, the boundary
 * test) rides INTO the scanners, which stop pushing once the hit count
 * passes the cap — a 4MB document with frequent short words allocates at
 * most cap+1 hit objects per recompute instead of the full 10^4–10^5 hit
 * list, with byte-identical results.
 *
 * The verdict half (0.18.0 windowed-scan revision): `overCap: true` is the
 * ONLY way to tell "the scan would exceed the cap" from "no matches" — an
 * array return alone cannot — and it is the signal the paint side keys its
 * visible-window scan on: an over-cap layer is never disabled on
 * frequency, its matches come from `findLineMatches` over the visible
 * lines instead. An over-cap scan materializes nothing: `{ ranges: [],
 * overCap: true }`. Unusable input (non-string text, null query, empty
 * query text) degrades to `{ ranges: [], overCap: false }` — a degrade is
 * not an over-cap — never a throw.
 * @param {any} text - the document text.
 * @param {any} query - `{ text, caseSensitive, wholeWord }` from a query
 *   builder; a null/empty query text yields no ranges.
 * @param {number} [cap = MAX_MATCHES_PER_LAYER] - the per-layer match cap.
 * @returns {{ ranges: Array<{ start: number, end: number }>, overCap: boolean }}
 *   the hit spans ascending with `overCap: false`, or `{ ranges: [],
 *   overCap: true }` when the match count would exceed `cap`.
 */
export function findMatchesDetailed(text, query, cap = MAX_MATCHES_PER_LAYER) {
	if (typeof text !== 'string' || query === null || typeof query !== 'object') return { ranges: [], overCap: false };
	if (typeof query.text !== 'string' || query.text.length === 0) return { ranges: [], overCap: false };
	const limit = Number.isInteger(cap) && cap >= 0 ? cap : MAX_MATCHES_PER_LAYER;
	// The whole-word boundary test, handed to the scanners as a per-hit
	// acceptor so it runs inline: only boundary-passing hits count toward
	// the cap (an embedded hit costs the scan itself, never an allocation).
	// It always reads the ORIGINAL text — in the length-preserving fold
	// path the folded offsets coincide with the original ones.
	const accept = query.wholeWord === true
		? (start, end) =>
				(start === 0 || isSeparatorChar(text[start - 1])) &&
				(end === text.length || isSeparatorChar(text[end]))
		: null;
	const hits = query.caseSensitive === true
		? scanLiteral(text, query.text, limit, accept)
		: scanCaseInsensitive(text, query.text, limit, accept);
	return hits.length > limit ? { ranges: [], overCap: true } : { ranges: hits, overCap: false };
}

/**
 * The array projection of `findMatchesDetailed`: the layer's matches as a
 * bare ascending list — exactly the pre-0.18.0 contract, kept so every
 * array-shaped consumer (including `findLineMatches` below) shares ONE
 * scan implementation. An over-cap scan yields `[]`; a caller that needs
 * to tell an over-cap layer from an empty one reads the flag through
 * `findMatchesDetailed` instead.
 * @param {any} text - the document text.
 * @param {any} query - `{ text, caseSensitive, wholeWord }` from a query
 *   builder; a null/empty query text yields `[]`.
 * @param {number} [cap = MAX_MATCHES_PER_LAYER] - the per-layer match cap.
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending,
 *   or `[]` when the match count would exceed `cap` (the over-cap verdict
 *   lives on `findMatchesDetailed`).
 */
export function findMatches(text, query, cap = MAX_MATCHES_PER_LAYER) {
	return findMatchesDetailed(text, query, cap).ranges;
}

/**
 * One logical line's matches, in document coordinates — the per-line half
 * of an over-cap layer's visible-window scan (0.18.0): the paint side
 * knows which lines are visible, this turns each into the same
 * document-offset `{ start, end }` ranges the materialized path produces,
 * so `buildMatchRowFragments` consumes either source identically. A query
 * from `wordQueryOf`/`selectionQueryOf` never contains a newline (word
 * characters exclude separators; a selection query is single-line by
 * construction), so no match can straddle two lines — the per-line scan
 * finds exactly the line's slice of the full-document result, with the
 * line's edges playing the document-boundary role a newline played
 * (it is a separator either way). The per-line cap is the same
 * `MAX_MATCHES_PER_LAYER`: a single logical line with more than `cap`
 * hits yields `[]` for that line — the line-level materialization ceiling,
 * the same bound the full scan enforces. Unusable input — a null query or
 * a non-string `lineText` (a line index past the document end) — degrades
 * to `[]`, never a throw; a non-finite `lineStart` reads as 0, the same
 * normalization `buildMatchRowFragments` applies to its own translation
 * base.
 * @param {any} lineText - the logical line's text (one entry of
 *   `value.split('\n')`).
 * @param {any} lineStart - the line's document start offset (from
 *   `lineStartOffsets`); non-finite values read as 0.
 * @param {any} query - `{ text, caseSensitive, wholeWord }` from a query
 *   builder; a null/empty query text yields `[]`.
 * @param {number} [cap = MAX_MATCHES_PER_LAYER] - the per-line match cap.
 * @returns {Array<{ start: number, end: number }>} the line's hit spans in
 *   document coordinates, ascending.
 */
export function findLineMatches(lineText, lineStart, query, cap = MAX_MATCHES_PER_LAYER) {
	if (typeof lineText !== 'string') return [];
	// The translation base, normalized exactly as buildMatchRowFragments
	// normalizes its lineStart: a non-finite number reads as 0, a finite
	// one floors to a character index.
	const base = typeof lineStart === 'number' && Number.isFinite(lineStart) ? Math.floor(lineStart) : 0;
	const hits = findMatches(lineText, query, cap);
	const ranges = new Array(hits.length);
	for (let i = 0; i < hits.length; i++) {
		ranges[i] = { start: hits[i].start + base, end: hits[i].end + base };
	}
	return ranges;
}

/**
 * Exact-literal scan: every non-overlapping `indexOf` hit of the needle,
 * ascending. Cap-aware: stops pushing once the hit count passes `limit`
 * (returning the limit+1-long list for the caller to reject), and filters
 * each hit through `accept` when present.
 * @param {string} text - the document text.
 * @param {string} needle - the literal search term.
 * @param {number} limit - the cap; scanning stops after the limit+1-th
 *   accepted hit.
 * @param {((start: number, end: number) => boolean) | null} accept - the
 *   optional per-hit filter (the whole-word boundary test).
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending,
 *   at most `limit + 1` long.
 */
function scanLiteral(text, needle, limit, accept) {
	const hits = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf(needle, from);
		if (at === -1) return hits;
		const end = at + needle.length;
		if (accept === null || accept(at, end)) {
			hits.push({ start: at, end });
			if (hits.length > limit) return hits;
		}
		from = end;
	}
}

/**
 * Case-insensitive scan on the lowercased strings. `toLowerCase` usually
 * preserves every offset; a length change (rare folds like `İ` → `i` +
 * combining dot) falls back to the per-character scan that maps folded hits
 * back to original offsets. The cap and the per-hit acceptor thread
 * through to both paths unchanged.
 * @param {string} text - the document text.
 * @param {string} needle - the literal search term.
 * @param {number} limit - the cap; scanning stops after the limit+1-th
 *   accepted hit.
 * @param {((start: number, end: number) => boolean) | null} accept - the
 *   optional per-hit filter (the whole-word boundary test, reading the
 *   original text).
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending,
 *   at most `limit + 1` long.
 */
function scanCaseInsensitive(text, needle, limit, accept) {
	const hayFolded = text.toLowerCase();
	const needleFolded = needle.toLowerCase();
	if (hayFolded.length === text.length && needleFolded.length === needle.length) {
		return scanLiteral(hayFolded, needleFolded, limit, accept); // 折叠不变长：偏移不变
	}
	return scanLengthChangingFold(text, needleFolded, limit, accept);
}

/**
 * The length-changing fold fallback. The haystack is folded character by
 * character, and the folded needle is located in that folded text with
 * `indexOf`; hits are only accepted on character boundaries (a folded unit
 * never straddles two original characters) and mapped back to the original
 * `[start, end)` span by walking characters until the folded needle length
 * is consumed — advancing per character where folds change length. Locating
 * candidates on the folded text (rather than the raw first character's two
 * case forms) is what keeps a hit whose source character folds into several
 * characters — `İ` under the needle `i` + combining dot — findable at all.
 * Cap-aware like the other scanners: `accept` filters inline and pushing
 * stops once the hit count passes `limit`.
 * @param {string} text - the document text.
 * @param {string} needleFolded - `needle.toLowerCase()`.
 * @param {number} limit - the cap; scanning stops after the limit+1-th
 *   accepted hit.
 * @param {((start: number, end: number) => boolean) | null} accept - the
 *   optional per-hit filter (the whole-word boundary test, reading the
 *   original text).
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending,
 *   at most `limit + 1` long.
 */
function scanLengthChangingFold(text, needleFolded, limit, accept) {
	if (needleFolded.length === 0) return [];
	const pieces = new Array(text.length); // 每个原字符的折叠串
	const foldStarts = new Array(text.length); // 每个原字符折叠串在折叠文本中的起点
	let folded = '';
	for (let i = 0; i < text.length; i++) {
		pieces[i] = text[i].toLowerCase();
		foldStarts[i] = folded.length;
		folded += pieces[i];
	}
	const hits = [];
	let from = 0;
	let piece = 0;
	for (;;) {
		const at = folded.indexOf(needleFolded, from);
		if (at === -1) return hits;
		while (piece < text.length && foldStarts[piece] < at) piece++;
		if (piece === text.length) return hits;
		if (foldStarts[piece] !== at) {
			from = foldStarts[piece]; // 命中跨在字符折叠串中间 → 滑到下一字符边界重试
			continue;
		}
		let end = piece;
		let foldedLength = 0;
		while (end < text.length && foldedLength < needleFolded.length) {
			foldedLength += pieces[end].length;
			end++;
		}
		if (foldedLength === needleFolded.length && (accept === null || accept(piece, end))) {
			hits.push({ start: piece, end });
			if (hits.length > limit) return hits;
		}
		from = at + needleFolded.length;
	}
}

/**
 * Drop every range that intersects or coincides with any excluded range;
 * adjacent ranges (one's `end` equals the other's `start`) are not an
 * intersection and survive. Usable both to carve the selection out of the
 * selection layer's matches and as a general span subtraction: malformed
 * entries degrade instead of throwing, and both sides are normalized, so a
 * reversed selection still excludes its ordered span.
 * @param {any} ranges - the candidate `{ start, end }` spans, kept in order.
 * @param {any} excluded - the `{ start, end }` spans to remove.
 * @returns {Array<{ start: number, end: number }>} the surviving spans, in
 *   input order.
 */
export function subtractRanges(ranges, excluded) {
	if (!Array.isArray(ranges)) return [];
	const masks = Array.isArray(excluded) ? excluded : [];
	const kept = [];
	for (const range of ranges) {
		const span = spanBounds(range);
		if (span === null) continue;
		let dropped = false;
		for (const mask of masks) {
			const bound = spanBounds(mask);
			if (bound !== null && span.lo < bound.hi && bound.lo < span.hi) {
				dropped = true;
				break;
			}
		}
		if (!dropped) kept.push({ start: span.lo, end: span.hi });
	}
	return kept;
}

/**
 * The two highlight layers for a selection, ready for the paint pipeline:
 * the word layer from `wordQueryOf` → `findMatches` (it deliberately keeps
 * the selection's own span — that is what tells the caret's word apart from
 * the other matches), and the selection layer from `selectionQueryOf` →
 * `findMatches` → `subtractRanges(·, [selection])` (it never highlights the
 * selection itself). A switched-off layer, a null query or unusable input
 * yields `[]`, never a throw.
 *
 * 0.18.0 windowed-scan revision: the return also carries each layer's
 * `overCap` flag (an over-cap layer materializes `[]` with its flag true —
 * the paint side switches that layer to a per-visible-line scan instead of
 * disabling it; a layer never turns off on frequency) and the `queries`
 * both arrays came from. The queries are derived ONCE here and returned
 * alongside so the paint-side windowed scan consumes the same objects the
 * arrays were scanned with — a second derivation at paint time could drift
 * from this one.
 * @param {any} text - the document text.
 * @param {any} selection - `{ start, end }` caret offsets; the query
 *   builders normalize and validate it.
 * @param {any} opts - `{ selectionEnabled, wordEnabled, cap }` layer
 *   switches plus the per-layer match cap; a non-object degrades to both
 *   off.
 * @returns {{ word: Array<{ start: number, end: number }>, selection:
 *   Array<{ start: number, end: number }>, wordOverCap: boolean,
 *   selectionOverCap: boolean, queries: { word: { text: string,
 *   caseSensitive: boolean, wholeWord: boolean } | null, selection: { text:
 *   string, caseSensitive: boolean, wholeWord: boolean } | null } }} both
 *   layers' highlight ranges, their over-cap flags, and the queries the
 *   arrays came from.
 */
export function computeMatchHighlights(text, selection, opts) {
	const options = opts !== null && typeof opts === 'object' ? opts : {};
	// One derivation per layer: the query feeds the scan here AND rides
	// back out in `queries` for the paint-side windowed scan of an
	// over-cap layer.
	const wordQuery = options.wordEnabled === true ? wordQueryOf(text, selection) : null;
	const selectionQuery = options.selectionEnabled === true ? selectionQueryOf(text, selection) : null;
	const wordScan = wordQuery === null ? { ranges: [], overCap: false } : findMatchesDetailed(text, wordQuery, options.cap);
	const selectionScan = selectionQuery === null ? { ranges: [], overCap: false } : findMatchesDetailed(text, selectionQuery, options.cap);
	return {
		word: wordScan.ranges,
		selection: subtractRanges(selectionScan.ranges, [selection]),
		wordOverCap: wordScan.overCap,
		selectionOverCap: selectionScan.overCap,
		queries: { word: wordQuery, selection: selectionQuery },
	};
}

/**
 * Each line's document start offset, for translating document-offset matches
 * into per-line coordinates: `lines` is `value.split('\n')`'s result and
 * `[i]` is where line i starts in the document — line i+1 starts after line
 * i's characters plus one `\n`, so `['ab','c','','d']` maps to
 * `[0, 3, 5, 6]` and an empty array maps to `[]`. A non-string line counts
 * as length 0 (its offset still advances by the newline), and a non-array
 * degrades to `[0]` — the first line starts at offset 0. Never a throw.
 * @param {any} lines - the document split into lines by `'\n'`.
 * @returns {number[]} each line's start offset, ascending.
 */
export function lineStartOffsets(lines) {
	if (!Array.isArray(lines)) return [0];
	const offsets = new Array(lines.length);
	let at = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets[i] = at;
		const line = lines[i];
		at += (typeof line === 'string' ? line.length : 0) + 1; // 行内容 + 一个换行符
	}
	return offsets;
}

/**
 * One visual row's fragment list for the paint layer, mirroring
 * `token-rows.js` `buildTokenRowFragments`' contract with highlight layers in
 * place of token colors: the runs cover `slice` exactly (the whole line when
 * `slice` is null) as ordered `{ text, layer }` runs, and a match crossing a
 * slice boundary splits EXACTLY at it — the slices' runs concatenate back
 * into the line without duplicating or dropping a character at the seams.
 * Matches arrive as document-offset `{ start, end }` ranges (ascending,
 * non-overlapping within a layer) and are translated by `lineStart` into
 * line coordinates before use. The scan collects the union of both layers'
 * clamped span edges plus the window edges, then emits one run per
 * consecutive edge pair — the same shape as the token builder's emitRun —
 * with the run's layer set by the matches covering it: word only `'word'`,
 * selection only `'selection'`, both `'both'` (one merged run, never two
 * overlapping ones), neither `'plain'`. Zero-length runs never append, and
 * adjacent runs stay unmerged (per-segment emission, like the token
 * builder). Unusable input degrades defensively: a non-string `lineText` or
 * a non-array match list yields `[]`, an inverted slice covers nothing, and
 * a malformed match entry is skipped rather than splitting a run around
 * nothing — never a throw, never a DOM read.
 * @param {any} lineText - the source line (or slice's source line) text.
 * @param {any} lineStart - the line's document start offset (from
 *   `lineStartOffsets`); non-finite numbers degrade to 0.
 * @param {any} wordMatches - the word layer's document-offset
 *   `{ start, end }` ranges.
 * @param {any} selectionMatches - the selection layer's document-offset
 *   `{ start, end }` ranges.
 * @param {any} slice - `{ start, end }` offsets into `lineText` covering one
 *   visual row (wrap mode), or null for the whole line. The slice clamps
 *   into the line; an inverted one covers nothing.
 * @returns {Array<{text: string, layer: 'plain' | 'word' | 'selection' | 'both'}>}
 *   the ordered runs to paint.
 */
export function buildMatchRowFragments(lineText, lineStart, wordMatches, selectionMatches, slice) {
	if (typeof lineText !== 'string' || !Array.isArray(wordMatches) || !Array.isArray(selectionMatches)) return [];
	const text = lineText;
	// 文档偏移 → 行内偏移的平移基准：非有限数退化为 0。
	const base = typeof lineStart === 'number' && Number.isFinite(lineStart) ? Math.floor(lineStart) : 0;
	// The slice window: absent/null → the whole line; present → clamped into
	// the line and floored to character indices, exactly as token-rows does
	// (an inverted slice clamps from === to and covers nothing).
	let from = 0;
	let to = text.length;
	if (slice !== null && typeof slice === 'object') {
		const start = typeof slice.start === 'number' && Number.isFinite(slice.start) ? Math.floor(slice.start) : 0;
		const end = typeof slice.end === 'number' && Number.isFinite(slice.end) ? Math.floor(slice.end) : text.length;
		from = Math.min(Math.max(start, 0), text.length);
		to = Math.min(Math.max(end, from), text.length);
	}
	// One layer's matches → line-relative spans clamped into the window. Both
	// edges clamp into the slice, so a match hanging off either side (or off
	// the line) contributes only its covered part — the split at a slice
	// boundary is exact by construction.
	const spansOf = (matches) => {
		const spans = [];
		for (const match of matches) {
			if (match === null || typeof match !== 'object') continue;
			const { start, end } = match;
			if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end)) {
				continue;
			}
			const spanStart = Math.min(Math.max(Math.floor(start) - base, from), to);
			const spanEnd = Math.min(Math.max(Math.floor(end) - base, spanStart), to);
			if (spanEnd <= spanStart) continue;
			spans.push([spanStart, spanEnd]);
		}
		return spans;
	};
	const wordSpans = spansOf(wordMatches);
	const selectionSpans = spansOf(selectionMatches);
	// The union of every span edge plus the window edges: consecutive edges
	// tile the slice exactly (runs cover it with no gap and no overlap), and
	// a boundary-crossing match contributes its edge AT the boundary — the
	// seam split falls out of the edge set instead of extra logic.
	const edges = [...new Set([from, to, ...wordSpans.flat(), ...selectionSpans.flat()])].sort((a, b) => a - b);
	const covers = (spans, at) => spans.some(([start, end]) => start <= at && at < end);
	const fragments = [];
	for (let i = 0; i + 1 < edges.length; i++) {
		const runFrom = edges[i];
		const runTo = edges[i + 1];
		// No span edge lies strictly between consecutive edges, so a span
		// covering the segment's first offset covers the whole segment.
		const word = covers(wordSpans, runFrom);
		const selection = covers(selectionSpans, runFrom);
		fragments.push({
			text: text.slice(runFrom, runTo),
			layer: word && selection ? 'both' : word ? 'word' : selection ? 'selection' : 'plain',
		});
	}
	return fragments;
}
