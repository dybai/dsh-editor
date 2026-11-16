/**
 * Host-side persistent log service: chunked appends into ONE DSH storage KV
 * unit, count+age rotation on the append path, and a cordis-shaped exporter
 * that funnels the plugin's OWN named logger records into the same write
 * chain (spec: plugin log manager §7.2).
 *
 * `createLogService({ kv, now, report })` builds the service over the unit
 * `dsh_editor_logs` (single layout, verbatim descriptor below):
 *
 * - `chunks` table — one record per appended batch; key = `'c'` + the seq
 *   zero-padded to 12 digits (lexicographic order = numeric order, keys are
 *   NEVER reused), value = `{ seq, ts, entries }` with `ts` the Host clock at
 *   append time (rotation ages by it);
 * - global singleton — `{ lastSeq }`, the monotonic seq cursor, 0 before the
 *   first write. The cursor is only a HINT: each append derives its seq from
 *   the max of the cursor and the largest chunk key actually on disk (same
 *   snapshot), so a rejected `setGlobal` or a lost global slot can never
 *   make a later append overwrite a persisted chunk.
 *
 * `appendEntries(entries)` validates the payload fail-loud BEFORE anything
 * else (an `Error` with `code === 'logs/invalid'`, storage untouched), then
 * runs the write inside ONE serialized chain: load the cursor, write the
 * chunk, restamp the global, rotate. A batch is 1–200 entries, so one chunk
 * never exceeds 200 entries.
 *
 * `createExporter({ loggerName })` returns a cordis exporter object:
 * records are accepted only for the named logger (`message.name`), same-tick
 * records coalesce via ONE microtask into a single batch, and an oversized
 * coalesced batch splits into ≤200-entry `appendEntries` calls made
 * sequentially (the write chain serializes them — a chatty tick must never
 * hit the `logs/invalid` >200 rejection). Exporter entries carry
 * `source: 'host'`, `scope: 'host'` and `text = formatLogArgs(args)`.
 *
 * Concurrency shape (the preferences-service pattern):
 * - the unit opens lazily on first use, memoized; concurrent callers share
 *   one open promise;
 * - every append runs inside ONE internal write chain (promise queue) —
 *   the KV unit does NOT serialize writes itself, and each append must read
 *   the cursor, write the chunk and rotate as one uninterrupted critical
 *   section. A rejected write never poisons the chain (the chain tail stays
 *   settled);
 * - the FIRST `kv.open` failure DEGRADES the service permanently (spec §7.2,
 *   deliberately different from preferences-service's retry-on-next-call):
 *   `appendEntries` then always resolves `{ accepted: 0 }`, never retries
 *   the open, and reports the failure via `report.error` exactly once.
 *
 * Re-entrancy guard: while the exporter is processing (building entries /
 * appending) a flag makes it ignore incoming records — the log module's own
 * errors (routed to `report.error`/console) can never loop back into the
 * channel. `export()` never throws on any input. A rotation pass deleting
 * more than 500 entries reports one `report.warn` (storage anomaly
 * touchpoint, spec §7.2).
 *
 * Failure policy: `appendEntries` is fail-loud for structural violations
 * (`logs/invalid`) and propagates storage write rejections to its caller
 * (the RPC endpoint / exporter layer decides what to do with them); the
 * exporter catches everything it triggers and reports instead of throwing.
 * `close()` is terminal: it drains the write chain and releases the unit,
 * after which `appendEntries` resolves `{ accepted: 0 }` rather than lazily
 * reopening it (a post-close exporter microtask must never leave a unit
 * open across a quick fiber restart). `report` defaults to `console`.
 *
 * @module @dybai/dsh-editor/host/log-service
 */

import { formatLogArgs } from './log-serialize.js';

/**
 * Static identity and shape of the `dsh_editor_logs` KV unit (verbatim,
 * storage contract; single layout is the backend's default, so it is not
 * declared).
 */
const UNIT_DESCRIPTOR = Object.freeze({
	name: 'dsh_editor_logs',
	version: 1,
	tables: Object.freeze(['chunks']),
	hasGlobal: true
});

/** Table whose records are the log chunks: record key = padded seq. */
const TABLE = 'chunks';

/** Entry levels the channel persists. */
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
/** Entries per appendEntries call (the RPC batch cap). */
const MAX_BATCH_ENTRIES = 200;
/** Rotation cap: total persisted entries converge to at most this. */
const MAX_TOTAL_ENTRIES = 2000;
/** Rotation cap: chunks older than 7 days are pruned (ts == cutoff KEPT). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Rotation anomaly threshold (spec §7.2): one rotation pass deleting MORE
 * than 500 entries is reported via `report.warn`.
 */
