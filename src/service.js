/**
 * Editor service and handle registry — the framework's client-side face.
 *
 * `createEditorService(deps)` builds the object other plugins receive as
 * `ctx.get('dshEditor')`: `version`, the `active` foreground-handle
 * observable, `open()` navigation, the tab `registerTab`/`unregisterTab`
 * registry, `saveAll(sessionId)` and the read-only `modeRegistryProxy`.
 * Zero imports: every capability (foreground resolution, sidebar opening,
 * tab closing, the mode registry) is injected through `deps`, so the module
 * is pure and unit-testable without cordis or DOM.
 *
 * `active` resolution (spec §4.2): `deps.resolveForegroundTab()` is the
 * single authority for WHICH registered tab is foreground (sidebar-right
 * semantics live behind it). The service re-runs resolution when
 *   (a) a tab registration changes (register/unregister/re-register), or
 *   (b) a change signal fires: every registered controller's own publish
 *       (phase/content commits) is hooked automatically, and a registration
 *       may additionally provide `notifyChange(listener) → detach` for
 *       tab-level changes the controller cannot see (visibility flips).
 * Handles are memoized per `tabKey`, so an unchanged foreground identity
 * yields the SAME handle reference — no notify. Without a `notifyChange`
 * hook, visibility changes are signaled by re-registering the tab.
 *
 * Handles are short-lived: backed by a registration, invalidated by
 * `unregisterTab` (re-registering the same tabKey mints a fresh handle).
 * Stale handles never throw — `save()` resolves `{ ok:false, error }`,
 * `navigateToLine` returns `false`, `close()` is a no-op, and every slice
 * serves one frozen stale snapshot (`content` `{text:'',dirty:false}`,
 * `selection` `null`, `state` `{phase:'failed',failure:'handle closed',…}`,
 * `mode` `{modeId: undefined}`).
 *
 * Snapshot discipline (same as tab-machine): every observable follows the
 * DSH `{ getSnapshot(), subscribe(fn) }` convention with reference-stable
 * snapshots — a slice object survives untouched commits of other slices,
 * and `active` survives re-validations that resolve to the same handle.
 * No initial publish: consumers read `getSnapshot()` first.
 */

/** Frozen stale-handle snapshots served after unregistration. */
const STALE_CONTENT = Object.freeze({ text: '', dirty: false });
const STALE_SELECTION = null;
const STALE_STATE = Object.freeze({ phase: 'failed', saving: false, conflict: false, version: '', failure: 'handle closed' });
const STALE_MODE = Object.freeze({ modeId: undefined });

/**
 * Reference-stable observable snapshot store (private).
 * `publish(next)` is a no-op on reference equality; callers therefore
 * hand out memoized/derived-on-change objects only. Subscriber isolation:
 * a throwing listener must not starve the remaining ones.
 * @param {any} initial
 */
