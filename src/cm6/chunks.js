/**
 * CM6 chunk loader — the lazy transport adapter between the editor's
 * code-highlight surface and the single chunk file the build emits for
 * all of CodeMirror (Task 1, standalone: the client entry wires
 * `createCm6Loader(...).loadCm6` into the component runtime in a later
 * task).
 *
 * CM6 lives entirely in `client.editor-cm6.js`: the main bundle and the
 * DSH startup path never pay for it, and plain-text users never fetch
 * it. The component knows CM6, not the chunk transport; the entry knows
 * the transport, not CM6. This module is the pure seam between them:
 * `CM6_CHUNK_FILE` names the chunk, and `createCm6Loader` adapts an
 * injected `requireAsync(fileName)` transport into the `loadCm6()`
 * contract — resolving the chunk exports object (its non-empty `cm6`
 * record is what the component factory consumes).
 *
 * Failure discipline (spec §8.1–2): a chunk load that rejects — a failed
 * fetch or a chunk exporting no usable cm6 record — blocks this loader
 * for its lifetime: `isBlocked` reports true and later `loadCm6` calls
 * reject immediately without touching the transport again. A user typing
 * while the chunk fails keeps editing in the plain-text fallback; there
 * is no per-mount retry storm. A new activation builds a new loader, so
 * a later chunk fix heals without a restart.
 *
 * Concurrency: in-flight loads dedupe — every concurrent caller shares
 * one transport call and one settled result. A load that settles is
 * forgotten (a successful module is cached by the module loader itself,
 * and a failed one by the negative cache), so the map never grows.
 *
 * Zero imports: pure adapter logic over injected collaborators,
 * unit-testable with a fake transport.
 *
 * @module @dybai/dsh-editor/cm6/chunks
 */

/**
 * The single lazy chunk file the build emits for all CM6 code.
 */
export const CM6_CHUNK_FILE = 'client.editor-cm6.js';

/**
 * Create the CM6 chunk loader.
 *
 * @param {object} deps - injected collaborators:
 * - `requireAsync(fileName: string): Promise<object>`: the transport —
 *   the entry passes `(f) => require.async('./' + f)`, so the resolved
 *   value is the chunk module's exports object (`{ cm6 }`).
 * - `log`: the leveled log channel (`log.warn(scope, text)`, scope
 *   `'cm6'`); a missing or method-less log degrades to silence rather
 *   than throwing.
 * @returns {{ loadCm6: () => Promise<{ cm6: object }>,
 *   isBlocked: () => boolean }} the loader.
 */
export function createCm6Loader({ requireAsync, log }) {
	const logSource = log === null || log === undefined ? {} : log;
	const logWarn = typeof logSource.warn === 'function' ? logSource.warn.bind(logSource) : () => {};

	/** In-flight load: one transport call serves every concurrent caller. */
	const inFlight = new Map();
	/** The chunk once its load failed — blocked for this loader's lifetime. */
	const blocked = new Set();

	/**
	 * Whether the CM6 chunk load already failed. A blocked loader rejects
	 * every later `loadCm6` without touching the transport.
	 * @returns {boolean} true when the chunk is blocked.
	 */
	function isBlocked() {
		return blocked.has(CM6_CHUNK_FILE);
	}

	/**
	 * Fetch the CM6 chunk and resolve its exports object (the one carrying
	 * the `cm6` record). A blocked loader rejects immediately; concurrent
	 * callers share the single in-flight transport call.
	 * @returns {Promise<{ cm6: object }>} the chunk exports object.
	 */
	function loadCm6() {
		if (blocked.has(CM6_CHUNK_FILE)) {
			return Promise.reject(new Error(`cm6 chunk "${CM6_CHUNK_FILE}" is blocked after a failed load`));
		}
		const pending = inFlight.get(CM6_CHUNK_FILE);
		if (pending !== undefined) return pending;
		const attempt = fetchChunk();
		inFlight.set(CM6_CHUNK_FILE, attempt);
		const forget = () => inFlight.delete(CM6_CHUNK_FILE);
		attempt.then(forget, forget);
		return attempt;
	}

	/**
	 * The transport call behind one load. Any failure — a rejected fetch
	 * or a chunk without a usable cm6 record — marks the loader blocked
	 * (negative cache) and rejects; the rejection reason flows to the
	 * component, which logs it and degrades to plain rendering.
	 */
	async function fetchChunk() {
		try {
			const chunkExports = await requireAsync(CM6_CHUNK_FILE);
			const cm6 = chunkExports === null || chunkExports === undefined ? undefined : chunkExports.cm6;
			const usable = cm6 !== null && typeof cm6 === 'object' && Object.keys(cm6).length > 0;
			if (!usable) {
				throw new Error(`chunk "${CM6_CHUNK_FILE}" exports no cm6 record`);
			}
			return chunkExports;
		} catch (error) {
			blocked.add(CM6_CHUNK_FILE);
			logWarn('cm6', `chunk "${CM6_CHUNK_FILE}" failed — loader blocked (${messageOf(error)})`);
			throw error;
		}
	}

	return { loadCm6, isBlocked };
}

/** Error text for log lines — never throws on a non-Error rejection value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