const ROTATION_ANOMALY_ENTRIES = 500;
/** Scope length cap for an entry. */
const MAX_SCOPE_CHARS = 64;
/** Text length cap for an entry. */
const MAX_TEXT_CHARS = 2000;
/** Scope stamped on exporter-built (Host) entries. */
const HOST_SCOPE = 'host';
/** Source stamped on exporter-built (Host) entries. */
const HOST_SOURCE = 'host';
/** The only source `appendEntries` accepts (Host entries never go via RPC). */
const CLIENT_SOURCE = 'client';

/**
 * Build a stable-code error (`message` === `code`, plus a `.code` property
 * the client can switch on).
 * @param code - stable discriminant, e.g. 'logs/invalid'.
 * @returns a fresh Error carrying the code.
 */
function codedError(code) {
	const error = new Error(code);
	error.code = code;
	return error;
}

/**
 * Chunk record key: `'c'` + the seq zero-padded to 12 digits, so
 * lexicographic order equals numeric order.
 * @param seq - the chunk's monotonic sequence number.
 * @returns the 13-character record key.
 */
function chunkKey(seq) {
	return `c${String(seq).padStart(12, '0')}`;
}

/**
 * Read the `lastSeq` cursor out of the unit's global singleton.
 * @param global - the global slot as `loadAll` returned it (`null` when
 * never written).
 * @returns the stored number, or 0 when nothing was written yet.
 */
