import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefsBus } from './prefs-bus.js';

/** A programmable BroadcastChannel fake: records every postMessage, and
 * `fire(data)` plays the message event another window would receive. */
function makeFakeChannel() {
	const posted = [];
	const channel = {
		posted,
		onmessage: null,
		closed: false,
		postMessage(message) {
			posted.push(message);
		},
		close() {
			channel.closed = true;
		}
	};
	channel.fire = (data) => {
		if (typeof channel.onmessage === 'function') channel.onmessage({ data });
	};
	return channel;
}

/** A localStorage fake: records setItem writes; `simulateExternalWrite(key,
 * newValue)` plays the storage event another window would receive (the real
 * browser never fires storage back into the writing page, so neither does
 * the fake). */
function makeFakeStorage() {
	const writes = [];
	const storage = {
		writes,
		onstorage: null,
		getItem(key) {
			for (let i = writes.length - 1; i >= 0; i--) {
				if (writes[i][0] === key) return writes[i][1];
			}
			return null;
		},
		setItem(key, value) {
			writes.push([key, value]);
		}
	};
	storage.simulateExternalWrite = (key, newValue) => {
		if (typeof storage.onstorage === 'function') storage.onstorage({ key, newValue });
	};
	return storage;
}

/** A recorder pairing a handler with its received store names. */
function makeRecorder() {
	const calls = [];
	const handler = (store) => {
		calls.push(store);
	};
	return { calls, handler };
}

test('notify posts on the channel and writes the storage key', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	let requestedName = null;
	const bus = createPrefsBus({
		broadcastFactory: (name) => {
			requestedName = name;
			return channel;
		},
		storage
	});

	// the default channel name reaches the factory
	assert.equal(requestedName, 'dsh-editor-prefs');

	bus.notify('appearance');
	assert.deepEqual(channel.posted, [{ store: 'appearance' }]);
	assert.deepEqual(storage.writes, [['dsh-editor-prefs-notify', '1:appearance']]);

	// the fallback value must change on every write, so the sequence grows
	bus.notify('behavior');
	assert.deepEqual(channel.posted, [{ store: 'appearance' }, { store: 'behavior' }]);
	assert.deepEqual(storage.writes, [
		['dsh-editor-prefs-notify', '1:appearance'],
		['dsh-editor-prefs-notify', '2:behavior']
	]);
});

test('deps override the channel name and the storage key', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	let requestedName = null;
	const bus = createPrefsBus({
		channelName: 'custom-prefs',
		storageKey: 'custom-notify',
		broadcastFactory: (name) => {
			requestedName = name;
			return channel;
		},
		storage
	});
	bus.notify('wrap');
	assert.equal(requestedName, 'custom-prefs');
	assert.deepEqual(storage.writes, [['custom-notify', '1:wrap']]);
});

test('subscribe handlers fire from both sources with the store name', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	const bus = createPrefsBus({ broadcastFactory: () => channel, storage });
	const first = makeRecorder();
	const second = makeRecorder();
	bus.subscribe(first.handler);
	bus.subscribe(second.handler);

	// the BroadcastChannel source
	channel.fire({ store: 'appearance' });
	assert.deepEqual(first.calls, ['appearance']);
	assert.deepEqual(second.calls, ['appearance']);

	// the storage source: '<seq>:<store>' carries the store after the colon
	storage.simulateExternalWrite('dsh-editor-prefs-notify', '7:behavior');
	assert.deepEqual(first.calls, ['appearance', 'behavior']);
	assert.deepEqual(second.calls, ['appearance', 'behavior']);

	// a foreign storage key is ignored
	storage.simulateExternalWrite('other-key', '8:keymap');
	assert.deepEqual(first.calls, ['appearance', 'behavior']);
	assert.deepEqual(second.calls, ['appearance', 'behavior']);
});

test('subscribing the same handler reference twice registers it twice', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	const bus = createPrefsBus({ broadcastFactory: () => channel, storage });
	const calls = [];
	const handler = (store) => {
		calls.push(store);
	};
	const unsubA = bus.subscribe(handler);
	const unsubB = bus.subscribe(handler);

	// each subscribe is its own registration: the same reference counts twice
	channel.fire({ store: 'appearance' });
	assert.deepEqual(calls, ['appearance', 'appearance']);

	// one unsub removes exactly its own registration
	unsubA();
	channel.fire({ store: 'behavior' });
	assert.deepEqual(calls, ['appearance', 'appearance', 'behavior']);

	// the other unsub removes the last one
	unsubB();
	channel.fire({ store: 'wrap' });
	assert.deepEqual(calls, ['appearance', 'appearance', 'behavior']);
});

