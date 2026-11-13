/**
 * Tab document-handle state machine and save queue — the editor framework core.
 *
 * One controller owns the content state of ONE editor tab (draft text, saved
 * baseline, dirty flag, file version, conflict marker) and runs the phase
 * machine `loading → ready | failed`, `ready ⇄ saving`. The React layer (a
 * later task) renders from `getState()` snapshots and calls the request*
 * methods; the global service exposes the same snapshots as observable
 * slices. Zero imports: every capability is injected through `deps`.
 *
 * Concurrency model (spec §7): JS is single-threaded, so the only hazards are
 * `await` interleavings. Host optimistic concurrency — every write carrying a
 * `baseVersion` (`replaceIfVersion` intent) — is the correctness backstop.
 * The save queue here is a UX refinement, never a correctness dependency.
 *
 * Save queue: at most ONE in-flight write per controller. `requestSave()`
 * while a write is in flight only sets a `pending` flag. When the write
 * settles: on success the version/saved text update and publish; if the queue
 * is pending AND the draft is still dirty, a follow-up write is issued
 * immediately with the FRESH baseVersion and the CURRENT draft. A stale
 * rejection (`code`/`message` matching /stale/i, e.g. `FS_STALE_VERSION`)
 * sets `conflict = true` and keeps the draft; any other failure records a
 * `lastError` notice. `requestSave(true)` forces a write through the same
 * queue with `baseVersion = ''` (no version intent).
 *
 * Error channel: `requestSave()` never throws — every outcome, including
 * rejections, resolves as `{ ok: true, value } | { ok: false, error }`,
 * matching the `EditorHandle.save()` contract. Accepted saves settle with the
 * result of the final write that drains the queue (a follow-up covers queued
 * waiters).
 *
 * Phase gating: `requestSave` is accepted in `ready`/`saving` and rejected
 * with the error envelope in `loading`/`failed`. `requestNavigate` during
 * `loading` is deferred (latest request wins) and delivered once after
 * `ready`; during `failed` it returns false; in `ready`/`saving` it delivers
 * immediately. Mode switches (`attachMode`/`detachMode`) are allowed in any
 * phase. `requestReload` drops the queue (waiters resolve `cancelled`),
 * clears conflict/notice/failure and the persisted draft, then re-reads;
 * in-flight settles from before the reload are discarded.
 *
 * Snapshot discipline: state fields are committed first, then subscribers are
 * notified with the fresh snapshot; the snapshot object reference is stable
 * while nothing changes. No initial publish — callers read `getState()`.
 *
 * External disk state: a disk-watch layer reports observed facts through
 * `notifyDiskState({ version } | { absent: true })`; the machine owns ALL
 * policy. A version mismatch with the loaded baseline raises the external ask
 * (`external`/`externalNotice = 'modified'`) without touching draft or
 * baseline; the ask offers reload / dismiss (放弃更新) / suppress (不再询问,
 * per-tab lifetime). An absent notice raises the deleted ask with a durable
 * marker (`external = 'deleted'` — the tab-title strike reads it); saving
 * while deleted writes WITHOUT version intent (recreate) and clears the
 * marker. Recreation notices clear the marker and re-enter the modified
 * policy. Notices arriving mid-save are HELD and evaluated against the
 * settled version, so the watcher's own-echo of this tab's save is ignored.
 * The existing conflict banner and the external ask never stack: a stale
 * save folds an open modified ask into the conflict banner (its options are
 * a superset), and notices are not surfaced while `conflict` is true. Every
 * successful load/save/reset clears the external state (fresh disk truth);
 * `neverAsk` survives until the tab closes.
 *
 * `deps.signal` (tab occurrence AbortSignal): on abort the machine stops —
 * no further writes, in-flight settles discarded, pending queue dropped and
 * its waiters resolved with an explicit error. It then simply stops
 * publishing (no synthetic "closed" phase): the React component that owned
 * the tab is being unmounted and would discard such a snapshot anyway.
 * `destroy()` runs the same teardown for explicit close; neither touches the
 * draft store (its own debounce persists; the UI layer owns flush-on-hide).
 *
 * Wiring parity: `deps.now` is accepted but unused in v1 (timestamps live in
 * the draft store). Foreground semantics never enter the machine — they are
 * resolved by the service layer. `deps.onStateChange(fn)`, when provided, receives the
 * machine's broadcast at construction — a host may keep it to re-request the
 * current snapshot; the machine always broadcasts after every commit. Of the
 * spec §5.5 framework→mode commands, `onNavigate`/`setContent` are state-level
 * and live here; `focus()` is DOM-bound and stays in the UI layer.
 */

