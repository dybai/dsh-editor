/**
 * Mode-preference persistence over one DSH storage KV unit.
 *
 * `createPreferencesService({ kv, now })` builds the Host half of the editor's
 * mode-association store: the complete set of `glob → modeId` associations the
 * "open as default" / "reset to default" menu writes, plus a monotonic
 * `updatedAt` stamp the menu round-trips for compare-and-set updates.
 *
 * The module imports NOTHING on purpose: `kv` is a `StorageBackend` KvFacet
 * (`open(descriptor)` → unit with `loadAll()/putRecord/deleteRecord(s)/
 * setGlobal/close`, the DSH storage contract) and `now` produces the
 * millisecond stamps, so the factory is unit-testable with in-memory fakes
 * and runs under any profile's node_modules layout.
 *
 * Concurrency shape:
 * - the unit opens lazily on first use and the open is memoized (concurrent
 *   callers share one `open` promise; a rejecting open forgets the memo so a
 *   later call retries);
 * - every `setModePreferences` runs inside one internal write chain (promise
 *   queue) that serializes set operations — the KV unit does NOT serialize
 *   writes itself, and the write must read fresh state, diff records, and
 *   restamp the global as one uninterrupted critical section. A rejected
 *   write never poisons the chain. Reads stay outside the chain: `loadAll`
 *   re-reads the medium and never mutates, so a read may honestly observe a
 *   write that settled a beat earlier.
 *
 * Failure policy: fail loud. A backend whose medium rejects (`loadAll` on an
 * unmounted backend, a closed unit) propagates that rejection to the caller.
 *
 * @module @dybai/dsh-editor/host/preferences-service
 */

/** Static identity and shape of the `dsh-editor` KV unit (storage contract). */
const UNIT_DESCRIPTOR = Object.freeze({
	name: 'dsh-editor',
	version: 1,
	tables: Object.freeze(['modeAssociations']),
	hasGlobal: true
});

/** Table whose records are the associations: record key = glob. */
const TABLE = 'modeAssociations';

/**
 * Build the plain-Error stand-in for a DOMException AbortError; the storage
 * and RPC layers only switch on `name`, so a real DOMException is unnecessary.
 * @returns a fresh Error with `name` 'AbortError'.
 */
function abortError() {
	const error = new Error('aborted');
	error.name = 'AbortError';
	return error;
}

/**
 * Reject immediately when the caller's signal is already aborted.
 * @param signal - caller cancellation (`AbortSignal`-shaped), last parameter
 * of every service method per the SRC cancellation convention.
 */
function throwIfAborted(signal) {
	if (signal !== undefined && signal !== null && signal.aborted === true) throw abortError();
}

/**
 * Build a stable-code error (`message` === `code`, plus a `.code` property the
 * client can switch on).
 * @param code - stable discriminant, e.g. 'mode-preferences/conflict'.
 * @returns a fresh Error carrying the code.
 */
function codedError(code) {
	const error = new Error(code);
	error.code = code;
	return error;
}

/**
 * Read the `updatedAt` number out of the unit's global singleton.
 * @param global - the global slot as `loadAll` returned it (`null` when never
 * written).
 * @returns the stored number, or 0 when nothing was written yet.
 */
function globalUpdatedAt(global) {
	if (global !== null && typeof global === 'object' && typeof global.updatedAt === 'number') {
		return global.updatedAt;
	}
	return 0;
}

/**
 * Validate the associations payload: an array of
 * `{ glob: non-empty string, modeId: non-empty string }`. Extra properties are
 * tolerated (only the contract fields are read); duplicate globs are not
 * rejected — the complete-set write upserts by glob, so the last entry wins.
 * @param associations - the caller's payload.
 * @returns whether the payload is storable.
 */
function isValidAssociations(associations) {
	if (!Array.isArray(associations)) return false;
	for (const entry of associations) {
		if (entry === null || typeof entry !== 'object') return false;
		if (typeof entry.glob !== 'string' || entry.glob.length === 0) return false;
		if (typeof entry.modeId !== 'string' || entry.modeId.length === 0) return false;
	}
	return true;
}

/**
 * Build the mode-preferences service.
 * @param kv - a `StorageBackend` KvFacet (`open(descriptor)` → `KvUnit`).
 * @param now - clock producing millisecond `updatedAt` stamps.
 * @returns the service (methods on its prototype so a Host SRC registration
 * can read them for remote discovery); also carries `close()` for disposal.
 */
