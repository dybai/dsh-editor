import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditorService } from './service.js';
import { createTabController } from './tab-machine.js';

const ADDRESS_A = 'dsh-resource://file/session/s1/docs/a.txt';
const ADDRESS_B = 'dsh-resource://file/session/s1/docs/b.txt';
const ADDRESS_C = 'dsh-resource://file/session/s2/docs/c.txt';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

/** 记录调用的 draftStore 替身：机器只允许调 get/set/clear（沿用 tab-machine.test.js 模式）。 */
function fakeDraftStore() {
	const entries = new Map();
	const key = (s, a) => `${s}|${a}`;
	return {
		seed(sessionId, address, entry) { entries.set(key(sessionId, address), entry); },
		get: (s, a) => { const e = entries.get(key(s, a)); return e ? { ...e } : undefined; },
		set: (s, a, text, baseVersion) => { entries.set(key(s, a), { text, baseVersion, savedAt: 0 }); },
		clear: (s, a) => { entries.delete(key(s, a)); },
	};
}

/** 真实 createTabController + 可控 load/write deferred（真实机器，假传输）。 */
function makeTab(address, sessionId = 's1') {
	const loads = [];
	const writes = [];
	const controller = createTabController({
		address,
		sessionId,
		load: () => { const d = deferred(); loads.push(d); return d.promise; },
		write: (content, baseVersion) => { const d = deferred(); writes.push({ content, baseVersion, ...d }); return d.promise; },
		draftStore: fakeDraftStore(),
	});
	return { controller, loads, writes };
}

/** 常用前置：首轮加载到 ready。 */
async function ready(tab, text = 'x', version = 'v1') {
	tab.loads[0].resolve({ text, version });
	await flush();
}

/** 服务依赖替身：可控前台解析器 + 记录 open/close + 假模式注册表。 */
function makeServiceDeps() {
	const opened = [];
	const closed = [];
	const modeSubs = new Set();
	const modeEntries = [{ id: 'plain-text', priority: 'fallback', globs: ['*'] }];
	let resolver = () => undefined;
	const deps = {
		resolveForegroundTab: () => resolver(),
		openInSidebar: (address, opts) => { opened.push({ address, opts }); },
		closeTab: (tabKey) => { closed.push(tabKey); },
		modeRegistry: {
			entries: () => modeEntries,
			subscribe: (fn) => { modeSubs.add(fn); return () => modeSubs.delete(fn); },
		},
		version: '0.2.0-test',
	};
	return { deps, opened, closed, modeEntries, modeSubs, setResolver: (fn) => { resolver = fn; } };
}

/** 登记 + 指定其为前台的常用组合；registration.notifyChange 暴露手动触发口。 */
function registerForeground(service, env, tabKey, tab, { sessionId = 's1', address = ADDRESS_A } = {}) {
	let visible = true;
	const listeners = new Set();
	const notify = () => { for (const fn of [...listeners]) fn(); };
	const registration = {
		sessionId,
		address,
		controller: tab.controller,
		isVisible: () => visible,
		notifyChange: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
	};
	env.setResolver(() => (visible
		? { tabKey, sessionId, address, controller: tab.controller, isVisible: visible }
		: undefined));
	const unregister = service.registerTab(tabKey, registration);
	return { unregister, setVisible: (v) => { visible = v; }, notify, registration };
}

// ---- 5 个 brief 场景 ----

test('active resolves foreground editor tab or undefined', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	assert.equal(service.active.getSnapshot(), undefined); // 无任何登记

	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const handle = service.active.getSnapshot();
	assert.notEqual(handle, undefined);
	assert.equal(handle.address, ADDRESS_A);
	assert.equal(handle.sessionId, 's1');

	// 前台指向未登记的 tabKey → undefined（挂载滞后是正常瞬态）
	env.setResolver(() => ({ tabKey: 'Z', sessionId: 's1', address: ADDRESS_A, controller: tab.controller, isVisible: true }));
	tab.controller.applySelection({ start: 0, end: 0, lineStart: 1, lineEnd: 1, text: '' }); // 控制器发布 → 重新解析
	assert.equal(service.active.getSnapshot(), undefined);

	fg.unregister();
});

