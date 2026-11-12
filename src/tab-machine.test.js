import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabController } from './tab-machine.js';
import { createDraftStore } from './draft-store.js';

const ADDRESS = 'dsh-resource://file/session/s1/docs/a.txt';
const SESSION = 's1';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 注入用 memory storage（真实 draft-store 落盘断言用）。 */
function memoryStorage() {
  const backing = new Map();
  return {
    backing,
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { backing.set(k, v); },
    removeItem: (k) => { backing.delete(k); },
  };
}

/** 记录调用的 draftStore 替身：机器只允许调 get/set/clear。 */
function fakeDraftStore() {
  const entries = new Map();
  const calls = { get: [], set: [], clear: [] };
  const key = (s, a) => `${s}|${a}`;
  return {
    calls,
    seed(sessionId, address, entry) { entries.set(key(sessionId, address), entry); },
    get: (s, a) => { calls.get.push([s, a]); const e = entries.get(key(s, a)); return e ? { ...e } : undefined; },
    set: (s, a, text, baseVersion) => { calls.set.push([s, a, text, baseVersion]); entries.set(key(s, a), { text, baseVersion, savedAt: 0 }); },
    clear: (s, a) => { calls.clear.push([s, a]); entries.delete(key(s, a)); },
  };
}

/** 默认线束：可控 load/write deferred + 记录发布的快照。 */
function makeHarness(depsOverride = {}) {
  const loads = [];
  const writes = [];
  const draftStore = fakeDraftStore();
  const controller = createTabController({
    address: ADDRESS,
    sessionId: SESSION,
    load: () => { const d = deferred(); loads.push(d); return d.promise; },
    write: (content, baseVersion) => { const d = deferred(); writes.push({ content, baseVersion, ...d }); return d.promise; },
    draftStore,
    isForeground: () => true,
    now: () => 0,
    ...depsOverride,
  });
  const published = [];
  controller.subscribe((snapshot) => published.push(snapshot));
  return { controller, loads, writes, draftStore, published };
}

/** 常用前置：首轮加载到 ready。 */
async function ready(h, text = 'a', version = 'v1') {
  h.loads[0].resolve({ text, version });
  await flush();
}

// ---- 12 个必测场景（task brief 原文） ----

test('load success publishes ready with text and version', async () => {
  const h = makeHarness();
  const initial = h.controller.getState();
  assert.equal(initial.phase, 'loading');
  assert.equal(initial.text, '');
  assert.equal(initial.dirty, false);
  assert.equal(initial.failure, null);
  assert.equal(h.controller.getState(), initial); // 引用稳定：无变更不换快照
  await ready(h, 'hello\nworld', 'v1');
  const state = h.controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.text, 'hello\nworld');
  assert.equal(state.draft, 'hello\nworld');
  assert.equal(state.version, 'v1');
  assert.equal(state.dirty, false);
  assert.equal(state.conflict, false);
  assert.equal(state.saving, false);
  assert.equal(state.failure, null);
  assert.equal(h.published.length, 1); // 提交后发布一次（初始态不发布）
  assert.equal(h.published[0], state); // 发布的就是 getState() 同一引用
});

test('load rejects oversize with kind too-large and publishes failed', async () => {
  const h = makeHarness();
  h.loads[0].reject(Object.assign(new Error('file exceeds 4MiB limit'), { kind: 'too-large' }));
  await flush();
  const state = h.controller.getState();
  assert.equal(state.phase, 'failed');
  assert.deepEqual(state.failure, { kind: 'too-large', message: 'file exceeds 4MiB limit' });
  assert.equal(state.text, '');
  assert.equal(state.dirty, false);
});

test('load rejects invalid utf8 with kind not-text', async () => {
  const h = makeHarness();
  h.loads[0].reject(Object.assign(new Error('file is not valid utf-8'), { kind: 'not-text' }));
  await flush();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.deepEqual(h.controller.getState().failure, { kind: 'not-text', message: 'file is not valid utf-8' });
});

test('save success updates version and clears dirty', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('b');
  assert.equal(h.controller.getState().dirty, true);
  const p = h.controller.requestSave();
  assert.equal(h.writes.length, 1);
  assert.deepEqual([h.writes[0].content, h.writes[0].baseVersion], ['b', 'v1']);
  assert.equal(h.controller.getState().phase, 'saving');
  h.writes[0].resolve({ operation: 'update', version: 'v2' });
  assert.deepEqual(await p, { ok: true, value: { operation: 'update', version: 'v2' } });
  const state = h.controller.getState();
  assert.equal(state.version, 'v2');
  assert.equal(state.text, 'b');
  assert.equal(state.draft, 'b');
  assert.equal(state.dirty, false);
  assert.equal(state.saving, false);
  assert.equal(state.phase, 'ready');
  assert.deepEqual(h.draftStore.calls.clear, [[SESSION, ADDRESS]]); // 保存成功清草稿
});

