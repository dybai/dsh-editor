/**
 * Go-to-line input model — the pure parser behind the jump popover (v0.6.0).
 *
 * One function: `parseGotoLine(raw, lineCount)` turns the popover's input
 * into a concrete 1-based target line, or rejects it. VALID numbers are
 * CLAMPED into `[1, lineCount]` (out-of-range input jumps to the nearest
 * existing line instead of erroring — the dominant editor convention);
 * empty, non-numeric and non-finite input is rejected so Enter on an empty
 * field never jumps.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/goto-line
 */

/**
 * Parse a go-to-line input into a concrete 1-based target line.
 *
 * Accepts a string (the input field's value — surrounding whitespace is
 * tolerated, an empty/whitespace-only value is NOT) or a number. Fractional
 * values floor, the same semantics the navigation path applies downstream.
 * @param {string|number} raw - the input value.
 * @param {number} lineCount - the draft's line total (`>= 1`; garbage rejects).
 * @returns {{ ok: true, line: number } | { ok: false }} `line` clamped to
 *   `[1, lineCount]`.
 */
export function parseGotoLine(raw, lineCount) {
	let asNumber;
	if (typeof raw === 'number') {
		asNumber = raw;
	} else if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (trimmed.length === 0) return { ok: false }; // Number('') is 0 — never jump on empty
		asNumber = Number(trimmed);
	} else {
		return { ok: false };
	}
	if (!Number.isFinite(asNumber)) return { ok: false };
	if (typeof lineCount !== 'number' || !Number.isFinite(lineCount) || lineCount < 1) return { ok: false };
	const line = Math.min(Math.max(Math.floor(asNumber), 1), lineCount);
	return { ok: true, line };
}
