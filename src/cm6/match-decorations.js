/**
 * CM6 match-decoration pure core — the progressive cutoff plus the two
 * match-highlight layers as decoration descriptors (Task 6).
 *
 * Two exports, both pure:
 *
 * - `visibleTokenLineCeiling(session, fromLine, toLine)` — the Review
 *   Focus 4 pin: a progressive session's decoration line range must never
 *   pass `session.progressLine` (coloring un-tokenized lines = wrong
 *   highlight). Idle/degraded sessions have no readable tokens at all, so
 *   they release nothing; a normal (fully tokenized) session releases the
 *   whole requested range.
 * - `matchDecorationDescriptors({ ... })` — the VS Code-style double-layer
 *   match highlight ported onto CM6 by REUSING `match-highlight.js`'s
 *   exports: the full-document path is `computeMatchHighlights` with the
 *   `{ start, end }` ranges mapped to CM6's `{ from, to }` descriptors, and
 *   the viewport fallback recomputes an over-cap layer inside the viewport
 *   line range only (slice + `findMatches` + offset shift) — CM6 only
 *   renders the viewport, so the windowed semantics hold naturally there.
 *
 * Zero CM6, zero React: the Task 8 view shell consumes these descriptors
 * directly. The active-tint/active-layer concept of the DOM pipeline is
 * deliberately absent — CM6's native selection rendering replaces it.
 *
 * @module @dybai/dsh-editor/cm6/match-decorations
 */

import { computeMatchHighlights, findMatches, lineStartOffsets, subtractRanges } from '../match-highlight.js';

/**
 * Clamp a line number defensively: non-finite values read as `fallback`,
 * fractions floor to line indices, negatives clamp to 0. Shared by the
 * ceiling's and the viewport's line normalization so neither can drift.
 * @param {any} value - the raw line number.
 * @param {number} fallback - the value for non-finite input.
 * @returns {number} a finite integer ≥ 0.
 */
function clampLineIndex(value, fallback) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const index = Math.floor(value);
	return index < 0 ? 0 : index;
}

/**
 * Map a scan layer's `{ start, end }` ranges to CM6 decoration descriptors.
 * The scan layer emits well-formed integer ranges, so this is a pure
 * field rename — the defensive normalization already happened upstream.
 * @param {Array<{ start: number, end: number }>} ranges - the layer's
 *   document-offset ranges.
 * @returns {Array<{ from: number, to: number }>} the same ranges as
 *   descriptors.
 */
function toDescriptors(ranges) {
	const descriptors = [];
	if (!Array.isArray(ranges)) return descriptors;
	for (const range of ranges) {
		descriptors.push({ from: range.start, to: range.end });
	}
	return descriptors;
}

/**
 * The highest line a decoration pass may cover, in 0-based line indices —
 * the Review Focus 4 pin: a progressive session's decoration range must
 * never pass `session.progressLine`, because lines at and beyond the
 * progress cursor have no token cache yet (coloring them = wrong
 * highlight). The session flags are the engine's (engine.js
 * `createSession`): `degraded`, `idle`, `progressive`, `progressLine`.
 *
 * - `idle === true` or `degraded === true` → `fromLine`: no token exists,
 *   nothing may be decorated.
 * - `progressive === true` → `Math.min(toLine, Math.max(fromLine,
 *   session.progressLine))`: clamp into the requested window AND the
 *   tokenized prefix; a stale/negative progress cursor never lifts the
 *   floor past `fromLine`, a cursor past `toLine` never extends the pass.
 * - otherwise (a normal, fully tokenized session) → `toLine`.
 *
 * Line numbers normalize defensively: `fromLine` floors and clamps to ≥ 0,
 * `toLine` floors and clamps to ≥ `fromLine` (the returned ceiling always
 * satisfies `fromLine ≤ ceiling ≤ toLine`), non-finite input reads as the
 * clamped default, and a missing/non-object session (no evidence any line
 * is tokenized) releases nothing — `fromLine`, like idle. Never throws.
 * @param {any} session - the highlight engine session; the four flags are
 *   read defensively, anything else is ignored.
 * @param {any} fromLine - the first requested line (0-based index into
 *   `session.lines`).
 * @param {any} toLine - the last requested line (inclusive, 0-based).
 * @returns {number} the inclusive last line the pass may decorate.
 */
export function visibleTokenLineCeiling(session, fromLine, toLine) {
	const from = clampLineIndex(fromLine, 0);
	const to = Math.max(from, clampLineIndex(toLine, from));
	if (session === null || typeof session !== 'object') return from;
	if (session.idle === true || session.degraded === true) return from;
	if (session.progressive === true) {
		const progress = clampLineIndex(session.progressLine, 0);
		return Math.min(to, Math.max(from, progress));
	}
	return to;
}