test('stale write sets conflict without losing draft', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('mine');
  const p = h.controller.requestSave();
  h.writes[0].reject(Object.assign(new Error('file changed on disk'), { code: 'FS_STALE_VERSION' }));
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'stale');
  const state = h.controller.getState();
  assert.equal(state.conflict, true);
  assert.equal(state.draft, 'mine'); // 草稿不丢
  assert.equal(state.text, 'a');
  assert.equal(state.dirty, true);
  assert.equal(state.phase, 'ready');
  assert.equal(state.saving, false);
});

test('save during in-flight merges and follows up with fresh version', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('b');
  const p1 = h.controller.requestSave(); // write#1 in-flight: ('b','v1')
  h.controller.applyEdit('c');           // in-flight 期间再编辑
  const p2 = h.controller.requestSave(); // 只置 pending，不发第二个写
  assert.equal(h.writes.length, 1);
  h.writes[0].resolve({ operation: 'update', version: 'v2' });
  await flush();
  // 结算后自动补写：新 baseVersion=v2（非旧的 v1）、当前草稿 'c'
  assert.equal(h.writes.length, 2);
  assert.deepEqual([h.writes[1].content, h.writes[1].baseVersion], ['c', 'v2']);
  assert.equal(h.controller.getState().phase, 'saving');
  // 补写期间更新的草稿仍被持久化（崩溃安全），baseVersion 用结算后的新版本
  assert.deepEqual(h.draftStore.calls.set.at(-1), [SESSION, ADDRESS, 'c', 'v2']);
  h.writes[1].resolve({ operation: 'update', version: 'v3' });
  assert.equal((await p1).ok, true);
  assert.equal((await p2).ok, true);
  const state = h.controller.getState();
  assert.equal(state.version, 'v3');
  assert.equal(state.text, 'c');
  assert.equal(state.dirty, false);
  assert.equal(state.phase, 'ready');
});

test('force save writes with empty baseVersion', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('b');
  const p = h.controller.requestSave(true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].baseVersion, ''); // 无版本意图
  assert.equal(h.writes[0].content, 'b');
  h.writes[0].resolve({ operation: 'update', version: 'v2' });
  assert.equal((await p).ok, true);
  assert.equal(h.controller.getState().version, 'v2');
});

test('restoreDraft marks conflict when stored baseVersion differs from fresh read', async () => {
  const h = makeHarness();
  h.draftStore.seed(SESSION, ADDRESS, { text: 'recovered draft', baseVersion: 'v0', savedAt: 5 });
  await ready(h, 'fresh from disk', 'v1');
  const state = h.controller.getState();
  assert.equal(state.draft, 'recovered draft');
  assert.equal(state.dirty, true);
  assert.equal(state.conflict, true); // 文件已被外部修改
  assert.equal(state.text, 'fresh from disk');
  assert.equal(state.version, 'v1');
});

test('restoreDraft without version mismatch is dirty but not conflict', async () => {
  const h = makeHarness();
  h.draftStore.seed(SESSION, ADDRESS, { text: 'recovered draft', baseVersion: 'v1', savedAt: 5 });
  await ready(h, 'fresh from disk', 'v1');
  const state = h.controller.getState();
  assert.equal(state.draft, 'recovered draft');
  assert.equal(state.dirty, true);
  assert.equal(state.conflict, false);
});

test('close during saving keeps persisted draft', async () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage, () => 1000, 20);
  const load = deferred();
  const write = deferred();
  const controller = createTabController({
    address: ADDRESS,
    sessionId: SESSION,
    load: () => load.promise,
    write: () => write.promise,
    draftStore: store,
  });
  load.resolve({ text: 'base', version: 'v1' });
  await flush();
  controller.applyEdit('kept mid-flight');
  const p = controller.requestSave(); // in-flight，永不结算
  controller.destroy();               // tab 关闭：队列中止
  assert.deepEqual(await p, { ok: false, error: { kind: 'destroyed', message: 'controller destroyed' } });
  assert.deepEqual(store.get(SESSION, ADDRESS), { text: 'kept mid-flight', baseVersion: 'v1', savedAt: 1000 });
  write.resolve({ operation: 'update', version: 'v9' }); // 迟到的结算被丢弃
  await flush();
  const state = controller.getState();
  assert.equal(state.version, 'v1');
  assert.equal(state.text, 'base');
  assert.equal(state.draft, 'kept mid-flight');
  await sleep(100); // debounce 自行落盘；destroy 不取消草稿持久化
  const reopened = createDraftStore(storage, () => 2000, 20);
  assert.equal(reopened.get(SESSION, ADDRESS)?.text, 'kept mid-flight');
});