function createObservable(initial) {
	let snapshot = initial;
	const listeners = new Set();
	function notifyAll() {
		for (const fn of [...listeners]) {
			try {
				fn(snapshot);
			} catch {
				// swallow
			}
		}
	}
	return {
		getSnapshot: () => snapshot,
		subscribe(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		/** Commit the next snapshot (caller guarantees a semantic change) and notify. */
		publish(next) {
			if (next === snapshot) return;
			snapshot = next;
			notifyAll();
		},
	};
}

/** Read-only view of a store: hides `publish` from consumers. */
function publicView(store) {
	return { getSnapshot: store.getSnapshot, subscribe: store.subscribe };
}

/**
 * Create the EditorHandle for one registered tab.
 *
 * Slices forward the controller's state snapshot, filtered per slice with
 * field comparison, so each slice keeps its own reference stability:
 *   - `content`   `{ text, dirty }` — text is the LIVE draft being edited;
 *   - `selection` the controller's `{ start, end, lineStart, lineEnd, text } | null`;
 *   - `state`     `{ phase, saving, conflict, version, failure }` — the machine's
 *                 `saving` phase maps to `phase:'ready'` + `saving:true`, and a
 *                 load failure renders as its message string;
 *   - `mode`      `{ modeId }`.
 * @param {string} tabKey
 * @param {{ sessionId: string, address: string, controller: object }} registration
 * @param {{ closeTab(tabKey: string): void }} deps
 */
function createHandle(tabKey, registration, deps) {
	const { controller } = registration;
	let stale = false;

	const initial = controller.getState();
	const contentStore = createObservable({ text: initial.draft, dirty: initial.dirty });
	const selectionStore = createObservable(initial.selection);
	const stateStore = createObservable({
		phase: initial.phase === 'saving' ? 'ready' : initial.phase,
		saving: initial.saving,
		conflict: initial.conflict,
		version: initial.version,
		failure: initial.failure ? initial.failure.message : null,
	});
	const modeStore = createObservable({ modeId: initial.modeId });

	/** Per-slice filter over the machine's whole-state broadcasts. */
	function onPublish(machineState) {
		if (stale) return;
		const prevContent = contentStore.getSnapshot();
		if (machineState.draft !== prevContent.text || machineState.dirty !== prevContent.dirty) {
			contentStore.publish({ text: machineState.draft, dirty: machineState.dirty });
		}
		if (machineState.selection !== selectionStore.getSnapshot()) {
			selectionStore.publish(machineState.selection);
		}
		const prevState = stateStore.getSnapshot();
		const nextFailure = machineState.failure ? machineState.failure.message : null;
		const nextPhase = machineState.phase === 'saving' ? 'ready' : machineState.phase;
		if (nextPhase !== prevState.phase || machineState.saving !== prevState.saving
			|| machineState.conflict !== prevState.conflict || machineState.version !== prevState.version
			|| nextFailure !== prevState.failure) {
			stateStore.publish({
				phase: nextPhase,
				saving: machineState.saving,
				conflict: machineState.conflict,
				version: machineState.version,
				failure: nextFailure,
			});
		}
		if (machineState.modeId !== modeStore.getSnapshot().modeId) {
			modeStore.publish({ modeId: machineState.modeId });
		}
	}

	const detachController = controller.subscribe(onPublish);

	const handle = {
		address: registration.address,
		sessionId: registration.sessionId,
		content: publicView(contentStore),
		selection: publicView(selectionStore),
		state: publicView(stateStore),
		mode: publicView(modeStore),
		/** Into the save queue (non-force); resolves the controller's envelope. */
		save() {
			if (stale) return Promise.resolve({ ok: false, error: { message: 'dsh-editor: handle closed' } });
			return controller.requestSave(false);
		},
		/** Delivered by the machine (deferred while loading); false when rejected or stale. */
		navigateToLine(line) {
			if (stale) return false;
			return controller.requestNavigate(line);
		},
		/** Framework close; unregistration (and staleness) follows via the tab unmount. */
		close() {
			if (stale) return;
			deps.closeTab(tabKey);
		},
	};

	/** Invalidate: stop tracking the controller and serve the frozen stale snapshots. */
	function dispose() {
		if (stale) return;
		stale = true;
		detachController();
		contentStore.publish(STALE_CONTENT);
		selectionStore.publish(STALE_SELECTION);
		stateStore.publish(STALE_STATE);
		modeStore.publish(STALE_MODE);
	}

	return { handle, dispose };
}

/**
 * Create the `dshEditor` service.
 * @param {{
 *   resolveForegroundTab(): { tabKey: string, sessionId: string, address: string, controller: object, isVisible: boolean } | undefined,
 *   openInSidebar(address: string, opts: object): void,
 *   modeRegistry: { entries(): readonly object[], subscribe(fn): () => void },
 *   closeTab(tabKey: string): void,
 *   version: string,
 * }} deps
 * @returns the service object (see module doc).
 */
export function createEditorService(deps) {
	/** tabKey -> { registration, handle, dispose, detachSignals() } */
	const tabs = new Map();
	const activeStore = createObservable(undefined);

	/** Re-run foreground resolution; same identity ⇒ same snapshot, no notify. */
	function revalidate() {
		const result = deps.resolveForegroundTab();
		const entry = result ? tabs.get(result.tabKey) : undefined;
		activeStore.publish(entry ? entry.handle : undefined); // unregistered/unknown foreground ⇒ undefined
	}

	/**
	 * Register a mounted editor tab. `registration = { sessionId, address,
	 * controller, isVisible(), notifyChange?(listener): detach }`; the optional
	 * `notifyChange` hook (subscribe-style) carries tab-level changes such as
	 * visibility flips — controller commits are hooked automatically. Re-registering
	 * a tabKey replaces the entry and invalidates the previous handle.
	 * @returns the unregister disposer.
	 */
	function registerTab(tabKey, registration) {
		if (tabs.has(tabKey)) unregisterTab(tabKey);
		const detachers = [registration.controller.subscribe(revalidate)];
		if (typeof registration.notifyChange === 'function') {
			const detach = registration.notifyChange(revalidate);
			if (typeof detach === 'function') detachers.push(detach);
		}
		const { handle, dispose } = createHandle(tabKey, registration, deps);
		tabs.set(tabKey, { registration, handle, dispose, detachSignals: () => { for (const detach of detachers) detach(); } });
		revalidate();
		return () => unregisterTab(tabKey);
	}

	/** Unregister (idempotent): the tab's handle goes stale, `active` re-resolves. */
	function unregisterTab(tabKey) {
		const entry = tabs.get(tabKey);
		if (!entry) return;
		tabs.delete(tabKey);
		entry.detachSignals();
		entry.dispose();
		revalidate();
	}

	/**
	 * Queue saves for every REGISTERED handle of the session with dirty
	 * content whose controller accepts a save (ready/saving — a dirty draft
	 * can survive into `failed` after a failed reload; it is not queued).
	 * `saved` counts accepted requests: outcomes flow through each handle's
	 * own state slices, not through this return value.
	 * @returns {Promise<{ saved: number }>}
	 */
	function saveAll(sessionId) {
		let saved = 0;
		for (const entry of tabs.values()) {
			if (entry.registration.sessionId !== sessionId) continue;
			const machineState = entry.registration.controller.getState();
			if (machineState.phase !== 'ready' && machineState.phase !== 'saving') continue;
			if (!machineState.dirty) continue;
			entry.handle.save();
			saved++;
		}
		return Promise.resolve({ saved });
	}

	/**
	 * Convenience navigation entry (spec §4.5): forwards to
	 * `openInSidebar(address, { kind: 'editor', params: { file: { line } } })`.
	 * Never throws and never validates addresses — the navigation verdict is
	 * sidebar-right's domain.
	 */
	function open(address, opts) {
		try {
			const openOpts = { kind: 'editor' };
			if (opts && typeof opts.line === 'number' && Number.isFinite(opts.line)) {
				openOpts.params = { file: { line: opts.line } };
			}
			deps.openInSidebar(address, openOpts);
		} catch {
			// open() never throws on the consumer surface
		}
	}

	/** Live handle for a registered tabKey (internal; wiring helper). */
	function _resolveHandleFor(tabKey) {
		return tabs.get(tabKey)?.handle;
	}

	return {
		version: deps.version,
		active: publicView(activeStore),
		open,
		registerTab,
		unregisterTab,
		saveAll,
		modeRegistryProxy: {
			entries: () => deps.modeRegistry.entries(),
			subscribe: (fn) => deps.modeRegistry.subscribe(fn),
		},
		_resolveHandleFor,
	};
}