test('active updates when registration visibility changes', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const first = service.active.getSnapshot();
	const seen = [];
	service.active.subscribe((h) => seen.push(h));

	fg.setVisible(false);
	fg.notify(); // 可见性变化经 registration.notifyChange 流入 → 重新解析
	assert.equal(service.active.getSnapshot(), undefined);
	assert.deepEqual(seen, [undefined]);

	fg.setVisible(true);
	fg.notify();
	assert.equal(service.active.getSnapshot(), first); // 同一 tab：句柄引用复用（快照稳定）
	assert.deepEqual(seen, [undefined, first]);

	fg.notify(); // 解析结果未变 → 不重复通知
	assert.equal(seen.length, 2);
	assert.equal(service.active.getSnapshot(), first);

	fg.unregister();
});

test('unregistered handle becomes stale (methods return explicit error)', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	await ready(tab, 'draft me', 'v1');
	tab.controller.applyEdit('dirty edit');
	const handle = service.active.getSnapshot();

	const staleStates = [];
	handle.state.subscribe((s) => staleStates.push(s));
	const staleContents = [];
	handle.content.subscribe((c) => staleContents.push(c));

	fg.unregister();

	assert.equal(service.active.getSnapshot(), undefined); // 前台不再解析到该句柄
	assert.equal(service._resolveHandleFor('A'), undefined); // 内部登记亦不复存在
	// 方法：显式错误信封 / false / no-op，绝不抛
	assert.deepEqual(await handle.save(), { ok: false, error: { message: 'dsh-editor: handle closed' } });
	assert.equal(handle.navigateToLine(3), false);
	handle.close();
	assert.deepEqual(env.closed, []); // stale close 是 no-op
	// 切片：冻结的 stale 快照
	assert.deepEqual(handle.content.getSnapshot(), { text: '', dirty: false });
	assert.equal(handle.content.getSnapshot(), handle.content.getSnapshot()); // 冻结引用稳定
	assert.equal(handle.selection.getSnapshot(), null);
	assert.deepEqual(handle.state.getSnapshot(), { phase: 'failed', saving: false, conflict: false, version: '', failure: 'handle closed' });
	assert.deepEqual(handle.mode.getSnapshot(), { modeId: undefined });
	// 切片订阅者在失效时收到 stale 快照
	assert.equal(staleStates.at(-1), handle.state.getSnapshot());
	assert.equal(staleContents.at(-1), handle.content.getSnapshot());
});

test('saveAll queues saves only for dirty handles of the session', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tabA = makeTab(ADDRESS_A);
	const tabB = makeTab(ADDRESS_B);
	const tabC = makeTab(ADDRESS_C, 's2');
	service.registerTab('A', { sessionId: 's1', address: ADDRESS_A, controller: tabA.controller, isVisible: () => true });
	service.registerTab('B', { sessionId: 's1', address: ADDRESS_B, controller: tabB.controller, isVisible: () => false });
	service.registerTab('C', { sessionId: 's2', address: ADDRESS_C, controller: tabC.controller, isVisible: () => false });
	await ready(tabA, 'a', 'v1');
	await ready(tabB, 'b', 'v1');
	await ready(tabC, 'c', 'v1');
	tabA.controller.applyEdit('a*'); // s1 脏
	tabC.controller.applyEdit('c*'); // s2 脏（别的会话）

	const result = await service.saveAll('s1');
	assert.deepEqual(result, { saved: 1 }); // 只统计入队请求
	assert.equal(tabA.writes.length, 1);   // 脏句柄入队即发写
	assert.deepEqual([tabA.writes[0].content, tabA.writes[0].baseVersion], ['a*', 'v1']); // 非强制
	assert.equal(tabB.writes.length, 0);   // 干净不入队
	assert.equal(tabC.writes.length, 0);   // 跨会话不动

	assert.deepEqual(await service.saveAll('s-nope'), { saved: 0 }); // 无匹配会话
	tabA.writes[0].resolve({ operation: 'update', version: 'v2' });
	await flush();
});