export function createPreferencesService({ kv, now }) {
	if (kv === undefined || kv === null || typeof kv.open !== 'function') {
		throw new Error('dsh-editor: createPreferencesService requires a kv facet with open(descriptor)');
	}
	if (typeof now !== 'function') {
		throw new Error('dsh-editor: createPreferencesService requires a now() clock function');
	}

	/** Memoized `kv.open(UNIT_DESCRIPTOR)`; undefined until first use. */
	let unitPromise;
	/** Tail of the serialized write queue; always settled, never rejecting. */
	let writeChain = Promise.resolve();

	/**
	 * Open the unit lazily, memoizing the open so concurrent callers share one
	 * promise. A rejecting open forgets the memo so a later call retries
	 * instead of caching the failure forever.
	 * @returns the open unit promise.
	 */
	function openUnit() {
		if (unitPromise === undefined) {
			const opening = kv.open(UNIT_DESCRIPTOR);
			unitPromise = opening;
			opening.catch(() => {
				if (unitPromise === opening) unitPromise = undefined;
			});
		}
		return unitPromise;
	}

	/**
	 * Append one serialized job to the write chain. The returned promise
	 * settles with the job's outcome while the chain's tail stays resolved,
	 * so one rejected write never poisons the next.
	 * @param job - async critical section to run once all earlier writes settled.
	 * @returns the job's own outcome.
	 */
	function enqueue(job) {
		const run = writeChain.then(job, job);
		writeChain = run.then(
			() => {},
			() => {}
		);
		return run;
	}

	return Object.create({
		/**
		 * Read the complete association set.
		 * @param signal - caller cancellation (last parameter, SRC convention).
		 * @returns `{ associations: [{ glob, modeId }] sorted by glob, updatedAt }`
		 * — `updatedAt` is 0 before the first successful set.
		 */
		async getModePreferences(signal) {
			throwIfAborted(signal);
			const unit = await openUnit();
			const snapshot = await unit.loadAll();
			throwIfAborted(signal);
			const records =
				snapshot.tables !== null && typeof snapshot.tables === 'object'
					? snapshot.tables[TABLE] ?? {}
					: {};
			const associations = Object.keys(records)
				.filter((glob) => {
					const value = records[glob];
					return value !== null && typeof value === 'object';
				})
				.sort()
				.map((glob) => ({ glob, modeId: records[glob].modeId }));
			return { associations, updatedAt: globalUpdatedAt(snapshot.global) };
		},

		/**
		 * Replace the complete association set (records absent from the array
		 * are deleted), restamping the unit's global `updatedAt`.
		 * @param associations - the complete new set; validated before the
		 * write chain, so an invalid payload never touches storage.
		 * @param expectedUpdatedAt - compare-and-set guard: when provided and
		 * not equal to the storage's current `updatedAt`, the write rejects
		 * with `mode-preferences/conflict` and storage is untouched. Omit (or
		 * pass `undefined`) to write unconditionally.
		 * @param signal - caller cancellation (last parameter, SRC convention).
		 * @returns `{ updatedAt }` of the settled write.
		 */
		async setModePreferences(associations, expectedUpdatedAt, signal) {
			if (!isValidAssociations(associations)) {
				throw codedError('mode-preferences/invalid-associations');
			}
			throwIfAborted(signal);
			return enqueue(async () => {
				throwIfAborted(signal);
				const unit = await openUnit();
				const snapshot = await unit.loadAll();
				const records =
					snapshot.tables !== null && typeof snapshot.tables === 'object'
						? snapshot.tables[TABLE] ?? {}
						: {};
				const currentUpdatedAt = globalUpdatedAt(snapshot.global);
				if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== currentUpdatedAt) {
					throw codedError('mode-preferences/conflict');
				}
				const existingKeys = Object.keys(records);
				if (existingKeys.length > 0) {
					await unit.deleteRecords(TABLE, existingKeys);
				}
				const updatedAt = now();
				for (const { glob, modeId } of associations) {
					await unit.putRecord(TABLE, glob, { modeId, updatedAt });
				}
				await unit.setGlobal({ updatedAt });
				throwIfAborted(signal);
				return { updatedAt };
			});
		},

		/**
		 * Drain the write chain, close the unit when one was opened, and forget
		 * the open so a later call reopens lazily. Idempotent; wired into the
		 * plugin's effect cleanup so a fiber restart never trips the storage
		 * contract's "same unit opened twice" rejection.
		 * @returns resolution after the unit (if any) is released.
		 */
		async close() {
			const closing = writeChain.then(async () => {
				if (unitPromise === undefined) return;
				const unit = await unitPromise;
				unitPromise = undefined;
				await unit.close();
			});
			writeChain = closing.then(
				() => {},
				() => {}
			);
			return closing;
		}
	});
}
