/**
 * Editor preference persistence over one DSH storage KV unit.
 *
 * `createPreferencesService({ kv, now })` builds the Host half of the editor's
 * user-preference stores over ONE unit:
 *
 * - `mode_associations` — the complete set of `glob → modeId` associations
 *   the "open as default" / "reset to default" menu writes;
 * - `keymap` — the framework's SELF-MANAGED key bindings for the actions
 *   save / saveAll / deleteLines (record key = action id, value =
 *   `{ code, modifiers, updatedAt }`), written by the status-bar keymap
 *   recorder;
 * - `settings` — the editor's behavior toggles (record key = setting name,
 *   value = `{ value, updatedAt }`), written by the status-bar settings
 *   panel; unknown-to-this-build keys are never read, so newer clients may
 *   store more settings than this build knows.
 *
 * All tables share ONE monotonic `updatedAt` stamp carried by the unit's
 * global singleton, round-tripped for compare-and-set updates.
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
 * - every mutating call (`setModePreferences`, `setKeymap`) runs inside ONE
 *   internal write chain (promise queue) that serializes writes — the KV unit
 *   does NOT serialize writes itself, and each write must read fresh state,
 *   diff records, and restamp the global as one uninterrupted critical
 *   section. A rejected write never poisons the chain. Reads stay outside the
 *   chain: `loadAll` re-reads the medium and never mutates, so a read may
 *   honestly observe a write that settled a beat earlier.
 *
 * Shared CAS token: the unit's global `updatedAt` is the compare-and-set
 * guard for BOTH tables. A `setKeymap` write restamps the token, so a
 * concurrent `setModePreferences` carrying the older token fails its CAS with
 * `mode-preferences/conflict` (and symmetrically `keymap/conflict`) — the
 * client refetches and retries. That is intentional: one unit, one stamp, no
 * cross-table lost updates.
 *
 * Failure policy: fail loud. A backend whose medium rejects (`loadAll` on an
 * unmounted backend, a closed unit) propagates that rejection to the caller.
 *
 * @module @dybai/dsh-editor/host/preferences-service
 */

/**
 * Static identity and shape of the `dsh_editor` KV unit (storage contract).
 * Unit and table names must satisfy the DSH storage contract's
 * `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` (lowercase/digits/underscores only) —
 * the earlier `dsh-editor` / `modeAssociations` spellings were rejected by
 * `open()`, so NO data was ever persisted under them and this unit starts
 * fresh at version 1 with no migration surface.
 */
const UNIT_DESCRIPTOR = Object.freeze({
	name: 'dsh_editor',
	version: 1,
	tables: Object.freeze(['mode_associations', 'keymap', 'settings']),
	hasGlobal: true
});

/** Table whose records are the associations: record key = glob. */
const TABLE = 'mode_associations';
/** Table whose records are the key bindings: record key = action id. */
const KEYMAP_TABLE = 'keymap';
/** Table whose records are the behavior toggles: record key = setting name. */
const SETTINGS_TABLE = 'settings';

/** Setting names this build knows; unknown keys in a payload are rejected. */
const SETTINGS_KEYS = new Set(['autoReloadClean', 'highlightActiveLine']);

/** Keymap action ids the editor framework owns (spec §6). */
const KEYMAP_ACTIONS = new Set(['save', 'saveAll', 'deleteLines']);
/** Storable `KeyboardEvent.code` alphabet for a keymap binding. */
const KEYMAP_CODE_RE = /^(Key[A-Z]|Digit[0-9])$/;
/** Abstract modifier vocabulary for a keymap binding. */
const KEYMAP_MODIFIERS = new Set(['primary', 'control', 'alt', 'shift', 'meta']);

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
 * One table's records out of a `loadAll` snapshot (`{}` when absent).
 * @param snapshot - the `loadAll` result.
 * @param name - table name.
 * @returns the table's record map.
 */
function tableOf(snapshot, name) {
	return snapshot.tables !== null && typeof snapshot.tables === 'object' ? snapshot.tables[name] ?? {} : {};
}

