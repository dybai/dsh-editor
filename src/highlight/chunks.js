/**
 * Chunk loader — the lazy language-group transport adapter between the
 * engine and the bundler's chunk files (Task 4, standalone: the client
 * entry wires `createChunkLoader(...).loadGroup` into `createEngine` in a
 * later task).
 *
 * The engine knows group names, not chunk files; the entry knows the
 * chunk transport, not the engine. This module is the pure seam between
 * them: `CHUNK_GROUP_FILES` maps each lazy group to the chunk file the
 * build emits next to the client bundle, and `createChunkLoader` adapts
 * an injected `requireAsync(fileName)` transport into the engine's
 * `loadGroup(group)` contract — resolving the chunk exports object (its
 * `languages` record is what the engine registers, one grammar at a
 * time).
 *
 * Failure discipline (spec §8, review focus #3): a chunk load that
 * rejects — a failed fetch or a chunk exporting no usable languages
 * record — blocks that group for THIS loader's lifetime: `isBlocked`
 * reports true and later `loadGroup` calls reject immediately without
 * touching the transport again. A user typing while a chunk fails keeps
 * typing in plain rendering; there is no per-keystroke retry storm. The
 * block is per-group: one bad group never poisons the others, and a
 * group that loads cleanly keeps working.
 *
 * Concurrency: in-flight loads dedupe per group — every concurrent caller
 * shares one transport call and one settled result. A load that settles
 * is forgotten (a successful registration is cached by the core's
 * loaded-language set, and a failed one by the negative cache), so the
 * map never grows.
 *
 * Zero imports: pure adapter logic over injected collaborators,
 * unit-testable with a fake transport.
 *
 * @module @dybai/dsh-editor/highlight/chunks
 */

/**
 * The lazy language groups and the chunk files the build emits for them.
 * `warmup` is intentionally absent: warmup grammars ship in the main
 * bundle and never fetch a chunk.
 */
export const CHUNK_GROUP_FILES = Object.freeze({
	web: 'client.lang-web.js',
	script: 'client.lang-script.js',
	system: 'client.lang-system.js',
	data: 'client.lang-data.js',
});

/**
 * Create the chunk loader.
 *
 * @param {object} deps - injected collaborators:
 * - `requireAsync(fileName: string): Promise<object>`: the transport —
 *   the entry passes `(f) => require.async('./' + f)`, so the resolved
 *   value is the chunk module's exports object (`{ languages }`).
 * - `log`: the leveled log channel (`log.warn(scope, text)`, scope
 *   `'highlight'`); a missing or method-less log degrades to silence
 *   rather than throwing.
 * @returns {{ loadGroup: (group: string) => Promise<object>,
 *   isBlocked: (group: string) => boolean }} the loader.
 */
export function createChunkLoader({ requireAsync, log }) {
	const logSource = log === null || log === undefined ? {} : log;
	const logWarn = typeof logSource.warn === 'function' ? logSource.warn.bind(logSource) : () => {};

	/** In-flight group loads: one transport call serves every concurrent caller. */
	const inFlight = new Map();
	/** Groups whose load failed once — blocked for this loader's lifetime. */
	const blocked = new Set();

	/**
	 * Whether a group's chunk load already failed. Blocked groups reject
	 * every later `loadGroup` without touching the transport.
	 * @param {string} group - the language group name.
	 * @returns {boolean} true when the group is blocked.
	 */
	function isBlocked(group) {
		return blocked.has(group);
	}

	/**
	 * Fetch a lazy group's chunk and resolve its exports object (the one
	 * carrying the `languages` record). Unknown groups reject; blocked
	 * groups reject immediately; concurrent callers share the single
	 * in-flight transport call.
	 * @param {string} group - the language group name.
	 * @returns {Promise<object>} the chunk exports object.
	 */
	function loadGroup(group) {
		const fileName = CHUNK_GROUP_FILES[group];
		if (fileName === undefined) {
			return Promise.reject(new Error(`unknown language group "${String(group)}"`));
		}
		if (blocked.has(group)) {
			return Promise.reject(new Error(`language group "${group}" is blocked after a failed chunk load`));
		}
		const pending = inFlight.get(group);
		if (pending !== undefined) return pending;
		const attempt = fetchChunk(group, fileName);
		inFlight.set(group, attempt);
		const forget = () => inFlight.delete(group);
		attempt.then(forget, forget);
		return attempt;
	}

	/**
	 * The transport call behind one group load. Any failure — a rejected
	 * fetch or a chunk without a usable languages record — marks the group
	 * blocked (negative cache) and rejects; the rejection reason flows to
	 * the engine, which logs it and degrades to plain rendering.
	 */
	async function fetchChunk(group, fileName) {
		try {
			const chunkExports = await requireAsync(fileName);
			const languages = chunkExports === null || chunkExports === undefined ? undefined : chunkExports.languages;
			if (languages === null || typeof languages !== 'object') {
				throw new Error(`chunk "${fileName}" for group "${group}" exports no languages record`);
			}
			return chunkExports;
		} catch (error) {
			blocked.add(group);
			logWarn('highlight', `chunk "${fileName}" for group "${group}" failed — group blocked (${messageOf(error)})`);
			throw error;
		}
	}

	return { loadGroup, isBlocked };
}

/** Error text for log lines — never throws on a non-Error rejection value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
