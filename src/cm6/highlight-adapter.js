/**
 * CM6 highlight adapter pure core — one line's cached token row to
 * document-absolute decoration descriptors (Task 5).
 *
 * The highlight view plugin (Task 8) walks the visible lines and hands
 * each `session.lines[lineIndex]` row here; this module owns only the
 * per-line math: compose the in-line token offsets with the line start,
 * clamp the end to the line length (a stale cache row can overrun a line
 * that shrank), map the fontStyle bits to the theme's token classes and
 * carry the token colour inline. It is session-agnostic — the degraded,
 * idle and progressive gating live in the view shell — and imports only
 * the theme's `fontStyleClasses`, so it is directly testable under
 * node:test.
 *
 * @module @dybai/dsh-editor/cm6/highlight-adapter
 */

import { fontStyleClasses } from './theme.js';

/**
 * Build the decoration descriptors for one line's token row.
 *
 * Tokens arrive sorted by offset; their order is preserved. A token whose
 * clamped range is empty — a zero-width token, an inverted range, or one
 * starting at or past the line end — is skipped, and a `to` that would
 * run past the line end is clamped, so the caller never sees a range
 * outside `lineStart .. lineStart + lineText.length` (stale rows are
 * normal while the token cache catches up with an edit).
 *
 * `attrs.class` is always present, the empty string when fontStyle is 0;
 * the Task 8 view shell decides whether to skip an unclassed decoration.
 * `attrs.style` exists only when the token carries a colour, formatted as
 * the inline style `color: <token.color>` (the shiki CSS variable).
 *
 * @param {Array<{ start: number, end: number, color: string, fontStyle: number }>} tokenRow
 *   the line's tokens, offsets within the line.
 * @param {number} lineStart - the line's first character offset in the document.
 * @param {string} lineText - the line's current text; its length bounds the ranges.
 * @returns {Array<{ from: number, to: number, attrs: { class: string, style?: string } }>}
 *   descriptors in token order, `from`/`to` in document offsets.
 */
export function lineTokenDecorations(tokenRow, lineStart, lineText) {
	const lineEnd = lineStart + lineText.length;
	const decorations = [];
	for (const token of tokenRow) {
		const from = lineStart + token.start;
		const to = Math.min(lineStart + token.end, lineEnd);
		if (from >= to) continue;
		const attrs = { class: fontStyleClasses(token.fontStyle).join(' ') };
		if (typeof token.color === 'string' && token.color !== '') attrs.style = `color: ${token.color}`;
		decorations.push({ from, to, attrs });
	}
	return decorations;
}