/**
 * Validate the keymap payload: a NON-EMPTY array of
 * `{ action ∈ {save, saveAll, deleteLines}, code: /^(Key[A-Z]|Digit[0-9])$/,
 * modifiers: array ⊆ {primary, control, alt, shift, meta} }` with unique
 * action ids and no two bindings sharing one (code, modifier-set) combo — a
 * duplicated combo would make dispatch ambiguous. Extra properties are
 * tolerated (only the contract fields are read).
 * @param bindings - the caller's payload.
 * @returns whether the payload is storable.
 */
function isValidKeymapBindings(bindings) {
	if (!Array.isArray(bindings) || bindings.length === 0) return false;
	const actions = new Set();
	const combos = new Set();
	for (const binding of bindings) {
		if (binding === null || typeof binding !== 'object') return false;
		if (!KEYMAP_ACTIONS.has(binding.action)) return false;
		if (actions.has(binding.action)) return false; // duplicate action
		actions.add(binding.action);
		if (typeof binding.code !== 'string' || !KEYMAP_CODE_RE.test(binding.code)) return false;
		if (!Array.isArray(binding.modifiers)) return false;
		const set = new Set();
		for (const modifier of binding.modifiers) {
			if (typeof modifier !== 'string' || !KEYMAP_MODIFIERS.has(modifier)) return false;
			set.add(modifier);
		}
		const combo = `${binding.code}|${[...set].sort().join('+')}`;
		if (combos.has(combo)) return false; // duplicate combo across actions
		combos.add(combo);
	}
	return true;
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
 * Validate the settings payload: a plain object whose keys are all setting
 * names this build knows and whose values are all booleans. An EMPTY object
 * is valid — it means "reset to defaults" (full-set replace deletes every
 * stored record). Extra/unknown keys are rejected so a typo never silently
 * persists a setting this build would never read back.
 * @param settings - the caller's payload.
 * @returns whether the payload is storable.
 */
function isValidSettings(settings) {
	if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return false;
	for (const key of Object.keys(settings)) {
		if (!SETTINGS_KEYS.has(key)) return false;
		if (typeof settings[key] !== 'boolean') return false;
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
			const records = tableOf(snapshot, TABLE);
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
				const records = tableOf(snapshot, TABLE);
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
		 * Read the complete framework keymap (spec §6: the self-managed
		 * save/saveAll/deleteLines bindings).
		 * @param signal - caller cancellation (last parameter, SRC convention).
		 * @returns `{ bindings: [{ action, code, modifiers }] sorted by action,
		 * updatedAt }` — `bindings` is empty before the first successful set
		 * (the client then falls back to its built-in defaults); `updatedAt`
		 * is the SHARED token (see the module doc: associations and keymap
		 * CAS against the same global stamp).
		 */
		async getKeymap(signal) {
			throwIfAborted(signal);
			const unit = await openUnit();
			const snapshot = await unit.loadAll();
			throwIfAborted(signal);
			const records = tableOf(snapshot, KEYMAP_TABLE);
			const bindings = Object.keys(records)
				.filter((action) => KEYMAP_ACTIONS.has(action) && records[action] !== null && typeof records[action] === 'object')
				.sort()
				.map((action) => ({
					action,
					code: records[action].code,
					modifiers: Array.isArray(records[action].modifiers) ? records[action].modifiers : undefined
				}));
			return { bindings, updatedAt: globalUpdatedAt(snapshot.global) };
		},

		/**
		 * Replace the complete keymap (records absent from the array are
		 * deleted), restamping the unit's SHARED global `updatedAt` — which
		 * invalidates any pending associations CAS against the older token.
		 * @param bindings - the complete new set (`[{ action, code, modifiers }]`);
		 * validated before the write chain, so an invalid payload never
		 * touches storage.
		 * @param expectedUpdatedAt - compare-and-set guard against the SHARED
		 * token: when provided and not equal to the storage's current
		 * `updatedAt`, the write rejects with `keymap/conflict` and storage is
		 * untouched. Omit (or pass `undefined`) to write unconditionally.
		 * @param signal - caller cancellation (last parameter, SRC convention).
		 * @returns `{ updatedAt }` of the settled write.
		 */
		async setKeymap(bindings, expectedUpdatedAt, signal) {
			if (!isValidKeymapBindings(bindings)) {
				throw codedError('keymap/invalid');
			}
			throwIfAborted(signal);
			return enqueue(async () => {
				throwIfAborted(signal);
				const unit = await openUnit();
				const snapshot = await unit.loadAll();
				const records = tableOf(snapshot, KEYMAP_TABLE);
				const currentUpdatedAt = globalUpdatedAt(snapshot.global);
				if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== currentUpdatedAt) {
					throw codedError('keymap/conflict');
				}
				const existingKeys = Object.keys(records);
				if (existingKeys.length > 0) {
					await unit.deleteRecords(KEYMAP_TABLE, existingKeys);
				}
				const updatedAt = now();
				for (const { action, code, modifiers } of bindings) {
					await unit.putRecord(KEYMAP_TABLE, action, { code, modifiers, updatedAt });
				}
				await unit.setGlobal({ updatedAt });
				throwIfAborted(signal);
				return { updatedAt };
			});
		},

		/**
		 * Read the stored behavior settings (spec: the settings panel's
		 * toggles). Settings this build knows but storage never wrote come
		 * back absent — the client applies its own defaults; unknown keys
		 * that somehow reached the medium (older bug, hand edit) are ignored.
		 * @param signal - caller cancellation (last parameter, SRC convention).
		 * @returns `{ settings: { [name]: boolean }, updatedAt }` — `updatedAt`
		 * is the SHARED token (see the module doc).
		 */
		async getSettings(signal) {
			throwIfAborted(signal);
			const unit = await openUnit();
			const snapshot = await unit.loadAll();
			throwIfAborted(signal);
			const records = tableOf(snapshot, SETTINGS_TABLE);
			const settings = {};
			for (const key of SETTINGS_KEYS) {
				const record = records[key];
				if (record !== null && typeof record === 'object' && typeof record.value === 'boolean') {
					settings[key] = record.value;
				}
			}
			return { settings, updatedAt: globalUpdatedAt(snapshot.global) };
		},

		/**
		 * Replace the complete settings set (records absent from the object
		 * are deleted; `{}` resets to defaults), restamping the unit's SHARED
		 * global `updatedAt`.
		 * @param settings - the complete new set (keys ⊆ known setting names,
		 * values all booleans); validated before the write chain, so an
		 * invalid payload never touches storage.
		 * @param expectedUpdatedAt - compare-and-set guard against the SHARED
		 * token: when provided and not equal to the storage's current
		 * `updatedAt`, the write rejects with `settings/conflict` and storage
		 * is untouched. Omit (or pass `undefined`) to write unconditionally.
		 * @param signal - caller cancellation (last parameter, SRC convention).
		 * @returns `{ updatedAt }` of the settled write.
		 */
		async setSettings(settings, expectedUpdatedAt, signal) {
			if (!isValidSettings(settings)) {
				throw codedError('settings/invalid');
			}
			throwIfAborted(signal);
			return enqueue(async () => {
				throwIfAborted(signal);
				const unit = await openUnit();
				const snapshot = await unit.loadAll();
				const records = tableOf(snapshot, SETTINGS_TABLE);
				const currentUpdatedAt = globalUpdatedAt(snapshot.global);
				if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== currentUpdatedAt) {
					throw codedError('settings/conflict');
				}
				const existingKeys = Object.keys(records);
				if (existingKeys.length > 0) {
					await unit.deleteRecords(SETTINGS_TABLE, existingKeys);
				}
				const updatedAt = now();
				for (const key of Object.keys(settings)) {
					await unit.putRecord(SETTINGS_TABLE, key, { value: settings[key], updatedAt });
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
