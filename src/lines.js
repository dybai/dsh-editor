/** Line/offset mapping for `\n`-separated text. All line numbers are 1-based. */

/**
 * The 1-based line number containing `offset`.
 *
 * An offset on a `\n` belongs to the line that newline terminates; the
 * end-of-text offset belongs to the final line. `offset` is clamped to
 * `[0, text.length]`.
 * @param {string} text
 * @param {number} offset
 * @returns {number} 1-based line
 */
export function lineOfOffset(text, offset) {
	const clamped = Math.max(0, Math.min(offset, text.length));
	return text.slice(0, clamped).split('\n').length;
}

/**
 * The 1-based line number containing `offset`, without allocating.
 *
 * Semantically identical to `lineOfOffset`, but counts newlines with an
 * `indexOf` loop instead of splitting the prefix — no intermediate strings,
 * so it stays cheap on multi-MB drafts (a selectionchange storm pays this
 * per event). `offset` is clamped to `[0, text.length]`.
 * @param {string} text
 * @param {number} offset
 * @returns {number} 1-based line
 */
export function lineOfOffsetFast(text, offset) {
	const clamped = Math.max(0, Math.min(offset, text.length));
	let line = 1;
	let position = -1;
	while ((position = text.indexOf('\n', position + 1)) !== -1) {
		if (position >= clamped) break;
		line++;
	}
	return line;
}

/**
 * The offset where the 1-based `line` starts.
 * @param {string} text
 * @param {number} line
 * @returns {number} `text.length` when `line` exceeds the number of lines
 */
export function offsetOfLine(text, line) {
	if (line <= 1) return 0;
	let position = -1;
	for (let remaining = line - 1; remaining > 0; remaining--) {
		position = text.indexOf('\n', position + 1);
		if (position === -1) return text.length;
	}
	return position + 1;
}

/**
 * Map an offset range to its inclusive 1-based line range.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {{ lineStart: number, lineEnd: number }}
 */
export function lineRangeOfOffsets(text, start, end) {
	return { lineStart: lineOfOffset(text, start), lineEnd: lineOfOffset(text, end) };
}

/**
 * Delete the lines touched by a selection: without a selection (`selStart ===
 * selEnd`) the caret line; with a selection every line the range touches.
 *
 * The caret lands on the original start line at column 1; when that line no
 * longer exists because the deletion removed the text tail, it falls to the
 * last line — the remaining lines keep an empty final line slot there, so the
 * bound is `lines.length + 1`.
 * @param {string} text
 * @param {number} selStart
 * @param {number} selEnd
 * @returns {{ text: string, caretLine: number }}
 */
export function deleteLines(text, selStart, selEnd) {
	const { lineStart, lineEnd } = lineRangeOfOffsets(text, selStart, selEnd);
	const lines = text.split('\n');
	lines.splice(lineStart - 1, lineEnd - lineStart + 1);
	return { text: lines.join('\n'), caretLine: Math.min(lineStart, lines.length + 1) };
}
