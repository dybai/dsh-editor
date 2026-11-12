/** Unsaved-draft persistence over an injected storage adapter (never touches `window`). */

const STORAGE_KEY = 'dsh-editor.draft';
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

/**
 * A crash/refresh-recovery draft store backed by a single storage key.
 *
 * State lives in an in-memory map mirroring the stored JSON map
 * `"<sessionId>|<address>" -> { text, baseVersion, savedAt }`. `set`/`clear`
 * only mutate memory and schedule a debounced persist; `flush` persists
 * immediately; `prune` drops entries expired after 14 days and all but the
 * 50 most-recent (by `savedAt`), persisting the result. Every persist is
 * best-effort: storage failures are swallowed so the in-memory state stays
 * authoritative, and the next successful write repairs durability.
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} storage
 * @param {() => number} [now] injectable clock, used for `savedAt` and expiry
 * @param {number} [delay] debounce window in milliseconds
 * @returns {{ get(sessionId: string, address: string): { text: string, baseVersion: number, savedAt: number } | undefined, set(sessionId: string, address: string, text: string, baseVersion: number): void, clear(sessionId: string, address: string): void, flush(): void, prune(): void }}
 */
export function createDraftStore(storage, now = Date.now, delay = 500) {
	/** @type {Map<string, { text: string, baseVersion: number, savedAt: number }>} */
	const entries = new Map(load());
	let timer = null;

	function load() {
		try {
			const raw = storage.getItem(STORAGE_KEY);
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
			return Object.entries(parsed);
		} catch {
			return [];
		}
	}

	function persist() {
		timer = null;
		try {
			if (entries.size === 0) storage.removeItem(STORAGE_KEY);
			else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
		} catch {
			// Best-effort: quota or serialization failure keeps the in-memory state;
			// the next successful write repairs durability.
		}
	}

	function schedule() {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(persist, delay);
	}

	return {
		get(sessionId, address) {
			const entry = entries.get(`${sessionId}|${address}`);
			return entry ? { ...entry } : undefined;
		},
		set(sessionId, address, text, baseVersion) {
			entries.set(`${sessionId}|${address}`, { text, baseVersion, savedAt: now() });
			schedule();
		},
		clear(sessionId, address) {
			entries.delete(`${sessionId}|${address}`);
			schedule();
		},
		flush() {
			if (timer !== null) clearTimeout(timer);
			persist();
		},
		prune() {
			const current = now();
			const kept = [...entries.entries()]
				.filter(([, entry]) => current - entry.savedAt < EXPIRY_MS)
				.sort((a, b) => b[1].savedAt - a[1].savedAt)
				.slice(0, MAX_ENTRIES);
			entries.clear();
			for (const [key, entry] of kept) entries.set(key, entry);
			persist();
		},
	};
}
