/**
 * Cross-window preference notification bus — the tiny pub/sub that lets every
 * plugin window learn that a preference changed somewhere else, so each one
 * refetches it from the Host, which is the source of truth.
 *
 * Why a bus: the plugin can run in several same-origin windows at once, all
 * sharing one Host-backed preference store. There is no registry between
 * windows, so a window that changes a preference must announce it and every
 * other window must hear it. The announcement carries no payload — only the
 * changed store's name — because a receiving window never trusts a
 * second-hand value: it refetches from the Host.
 *
 * Two best-effort delivery channels, either one alone is enough:
 *
 * - BroadcastChannel (primary): `postMessage({ store })` reaches every
 *   same-origin listener in the OTHER windows.
 * - localStorage (fallback): `setItem(storageKey, '<seq>:<store>')` fires a
 *   `storage` event in the other same-origin windows — never in the writing
 *   one — and a `storage` event only fires when the value actually changes,
 *   which is why the sequence number increments on every write.
 *
 * By the platform's event model neither channel echoes into the writing
 * page, and the bus adds no local loopback of its own: a window that called
 * `notify` already knows, so its own `subscribe` handlers stay silent.
 *
 * Everything platform-shaped arrives through injected ports, so the module
 * runs under `node --test` with no browser:
 *
 * - `broadcastFactory(name)` → a channel port `{ postMessage(msg) }` or
 *   null (default: `new BroadcastChannel(name)`, any failure → null).
 * - `storage` → `{ getItem(k) → string | null, setItem(k, v) }` or null
 *   (default: `window.localStorage`, unavailable → null). Storage events
 *   are received from the injected port itself (`addEventListener` when the
 *   port is an EventTarget, otherwise the `onstorage` property); with the
 *   default `window.localStorage` they are received from `window`, which is
 *   where the browser fires storage events.
 *
 * Never-throw: broken ports, throwing handlers, malformed messages and
 * non-string stores all degrade to silence — nothing propagates out of the
 * bus, and `dispose` makes it permanently inert while staying safe to call.
 *
 * Zero imports: every platform touchpoint is injected or guarded.
 *
 * @module @dybai/dsh-editor/prefs-bus
 */

/** The default BroadcastChannel name (fixed value, 0.11.0). */
const DEFAULT_CHANNEL_NAME = 'dsh-editor-prefs';

/** The default localStorage fallback key (fixed value, 0.11.0). */
const DEFAULT_STORAGE_KEY = 'dsh-editor-prefs-notify';

/**
 * The default channel factory: a real BroadcastChannel, or null anywhere it
 * does not exist or cannot be constructed.
 * @param {string} name - the channel name.
 * @returns {object | null} the channel port, or null.
 */
function defaultBroadcastFactory(name) {
	if (typeof BroadcastChannel !== 'function') return null;
	try {
		return new BroadcastChannel(name);
	} catch {
		return null;
	}
}

/**
 * The default storage: `window.localStorage` when present and writable.
 * Guarded so the module also loads (and degrades to null) where no window
 * exists, and where privacy settings make merely touching localStorage
 * throw.
 * @returns {object | null} the storage port, or null.
 */
function defaultStorage() {
	try {
		if (typeof window === 'undefined' || window === null) return null;
		const ls = window.localStorage;
		if (ls === null || typeof ls !== 'object' || typeof ls.setItem !== 'function') return null;
		return ls;
	} catch {
		return null;
	}
}

/**
 * Create a cross-window preference notification bus.
 *
 * The returned bus is a single per-window adapter: `notify` announces a
 * changed store to the other windows, `subscribe` registers a local handler
 * for announcements made elsewhere, and `dispose` unbinds everything. Every
 * method is safe to call in any state — nothing ever throws.
 *
 * @param {object} [deps] - all optional ports and knobs.
 * @param {string} [deps.channelName] - BroadcastChannel name
 *   (default `'dsh-editor-prefs'`).
 * @param {Function} [deps.broadcastFactory] - `name` → channel port
 *   `{ postMessage(msg) }` or null (default: a real BroadcastChannel).
 * @param {object} [deps.storage] - `{ getItem(k), setItem(k, v) }` or null
 *   (default: `window.localStorage`, unavailable → null).
 * @param {string} [deps.storageKey] - the localStorage fallback key
 *   (default `'dsh-editor-prefs-notify'`).
 * @returns {object} the bus — `notify`, `subscribe`, `dispose`.
 */
