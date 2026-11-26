/**
 * Match-highlight query primitives — the pure text math behind the editor's
 * VS Code-style double-layer match highlight (word layer + selection layer).
 *
 * Word extraction mirrors VS Code's usual word definition: a word is the
 * longest run of non-separator, non-whitespace characters (letters — a CJK
 * run counts as one word — digits and `_`), bounded by the fixed
 * `WORD_SEPARATORS` set. `wordAt` resolves the word an offset belongs to: an
 * offset sitting on a separator never resolves, while a caret hugging a word
 * end at the document end still does (VS Code column semantics).
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
 * per-layer cap (a layer that would exceed the cap skips whole), and
 * `subtractRanges` carves an excluded span — the selection itself — out of a
 * match list. `computeMatchHighlights` orchestrates the two layers end to
 * end: the word layer keeps the selection's own span, the selection layer
 * never highlights the selection itself.
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
 * Per-layer match cap: a layer that would produce more than this many
 * matches produces none (the layer skips whole instead of half-painting).
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
 * Hit rule: the word spans `[start, end)` and an offset hits when
 * `start ≤ offset ≤ end`. An offset on a separator or whitespace never hits
 * (which is exactly every mid-text `offset === end` case, since the character
 * at a word end is a separator); the one hugging case that resolves is
 * `offset === text.length` right after a word's final character, matching VS
 * Code's column semantics.
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
	const huggingWordEnd = offset === text.length && offset > 0 && isWordChar(text[offset - 1]);
	if (!onWordChar && !huggingWordEnd) return null;
	const anchor = huggingWordEnd ? offset - 1 : offset;
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
 * The layer's matches: every occurrence of the query text in the document,
 * in ascending document order, non-overlapping (scanning resumes past a
 * hit). Case-insensitive queries fold with `toLowerCase`; when that fold
 * changes a length (e.g. `İ` folds to the two characters `i` + combining
 * dot), a per-character fallback keeps offsets mapped back to the original
 * text. Whole-word queries keep only hits whose both sides are a separator
 * or the document boundary — so a word-end hugging the document end still
 * counts. Unusable input (non-string text, null query, empty query text)
 * degrades to an empty list, never a throw.
 * @param {any} text - the document text.
 * @param {any} query - `{ text, caseSensitive, wholeWord }` from a query
 *   builder; a null/empty query text yields `[]`.
 * @param {number} [cap = MAX_MATCHES_PER_LAYER] - the per-layer match cap.
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending,
 *   or `[]` when the match count would exceed `cap` — the layer skips whole
 *   instead of half-painting.
 */
export function findMatches(text, query, cap = MAX_MATCHES_PER_LAYER) {
	if (typeof text !== 'string' || query === null || typeof query !== 'object') return [];
	if (typeof query.text !== 'string' || query.text.length === 0) return [];
	const limit = Number.isInteger(cap) && cap >= 0 ? cap : MAX_MATCHES_PER_LAYER;
	const hits = query.caseSensitive === true
		? scanLiteral(text, query.text)
		: scanCaseInsensitive(text, query.text);
	if (query.wholeWord !== true) {
		return hits.length > limit ? [] : hits;
	}
	const matches = [];
	for (const { start, end } of hits) {
		const leftBounded = start === 0 || isSeparatorChar(text[start - 1]);
		const rightBounded = end === text.length || isSeparatorChar(text[end]);
		if (!leftBounded || !rightBounded) continue;
		matches.push({ start, end });
		if (matches.length > limit) return [];
	}
	return matches;
}

/**
 * Exact-literal scan: every non-overlapping `indexOf` hit of the needle,
 * ascending.
 * @param {string} text - the document text.
 * @param {string} needle - the literal search term.
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending.
 */
function scanLiteral(text, needle) {
	const hits = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf(needle, from);
		if (at === -1) return hits;
		hits.push({ start: at, end: at + needle.length });
		from = at + needle.length;
	}
}

/**
 * Case-insensitive scan on the lowercased strings. `toLowerCase` usually
 * preserves every offset; a length change (rare folds like `İ` → `i` +
 * combining dot) falls back to the per-character scan that maps folded hits
 * back to original offsets.
 * @param {string} text - the document text.
 * @param {string} needle - the literal search term.
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending.
 */
function scanCaseInsensitive(text, needle) {
	const hayFolded = text.toLowerCase();
	const needleFolded = needle.toLowerCase();
	if (hayFolded.length === text.length && needleFolded.length === needle.length) {
		return scanLiteral(hayFolded, needleFolded); // 折叠不变长：偏移不变
	}
	return scanLengthChangingFold(text, needleFolded);
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
 * @param {string} text - the document text.
 * @param {string} needleFolded - `needle.toLowerCase()`.
 * @returns {Array<{ start: number, end: number }>} the hit spans ascending.
 */
function scanLengthChangingFold(text, needleFolded) {
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
		if (foldedLength === needleFolded.length) hits.push({ start: piece, end });
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
 * @param {any} text - the document text.
 * @param {any} selection - `{ start, end }` caret offsets; the query
 *   builders normalize and validate it.
 * @param {any} opts - `{ selectionEnabled, wordEnabled }` layer switches; a
 *   non-object degrades to both off.
 * @returns {{ word: Array<{ start: number, end: number }>, selection:
 *   Array<{ start: number, end: number }>} both layers' highlight ranges.
 */
export function computeMatchHighlights(text, selection, opts) {
	const options = opts !== null && typeof opts === 'object' ? opts : {};
	const word = options.wordEnabled === true ? queryMatches(text, wordQueryOf(text, selection)) : [];
	let selectionLayer = [];
	if (options.selectionEnabled === true) {
		const query = selectionQueryOf(text, selection);
		if (query !== null) selectionLayer = subtractRanges(findMatches(text, query), [selection]);
	}
	return { word, selection: selectionLayer };
}

/**
 * Run one query builder's result through `findMatches`, degrading a null
 * query to an empty list.
 * @param {string} text - the document text.
 * @param {{ text: string, caseSensitive: boolean, wholeWord: boolean } | null} query - the builder's query.
 * @returns {Array<{ start: number, end: number }>} the layer's matches.
 */
function queryMatches(text, query) {
	return query === null ? [] : findMatches(text, query);
}