/** Extract a display message from a rejected value. */
function errorMessage(error) {
	if (error && typeof error.message === 'string' && error.message) return error.message;
	return String(error);
}

/** Failure kind for a rejected load: prefer an explicit `kind`, then `code`. */
function failureKind(error) {
	if (error && typeof error.kind === 'string' && error.kind) return error.kind;
	if (error && typeof error.code === 'string' && error.code) return error.code;
	return 'load-error';
}

/** Whether a write rejection is a stale-version verdict (host `FS_STALE_VERSION`). */
function isStaleFailure(error) {
	const code = error && typeof error.code === 'string' ? error.code : '';
	return /stale/i.test(`${code} ${errorMessage(error)}`);
}

/**
 * Create the per-tab controller.
 * @param {{ address: string, sessionId: string, load(): Promise<{ text: string, version: string }>, write(content: string, baseVersion: string): Promise<{ operation: string, version: string }>, draftStore: { get(s,a), set(s,a,text,baseVersion), clear(s,a) }, signal?: AbortSignal, onStateChange?(fn): () => void, now?(): number, autoReloadClean?: () => boolean }} deps
 * @returns {{
 *   getState(): { phase: 'loading'|'ready'|'saving'|'failed', text: string, draft: string, dirty: boolean, version: string, conflict: boolean, saving: boolean, failure: { kind: string, message: string } | null, lastError: string | null, selection: { start: number, end: number, lineStart: number, lineEnd: number, text: string } | null, modeId: string | undefined, external: 'modified'|'deleted'|null, externalNotice: 'modified'|'deleted'|null },
 *   subscribe(fn): () => void, applyEdit(content): void, applySelection(sel): void, setContent(content, selection?): void,
 *   requestSave(force?: boolean): Promise<{ ok: true, value } | { ok: false, error }>, requestReload(): boolean,
 *   notifyDiskState(notice): void, dismissExternalNotice(): void, suppressExternalNotice(): void,
 *   requestNavigate(line): boolean, onNavigate(cb): () => void, attachMode(modeId): void, detachMode(): void, destroy(): void,
 * }}
 */