test('open delegates to openInSidebar with kind editor', () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	service.open(ADDRESS_A);
	assert.deepEqual(env.opened, [{ address: ADDRESS_A, opts: { kind: 'editor' } }]);
	service.open(ADDRESS_B, { line: 42 });
	assert.deepEqual(env.opened.at(-1), { address: ADDRESS_B, opts: { kind: 'editor', params: { file: { line: 42 } } } });
});

// ---- 补充：句柄切片与前台语义 ----

test('content slice reflects edits and keeps reference stability per slice', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const handle = service.active.getSnapshot();
	await ready(tab, 'hello', 'v1');

	const contentSeen = [];
	handle.content.subscribe((c) => contentSeen.push(c));
	const c0 = handle.content.getSnapshot();
	assert.deepEqual(c0, { text: 'hello', dirty: false }); // text = 当前草稿

	tab.controller.applyEdit('hello!');
	const c1 = handle.content.getSnapshot();
	assert.deepEqual(c1, { text: 'hello!', dirty: true });
	assert.deepEqual(contentSeen, [c1]);

	// 无关变更（选区）不换 content 引用、不打扰 content 订阅者
	tab.controller.applySelection({ start: 0, end: 1, lineStart: 1, lineEnd: 1, text: 'h' });
	assert.equal(handle.content.getSnapshot(), c1);
	assert.deepEqual(handle.selection.getSnapshot(), { start: 0, end: 1, lineStart: 1, lineEnd: 1, text: 'h' });
	assert.equal(contentSeen.length, 1);

	// 同值编辑也不换引用
	tab.controller.applySelection({ start: 0, end: 1, lineStart: 1, lineEnd: 1, text: 'h' });
	assert.equal(handle.selection.getSnapshot(), handle.selection.getSnapshot());

	fg.unregister();
});

test('state slice maps controller phases and save lifecycle', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const handle = service.active.getSnapshot();

	// loading：failure 为 null
	assert.deepEqual(handle.state.getSnapshot(), { phase: 'loading', saving: false, conflict: false, version: '', failure: null });

	await ready(tab, 'a', 'v1');
	const p = handle.save(); // 非强制入队
	assert.equal(tab.writes.length, 1);
	assert.equal(tab.writes[0].baseVersion, 'v1');
	const saving = handle.state.getSnapshot();
	assert.equal(saving.phase, 'ready'); // 控制器 saving 相位映射为 phase ready + saving true
	assert.equal(saving.saving, true);
	assert.equal(saving.conflict, false);
	assert.equal(saving.version, 'v1');
	assert.equal(saving.failure, null);

	tab.writes[0].resolve({ operation: 'update', version: 'v2' });
	assert.equal((await p).ok, true);
	assert.deepEqual(handle.state.getSnapshot(), { phase: 'ready', saving: false, conflict: false, version: 'v2', failure: null });

	// stale 写 → conflict 标志经切片透出
	tab.controller.applyEdit('mine');
	const staleSave = handle.save();
	tab.writes[1].reject(Object.assign(new Error('file changed on disk'), { code: 'FS_STALE_VERSION' }));
	const rejected = await staleSave;
	assert.equal(rejected.ok, false);
	assert.equal(handle.state.getSnapshot().conflict, true);

	fg.unregister();
});

test('state slice maps load failure to a string failure', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const handle = service.active.getSnapshot();
	const states = [];
	handle.state.subscribe((s) => states.push(s));
	tab.loads[0].reject(Object.assign(new Error('gone'), { kind: 'not-found' }));
	await flush();
	assert.deepEqual(handle.state.getSnapshot(), { phase: 'failed', saving: false, conflict: false, version: '', failure: 'gone' });
	assert.equal(states.at(-1), handle.state.getSnapshot());
	fg.unregister();
});

