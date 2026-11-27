/**
 * CM6 whitespace-glyph pure core — the "show invisible characters"
 * affordance (spec §7.1) as decoration descriptors (Task 7).
 *
 * `whitespaceDecorationDescriptors({ text, show })` scans the document once,
 * logical line by logical line, and answers the glyph list the Task 8 view
 * shell turns into CM6 `Decoration.point` / `Decoration.replace` values:
 *
 * - a space under `show.spaces` → a point descriptor (`from === to`) at the
 *   space's document offset carrying `WHITESPACE_GLYPHS.space`;
 * - a tab under `show.tabs` → a replace descriptor covering the tab
 *   (`[pos, pos + 1)`) carrying `WHITESPACE_GLYPHS.tab` plus `widthCols =
 *   tabAdvance(column, WHITESPACE_TAB_SIZE)`. The column is the display
 *   column the tab starts at, counted exactly as `buildWhitespaceRow` counts
 *   it: from 0 at the line start, spaces and ordinary characters by
 *   `codePointColumns` (wide code points 2), tabs by their own advance — so
 *   the CM6 surface stops tabs on the same stops as the DOM layer does;
 * - a line break under `show.newlines` → a point descriptor just past the
 *   line's content (before its `\n`) carrying
 *   `WHITESPACE_GLYPHS.newline`, gated per line by `showsNewlineGlyph`:
 *   every real break paints, including a file's trailing newline (0.13.0),
 *   while a file without a trailing newline paints nothing on its last line;
 * - a CRLF break adds one `WHITESPACE_GLYPHS.carriage` replace descriptor
 *   for the `\r` byte itself, reproducing the ␍ then ↵ pair
 *   `buildWhitespaceRow`'s `eol === 'crlf'` branch paints (one glyph per
 *   file byte); like that branch it hangs off `show.newlines`.
 *
 * The three switches are independent and read with a literal-`true` gate,
 * the same gate the DOM layer applies; all off yields `[]`. Positions are
 * DOCUMENT offsets (UTF-16 units, surrogate pairs kept whole), never
 * line-local, so the caller can hand every descriptor straight to CM6.
 * Unusable input — a missing/non-string document, a missing/non-object
 * `show` — degrades to `[]`, never a throw.
 *
 * Zero CM6, zero React, zero DOM: Task 8's shell owns widget rendering and
 * `glyphSvgShape`, this core only says what to paint where.
 *
 * The column counter is `codePointColumns` from `wrap-geometry.js` — the
 * same helper `buildWhitespaceRow` counts with; `whitespace.js` does not
 * re-export it, and re-deriving the wide-code-point table here would let the
 * two column conventions drift.
 *
 * @module @dybai/dsh-editor/cm6/whitespace-decorations
 */

import { codePointColumns } from '../wrap-geometry.js';
import { showsNewlineGlyph, tabAdvance, WHITESPACE_GLYPHS, WHITESPACE_TAB_SIZE } from '../whitespace.js';

/** The carriage return character a CRLF break ends its line with. @type {string} */
const CARRIAGE_RETURN = '\r';

/**
 * The document's whitespace glyphs as CM6 decoration descriptors, in
 * ascending document-offset order. See the module doc for the four shape
 * families and their switch gates. Each descriptor is exactly
 * `{ from, to, glyph }` or, for a tab only, `{ from, to, glyph, widthCols }`;
 * spaces and line breaks are zero-width points (`from === to`), tabs and
 * CRLF carriage returns cover one document position (`to === from + 1`).
 *
 * The tab column mirrors `buildWhitespaceRow`'s running display column —
 * including wide code points counting two columns and an off-switch tab
 * counting one, so the `widthCols` a tab carries is exactly the advance the
 * DOM layer would use for the same line.
 * @param {any} [input] - the document and the switch object.
 * @param {any} [input.text] - the whole document text; non-strings yield `[]`.
 * @param {any} [input.show] - `{ spaces, tabs, newlines }`, each enabled by a
 *   literal `true`; missing/non-object reads as all off.
 * @returns {Array<{ from: number, to: number, glyph: string, widthCols?: number }>}
 *   the ordered glyph descriptors in document offsets.
 */
export function whitespaceDecorationDescriptors(input = {}) {
	const descriptors = [];
	const source = input !== null && typeof input === 'object' ? input : {};
	const text = source.text;
	if (typeof text !== 'string') return descriptors;
	const show = source.show;
	const flags = show !== null && typeof show === 'object' ? show : {};
	const spaces = flags.spaces === true;
	const tabs = flags.tabs === true;
	const newlines = flags.newlines === true;
	if (!spaces && !tabs && !newlines) return descriptors;
	// Split the way the DOM layer splits the draft (and the way
	// showsNewlineGlyph indexes): one entry per logical line, no trailing
	// empty entry beyond the last break. Line starts accumulate by UTF-16
	// length + the consumed '\n'.
	const lines = text.split('\n');
	let lineStart = 0;
	for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
		const line = lines[lineNumber - 1];
		let column = 0;
		let index = 0;
		while (index < line.length) {
			const codePoint = line.codePointAt(index);
			const character = String.fromCodePoint(codePoint);
			const width = character.length;
			if (character === ' ' && spaces) {
				descriptors.push({ from: lineStart + index, to: lineStart + index, glyph: WHITESPACE_GLYPHS.space });
				column += codePointColumns(codePoint);
			} else if (character === '\t' && tabs) {
				const advance = tabAdvance(column, WHITESPACE_TAB_SIZE);
				descriptors.push({
					from: lineStart + index,
					to: lineStart + index + 1,
					glyph: WHITESPACE_GLYPHS.tab,
					widthCols: advance,
				});
				column += advance;
			} else {
				// Ordinary text and switched-off whitespace advance the column
				// exactly as buildWhitespaceRow's text branch counts it: a
				// space is one column, an un-rendered tab one, a wide code
				// point two.
				column += codePointColumns(codePoint);
			}
			index += width;
		}
		if (newlines && showsNewlineGlyph(lines, lineNumber)) {
			const lineEnd = lineStart + line.length;
			// A CRLF break's '\r' is the line's last real character: replace
			// it with ␍ so the pair renders in the DOM layer's order, ␍ then ↵.
			if (line.endsWith(CARRIAGE_RETURN)) {
				descriptors.push({ from: lineEnd - 1, to: lineEnd, glyph: WHITESPACE_GLYPHS.carriage });
			}
			descriptors.push({ from: lineEnd, to: lineEnd, glyph: WHITESPACE_GLYPHS.newline });
		}
		lineStart += line.length + 1;
	}
	return descriptors;
}
