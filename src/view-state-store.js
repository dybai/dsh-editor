/**
 * View-state persistence over an injected storage adapter (never touches
 * `window`). It mirrors `ViewState` records keyed by `viewStateKey` under a
 * single storage key: `get`/`update` only touch the in-memory map and schedule
 * a debounced write, `flush` writes immediately, and `prune` applies the
 * 90-day expiry and 200-entry retention limits. Every storage failure is
 * swallowed so the in-memory state stays authoritative and the next successful
 * write repairs durability.
 */

import { isSelectionRecord } from './view-state.js';

export const VIEW_STATE_STORAGE_KEY = 'dsh-editor.view-state';
const MAX_ENTRIES = 200;
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{ start: { line: number, column: number }, end: { line: number, column: number } }} SelectionRecord
 * @typedef {{ selection: SelectionRecord | null, scrollTop: number, scrollLeft: number, savedAt: number }} ViewState
 */

/**
 * A JSON-like object: non-null, not an array.
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecordObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A scroll offset must be a finite number `>= 0`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isScrollOffset(value) {
	return Number.isFinite(value) && value >= 0;
}

/**
 * Copy a validated selection so callers cannot mutate the stored endpoints.
 * @param {SelectionRecord | null} selection
 * @returns {SelectionRecord | null}
 */
function cloneSelection(selection) {
	if (selection === null) return null;
	return {
		start: { line: selection.start.line, column: selection.start.column },
		end: { line: selection.end.line, column: selection.end.column }
	};
}

/**
 * Normalize one stored value into a `ViewState`, or `undefined` when invalid.
 * Missing `selection` means "nothing to restore"; missing scroll offsets mean
 * "top-left"; `savedAt` is required.
 * @param {unknown} value
 * @returns {ViewState | undefined}
 */
function normalizeViewState(value) {
	if (!isRecordObject(value)) return undefined;
	const selection = value.selection === undefined ? null : value.selection;
	const scrollTop = value.scrollTop === undefined ? 0 : value.scrollTop;
	const scrollLeft = value.scrollLeft === undefined ? 0 : value.scrollLeft;
	if (!isSelectionRecord(selection)) return undefined;
	if (!isScrollOffset(scrollTop) || !isScrollOffset(scrollLeft)) return undefined;
	if (!Number.isFinite(value.savedAt)) return undefined;
	return { selection: cloneSelection(selection), scrollTop, scrollLeft, savedAt: value.savedAt };
}

/**
 * Create a view-state store over `storage`.
 *
 * State lives in an in-memory map mirroring the stored JSON map
 * `viewStateKey -> ViewState`. `update` replaces only the provided fields and
 * schedules a debounced persist; `get` returns a copy; `prune` drops entries
 * expired at 90 days and all but the 200 most-recent (by `savedAt`). Every
 * public method is total: bad arguments are ignored and storage failures are
 * swallowed, leaving the in-memory state authoritative.
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} storage
 * @param {() => number} [now] injectable clock, used for `savedAt` and expiry
 * @param {number} [delay] debounce window in milliseconds
 * @returns {{ get(key: string): ViewState | undefined, update(key: string, patch: { selection?: SelectionRecord | null, scrollTop?: number, scrollLeft?: number }): void, flush(): void, prune(): void }}
 */
export function createViewStateStore(storage, now = Date.now, delay = 500) {
	const clock = typeof now === 'function' ? now : Date.now;
	const delayMs = Number.isFinite(delay) && delay >= 0 ? delay : 500;
	const entries = new Map(load());
	let timer = null;

	function load() {
		try {
			const raw = storage.getItem(VIEW_STATE_STORAGE_KEY);
			if (typeof raw !== 'string' || raw === '') return [];
			const parsed = JSON.parse(raw);
			if (!isRecordObject(parsed)) return [];
			const loaded = [];
			for (const [key, value] of Object.entries(parsed)) {
				const record = normalizeViewState(value);
				if (record !== undefined) loaded.push([key, record]);
			}
			return loaded;
		} catch {
			return [];
		}
	}

	function persist() {
		timer = null;
		try {
			if (entries.size === 0) storage.removeItem(VIEW_STATE_STORAGE_KEY);
			else storage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
		} catch {
			// Best-effort: a read-only, full, or absent storage keeps the in-memory
			// state authoritative; the next successful write repairs durability.
		}
	}

	function schedule() {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(persist, delayMs);
	}

	return {
		get(key) {
			if (typeof key !== 'string') return undefined;
			const record = entries.get(key);
			if (record === undefined) return undefined;
			return {
				selection: cloneSelection(record.selection),
				scrollTop: record.scrollTop,
				scrollLeft: record.scrollLeft,
				savedAt: record.savedAt
			};
		},
		update(key, patch) {
			if (typeof key !== 'string' || !isRecordObject(patch)) return;
			const current = entries.get(key);
			const next = current === undefined
				? { selection: null, scrollTop: 0, scrollLeft: 0 }
				: { selection: current.selection, scrollTop: current.scrollTop, scrollLeft: current.scrollLeft };
			if (Object.prototype.hasOwnProperty.call(patch, 'selection')) {
				if (!isSelectionRecord(patch.selection)) return;
				next.selection = cloneSelection(patch.selection);
			}
			if (Object.prototype.hasOwnProperty.call(patch, 'scrollTop')) {
				if (!isScrollOffset(patch.scrollTop)) return;
				next.scrollTop = patch.scrollTop;
			}
			if (Object.prototype.hasOwnProperty.call(patch, 'scrollLeft')) {
				if (!isScrollOffset(patch.scrollLeft)) return;
				next.scrollLeft = patch.scrollLeft;
			}
			next.savedAt = clock();
			entries.set(key, next);
			schedule();
		},
		flush() {
			if (timer !== null) clearTimeout(timer);
			persist();
		},
		prune() {
			const current = clock();
			const kept = [...entries]
				.filter(([, record]) => current - record.savedAt < EXPIRY_MS)
				.sort((a, b) => b[1].savedAt - a[1].savedAt)
				.slice(0, MAX_ENTRIES);
			entries.clear();
			for (const [key, record] of kept) entries.set(key, record);
			if (timer !== null) clearTimeout(timer);
			persist();
		}
	};
}