export function createTabController(deps) {
	const { address, sessionId, load, write, draftStore, signal } = deps;
	const autoReloadClean = typeof deps.autoReloadClean === 'function' ? deps.autoReloadClean : () => false;

	// --- state fields (the only source of truth) ---
	let phase = 'loading';
	let text = '';      // saved baseline (last loaded/written content)
	let draft = '';     // current in-editor content
	let version = '';   // last known file version (opaque token)
	let conflict = false;
	let saving = false;
	let failure = null; // load-phase failure { kind, message }
	let lastError = null; // save-phase notice (status bar), non-stale failures only
	let selection = null;
	let modeId = undefined;
	let external = null;       // durable divergence marker: 'modified' | 'deleted' | null (tab-title strike reads 'deleted')
	let externalNotice = null; // which ask is currently displayed: 'modified' | 'deleted' | null

	// --- queue / lifecycle bookkeeping ---
	let pendingSave = false;     // a save was requested while a write was in flight
	let pendingForce = false;    // any queued request asked for a force write (upgrade-only)
	let deferredNavigate = null; // navigate requested during loading, latest wins
	let destroyed = false;
	let epoch = 0;               // bumped on reload/destroy; supersedes in-flight settles
	let seenExternalVersion = ''; // disk version already surfaced/acknowledged (duplicate frames never re-ask)
	let neverAsk = false;        // 不再询问: per-tab, survives reloads, dies with the tab
	let heldDisk = null;         // disk notice held while a write is in flight (self-save race window)
	const saveWaiters = [];      // resolvers of accepted requestSave() calls
	const listeners = new Set();
	const navigateHandlers = new Set();
	let snapshotCache = null;

	function buildSnapshot() {
		return {
			phase,
			text,
			draft,
			dirty: draft !== text,
			version,
			conflict,
			saving,
			failure,
			lastError,
			selection,
			modeId,
			external,
			externalNotice,
		};
	}

	function getState() {
		if (snapshotCache === null) snapshotCache = buildSnapshot();
		return snapshotCache;
	}

	function broadcast() {
		const snapshot = getState();
		for (const fn of [...listeners]) {
			// Subscriber isolation: listeners are third-party surface — a bug in
			// one must not break the commit path (e.g. reject requestSave inside
			// its executor) or starve the remaining listeners. Swallowed on
			// purpose: deterministic and dependency-free.
			try {
				fn(snapshot);
			} catch {
				// swallow
			}
		}
	}

	/** Commit-then-publish: the only path that makes state changes visible. */
	function commit() {
		snapshotCache = null;
		broadcast();
	}

	function resolveWaiters(result) {
		const waiters = saveWaiters.splice(0);
		for (const resolve of waiters) resolve(result);
	}

	// --- load path ---

	function settleLoad(captured, error, result) {
		if (destroyed || captured !== epoch) return; // aborted or reloaded away
		if (error) {
			phase = 'failed';
			failure = { kind: failureKind(error), message: errorMessage(error) };
			commit();
			return;
		}
		phase = 'ready';
		failure = null;
		lastError = null;
		text = result.text;
		version = result.version;
		external = null;           // fresh disk truth: any divergence marker is stale
		externalNotice = null;
		seenExternalVersion = '';
		const stored = draftStore.get(sessionId, address);
		if (stored) {
			// Crash/refresh recovery: restore the draft; if the file changed
			// externally since the draft was taken, surface the conflict now
			// (banner before any save), never silently over the fresh read.
			draft = stored.text;
			conflict = stored.baseVersion !== version;
		} else {
			draft = text;
			conflict = false;
		}
		commit();
		if (deferredNavigate !== null) {
			const line = deferredNavigate;
			deferredNavigate = null;
			deliverNavigate(line); // deferred navigation: delivered once, after ready
		}
	}

	function startLoad() {
		const captured = epoch;
		let outcome;
		try {
			outcome = load();
		} catch (error) {
			outcome = Promise.reject(error);
		}
		Promise.resolve(outcome).then(
			(result) => settleLoad(captured, null, result),
			(error) => settleLoad(captured, error, null),
		);
	}

	// --- save queue ---

	function settleWrite(captured, content, error, result) {
		if (destroyed || captured !== epoch) return; // aborted or reloaded away: discard
		saving = false;
		phase = 'ready';
		if (error) {
			const stale = isStaleFailure(error);
			if (stale) {
				conflict = true; // draft kept; the user decides (reload / force)
				// The conflict banner's options are a superset of the modified
				// ask — fold an open ask into it instead of stacking banners.
				external = null;
				externalNotice = null;
				seenExternalVersion = '';
			} else lastError = errorMessage(error); // status-bar notice
			pendingSave = false;
			pendingForce = false;
			commit();
			resolveWaiters({ ok: false, error: { kind: stale ? 'stale' : 'write-error', message: errorMessage(error) } });
			const held = heldDisk;
			heldDisk = null;
			if (held !== null && !destroyed && captured === epoch) notifyDiskState(held);
			return; // no auto follow-up: a failed write needs user action, not a loop
		}
		version = result.version;
		text = content;
		conflict = false;
		lastError = null;
		external = null;          // our write IS fresh disk truth (also clears the deleted marker after a recreate)
		externalNotice = null;
		seenExternalVersion = '';
		if (draft !== text) draftStore.set(sessionId, address, draft, version); // edits landed mid-flight: keep the newer draft persisted (crash-safe)
		else draftStore.clear(sessionId, address); // saved clean: stored draft goes away
		const followUp = pendingSave && draft !== text; // queue pending AND dirty since this write
		const force = pendingForce;
		pendingSave = false;
		pendingForce = false;
		const broadcastEpoch = epoch; // the broadcast below re-enters subscribers synchronously
		commit();
		if (destroyed || broadcastEpoch !== epoch) {
			// A subscriber destroyed/reloaded during the broadcast: no write is
			// issued and waiters are left to the re-entrant call (destroy/reload
			// both resolve them). The already-committed state stands.
			heldDisk = null;
			return;
		}
		if (followUp) {
			startWrite(force); // queued waiters ride along and settle with the follow-up result
			return; // still saving: any held notice stays held for the next settle
		}
		resolveWaiters({ ok: true, value: result });
		const held = heldDisk;
		heldDisk = null;
		if (held !== null && !destroyed && epoch === broadcastEpoch) notifyDiskState(held);
	}

	function startWrite(force) {
		saving = true;
		phase = 'saving';
		lastError = null;
		const captured = epoch;
		const content = draft;
		// A deleted file has no version to be stale against: save = recreate,
		// so the write carries no version intent (same as a forced overwrite).
		const baseVersion = force || external === 'deleted' ? '' : version;
		const broadcastEpoch = epoch;
		commit();
		if (destroyed || broadcastEpoch !== epoch) {
			// A subscriber destroyed/reloaded during the phase-change broadcast:
			// the write is not issued (no write-after-destroy, no write racing a
			// reload); the re-entrant call already settled the queue waiters and
			// the committed phase stands.
			return;
		}
		let outcome;
		try {
			outcome = write(content, baseVersion);
		} catch (error) {
			outcome = Promise.reject(error);
		}
		Promise.resolve(outcome).then(
			(result) => settleWrite(captured, content, null, result),
			(error) => settleWrite(captured, content, error, null),
		);
	}

	function requestSave(force = false) {
		if (destroyed) {
			return Promise.resolve({ ok: false, error: { kind: 'destroyed', message: 'controller destroyed' } });
		}
		if (phase === 'loading' || phase === 'failed') {
			return Promise.resolve({ ok: false, error: { kind: 'not-ready', message: `save rejected in ${phase} phase` } });
		}
		return new Promise((resolve) => {
			saveWaiters.push(resolve);
			if (saving) {
				pendingSave = true; // merge into the queue; follow-up after the in-flight write settles
				pendingForce = pendingForce || force;
				return;
			}
			startWrite(force);
		});
	}

	// --- edits, selection, navigation, modes ---

	/** Stage a draft change (with draft persistence); false when nothing changed. */
	function stageEdit(content) {
		if (destroyed || typeof content !== 'string') return false;
		if (phase !== 'ready' && phase !== 'saving') return false; // modes only run in ready/saving
		if (content === draft) return false; // no change: no commit, no persistence write
		draft = content;
		draftStore.set(sessionId, address, draft, version); // debounced inside the store
		return true;
	}

	function applyEdit(content) {
		if (!stageEdit(content)) return;
		commit();
	}

	function normalizeSelection(sel) {
		if (sel === null || typeof sel !== 'object') return null;
		return { start: sel.start, end: sel.end, lineStart: sel.lineStart, lineEnd: sel.lineEnd, text: sel.text };
	}

	function sameSelection(a, b) {
		if (a === null || b === null) return a === b;
		return a.start === b.start && a.end === b.end && a.lineStart === b.lineStart && a.lineEnd === b.lineEnd && a.text === b.text;
	}

	function applySelection(sel) {
		if (destroyed) return;
		const next = normalizeSelection(sel);
		if (sameSelection(next, selection)) return;
		selection = next;
		commit();
	}

	/** Framework content-write command (deleteLines, templates, formatting).
	 * One logical command → one commit/notify, even though it touches both the
	 * draft and the selection. */
	function setContent(content, sel) {
		if (destroyed) return;
		const edited = stageEdit(content);
		let selected = false;
		if (sel !== undefined) {
			const next = normalizeSelection(sel);
			if (!sameSelection(next, selection)) {
				selection = next;
				selected = true;
			}
		}
		if (edited || selected) commit();
	}

	function deliverNavigate(line) {
		for (const handler of [...navigateHandlers]) {
			if (handler(line) === true) return; // first handler to claim it wins
		}
	}

	function requestNavigate(line) {
		if (destroyed) return false;
		if (phase === 'loading') {
			deferredNavigate = line; // delivered once, after ready; latest wins
			return true;
		}
		if (phase === 'failed') return false;
		deliverNavigate(line); // ready | saving
		return true;
	}

	/** Mode registration for navigation delivery (spec §5.5). */
	function onNavigate(handler) {
		navigateHandlers.add(handler);
		return () => {
			navigateHandlers.delete(handler);
		};
	}

	function attachMode(id) {
		if (destroyed || modeId === id) return; // mode switch: any phase, content state untouched
		modeId = id;
		commit();
	}

	function detachMode() {
		if (destroyed || modeId === undefined) return;
		modeId = undefined;
		commit();
	}

	function subscribe(fn) {
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	}

	// --- external disk state (the disk-watch layer reports facts; the machine decides) ---

	/** The derived dirty flag (draft diverged from the saved baseline). */
	function dirtyRef() {
		return draft !== text;
	}

	/**
	 * Observed disk truth for this tab's file: either the current version or
	 * absence. Malformed notices are ignored; notices during loading/failed
	 * are ignored (the next settle reflects disk truth); notices during an
	 * in-flight write are held and evaluated against the settled version, so
	 * the watcher's echo of this tab's own save never raises an ask.
	 * @param {{ version: string } | { absent: true }} notice
	 */
	function notifyDiskState(notice) {
		if (destroyed) return;
		if (phase !== 'ready' && phase !== 'saving') return;
		if (notice === null || typeof notice !== 'object') return;
		const absent = notice.absent === true;
		if (!absent && typeof notice.version !== 'string') return;
		if (saving) {
			heldDisk = absent ? { absent: true } : { version: notice.version };
			return;
		}
		if (absent) {
			if (external === 'deleted') return; // idempotent: the marker and its ask are already up
			seenExternalVersion = '';
			external = 'deleted';     // durable marker: the tab-title strike renders from this
			externalNotice = 'deleted';
			commit();
			return;
		}
		const diskVersion = notice.version;
		if (diskVersion === '') return;
		if (diskVersion === version) {
			if (external === 'deleted') {
				// recreated externally with baseline-identical content: the file
				// is back and matches what we hold — marker clears, nothing to ask
				external = null;
				externalNotice = null;
				seenExternalVersion = '';
				commit();
			}
			return;
		}
		// disk version differs from the loaded baseline
		if (diskVersion === seenExternalVersion) return; // already surfaced/acknowledged: duplicate frame, or a re-report after 放弃更新/不再询问
		if (external === 'modified') {
			seenExternalVersion = diskVersion; // a newer external change re-arms the ask (bar stays up)
			commit();
			return;
		}
		if (conflict) {
			seenExternalVersion = diskVersion; // the conflict banner owns the ask; never stack
			return;
		}
		if (neverAsk) {
			seenExternalVersion = diskVersion; // silent; the stale-save conflict banner remains the safety net
			if (external !== null) {
				external = null; // e.g. recreation clears the deleted marker even while suppressing asks
				commit();
			}
			return;
		}
		if (!dirtyRef() && autoReloadClean()) {
			requestReload(); // clean tab with the setting on: silent reload, no ask
			return;
		}
		seenExternalVersion = diskVersion;
		external = 'modified';
		externalNotice = 'modified';
		commit();
	}

	/**
	 * Close the displayed ask. 放弃更新 (modified): the ask and its marker drop
	 * together — the draft stays authoritative and a later save hits the stale
	 * conflict banner. 保留 (deleted): only the ask drops; the deleted marker
	 * persists until the file returns or this tab's save recreates it.
	 */
	function dismissExternalNotice() {
		if (destroyed || externalNotice === null) return;
		if (externalNotice === 'modified') external = null;
		externalNotice = null;
		commit();
	}

	/**
	 * 不再询问: for this tab's lifetime, external modifications stop raising
	 * the ask (the stale-save conflict banner remains the safety net).
	 * Deletion asks are unaffected — they ask about closing the tab, not
	 * about the draft.
	 */
	function suppressExternalNotice() {
		if (destroyed || externalNotice !== 'modified') return;
		neverAsk = true;
		external = null;
		externalNotice = null;
		commit();
	}

	function requestReload() {
		if (destroyed) return false;
		// Drop the queue (waiters resolve `cancelled`) and — via the epoch —
		// any in-flight settle; clear conflict/notice/failure and the stored
		// draft, then re-read the file.
		pendingSave = false;
		pendingForce = false;
		conflict = false;
		lastError = null;
		failure = null;
		saving = false;
		external = null;          // the ask is answered by the reload itself
		externalNotice = null;
		seenExternalVersion = '';
		heldDisk = null;          // notices held for the old epoch must not fire
		draftStore.clear(sessionId, address);
		resolveWaiters({ ok: false, error: { kind: 'cancelled', message: 'reload' } });
		epoch++;
		phase = 'loading';
		commit();
		startLoad();
		return true;
	}

	function destroy() {
		if (destroyed) return;
		destroyed = true;
		epoch++;
		pendingSave = false;
		pendingForce = false;
		deferredNavigate = null;
		heldDisk = null;
		resolveWaiters({ ok: false, error: { kind: 'destroyed', message: 'controller destroyed' } });
		// Abort/close: simply stop publishing (see module doc). The draft store
		// is untouched — its own debounce guarantees persistence.
		listeners.clear();
		detachSignal();
		if (detachHostChannel) detachHostChannel();
	}

	function onAbort() {
		destroy();
	}

	let detachSignal = () => {};
	let detachHostChannel = null;
	if (signal) {
		if (signal.aborted) destroy();
		else {
			signal.addEventListener('abort', onAbort, { once: true });
			detachSignal = () => signal.removeEventListener('abort', onAbort);
		}
	}
	if (typeof deps.onStateChange === 'function') {
		const detach = deps.onStateChange(broadcast);
		if (typeof detach === 'function') detachHostChannel = detach;
	}

	const controller = {
		getState,
		subscribe,
		applyEdit,
		applySelection,
		setContent,
		requestSave,
		requestReload,
		notifyDiskState,
		dismissExternalNotice,
		suppressExternalNotice,
		requestNavigate,
		onNavigate,
		attachMode,
		detachMode,
		destroy,
	};
	if (!destroyed) startLoad();
	return controller;
}