/**
 * One over-cap layer's viewport-restricted recompute: the layer's query
 * (the same object the full scan used, from `computeMatchHighlights`'s
 * `queries`) is rescanned inside the viewport line range only — slice the
 * text from the first viewport line's start offset to the last viewport
 * line's end offset (`lineStartOffsets` gives the line starts), scan the
 * slice with `findMatches` (the same per-layer cap applies), shift the hit
 * offsets back into document coordinates, and carve the selection out of
 * the selection layer exactly as the full path does (`subtractRanges`).
 * Queries from `wordQueryOf`/`selectionQueryOf` never contain a newline,
 * so no match can straddle a line boundary and the line-bounded slice
 * finds exactly the viewport's slice of the full-document result.
 *
 * `viewport` is `{ fromLine, toLine }` — 0-BASED line indices matching
 * `session.lines`' indexing (NOT CM6's 1-based `doc.line(n)`; the Task 8
 * view shell converts). Both fields must be finite numbers; anything else
 * — a missing viewport, missing fields, non-finite values — leaves no
 * range to recompute in, and an over-cap layer that materializes nothing
 * returns `[]`: the layer stays off rather than resurfacing unbounded.
 * `fromLine`/`toLine` clamp into the document (≥ 0, ≤ last line,
 * `toLine ≥ fromLine`) and fractions floor, same as the ceiling.
 * @param {string} text - the document text (validated by the caller's scan).
 * @param {{ text: string, caseSensitive: boolean, wholeWord: boolean } | null} query
 *   the layer's search query; `null` yields `[]`.
 * @param {any} viewport - `{ fromLine, toLine }` 0-based line indices.
 * @param {any} selection - the raw selection (the selection layer's
 *   exclusion masks).
 * @param {boolean} excludeSelection - whether this is the selection layer.
 * @returns {Array<{ from: number, to: number }>} the layer's viewport-local
 *   matches in document offsets.
 */
function viewportRestrictedMatches(text, query, viewport, selection, excludeSelection) {
	if (query === null || typeof text !== 'string') return [];
	if (viewport === null || typeof viewport !== 'object') return [];
	if (typeof viewport.fromLine !== 'number' || !Number.isFinite(viewport.fromLine)) return [];
	if (typeof viewport.toLine !== 'number' || !Number.isFinite(viewport.toLine)) return [];
	const lines = text.split('\n');
	const offsets = lineStartOffsets(lines);
	const lastLine = lines.length - 1;
	const fromLine = Math.min(clampLineIndex(viewport.fromLine, 0), lastLine);
	const toLine = Math.min(Math.max(fromLine, clampLineIndex(viewport.toLine, fromLine)), lastLine);
	const sliceStart = offsets[fromLine];
	const sliceEnd = offsets[toLine] + (typeof lines[toLine] === 'string' ? lines[toLine].length : 0);
	const shifted = findMatches(text.slice(sliceStart, sliceEnd), query).map((hit) => ({
		start: hit.start + sliceStart,
		end: hit.end + sliceStart,
	}));
	const kept = excludeSelection ? subtractRanges(shifted, [selection]) : shifted;
	return toDescriptors(kept);
}

/**
 * The two match-highlight layers as CM6 decoration descriptors for one
 * editor state — the Task 8 view shell's input. Each layer is computed
 * independently through `computeMatchHighlights` (which owns the ported
 * 0.18.0 semantics: the word layer's whole-word + case-sensitive +
 * selection⊆word gate, the selection layer's literal + case-insensitive +
 * whitespace/200-char/multiline skips, the per-layer cap, and the
 * selection-overlap exclusion that never highlights the selection itself);
 * this wrapper only maps `{ start, end }` to `{ from, to }` and applies
 * the one new decision, the viewport fallback: when a layer's full-document
 * scan hits the cap (its `overCap` flag is true, i.e. the match count may
 * have truncated and nothing materialized), that layer is recomputed
 * RESTRICTED to the viewport line range via `viewportRestrictedMatches` —
 * the layer shows viewport-local hits instead of vanishing (层永不跳过).
 * Under the cap the full-document result is used as-is and the viewport is
 * ignored; one layer may fall back while the other does not.
 *
 * Only `selectionEnabled === true` / `wordEnabled === true` enable a layer
 * (the same gate `computeMatchHighlights` applies); the switches are
 * independent — one off leaves the other computed in full. An unusable
 * document, a null/out-of-document selection, or a dropped query degrades
 * that layer to `[]`, never a throw.
 * @param {object} [input] - the editor state.
 * @param {any} [input.text] - the document text.
 * @param {any} [input.selection] - `{ start, end }` caret offsets; the
 *   query builders normalize and validate it.
 * @param {{ fromLine: number, toLine: number }} [input.viewport] - the
 *   visible line range, 0-based indices matching `session.lines` (see
 *   `viewportRestrictedMatches`); consumed only by an over-cap layer.
 * @param {any} [input.selectionEnabled] - enable the selection layer.
 * @param {any} [input.wordEnabled] - enable the word layer.
 * @returns {{ word: Array<{ from: number, to: number }>, selection: Array<{ from: number, to: number }> }}
 *   both layers' decoration ranges in document offsets.
 */
export function matchDecorationDescriptors({ text, selection, viewport, selectionEnabled, wordEnabled } = {}) {
	const scan = computeMatchHighlights(text, selection, { selectionEnabled, wordEnabled });
	return {
		word:
			scan.wordOverCap === true
				? viewportRestrictedMatches(text, scan.queries.word, viewport, selection, false)
				: toDescriptors(scan.word),
		selection:
			scan.selectionOverCap === true
				? viewportRestrictedMatches(text, scan.queries.selection, viewport, selection, true)
				: toDescriptors(scan.selection),
	};
}
