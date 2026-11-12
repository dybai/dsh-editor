import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore } from './draft-store.js';

const KEY = 'dsh-editor.draft';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 注入用 memory storage；`backing` 暴露给断言检查落盘内容。 */
function memoryStorage() {
  const backing = new Map();
  return {
    backing,
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { backing.set(k, v); },
    removeItem: (k) => { backing.delete(k); },
  };
}

test('set/get roundtrip with debounce flush', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage, () => 1000, 20);
  store.set('s1', 'file:///a.txt', 'hello', 7);
  assert.deepEqual(store.get('s1', 'file:///a.txt'), { text: 'hello', baseVersion: 7, savedAt: 1000 });
  store.flush();
  const reopened = createDraftStore(storage, () => 1000, 20); // 新实例从同一 storage 读回
  assert.deepEqual(reopened.get('s1', 'file:///a.txt'), { text: 'hello', baseVersion: 7, savedAt: 1000 });
});
test('set coalesces rapid writes within debounce window', async () => {
  const storage = memoryStorage();
  let writes = 0;
  const setItem = storage.setItem;
  storage.setItem = (k, v) => { writes += 1; setItem(k, v); };
  const clock = { now: 1_000_000 };
  const store = createDraftStore(storage, () => clock.now, 20);
  store.set('s', 'a', 'one', 1);
  clock.now += 10;
  store.set('s', 'a', 'two', 2);
  clock.now += 10;
  store.set('s', 'a', 'three', 3);
  assert.equal(writes, 0); // 窗口内不落盘
  await sleep(100); // fake now 推进断言只写一次
  assert.equal(writes, 1);
  const stored = JSON.parse(storage.backing.get(KEY));
  assert.deepEqual(stored['s|a'], { text: 'three', baseVersion: 3, savedAt: 1_000_020 }); // 只保留最后一次
});
test('prune drops entries older than 14 days and beyond 50 most-recent', () => {
  const storage = memoryStorage();
  const T = 20 * DAY;
  const clock = { now: T - HOUR };
  const store = createDraftStore(storage, () => clock.now, 20);
  for (let i = 0; i < 45; i++) store.set('s', `fresh-${i}`, `f${i}`, i);
  clock.now = T - 13 * DAY; // 旧但未过期（age 13d - i ms）
  for (let i = 0; i < 10; i++) { store.set('s', `old-${i}`, `o${i}`, i); clock.now += 1; }
  clock.now = T - 14 * DAY; // 恰好 14 天 → 过期
  store.set('s', 'boundary', 'b', 0);
  clock.now = T - 15 * DAY;
  for (let i = 0; i < 5; i++) { store.set('s', `expired-${i}`, `e${i}`, i); clock.now += 1; }
  store.flush();
  const reopened = createDraftStore(storage, () => T, 20);
  reopened.prune();
  assert.equal(reopened.get('s', 'expired-0'), undefined);
  assert.equal(reopened.get('s', 'boundary'), undefined); // 恰好 14 天也过期
  for (let i = 0; i < 5; i++) assert.equal(reopened.get('s', `old-${i}`), undefined); // LRU 裁掉最旧
  for (let i = 5; i < 10; i++) assert.equal(reopened.get('s', `old-${i}`)?.text, `o${i}`);
  for (let i = 0; i < 45; i++) assert.equal(reopened.get('s', `fresh-${i}`)?.text, `f${i}`);
  assert.equal(Object.keys(JSON.parse(storage.backing.get(KEY))).length, 50); // prune 结果落盘
});
test('clear removes single entry', async () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage, () => 1000, 20);
  store.set('s1', 'a', 'one', 1);
  store.set('s1', 'b', 'two', 2);
  store.flush();
  store.clear('s1', 'a');
  assert.equal(store.get('s1', 'a'), undefined);
  assert.equal(store.get('s1', 'b')?.text, 'two'); // 只清除目标条目
  await sleep(80); // 删除随 debounce 落盘
  const reopened = createDraftStore(storage, () => 1000, 20);
  assert.equal(reopened.get('s1', 'a'), undefined);
  assert.equal(reopened.get('s1', 'b')?.text, 'two');
});
test('storage failure degrades silently', () => {
  const storage = memoryStorage();
  let failing = true;
  const setItem = storage.setItem;
  storage.setItem = (k, v) => { // setItem 抛错 → 不抛出
    if (failing) throw new Error('QuotaExceededError');
    setItem(k, v);
  };
  const store = createDraftStore(storage, () => 1000, 20);
  store.set('s', 'a', 'hello', 7);
  store.flush();
  assert.deepEqual(store.get('s', 'a'), { text: 'hello', baseVersion: 7, savedAt: 1000 }); // 内存态保留
  failing = false; // 配额释放
  store.flush(); // 下一次成功写入修复持久化
  const stored = JSON.parse(storage.backing.get(KEY));
  assert.deepEqual(stored['s|a'], { text: 'hello', baseVersion: 7, savedAt: 1000 });
});
test('flush persists immediately and cancels the pending timer', async () => {
  const storage = memoryStorage();
  let writes = 0;
  const setItem = storage.setItem;
  storage.setItem = (k, v) => { writes += 1; setItem(k, v); };
  const store = createDraftStore(storage, () => 1000, 20);
  store.set('s', 'a', 'hello', 1);
  store.flush();
  assert.equal(writes, 1); // 立即落盘
  await sleep(80);
  assert.equal(writes, 1); // 原 timer 已取消，不再补写
  assert.equal(JSON.parse(storage.backing.get(KEY))['s|a'].text, 'hello');
});
test('removing the last entry drops the storage key', async () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage, () => 1000, 20);
  store.set('s', 'a', 'one', 1);
  store.flush();
  store.clear('s', 'a');
  await sleep(80);
  assert.equal(storage.backing.has(KEY), false); // 空 map → removeItem 而非 '{}'
});
test('get returns undefined for unknown keys', () => {
  const store = createDraftStore(memoryStorage(), () => 1000, 20);
  assert.equal(store.get('s', 'missing'), undefined);
  assert.equal(store.get('', ''), undefined);
});
test('corrupt stored payload is treated as empty and repaired on next write', () => {
  const storage = memoryStorage();
  storage.backing.set(KEY, '{oops');
  const store = createDraftStore(storage, () => 1000, 20);
  assert.equal(store.get('s', 'a'), undefined); // 坏数据不抛出、视为空
  store.set('s', 'a', 'new', 1);
  store.flush();
  const stored = JSON.parse(storage.backing.get(KEY)); // 有效写入覆盖坏数据
  assert.deepEqual(stored['s|a'], { text: 'new', baseVersion: 1, savedAt: 1000 });
});