function globalLastSeq(global) {
	if (global !== null && typeof global === 'object' && typeof global.lastSeq === 'number') {
		return global.lastSeq;
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
 * Validate one entry: `ts` a finite number, `level` one of the four levels,
 * `source` matching the expected lane (`'client'` for the public RPC lane,
 * `'host'` for the exporter's internal lane — spec §5: Host entries never
 * go through RPC), `scope` a non-empty string of at most 64 chars, `text` a
 * string of at most 2000 chars. Extra properties are tolerated (only the
 * contract fields are read).
 * @param entry - the caller's entry.
 * @param source - the lane's required source value.
 * @returns whether the entry is storable.
 */
function isValidEntry(entry, source) {
	if (entry === null || typeof entry !== 'object') return false;
	if (typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) return false;
	if (!LEVELS.has(entry.level)) return false;
	if (entry.source !== source) return false;
	if (typeof entry.scope !== 'string' || entry.scope.length === 0 || entry.scope.length > MAX_SCOPE_CHARS) return false;
	if (typeof entry.text !== 'string' || entry.text.length > MAX_TEXT_CHARS) return false;
	return true;
}

/**
 * Validate an append payload: an array of 1–200 valid entries.
 * @param entries - the caller's payload.
 * @param source - the lane's required source value.
 * @returns whether the payload is storable.
 */
function isValidEntries(entries, source) {
	if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BATCH_ENTRIES) return false;
	for (const entry of entries) {
		if (!isValidEntry(entry, source)) return false;
	}
	return true;
}

/**
 * Build the Host log service.
 * @param kv - a `StorageBackend` KvFacet (`open(descriptor)` → `KvUnit`).
 * @param now - clock producing millisecond chunk timestamps.
 * @param report - internal failure sink; `error` is called on permanent
 * degrade and exporter failures, `warn` on rotation anomalies (a pass
 * deleting more than 500 entries). Both default to `console`.
 * @returns the service (methods on its prototype so a Host SRC registration
 * can read them for remote discovery); also carries `close()` for disposal.
 */
export function createLogService({ kv, now, report }) {
	if (kv === undefined || kv === null || typeof kv.open !== 'function') {
		throw new Error('dsh-editor: createLogService requires a kv facet with open(descriptor)');
	}
	if (typeof now !== 'function') {
		throw new Error('dsh-editor: createLogService requires a now() clock function');
	}

	/** Memoized `kv.open(UNIT_DESCRIPTOR)`; undefined until first use. */
	let unitPromise;
	/** Tail of the serialized write queue; always settled, never rejecting. */
	let writeChain = Promise.resolve();
	/** Permanent degrade flag: set by the FIRST open failure, never cleared. */
	let degraded = false;
	/**
	 * Set synchronously when `close()` begins: the service never opens or
	 * reopens a unit again, so a late exporter microtask queued just before
	 * fiber disposal cannot resurrect the unit (a "same unit opened twice"
	 * rejection on a quick restart). Jobs already enqueued before close still
	 * drain first.
	 */
	let closed = false;

	/**
	 * Report one internal failure through `report.error`, falling back to
	 * `console.error`. The report channel itself must never throw (iron
	 * rule): a hostile sink is swallowed.
	 * @param args - message parts handed to the sink.
	 */
	function reportError(...args) {
		try {
			if (typeof report?.error === 'function') {
				report.error(...args);
			} else {
				console.error(...args);
			}
		} catch {
			// 上报通道自身失败只吞掉：日志模块的失败不得外溢
		}
	}

	/**
	 * Report one internal anomaly through `report.warn`, falling back to
	 * `console.warn`. Same swallow rule as `reportError`.
	 * @param args - message parts handed to the sink.
	 */
	function reportWarn(...args) {
		try {
			if (typeof report?.warn === 'function') {
				report.warn(...args);
			} else {
				console.warn(...args);
			}
		} catch {
			// 上报通道自身失败只吞掉：日志模块的失败不得外溢
		}
	}

	/**
	 * Open the unit lazily, memoizing the open so concurrent callers share
	 * one promise. Unlike preferences-service there is NO forget-on-reject:
	 * the first failure degrades this service for its lifetime (spec §7.2),
	 * so a retry can never be attempted.
	 * @returns the open unit promise.
	 */
	function openUnit() {
		if (unitPromise === undefined) {
			unitPromise = kv.open(UNIT_DESCRIPTOR);
		}
		return unitPromise;
	}

	/**
	 * Degrade the service permanently and report the triggering failure
	 * exactly once (the flag makes this idempotent).
	 * @param error - the open rejection.
	 */
	function degrade(error) {
		if (degraded) return;
		degraded = true;
		reportError('dsh-editor log-service: kv.open failed; logging degraded for this session (appendEntries resolves { accepted: 0 }):', error);
	}

	/**
	 * Append one serialized job to the write chain. The returned promise
	 * settles with the job's outcome while the chain's tail stays resolved,
	 * so one rejected write never poisons the next.
	 * @param job - async critical section to run once all earlier writes
	 * settled.
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

	/**
	 * Rotate storage inside the write chain: ONE ascending pass over the
	 * stored chunk keys (= seq order, oldest first). A chunk is deleted when
	 * the running total still exceeds MAX_TOTAL_ENTRIES after everything
	 * deleted before it, OR its stored `ts` is older than the 7-day cutoff
	 * (`ts` EQUAL to the cutoff is kept). `remaining` shrinks with every
	 * deletion and a chunk never exceeds 200 entries, so the pass terminates
	 * with at most MAX_TOTAL_ENTRIES entries. Judging by the STORED `ts`
	 * (never re-derived) keeps a regressed clock from deleting fresh chunks.
	 * Anomaly touchpoint (spec §7.2): a pass deleting MORE than 500 entries
	 * reports exactly one `report.warn` carrying the deleted count.
	 * @param unit - the open KV unit.
	 * @param storedChunks - pre-write chunks from the job's snapshot,
	 * already sorted ascending by key: `{ key, ts, count }`.
	 * @param appendedCount - entries in the chunk just written.
	 */
	async function rotate(unit, storedChunks, appendedCount) {
		let remaining = appendedCount;
		for (const chunk of storedChunks) remaining += chunk.count;
		const cutoff = now() - RETENTION_MS;
		const doomed = [];
		let deletedEntries = 0;
		for (const chunk of storedChunks) {
			if (remaining > MAX_TOTAL_ENTRIES || chunk.ts < cutoff) {
				doomed.push(chunk.key);
				deletedEntries += chunk.count;
				remaining -= chunk.count;
			}
		}
		if (doomed.length > 0) {
			await unit.deleteRecords(TABLE, doomed);
		}
		if (deletedEntries > ROTATION_ANOMALY_ENTRIES) {
			reportWarn(`dsh-editor log-service: rotation deleted ${deletedEntries} entries in one pass (> ${ROTATION_ANOMALY_ENTRIES}); inspect the dsh_editor_logs storage`);
		}
	}

	/**
	 * Validate, then append one batch as a chunk inside the write chain:
	 * load the cursor, `putRecord` the chunk (`{ seq, ts: now(), entries }`),
	 * restamp the global, rotate. The public lane requires
	 * `source === 'client'` (the RPC contract); the exporter's internal lane
	 * requires `source === 'host'` (Host entries never go through RPC).
	 * Degraded state always resolves `{ accepted: 0 }`; structural
	 * violations reject `logs/invalid` before the chain (and before the
	 * unit) is ever touched.
	 * @param entries - the caller's payload (1–200 valid entries).
	 * @param source - the lane's required source value.
	 * @returns `{ accepted }` — the number of entries persisted.
	 */
	async function appendEntriesImpl(entries, source) {
		if (!isValidEntries(entries, source)) {
			throw codedError('logs/invalid');
		}
		// A closed service never opens a unit again (the call is synchronous,
		// so no close() can interleave between this check and the enqueue).
		if (degraded || closed) return { accepted: 0 };
		return enqueue(async () => {
			if (degraded) return { accepted: 0 }; // 排队期间前序作业已降级
			let unit;
			try {
				unit = await openUnit();
			} catch (error) {
				degrade(error);
				return { accepted: 0 };
			}
			const snapshot = await unit.loadAll();
			const records = tableOf(snapshot, TABLE);
			// Seq derivation must honor the "keys are NEVER reused" invariant
			// even when the global cursor lies: a rejected `setGlobal` (or a
			// crash between `putRecord` and `setGlobal`, or a lost global
			// slot) leaves the chunk on disk with the cursor unchanged, so
			// the next seq is the max of the global AND the largest chunk key
			// actually stored — read from the SAME snapshot rotation uses.
			let maxSeq = globalLastSeq(snapshot.global);
			const storedChunks = Object.keys(records)
				.sort()
				.map((key) => {
					const record = records[key];
					const keySeq = Number(key.slice(1));
					if (Number.isFinite(keySeq) && keySeq > maxSeq) maxSeq = keySeq;
					return {
						key,
						ts: record?.ts,
						count: Array.isArray(record?.entries) ? record.entries.length : 0
					};
				});
			const seq = maxSeq + 1;
			await unit.putRecord(TABLE, chunkKey(seq), { seq, ts: now(), entries });
			await unit.setGlobal({ lastSeq: seq });
			await rotate(unit, storedChunks, entries.length);
			return { accepted: entries.length };
		});
	}

	return Object.create({
		/**
		 * Append one batch of client entries as a single chunk (the RPC
		 * endpoint `dshEditor/appendLogs` delegates here). Only
		 * `source === 'client'` entries are accepted — Host entries enter
		 * via the exporter's internal lane and never through this public
		 * surface.
		 * @param entries - 1–200 entries of the contract shape.
		 * @returns `{ accepted }`; `{ accepted: 0 }` once degraded.
		 * @throws a `logs/invalid` coded Error for a structurally invalid
		 * payload (storage untouched).
		 */
		async appendEntries(entries) {
			return appendEntriesImpl(entries, CLIENT_SOURCE);
		},

		/**
		 * Build a cordis exporter for ONE named logger: only records with
		 * `message.name === loggerName` enter the channel. Same-tick records
		 * coalesce into one batch flushed on a microtask; a batch over 200
		 * entries splits into sequential ≤200-entry appends. Records arriving
		 * while a flush is in flight are dropped (the re-entrancy guard: the
		 * module's own errors must never loop back into the channel).
		 * `export` NEVER throws.
		 * @param loggerName - the cordis logger name to filter by.
		 * @returns the `{ export(message) }` exporter object.
		 */
		createExporter({ loggerName }) {
			/** Same-tick coalesced records awaiting the flush microtask. */
			let queue = [];
			/** Whether the flush microtask is scheduled. */
			let scheduled = false;
			/** Re-entrancy guard: true while building entries / appending. */
			let processing = false;

			/**
			 * Drain the coalesced queue into the write chain; any failure is
			 * reported (never thrown, never re-queued).
			 */
			const flush = async () => {
				scheduled = false;
				if (queue.length === 0) return;
				const messages = queue;
				queue = [];
				processing = true;
				try {
					const entries = messages.map((message) => ({
						ts: now(),
						level: message?.type,
						source: HOST_SOURCE,
						scope: HOST_SCOPE,
						text: formatLogArgs(message?.args)
					}));
					for (let i = 0; i < entries.length; i += MAX_BATCH_ENTRIES) {
						await appendEntriesImpl(entries.slice(i, i + MAX_BATCH_ENTRIES), HOST_SOURCE);
					}
				} catch (error) {
					reportError('dsh-editor log-service: exporter append failed:', error);
				} finally {
					processing = false;
				}
			};

			return {
				/**
				 * Cordis exporter entry point.
				 * @param message - `{ name, type, args }` logger record.
				 */
				export(message) {
					try {
						if (processing) return; // 防自激：处理期间一律拦截
						if (message?.name !== loggerName) return; // 只收命名 logger
						queue.push(message);
						if (!scheduled) {
							scheduled = true;
							queueMicrotask(flush);
						}
					} catch {
						// 铁律：export 永不 throw
					}
				}
			};
		},

		/**
		 * Drain the write chain, close the unit when one was opened, and stop
		 * the service for good: from the moment close() begins, later
		 * `appendEntries` calls resolve `{ accepted: 0 }` without opening (or
		 * reopening) the unit, so a late exporter microtask cannot leave a
		 * unit open across a fiber restart. A batch already enqueued before
		 * the close still drains and persists. Idempotent; a degraded open
		 * failure does not reject the close. Wired into the plugin's effect
		 * cleanup.
		 * @returns resolution after the unit (if any) is released.
		 */
		async close() {
			closed = true;
			const closing = writeChain.then(async () => {
				if (unitPromise === undefined) return;
				const unit = await unitPromise.catch(() => undefined); // 降级 memo 不让 close 炸
				unitPromise = undefined;
				if (unit !== undefined) {
					await unit.close();
				}
			});
			writeChain = closing.then(
				() => {},
				() => {}
			);
			return closing;
		}
	});
}