test('navigate before ready is delivered after ready', async () => {
  const h = makeHarness();
  const lines = [];
  h.controller.onNavigate((line) => { lines.push(line); return true; });
  assert.equal(h.controller.requestNavigate(3), true); // loading 挂起
  assert.equal(h.controller.requestNavigate(7), true); // 最新一次生效
  assert.deepEqual(lines, []);
  await ready(h, 'a\nb\nc', 'v1');
  assert.deepEqual(lines, [7]); // ready 后交付一次
  assert.equal(h.controller.requestNavigate(5), true);
  assert.deepEqual(lines, [7, 5]); // ready 即时交付
});

test('reload clears pending and conflict and reloads content', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  // 第一轮：stale → conflict
  h.controller.applyEdit('b');
  h.controller.requestSave();
  h.writes[0].reject(Object.assign(new Error('file changed on disk'), { code: 'FS_STALE_VERSION' }));
  await flush();
  assert.equal(h.controller.getState().conflict, true);
  // 第二轮：in-flight + pending
  h.controller.applyEdit('bb');
  const p1 = h.controller.requestSave(); // write#2 in-flight
  h.controller.applyEdit('bbb');
  const p2 = h.controller.requestSave(); // pending
  assert.equal(h.controller.requestReload(), true);
  const reloading = h.controller.getState();
  assert.equal(reloading.phase, 'loading');
  assert.equal(reloading.conflict, false); // 冲突清除
  assert.deepEqual(h.draftStore.calls.clear, [[SESSION, ADDRESS]]); // 草稿存储同步清除
  h.writes[1].resolve({ operation: 'update', version: 'v9' }); // 迟到结算丢弃
  await flush();
  assert.equal(h.writes.length, 2); // 不补写
  assert.equal(h.controller.getState().version, 'v1');
  assert.deepEqual(await p1, { ok: false, error: { kind: 'cancelled', message: 'reload' } });
  assert.deepEqual(await p2, { ok: false, error: { kind: 'cancelled', message: 'reload' } });
  h.loads[1].resolve({ text: 'fresh', version: 'v2' });
  await flush();
  const state = h.controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.text, 'fresh');
  assert.equal(state.draft, 'fresh'); // 草稿存储已清 → 不恢复
  assert.equal(state.version, 'v2');
  assert.equal(state.dirty, false);
  assert.equal(state.conflict, false);
});

// ---- 补充边界测试（自行引入的行为） ----

test('queued save without further edits resolves from the in-flight write', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('b');
  const p1 = h.controller.requestSave();
  const p2 = h.controller.requestSave(); // 无新编辑 → 只排队
  h.writes[0].resolve({ operation: 'update', version: 'v2' });
  assert.equal((await p1).ok, true);
  assert.deepEqual(await p2, { ok: true, value: { operation: 'update', version: 'v2' } });
  await flush();
  assert.equal(h.writes.length, 1); // 草稿未再变 → 无冗余补写
  assert.equal(h.controller.getState().dirty, false);
});

test('force save after stale conflict succeeds and clears conflict', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('mine');
  const stale = h.controller.requestSave();
  h.writes[0].reject(new Error('write rejected: stale base version')); // message 路径的 stale 检测
  await stale;
  assert.equal(h.controller.getState().conflict, true);
  h.controller.applyEdit('mine+more');
  const p = h.controller.requestSave(true);
  assert.equal(h.writes[1].baseVersion, '');
  h.writes[1].resolve({ operation: 'update', version: 'v5' });
  assert.equal((await p).ok, true);
  const state = h.controller.getState();
  assert.equal(state.conflict, false);
  assert.equal(state.version, 'v5');
  assert.equal(state.text, 'mine+more');
  assert.equal(state.dirty, false);
});

test('requestSave is rejected with an error envelope during loading and failed', async () => {
  const h = makeHarness();
  const duringLoad = await h.controller.requestSave();
  assert.deepEqual(duringLoad, { ok: false, error: { kind: 'not-ready', message: 'save rejected in loading phase' } });
  assert.equal(h.writes.length, 0);
  h.loads[0].reject(Object.assign(new Error('gone'), { kind: 'not-found' }));
  await flush();
  const duringFailed = await h.controller.requestSave();
  assert.equal(duringFailed.ok, false);
  assert.equal(duringFailed.error.kind, 'not-ready');
  assert.equal(h.writes.length, 0);
});

test('non-stale save failure records a lastError notice and returns to ready', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('b');
  const p = h.controller.requestSave();
  h.writes[0].reject(new Error('network down'));
  assert.deepEqual(await p, { ok: false, error: { kind: 'write-error', message: 'network down' } });
  const state = h.controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.saving, false);
  assert.equal(state.lastError, 'network down'); // 状态栏 notice
  assert.equal(state.conflict, false);
  assert.equal(state.draft, 'b'); // 草稿保留
  assert.equal(state.dirty, true);
});