export function createPrefsBus(deps) {
	const options = deps !== null && typeof deps === 'object' ? deps : {};
	const channelName = typeof options.channelName === 'string' && options.channelName !== '' ? options.channelName : DEFAULT_CHANNEL_NAME;
	const storageKey = typeof options.storageKey === 'string' && options.storageKey !== '' ? options.storageKey : DEFAULT_STORAGE_KEY;

	// Resolve the channel port: the injected factory wins; a throwing or
	// shapeless factory degrades to no channel.
	let channel = null;
	if (typeof options.broadcastFactory === 'function') {
		try {
			channel = options.broadcastFactory(channelName);
		} catch {
			channel = null;
		}
	} else {
		channel = defaultBroadcastFactory(channelName);
	}
	if (channel === null || typeof channel !== 'object' || typeof channel.postMessage !== 'function') channel = null;

	// Resolve the storage port: the injected storage wins; otherwise the
	// window default. Without a writable setItem there is no storage path.
	const injectedStorage =
		options.storage !== null && typeof options.storage === 'object' && typeof options.storage.setItem === 'function'
			? options.storage
			: null;
	let storage = injectedStorage !== null ? injectedStorage : defaultStorage();

	// One record per `subscribe` call — an array of wrappers, not a Set of
	// handlers — so repeating the same handler reference yields independent
	// registrations that each unsub removes individually.
	const registrations = [];
	let seq = 0;
	let disposed = false;
	let detachChannelEvents = null;
	let detachStorageEvents = null;

	/**
	 * Fan one delivered store name out to every handler. Each handler is
	 * isolated: a throwing one is skipped, the others still fire, and the
	 * snapshot survives handlers subscribing or unsubscribing mid-delivery.
	 * @param {any} store - the changed store's name.
	 */
	function deliver(store) {
		if (disposed || typeof store !== 'string') return;
		const snapshot = registrations.slice();
		for (const record of snapshot) {
			try {
				record.handler(store);
			} catch {
				// one broken handler must not starve the rest or leak out
			}
		}
	}

	/**
	 * The BroadcastChannel message listener: only `{ store: <string> }`
	 * messages carry an announcement; anything else is dropped.
	 * @param {any} event - the message event (`event.data`).
	 */
	function onChannelMessage(event) {
		if (disposed || event === null || typeof event !== 'object') return;
		const data = event.data;
		if (data === null || typeof data !== 'object') return;
		deliver(data.store);
	}

	/**
	 * The storage-event listener: only the bus's own key counts, and the
	 * store name is whatever follows the `<seq>:` separator. Cleared,
	 * non-string or separator-less values are dropped.
	 * @param {any} event - the storage event (`{ key, newValue }`).
	 */
	function onStorageEvent(event) {
		if (disposed || event === null || typeof event !== 'object') return;
		if (event.key !== storageKey) return;
		const newValue = event.newValue;
		if (typeof newValue !== 'string') return;
		const separator = newValue.indexOf(':');
		if (separator < 0) return;
		deliver(newValue.slice(separator + 1));
	}

	/**
	 * Hook the channel's message events: `addEventListener` when the port is
	 * an EventTarget, otherwise the `onmessage` property (real channels and
	 * fakes alike).
	 */
	function attachChannelEvents() {
		if (channel === null) return;
		const port = channel;
		const listener = onChannelMessage;
		if (typeof port.addEventListener === 'function') {
			try {
				port.addEventListener('message', listener);
				detachChannelEvents = () => {
					try {
						port.removeEventListener('message', listener);
					} catch {
						// the port is already gone
					}
				};
				return;
			} catch {
				// fall through to the onmessage property
			}
		}
		port.onmessage = listener;
		detachChannelEvents = () => {
			port.onmessage = null;
		};
	}

	/**
	 * Hook the storage events. An injected port delivers through itself
	 * (`addEventListener('storage')` or the `onstorage` property); the
	 * default `window.localStorage` delivers through `window`, where the
	 * browser fires storage events. Without either, the storage source
	 * simply never fires.
	 */
	function attachStorageEvents() {
		if (storage === null) return;
		const port = storage;
		const listener = onStorageEvent;
		if (injectedStorage !== null) {
			if (typeof port.addEventListener === 'function') {
				try {
					port.addEventListener('storage', listener);
					detachStorageEvents = () => {
						try {
							port.removeEventListener('storage', listener);
						} catch {
							// the port is already gone
						}
					};
					return;
				} catch {
					// fall through to the onstorage property
				}
			}
			port.onstorage = listener;
			detachStorageEvents = () => {
				port.onstorage = null;
			};
			return;
		}
		if (typeof window === 'undefined' || window === null || typeof window.addEventListener !== 'function') return;
		window.addEventListener('storage', listener);
		detachStorageEvents = () => {
			try {
				window.removeEventListener('storage', listener);
			} catch {
				// the window is already gone
			}
		};
	}

	/**
	 * Announce a changed store to the OTHER windows: posted as
	 * `{ store }` on the channel when there is one, and written to the
	 * storage key as `'<seq>:<store>'` when there is one. The sequence
	 * number increments on every write so the value always changes — a
	 * `storage` event fires in the other windows only then. Neither channel
	 * echoes back into this window, and the bus adds no local loopback: the
	 * writing window's own handlers stay silent. With both channels
	 * unavailable, or for a non-string store, this is a silent no-op.
	 * @param {string} store - the changed store's name.
	 */
	function notify(store) {
		if (disposed || typeof store !== 'string') return;
		if (channel !== null) {
			try {
				channel.postMessage({ store });
			} catch {
				// a broken channel stays silent; the storage path still runs
			}
		}
		if (storage !== null) {
			seq += 1;
			try {
				storage.setItem(storageKey, seq + ':' + store);
			} catch {
				// a broken storage stays silent
			}
		}
	}

	/**
	 * Register a handler for announcements made in OTHER windows — it
	 * receives the changed store's name and is expected to refetch that
	 * store from the Host. Every call is its own registration: subscribing
	 * twice — even with the same handler reference — delivers twice, and
	 * each call returns its own independent unsub that removes exactly its
	 * own registration.
	 * @param {Function} handler - `(store: string)` → void.
	 * @returns {Function} `unsub()` — idempotent; after `dispose` the
	 *   handler is never registered and the unsub is a safe no-op.
	 */
	function subscribe(handler) {
		if (disposed || typeof handler !== 'function') return function unsub() {};
		const record = { handler };
		registrations.push(record);
		let active = true;
		return function unsub() {
			if (!active) return;
			active = false;
			const at = registrations.indexOf(record);
			if (at >= 0) registrations.splice(at, 1);
		};
	}

	/**
	 * Unbind everything: both event sources, the channel itself (closed
	 * when the port supports it), and every handler. Afterwards `notify`
	 * and `subscribe` are safe no-ops, delivery from late platform events
	 * stops, and calling `dispose` again does nothing.
	 */
	function dispose() {
		if (disposed) return;
		disposed = true;
		if (detachChannelEvents !== null) {
			const detach = detachChannelEvents;
			detachChannelEvents = null;
			try {
				detach();
			} catch {
				// the source is already gone
			}
		}
		if (channel !== null && typeof channel.close === 'function') {
			try {
				channel.close();
			} catch {
				// the channel is already closed
			}
		}
		channel = null;
		if (detachStorageEvents !== null) {
			const detach = detachStorageEvents;
			detachStorageEvents = null;
			try {
				detach();
			} catch {
				// the source is already gone
			}
		}
		storage = null;
		registrations.length = 0;
	}

	attachChannelEvents();
	attachStorageEvents();
	return { notify, subscribe, dispose };
}