test('malformed messages and non-string stores are dropped silently', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	const bus = createPrefsBus({ broadcastFactory: () => channel, storage });
	const rec = makeRecorder();
	bus.subscribe(rec.handler);

	// notify only travels with a string store
	assert.doesNotThrow(() => bus.notify(42));
	assert.doesNotThrow(() => bus.notify(undefined));
	assert.deepEqual(channel.posted, []);
	assert.deepEqual(storage.writes, []);

	// malformed channel messages and storage values never deliver
	channel.fire(undefined);
	channel.fire(null);
	channel.fire('appearance');
	channel.fire({ store: 42 });
	channel.fire({});
	storage.simulateExternalWrite('dsh-editor-prefs-notify', 'no-separator');
	storage.simulateExternalWrite('dsh-editor-prefs-notify', null);
	storage.simulateExternalWrite(undefined, '3:appearance');
	assert.deepEqual(rec.calls, []);

	// well-formed traffic still delivers afterwards
	channel.fire({ store: 'appearance' });
	assert.deepEqual(rec.calls, ['appearance']);
});

test('an unavailable channel and storage degrade to silent no-ops', () => {
	// no channel and no storage at all (node has no window, so the default
	// storage resolves to null): notify is a silent no-op
	const noneBus = createPrefsBus({ broadcastFactory: () => null });
	assert.doesNotThrow(() => noneBus.notify('appearance'));
	assert.doesNotThrow(() => noneBus.dispose());

	// a throwing factory degrades to no channel; the storage path still works
	const storage = makeFakeStorage();
	const brokenFactoryBus = createPrefsBus({
		broadcastFactory: () => {
			throw new Error('no BroadcastChannel here');
		},
		storage
	});
	assert.doesNotThrow(() => brokenFactoryBus.notify('behavior'));
	assert.deepEqual(storage.writes, [['dsh-editor-prefs-notify', '1:behavior']]);

	// a port without postMessage is no channel at all
	const shapelessBus = createPrefsBus({ broadcastFactory: () => ({}), storage });
	assert.doesNotThrow(() => shapelessBus.notify('wrap'));
	assert.equal(shapelessBus !== null, true);

	// a channel without any storage still posts
	const channel = makeFakeChannel();
	const noStorageBus = createPrefsBus({ broadcastFactory: () => channel, storage: null });
	assert.doesNotThrow(() => noStorageBus.notify('keymap'));
	assert.deepEqual(channel.posted, [{ store: 'keymap' }]);
});

test('notify does not loop back to the local handlers', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	const bus = createPrefsBus({ broadcastFactory: () => channel, storage });
	const rec = makeRecorder();
	bus.subscribe(rec.handler);

	// the writing page already knows: neither channel nor storage echoes to it,
	// and the bus adds no local loopback of its own
	bus.notify('appearance');
	assert.deepEqual(rec.calls, []);
});

test('a throwing handler does not break the bus or other handlers', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	const bus = createPrefsBus({ broadcastFactory: () => channel, storage });
	const rec = makeRecorder();
	bus.subscribe(() => {
		throw new Error('handler exploded');
	});
	bus.subscribe(rec.handler);

	// both sources deliver past the broken handler
	channel.fire({ store: 'appearance' });
	assert.deepEqual(rec.calls, ['appearance']);
	storage.simulateExternalWrite('dsh-editor-prefs-notify', '2:behavior');
	assert.deepEqual(rec.calls, ['appearance', 'behavior']);

	// the bus still notifies afterwards (the seq counts only this bus's own writes)
	assert.doesNotThrow(() => bus.notify('wrap'));
	assert.deepEqual(channel.posted, [{ store: 'wrap' }]);
	assert.deepEqual(storage.writes, [['dsh-editor-prefs-notify', '1:wrap']]);
});

test('unsub and dispose stop delivery and stay safe', () => {
	const channel = makeFakeChannel();
	const storage = makeFakeStorage();
	const bus = createPrefsBus({ broadcastFactory: () => channel, storage });
	const first = makeRecorder();
	const second = makeRecorder();
	const unsubFirst = bus.subscribe(first.handler);
	bus.subscribe(second.handler);

	// unsub removes exactly its own handler and is idempotent
	unsubFirst();
	unsubFirst();
	channel.fire({ store: 'appearance' });
	assert.deepEqual(first.calls, []);
	assert.deepEqual(second.calls, ['appearance']);

	// dispose unbinds both sources: later events deliver to nobody
	bus.dispose();
	channel.fire({ store: 'behavior' });
	storage.simulateExternalWrite('dsh-editor-prefs-notify', '2:behavior');
	assert.deepEqual(second.calls, ['appearance']);

	// notify and subscribe after dispose are safe no-ops
	assert.doesNotThrow(() => bus.notify('wrap'));
	assert.deepEqual(channel.posted, []);
	assert.deepEqual(storage.writes, []);
	assert.equal(channel.closed, true);
	let lateCalled = false;
	const unsubLate = bus.subscribe(() => {
		lateCalled = true;
	});
	assert.doesNotThrow(() => unsubLate());
	assert.equal(lateCalled, false);

	// a second dispose is safe too
	assert.doesNotThrow(() => bus.dispose());
});
