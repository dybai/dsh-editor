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
 * The word layer's search query for a selection: the whole word under the
 * caret (collapsed selection) or the whole word containing the selection.
 * @param {any} text - the document text.
 * @param {any} selection - `{ start, end }` caret offsets; reversed bounds
 *   are swapped, non-object selections or non-integer fields degrade to
 *   `null`, as do offsets outside the document.
 * @returns {{ text: string, caseSensitive: true, wholeWord: true } | null}
 *   the whole-word query, or `null` when no word underlies the selection or a
 *   non-empty selection reaches past the word end (`end > word.end`) or spans
 *   a newline — the layer degrades to off instead of half-matching.
 */
export function wordQueryOf(text, selection) {
	if (selection === null || typeof selection !== 'object') return null;
	const start = selection.start;
	const end = selection.end;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	const lo = Math.min(start, end);
	const hi = Math.max(start, end);
	if (lo < 0 || hi > text.length) return null;
	const word = wordAt(text, lo);
	if (word === null) return null;
	if (lo !== hi) {
		if (hi > word.end) return null;
		if (text.slice(lo, hi).includes('\n')) return null;
	}
	return { text: word.word, caseSensitive: true, wholeWord: true };
}

/**
 * The selection layer's search query: the selection's literal slice, matched
 * case-insensitively as a plain substring.
 * @param {any} text - the document text.
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
	if (selection === null || typeof selection !== 'object') return null;
	const start = selection.start;
	const end = selection.end;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	const lo = Math.min(start, end);
	const hi = Math.max(start, end);
	if (lo < 0 || hi > text.length) return null;
	if (lo === hi) return null;
	const slice = text.slice(lo, hi);
	if (slice.includes('\n')) return null;
	if (slice.length > MAX_SELECTION_QUERY_LENGTH) return null;
	if (/^[ \t]+$/.test(slice)) return null;
	return { text: slice, caseSensitive: false, wholeWord: false };
}
