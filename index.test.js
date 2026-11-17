import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.js';

/**
 * Host-assembly tests for the plugin entry (`apply`): the wire service's
 * Remote markers, the `appendLogs` delegation into the log service, the
 * named-logger touchpoints (`lifecycle` begin/complete, rotation-anomaly
 * warns routed into the log lane), and the effect-cleanup contract (log
 * service closed, never throwing). Everything cordis-shaped is faked:
 * `get`/`provide`/`effect` on the context, a Map-backed json storage
 * backend, an in-memory KvFacet over the `dsh_editor_logs` unit tables, and
 * a CALLABLE `ctx.logger(name)` whose fake named logger records every
 * `{ name, method, args }` call, with `.exporter` capturing the registration
 * and returning the bare callable effect disposer real cordis hands back.
 */

/** Fallback prototype key index.js stamps when live discovery finds nothing. */
const REMOTE_MARKER_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * fake kv（内存 KvFacet）：`open(descriptor)` → `dsh_editor_logs` unit。
 * chunks 表与 global 单例即「介质」，供断言收到的 chunk；open/close 计数
 * 供懒打开/释放断言；`openError` 模拟存储后端未挂（降级上报场景）。
 */
function fakeLogKv({ openError } = {}) {
	const medium = {
		openCalls: 0,
		closeCalls: 0,
		descriptors: [],
		chunks: new Map(),
		global: null,
		async open(descriptor) {
			medium.openCalls += 1;
			medium.descriptors.push(descriptor);
			if (openError !== undefined) throw openError;
			return {
				async loadAll() {
					const records = {};
					for (const [key, value] of medium.chunks) records[key] = value;
					return { tables: { chunks: records }, global: medium.global };
				},
				async putRecord(table, key, value) {
					assert.equal(table, 'chunks');
					medium.chunks.set(key, structuredClone(value));
				},
				async deleteRecords(table, keys) {
					assert.equal(table, 'chunks');
					for (const key of keys) medium.chunks.delete(key);
				},
				async setGlobal(value) {
					medium.global = structuredClone(value);
				},
				async close() {
					medium.closeCalls += 1;
				}
			};
		}
	};
	return medium;
}

/**
 * fake ctx：`get(key)` 返回 fake 服务；`provide` 记录并返回撤销器；
 * `effect(fn, name)` 立即执行并捕获 cleanup。`ctx.logger` 是 callable（与
 * cordis 一致）：`ctx.logger(name)` 返回记录每次 `{ name, method, args }`
 * 调用的命名 logger；`.exporter` 捕获注册并返回裸 callable effect disposer
 * （真实 cordis 没有 `.dispose`，回收由 fiber 负责）。
 */
function makeFakeContext(kv) {
	const provides = new Map();
	const effects = [];
	const loggerState = { names: [], calls: [], registered: undefined };
	const namedLogger = (name) => {
		loggerState.names.push(name);
		const record = (method) => (...args) => {
			loggerState.calls.push({ name, method, args });
		};
		return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
	};
	namedLogger.exporter = (exporter) => {
		loggerState.registered = exporter;
		return () => {};
	};
	const services = {
		fs: { resolve: () => 'C:/workspace', writeText: async () => ({}) },
		sandboxPolicy: { resolve: () => ({ allowed: true }) },
		sessions: { get: () => undefined },
		storage: { backends: new Map([['json', { kv }]]) }
	};
	const ctx = {
		logger: namedLogger,
		get(key) {
			return services[key];
		},
		provide(key, service) {
			provides.set(key, service);
			return () => {
				provides.delete(key);
			};
		},
		effect(fn, name) {
			const cleanup = fn();
			effects.push({ cleanup, name });
			return () => cleanup();
		}
	};
	return { ctx, provides, effects, loggerState };
}

/** apply 一个 harness：跑完插件入口并拿回 effect disposer。 */
function makeHarness({ openError } = {}) {
	const kv = fakeLogKv({ openError });
	const harness = makeFakeContext(kv);
	harness.kv = kv;
	harness.dispose = apply(harness.ctx);
	return harness;
}

/** n 条合法 client 条目（ts 递增，text 带 prefix 与序号）。 */
function makeEntries(count, prefix = 'e') {
	return Array.from({ length: count }, (_, i) => ({
		ts: 1_700_000_000_000 + i,
		level: 'info',
		source: 'client',
		scope: 'test',
		text: `${prefix}${i}`
	}));
}

