import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViewStateStore, VIEW_STATE_STORAGE_KEY } from './view-state-store.js';

const KEY = VIEW_STATE_STORAGE_KEY;
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function memoryStorage() {
  const backing = new Map();
  return {
    backing,
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { backing.set(k, v); },
    removeItem: (k) => { backing.delete(k); }
  };
}

const SEL = { start: { line: 2, column: 3 }, end: { line: 2, column: 3 } };

test('update/get roundtrip survives a new store instance after flush', () => {
  const storage = memoryStorage();
  const store = createViewStateStore(storage, () => 1000, 20);
  store.update('k', { selection: SEL, scrollTop: 40, scrollLeft: 2 });
  assert.deepEqual(store.get('k'), { selection: SEL, scrollTop: 40, scrollLeft: 2, savedAt: 1000 });
  store.flush();
  const reopened = createViewStateStore(storage, () => 1000, 20);
  assert.deepEqual(reopened.get('k'), { selection: SEL, scrollTop: 40, scrollLeft: 2, savedAt: 1000 });
});

test('update merges partial patches and refreshes savedAt', () => {
  const clock = { now: 1000 };
  const store = createViewStateStore(memoryStorage(), () => clock.now, 20);
  store.update('k', { selection: SEL });
  clock.now = 2000;
  store.update('k', { scrollTop: 77, scrollLeft: 3 });
  assert.deepEqual(store.get('k'), { selection: SEL, scrollTop: 77, scrollLeft: 3, savedAt: 2000 });
});

test('an invalid patch is ignored as a whole', () => {
  const store = createViewStateStore(memoryStorage(), () => 1000, 20);
  store.update('k', { scrollTop: 1, scrollLeft: 2 });
  store.update('k', { scrollTop: -1, scrollLeft: 9 });
  store.update('k', { selection: { start: { line: 0, column: 1 }, end: { line: 1, column: 1 } } });
  assert.deepEqual(store.get('k'), { selection: null, scrollTop: 1, scrollLeft: 2, savedAt: 1000 });
});

test('rapid updates coalesce into one debounced write', async () => {
  const storage = memoryStorage();
  let writes = 0;
  const setItem = storage.setItem;
  storage.setItem = (k, v) => { writes += 1; setItem(k, v); };
  const store = createViewStateStore(storage, () => 1000, 20);
  store.update('k', { scrollTop: 1, scrollLeft: 0 });
  store.update('k', { scrollTop: 2, scrollLeft: 0 });
  assert.equal(writes, 0);
  await sleep(100);
  assert.equal(writes, 1);
  assert.equal(JSON.parse(storage.backing.get(KEY)).k.scrollTop, 2);
});

test('corrupt JSON and invalid entries are ignored', () => {
  const storage = memoryStorage();
  storage.backing.set(KEY, '{not json');
  assert.equal(createViewStateStore(storage, () => 1000, 20).get('k'), undefined);

  storage.backing.set(KEY, JSON.stringify({
    good: { selection: null, scrollTop: 1, scrollLeft: 0, savedAt: 1000 },
    bad: { selection: null, scrollTop: -1, scrollLeft: 0, savedAt: 1000 }
  }));
  const store = createViewStateStore(storage, () => 1000, 20);
  assert.equal(store.get('bad'), undefined);
  assert.deepEqual(store.get('good'), { selection: null, scrollTop: 1, scrollLeft: 0, savedAt: 1000 });
});

test('prune drops entries at or beyond 90 days and keeps the boundary', () => {
  const storage = memoryStorage();
  const clock = { now: 100 * DAY };
  const store = createViewStateStore(storage, () => clock.now, 20);
  store.update('fresh', { scrollTop: 1, scrollLeft: 0 });
  clock.now = 10 * DAY;
  store.update('expired', { scrollTop: 1, scrollLeft: 0 });
  clock.now = 10 * DAY + 1;
  store.update('boundary', { scrollTop: 1, scrollLeft: 0 });
  clock.now = 100 * DAY;
  store.prune();
  assert.equal(store.get('expired'), undefined);
  assert.ok(store.get('boundary'));
  assert.ok(store.get('fresh'));
});

test('prune keeps only the 200 most recent entries', () => {
  const storage = memoryStorage();
  const clock = { now: 1_000_000 };
  const store = createViewStateStore(storage, () => clock.now, 20);
  for (let i = 0; i < 205; i++) { clock.now = 1_000_000 + i; store.update(`k${i}`, { scrollTop: i, scrollLeft: 0 }); }
  clock.now = 2_000_000;
  store.prune();
  for (let i = 0; i < 5; i++) assert.equal(store.get(`k${i}`), undefined);
  for (let i = 5; i < 205; i++) assert.ok(store.get(`k${i}`));
  assert.equal(Object.keys(JSON.parse(storage.backing.get(KEY))).length, 200);
});

test('an empty map removes the storage key', () => {
  const storage = memoryStorage();
  const clock = { now: 1_000_000 };
  const store = createViewStateStore(storage, () => clock.now, 20);
  store.update('k', { scrollTop: 1, scrollLeft: 0 });
  store.flush();
  assert.ok(storage.backing.has(KEY));
  clock.now += 91 * DAY;
  store.prune();
  assert.equal(storage.backing.has(KEY), false);
});

test('storage failures never throw and never lose the in-memory state', () => {
  const storage = {
    getItem() { throw new Error('read denied'); },
    setItem() { throw new Error('write denied'); },
    removeItem() { throw new Error('remove denied'); }
  };
  const store = createViewStateStore(storage, () => 1000, 20);
  assert.doesNotThrow(() => store.update('k', { scrollTop: 1, scrollLeft: 0 }));
  assert.deepEqual(store.get('k'), { selection: null, scrollTop: 1, scrollLeft: 0, savedAt: 1000 });
  assert.doesNotThrow(() => store.flush());
  assert.doesNotThrow(() => store.prune());
});

test('get returns a copy and bad arguments are ignored', () => {
  const store = createViewStateStore(memoryStorage(), () => 1000, 20);
  store.update('k', { scrollTop: 1, scrollLeft: 0 });
  const got = store.get('k');
  got.scrollTop = 999;
  assert.equal(store.get('k').scrollTop, 1);
  assert.doesNotThrow(() => store.update(null, null));
  assert.equal(store.get(42), undefined);
});