test('mode slice follows attachMode and detachMode', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const handle = service.active.getSnapshot();
	tab.controller.attachMode('plain-text'); // loading 相位也允许
	assert.deepEqual(handle.mode.getSnapshot(), { modeId: 'plain-text' });
	tab.controller.detachMode();
	assert.deepEqual(handle.mode.getSnapshot(), { modeId: undefined });
	fg.unregister();
});

test('navigateToLine delegates to the controller queue', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const handle = service.active.getSnapshot();
	const lines = [];
	tab.controller.onNavigate((line) => { lines.push(line); return true; });
	assert.equal(handle.navigateToLine(3), true); // loading 挂起，接受
	await ready(tab, 'a\nb', 'v1');
	assert.deepEqual(lines, [3]); // ready 后交付
	assert.equal(handle.navigateToLine(2), true);
	assert.deepEqual(lines, [3, 2]);
	fg.unregister();
});

test('close delegates to the injected closeTab', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	const handle = service.active.getSnapshot();
	handle.close();
	assert.deepEqual(env.closed, ['A']); // 框架关闭（卸载后 UI 再 unregister）
	fg.unregister();
});

// ---- 补充：active 解析边界 ----

test('resolve passes without foreground handle: registered tabs but none foreground', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tabA = makeTab(ADDRESS_A);
	const tabB = makeTab(ADDRESS_B);
	service.registerTab('A', { sessionId: 's1', address: ADDRESS_A, controller: tabA.controller, isVisible: () => false });
	service.registerTab('B', { sessionId: 's1', address: ADDRESS_B, controller: tabB.controller, isVisible: () => false });
	env.setResolver(() => undefined); // 前台不是编辑器 tab（Review Focus 4 的服务侧基础）
	assert.equal(service.active.getSnapshot(), undefined);
});

test('active switches handles when the foreground tab changes', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tabA = makeTab(ADDRESS_A);
	const tabB = makeTab(ADDRESS_B);
	let foreground = 'A';
	env.setResolver(() => (foreground === 'A'
		? { tabKey: 'A', sessionId: 's1', address: ADDRESS_A, controller: tabA.controller, isVisible: true }
		: { tabKey: 'B', sessionId: 's1', address: ADDRESS_B, controller: tabB.controller, isVisible: true }));
	service.registerTab('A', { sessionId: 's1', address: ADDRESS_A, controller: tabA.controller, isVisible: () => foreground === 'A' });
	service.registerTab('B', { sessionId: 's1', address: ADDRESS_B, controller: tabB.controller, isVisible: () => foreground === 'B' });
	const handleA = service.active.getSnapshot();
	assert.equal(handleA.address, ADDRESS_A);

	const seen = [];
	service.active.subscribe((h) => seen.push(h));
	foreground = 'B';
	await ready(tabA, 'a', 'v1'); // 控制器发布 → 重新解析
	const handleB = service.active.getSnapshot();
	assert.equal(handleB.address, ADDRESS_B);
	assert.notEqual(handleB, handleA);
	assert.deepEqual(seen, [handleB]);
	assert.equal(typeof handleA.content.getSnapshot().text, 'string'); // 旧句柄仍登记 → 未失效，可继续读
});

test('active snapshot reference is stable while the foreground identity holds', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	await ready(tab, 'a', 'v1');
	const handle = service.active.getSnapshot();
	const seen = [];
	service.active.subscribe((h) => seen.push(h));
	tab.controller.applyEdit('edit');       // 控制器发布 → 重新解析 → 同一前台
	tab.controller.applySelection({ start: 0, end: 1, lineStart: 1, lineEnd: 1, text: 'e' });
	assert.equal(service.active.getSnapshot(), handle); // 引用不变
	assert.equal(seen.length, 0);                       // 不通知
	fg.unregister();
});

