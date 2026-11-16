/**
 * Pure view-state model for cursor/scroll restore. No DOM, no Host RPC: this
 * module only defines the identity of a remembered view, validates the shapes
 * persisted with it, and maps between machine selection offsets and the
 * 1-based line/column positions stored in a record.
 */

import { lineOfOffsetFast, offsetOfLine } from './lines.js';

/**
 * Normalize a path for key comparison: backslashes become slashes.
 * @param {string} value
 * @returns {string}
 */
function normalizeSlashes(value) {
	return value.replace(/\\/g, '/');
}

/**
 * Trim trailing slashes, keeping `/` itself meaningful.
 * @param {string} value
 * @returns {string}
 */
function trimTrailingSlashes(value) {
	let end = value.length;
	while (end > 1 && value[end - 1] === '/') end--;
	return value.slice(0, end);
}

/**
 * A path is absolute when it is POSIX-rooted, UNC, or drive-rooted.
 * @param {string} value
 * @returns {boolean}
 */
function isAbsolutePath(value) {
	return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

/**
 * The identity a remembered cursor/scroll is stored under: the workspace root
 * plus the file path. Absolute paths are already self-identifying and win over
 * `cwd`; a missing `cwd` falls back to the session (`session:<id>/<path>`).
 * Windows drive and UNC keys are case-folded (their filesystems are
 * case-insensitive); POSIX keys keep their case.
 * @param {string | undefined} cwd
 * @param {string | undefined} sessionId
 * @param {string | undefined} path
 * @returns {string | undefined}
 */
export function viewStateKey(cwd, sessionId, path) {
	if (typeof path !== 'string') return undefined;
	const normalizedPath = normalizeSlashes(path);
	if (normalizedPath === '') return undefined;

	let key;
	if (isAbsolutePath(normalizedPath)) {
		key = normalizedPath;
	} else if (typeof cwd === 'string' && cwd !== '') {
		const root = trimTrailingSlashes(normalizeSlashes(cwd));
		key = root === '/' ? `/${normalizedPath}` : `${root}/${normalizedPath}`;
	} else if (typeof sessionId === 'string' && sessionId !== '') {
		key = `session:${sessionId}/${normalizedPath}`;
	} else {
		return undefined;
	}

	return /^[A-Za-z]:\//.test(key) || key.startsWith('//') ? key.toLowerCase() : key;
}

/**
 * A 1-based document position: both `line` and `column` are integers `>= 1`.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPosition(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Number.isInteger(value.line) &&
		value.line >= 1 &&
		Number.isInteger(value.column) &&
		value.column >= 1
	);
}

/**
 * A persisted selection: `null` (nothing to restore) or an ordered pair of
 * positions (`start` is not after `end`).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSelectionRecord(value) {
	if (value === null) return true;
	if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return false;
	if (!isPosition(value.start) || !isPosition(value.end)) return false;
	return (
		value.start.line < value.end.line ||
		(value.start.line === value.end.line && value.start.column <= value.end.column)
	);
}

/**
 * Convert a machine selection (`{ start, end, lineStart, lineEnd, text }`,
 * offsets plus the lines those offsets fall on) into the persisted
 * line/column record. Endpoints are reordered when the offsets run backwards.
 * @param {string} draft
 * @param {{ start: number, end: number, lineStart: number, lineEnd: number, text: string | null } | null} selection
 * @returns {{ start: { line: number, column: number }, end: { line: number, column: number } } | null}
 */
export function selectionRecordFromSnapshot(draft, selection) {
	if (typeof draft !== 'string') return null;
	if (selection === null || typeof selection !== 'object') return null;
	const { start, end, lineStart, lineEnd } = selection;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	if (!Number.isInteger(lineStart) || lineStart < 1) return null;
	if (!Number.isInteger(lineEnd) || lineEnd < 1) return null;

	const at = (offset, line) => ({
		line,
		column: Math.max(1, offset - offsetOfLine(draft, line) + 1)
	});
	let startPosition = at(start, lineStart);
	let endPosition = at(end, lineEnd);
	if (
		startPosition.line > endPosition.line ||
		(startPosition.line === endPosition.line && startPosition.column > endPosition.column)
	) {
		[startPosition, endPosition] = [endPosition, startPosition];
	}
	return { start: startPosition, end: endPosition };
}

/**
 * Convert a persisted line/column selection back to machine offsets against the
 * current text. Out-of-range lines and columns are clamped to the document, and
 * reversed endpoints are normalized. The selected text is included only for a
 * non-empty range. A `\r` is an ordinary character (not a line break).
 * @param {string} text
 * @param {{ start: { line: number, column: number }, end: { line: number, column: number } } | null} selection
 * @returns {{ start: number, end: number, lineStart: number, lineEnd: number, text: string | null } | null}
 */
export function selectionFromViewState(text, selection) {
	if (typeof text !== 'string' || selection === null || typeof selection !== 'object') return null;
	// Endpoints may be reversed here: they are normalized below rather than rejected.
	if (!isPosition(selection.start) || !isPosition(selection.end)) return null;

	const lineCount = text.split('\n').length;
	const offsetOf = (position) => {
		const line = Math.min(Math.max(position.line, 1), lineCount);
		const lineStart = offsetOfLine(text, line);
		const newline = text.indexOf('\n', lineStart);
		const contentLength = (newline === -1 ? text.length : newline) - lineStart;
		const column = Math.min(Math.max(position.column, 1), contentLength + 1);
		return lineStart + column - 1;
	};

	let start = offsetOf(selection.start);
	let end = offsetOf(selection.end);
	if (start > end) [start, end] = [end, start];
	return {
		start,
		end,
		lineStart: lineOfOffsetFast(text, start),
		lineEnd: lineOfOffsetFast(text, end),
		text: start === end ? null : text.slice(start, end)
	};
}

/**
 * Whether a pending scroll target can be applied now: the element must be
 * attached, and a non-zero target on an axis needs that axis to have a size.
 * @param {{ top: number, left: number } | null} pending
 * @param {{ attached: boolean, clientHeight: number, clientWidth: number }} view
 * @returns {boolean}
 */
export function canApplyScroll(pending, view) {
	if (pending === null || typeof pending !== 'object') return false;
	if (view === null || typeof view !== 'object' || view.attached !== true) return false;
	if (!Number.isFinite(pending.top) || !Number.isFinite(pending.left)) return false;
	if (pending.top > 0 && !(view.clientHeight > 0)) return false;
	if (pending.left > 0 && !(view.clientWidth > 0)) return false;
	return true;
}

/**
 * Whether the element's actual scroll offset still differs from the desired
 * one by more than `tolerance` pixels on either axis. A missing target (or a
 * non-finite measurement) is not a difference to correct.
 * @param {{ top: number, left: number }} actual
 * @param {{ top: number, left: number } | null} desired
 * @param {number} [tolerance]
 * @returns {boolean}
 */
export function scrollDiffers(actual, desired, tolerance = 1) {
	if (desired === null || typeof desired !== 'object') return false;
	if (actual === null || typeof actual !== 'object') return false;
	if (!Number.isFinite(actual.top) || !Number.isFinite(actual.left)) return false;
	if (!Number.isFinite(desired.top) || !Number.isFinite(desired.left)) return false;
	const limit = Number.isFinite(tolerance) ? tolerance : 1;
	return Math.abs(actual.top - desired.top) > limit || Math.abs(actual.left - desired.left) > limit;
}

/**
 * Whether a freshly loaded draft should apply its remembered view. A pending
 * navigation (for example "go to line") owns the caret and suppresses the
 * restore until a mode switch asks for the view back.
 * @param {{ loaded: boolean, navigationLine: number | null, modeSwitched: boolean }} input
 * @returns {boolean}
 */
export function shouldRestoreViewState(input) {
	if (input === null || typeof input !== 'object') return false;
	return (
		input.loaded === true &&
		(input.modeSwitched === true || input.navigationLine === null || input.navigationLine === undefined)
	);
}
