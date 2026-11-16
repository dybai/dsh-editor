import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.js';

/**
 * Host-assembly tests for the plugin entry (`apply`): the wire service's
 * Remote markers, the `appendLogs` delegation into the log service, and the
 * effect-cleanup contract (exporter disposed, log service closed, never
 * throwing). Everything cordis-shaped is faked: `get`/`provide`/`effect` on
 * the context, a Map-backed json storage backend, an in-memory KvFacet over
 * the `dsh_editor_logs` unit tables, and a `ctx.logger` whose `exporter`
 * captures the registration and hands back a Disposable.
 */

/** Fallback prototype key index.js stamps when live discovery finds nothing. */
const REMOTE_MARKER_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * fake kv（内存 KvFacet）：`open(descriptor)` → `dsh_editor_logs` unit。
 * chunks 表与 global 单例即「介质」，供断言收到的 chunk；open/close 计数
 * 供懒打开/释放断言。
 */
function fakeLogKv() {
	const medium = {
		openCalls: 0,
		closeCalls: 0,
		descriptors: [],
		chunks: new Map(),
		global: null,
		async open(descriptor) {
			medium.openCalls += 1;
			medium.descriptors.push(descriptor);
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
 * `effect(fn, name)` 立即执行并捕获 cleanup；`ctx.logger.exporter` 捕获
 * 注册并返回带 `dispose` 的 Disposable。
 */
function makeFakeContext(kv) {
	const provides = new Map();
	const effects = [];
	const loggerState = { registered: undefined, disposeCalls: 0 };
	const services = {
		fs: { resolve: () => 'C:/workspace', writeText: async () => ({}) },
		sandboxPolicy: { resolve: () => ({ allowed: true }) },
		sessions: { get: () => undefined },
		storage: { backends: new Map([['json', { kv }]]) }
	};
	const ctx = {
		logger: {
			exporter(exporter) {
				loggerState.registered = exporter;
				return {
					dispose() {
						loggerState.disposeCalls += 1;
					}
				};
			}
		},
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
function makeHarness() {
	const kv = fakeLogKv();
	const harness = makeFakeContext(kv);
	harness.kv = kv;
	harness.dispose = apply(harness.ctx);
	return harness;
}

test('registers eight remote methods including appendLogs', () => {
	const harness = makeHarness();
	const service = harness.provides.get('dshEditor');
	assert.ok(service !== undefined, 'apply must provide the dshEditor service');
	const marker = Object.getPrototypeOf(service)[REMOTE_MARKER_KEY];
	assert.ok(marker !== undefined, 'the service prototype must carry the remote marker descriptor');
	assert.equal(marker.methods.length, 8);
	const appended = marker.methods.find((entry) => entry.method === 'appendLogs');
	assert.deepEqual(appended, { method: 'appendLogs', invocation: { kind: 'direct' } });
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
	harness.dispose(); // 撤销不抛
	assert.equal(harness.loggerState.disposeCalls, 1, 'cleanup must dispose the ctx.logger exporter');
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(harness.kv.closeCalls >= 1, 'the log service must close its kv unit');
	harness.dispose(); // 幂等：再次撤销同样不抛
});