test('a throwing active subscriber does not break notification', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tabA = makeTab(ADDRESS_A);
	const tabB = makeTab(ADDRESS_B);
	let foreground = 'A';
	env.setResolver(() => (foreground === 'A'
		? { tabKey: 'A', sessionId: 's1', address: ADDRESS_A, controller: tabA.controller, isVisible: true }
		: { tabKey: 'B', sessionId: 's1', address: ADDRESS_B, controller: tabB.controller, isVisible: true }));
	service.registerTab('A', { sessionId: 's1', address: ADDRESS_A, controller: tabA.controller, isVisible: () => true });
	service.registerTab('B', { sessionId: 's1', address: ADDRESS_B, controller: tabB.controller, isVisible: () => true });
	const seen = [];
	service.active.subscribe(() => { throw new Error('listener bug'); });
	service.active.subscribe((h) => seen.push(h));
	foreground = 'B';
	await ready(tabA, 'a', 'v1'); // 触发重解析
	assert.deepEqual(seen.length, 1);
	assert.equal(seen[0].address, ADDRESS_B);
});

// ---- 补充：登记生命周期 ----

test('re-registering a tabKey invalidates the previous handle', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab1 = makeTab(ADDRESS_A);
	const fg1 = registerForeground(service, env, 'A', tab1);
	const handle1 = service._resolveHandleFor('A');

	const tab2 = makeTab(ADDRESS_A);
	const fg2 = registerForeground(service, env, 'A', tab2); // 同 tabKey 重新登记
	const handle2 = service._resolveHandleFor('A');
	assert.notEqual(handle2, handle1);
	assert.notEqual(handle2, undefined);
	assert.deepEqual(await handle1.save(), { ok: false, error: { message: 'dsh-editor: handle closed' } }); // 旧句柄失效
	assert.equal(handle1.navigateToLine(1), false);
	assert.equal((await handle2.save()).ok, false); // 新句柄活着（loading 相位拒绝保存，但不是 stale 信封）
	fg2.unregister();
});

test('unregisterTab is idempotent and the disposer is equivalent', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	const fg = registerForeground(service, env, 'A', tab);
	assert.notEqual(service._resolveHandleFor('A'), undefined);
	fg.unregister();
	fg.unregister(); // 重复 dispose 安全
	service.unregisterTab('A'); // 未登记时同样安全
	assert.equal(service._resolveHandleFor('A'), undefined);
	assert.equal(service.active.getSnapshot(), undefined);
});

test('saveAll skips handles whose controller cannot accept a save', async () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	const tab = makeTab(ADDRESS_A);
	service.registerTab('A', { sessionId: 's1', address: ADDRESS_A, controller: tab.controller, isVisible: () => true });
	await ready(tab, 'a', 'v1');
	tab.controller.applyEdit('dirty');
	tab.controller.requestReload();
	tab.loads[1].reject(Object.assign(new Error('gone'), { kind: 'not-found' }));
	await flush();
	assert.equal(tab.controller.getState().phase, 'failed');
	assert.equal(tab.controller.getState().dirty, true); // reload 失败保留草稿 → 脏

	assert.deepEqual(await service.saveAll('s1'), { saved: 0 }); // failed 相位不接受保存
	assert.equal(tab.writes.length, 0);
});

// ---- 补充：服务面 ----

test('service exposes version and proxies the mode registry', () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	assert.equal(service.version, '0.2.0-test');
	assert.equal(service.modeRegistryProxy.entries(), env.modeEntries); // 透传同一数组引用
	const seen = [];
	const detach = service.modeRegistryProxy.subscribe((e) => seen.push(e));
	for (const fn of [...env.modeSubs]) fn([{ id: 'hex' }]); // 注册表广播经代理到达
	assert.deepEqual(seen, [[{ id: 'hex' }]]);
	detach();
});

test('open never throws and forwards addresses as-is', () => {
	const env = makeServiceDeps();
	const service = createEditorService(env.deps);
	env.deps.openInSidebar = () => { throw new Error('sidebar exploded'); };
	service.open('not an address'); // 不校验、不抛（导航契约归 sidebar-right）
	service.open('', { line: 7 });
	service.open(undefined);
});