test('registers ten remote methods including appendLogs and the wrap_overrides pair', () => {
	const harness = makeHarness();
	const service = harness.provides.get('dshEditor');
	assert.ok(service !== undefined, 'apply must provide the dshEditor service');
	const marker = Object.getPrototypeOf(service)[REMOTE_MARKER_KEY];
	assert.ok(marker !== undefined, 'the service prototype must carry the remote marker descriptor');
	assert.equal(marker.methods.length, 10);
	const appended = marker.methods.find((entry) => entry.method === 'appendLogs');
	assert.deepEqual(appended, { method: 'appendLogs', invocation: { kind: 'direct' } });
	// 新方法对同时出现在 marker 列表与 service 上，且沿既有 direct invocation 形状
	for (const method of ['getWrapOverrides', 'setWrapOverrides']) {
		const entry = marker.methods.find((candidate) => candidate.method === method);
		assert.deepEqual(entry, { method, invocation: { kind: 'direct' } });
		assert.equal(typeof service[method], 'function', `${method} must be exposed on the service`);
	}
});

test('appendLogs delegates to the log service', async () => {
	const harness = makeHarness();
	const service = harness.provides.get('dshEditor');
	const entries = [
		{ ts: 1700000000000, level: 'info', source: 'client', scope: 'lifecycle', text: 'flushed on hide' }
	];
	const result = await service.appendLogs(entries);
	assert.deepEqual(result, { accepted: 1 });
	// fake 介质收到 chunk：恰一条记录，entries 原样入存
	assert.equal(harness.kv.chunks.size, 1);
	const record = [...harness.kv.chunks.values()][0];
	assert.deepEqual(record.entries, entries);
});

test('disposal closes the log service', async () => {
	const harness = makeHarness();
	const service = harness.provides.get('dshEditor');
	// unit 懒打开：先 append 一次，close 才可观测
	await service.appendLogs([
		{ ts: 1700000000001, level: 'warn', source: 'client', scope: 'commands', text: 'register failed' }
	]);
	assert.ok(harness.loggerState.registered !== undefined, 'apply must register the log exporter on ctx.logger');
	assert.ok(typeof harness.loggerState.registered.export === 'function', 'the exporter must expose export()');
	harness.dispose(); // 撤销不抛（exporter 的回收由 cordis fiber 的 effect disposer 负责，插件不手动 dispose）
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(harness.kv.closeCalls >= 1, 'the log service must close its kv unit');
	harness.dispose(); // 幂等：再次撤销同样不抛
});

test('creates one dsh-editor named logger and marks the apply lifecycle', () => {
	const harness = makeHarness();
	assert.deepEqual(harness.loggerState.names, ['dsh-editor'], 'apply must create exactly one named logger');
	const infos = harness.loggerState.calls.filter((call) => call.method === 'info');
	assert.deepEqual(infos, [
		{ name: 'dsh-editor', method: 'info', args: ['lifecycle', 'host apply begin'] },
		{ name: 'dsh-editor', method: 'info', args: ['lifecycle', 'host apply complete'] }
	]); // begin 与 complete 各恰好一次（且顺序正确）
});

test('routes rotation warnings to the named logger and module errors to console', async () => {
	const originalNow = Date.now;
	const originalError = console.error;
	const errorCalls = [];
	let clock = 1_000_000;
	Date.now = () => clock;
	console.error = (...args) => {
		errorCalls.push(args);
	};
	try {
		// 轮转异常（spec §7.2 打点）：先落 3 个 chunk（600 条），拨过 7 天后
		// 再 append 触发一次删除 600 条（> 500）的轮转。
		const harness = makeHarness();
		const service = harness.provides.get('dshEditor');
		for (let i = 0; i < 3; i++) await service.appendLogs(makeEntries(200, `old${i}-`));
		clock += 7 * 24 * 60 * 60 * 1000 + 1;
		await service.appendLogs(makeEntries(1, 'trigger-'));
		const warns = harness.loggerState.calls.filter((call) => call.method === 'warn');
		assert.equal(warns.length, 1, 'one rotation-anomaly warn');
		assert.equal(warns[0].name, 'dsh-editor');
		assert.equal(warns[0].args[0], 'logs');
		assert.match(String(warns[0].args[1]), /deleted 600 entries/);
		assert.equal(errorCalls.length, 0, 'a rotation anomaly never falls back to console');

		// 模块自身错误（kv.open 失败）只进 console.error，绝不回流命名 logger。
		const failing = makeHarness({ openError: new Error('backend unmounted') });
		const failingService = failing.provides.get('dshEditor');
		assert.deepEqual(await failingService.appendLogs(makeEntries(2, 'x')), { accepted: 0 });
		assert.equal(errorCalls.length, 1, 'kv open failure goes to console.error');
		assert.match(String(errorCalls[0][0]), /kv\.open failed/);
		assert.equal(
			failing.loggerState.calls.filter((call) => call.method === 'warn').length,
			0,
			'module errors never re-enter the log channel'
		);
	} finally {
		Date.now = originalNow;
		console.error = originalError;
	}
});
