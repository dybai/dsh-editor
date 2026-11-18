/**
 * End-of-line preservation — the pure policy that lets a CRLF/CR file keep
 * its line endings across an edit session. The editor's internal draft is
 * ALWAYS LF (the textarea normalizes its DOM value and every offset module
 * splits on '\n'), so preservation works in two halves: `detectEol` inspects
 * the RAW decoded file text at load and names the file's dominant line
 * ending; `applyEol` converts the LF draft back to that ending at the one
 * point where content leaves the machine — the write call. Display never
 * sees '\r' (a textarea cannot show it), which is exactly why the ink half
 * of the pair lives at the write boundary: the file on disk keeps its
 * endings while everything inside the editor stays LF.
 *
 * Dominant detection counts each break AT its position ('\r\n' is one crlf,
 * never a cr plus an lf) and the majority kind wins; ties and break-free
 * text degrade to 'lf' — the default for new files.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/eol
 */

/** The line-ending kinds this module names. */
export const EOLS = Object.freeze(['lf', 'crlf', 'cr']);

/**
 * Name the dominant line ending of a decoded file text. '\r\n' counts once
 * as crlf (a following '\n' is never double-counted as a lone lf); the kind
 * with the most occurrences wins, and a tie — or text with no breaks at all
 * — degrades to 'lf'. Never throws: any non-string input is 'lf'.
 * @param {any} text - the raw decoded file text.
 * @returns {'lf' | 'crlf' | 'cr'} the dominant line ending.
 */
export function detectEol(text) {
	if (typeof text !== 'string') return 'lf';
	let crlf = 0;
	let lf = 0;
	let cr = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			if (text.charCodeAt(index + 1) === 10) {
				crlf++;
				index++;
			} else {
				cr++;
			}
		} else if (code === 10) {
			lf++;
		}
	}
	const max = Math.max(crlf, lf, cr);
	if (max === 0) return 'lf';
	const winners = [crlf, lf, cr].filter((count) => count === max).length;
	return winners > 1 ? 'lf' : (crlf === max ? 'crlf' : (cr === max ? 'cr' : 'lf'));
}

/**
 * Convert an LF-only draft to the file's line ending at the write boundary.
 * The draft never carries '\r' (the machine normalizes at load), so this is
 * a single forward replacement; 'lf' — or anything unrecognized — returns
 * the text unchanged. Never throws: a non-string input degrades to ''.
 * @param {any} text - the LF-only draft text.
 * @param {any} eol - the file's line ending ('lf' | 'crlf' | 'cr').
 * @returns {string} the text with '\n' rewritten to the target ending.
 */
export function applyEol(text, eol) {
	if (typeof text !== 'string') return '';
	if (eol === 'crlf') return text.replace(/\n/g, '\r\n');
	if (eol === 'cr') return text.replace(/\n/g, '\r');
	return text;
}