test('abort during in-flight write discards the settle and stops the machine', async () => {
  const abort = new AbortController();
  const h = makeHarness({ signal: abort.signal });
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('b');
  const p = h.controller.requestSave();
  const publishedCount = h.published.length;
  abort.abort();
  assert.deepEqual(await p, { ok: false, error: { kind: 'destroyed', message: 'controller destroyed' } });
  assert.equal(h.published.length, publishedCount); // 中止后不再发布
  h.writes[0].resolve({ operation: 'update', version: 'v9' });
  await flush();
  const state = h.controller.getState();
  assert.equal(state.version, 'v1'); // 迟到结算被丢弃
  assert.equal(state.text, 'a');
  assert.equal(state.draft, 'b');
  assert.equal(h.writes.length, 1); // 不再发写
  assert.equal((await h.controller.requestSave()).error.kind, 'destroyed');
  assert.equal(h.controller.requestNavigate(1), false);
  h.controller.applyEdit('ignored'); // 中止后编辑被忽略（不再持久化草稿）
  const sets = h.draftStore.calls.set.length;
  h.controller.applyEdit('ignored-again');
  assert.equal(h.draftStore.calls.set.length, sets);
});

test('applyEdit persists every changed draft to the store', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  h.controller.applyEdit('x');
  h.controller.applyEdit('y');
  assert.deepEqual(h.draftStore.calls.set, [
    [SESSION, ADDRESS, 'x', 'v1'],
    [SESSION, ADDRESS, 'y', 'v1'],
  ]);
  const before = h.controller.getState();
  h.controller.applyEdit('y'); // 未变化：不提交、不重复持久化
  assert.equal(h.controller.getState(), before);
  assert.equal(h.draftStore.calls.set.length, 2);
});

test('snapshot reference is stable while nothing changes', async () => {
  const h = makeHarness();
  await ready(h, 'a', 'v1');
  const s1 = h.controller.getState();
  assert.equal(h.controller.getState(), s1);
  h.controller.applySelection({ start: 0, end: 1, lineStart: 1, lineEnd: 1, text: 'a' });
  const s2 = h.controller.getState();
  assert.notEqual(s2, s1);
  assert.equal(h.published.at(-1), s2); // 发布的就是最新快照
  h.controller.applySelection({ start: 0, end: 1, lineStart: 1, lineEnd: 1, text: 'a' }); // 同值
  assert.equal(h.controller.getState(), s2);
  const gone = h.controller.subscribe(() => { throw new Error('unsubscribed listener must not run'); });
  gone();
  h.controller.applyEdit('changed');
  assert.notEqual(h.controller.getState(), s2);
});

test('requestNavigate in failed phase returns false', async () => {
  const h = makeHarness();
  const lines = [];
  h.controller.onNavigate((line) => lines.push(line));
  h.loads[0].reject(Object.assign(new Error('gone'), { kind: 'not-found' }));
  await flush();
  assert.equal(h.controller.requestNavigate(1), false);
  assert.deepEqual(lines, []);
});

test('attachMode and detachMode publish the mode slice in any phase', async () => {
  const h = makeHarness();
  h.controller.attachMode('plain-text'); // loading 相位也允许
  assert.equal(h.controller.getState().modeId, 'plain-text');
  await ready(h, 'a', 'v1');
  assert.equal(h.controller.getState().modeId, 'plain-text'); // 模式切换保内容状态
  h.controller.detachMode();
  assert.equal(h.controller.getState().modeId, undefined);
  assert.equal(h.controller.getState().text, 'a'); // 内容状态不受模式切换影响
});

test('reload from failed phase retries the load', async () => {
  const h = makeHarness();
  h.loads[0].reject(Object.assign(new Error('gone'), { kind: 'not-found' }));
  await flush();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.controller.requestReload(), true);
  const reloading = h.controller.getState();
  assert.equal(reloading.phase, 'loading');
  assert.equal(reloading.failure, null);
  h.loads[1].resolve({ text: 'back', version: 'v1' });
  await flush();
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.controller.getState().text, 'back');
});

test('setContent applies content and selection together', async () => {
  const h = makeHarness();
  await ready(h, 'a\nb', 'v1');
  h.controller.setContent('a\nx', { start: 2, end: 2, lineStart: 2, lineEnd: 2, text: '' });
  const state = h.controller.getState();
  assert.equal(state.draft, 'a\nx');
  assert.equal(state.dirty, true);
  assert.deepEqual(state.selection, { start: 2, end: 2, lineStart: 2, lineEnd: 2, text: '' });
  assert.deepEqual(h.draftStore.calls.set.at(-1), [SESSION, ADDRESS, 'a\nx', 'v1']);
});
