import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugLog } from './debug-log.js';
// 命名空间导入：v2 新 API 经属性访问取出，未实现时仅新用例失败，旧用例不受链接错误影响
import * as debugLogModule from './debug-log.js';

const { createLogChannel } = debugLogModule;

test('createDebugLog emits [dsh-editor]-prefixed lines through the injected sink', () => {
	const calls = [];
	const log = createDebugLog({ debug: (...args) => calls.push(args) });
	log('goto-line', 'open', { phase: 'ready' });
	log('keymap', 'migrated');
	assert.deepEqual(calls, [
		['[dsh-editor]', 'goto-line', 'open', { phase: 'ready' }],
		['[dsh-editor]', 'keymap', 'migrated']
	]);
});

test('createDebugLog tolerates a missing or sink-less console (silent no-op)', () => {
	assert.doesNotThrow(() => createDebugLog(null)('scope', 'message'));
	assert.doesNotThrow(() => createDebugLog(undefined)('scope', 'message'));
	assert.doesNotThrow(() => createDebugLog({})('scope', 'message')); // 无 debug 方法
});

// ---- createLogChannel（v2：分级 + 持久化入队）----

test('maps levels to console methods with prefix', () => {
	// 每个级别必须落到 sink 的同名方法，且首参固定为 '[dsh-editor]'
	const calls = { debug: [], info: [], warn: [], error: [] };
	const log = createLogChannel({
		sink: {
			debug: (...args) => calls.debug.push(args),
			info: (...args) => calls.info.push(args),
			warn: (...args) => calls.warn.push(args),
			error: (...args) => calls.error.push(args)
		},
		enqueue: () => {},
		now: () => 0
	});
	log.debug('keymap', 'x');
	log.info('keymap', 'x');
	log.warn('keymap', 'x');
	log.error('keymap', 'x');
	assert.deepEqual(calls.debug, [['[dsh-editor]', 'keymap', 'x']]);
	assert.deepEqual(calls.info, [['[dsh-editor]', 'keymap', 'x']]);
	assert.deepEqual(calls.warn, [['[dsh-editor]', 'keymap', 'x']]);
	assert.deepEqual(calls.error, [['[dsh-editor]', 'keymap', 'x']]);
});

test('enqueues one entry per call with shape', () => {
	// 每次调用恰好入队一条 entry，形状逐字匹配：ts 取注入的 now，text 走 serializeLogArgs
	const entries = [];
	const log = createLogChannel({
		sink: { debug() {}, info() {} },
		enqueue: (entry) => entries.push(entry),
		now: () => 12345
	});
	log.debug('keymap', 'x');
	log.info('ui', 'y', { a: 1 });
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0], { ts: 12345, level: 'debug', source: 'client', scope: 'keymap', text: 'x' });
	assert.deepEqual(entries[1], { ts: 12345, level: 'info', source: 'client', scope: 'ui', text: 'y {"a":1}' });
});

test('falls back silently when sink lacks the level method', () => {
	// sink 只有 debug：log.warn 不抛、跳过 console，entry 仍照常入队
	const entries = [];
	const log = createLogChannel({
		sink: { debug() {} },
		enqueue: (entry) => entries.push(entry),
		now: () => 1
	});
	assert.doesNotThrow(() => log.warn('keymap', 'w'));
	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0], { ts: 1, level: 'warn', source: 'client', scope: 'keymap', text: 'w' });
});

test('clamps scope', () => {
	// 非字符串 scope → 'unknown'；空字符串（约束要求非空）→ 'unknown'；超过 64 字符 → 截到 64；console 侧同样收到归一化后的 scope
	const entries = [];
	const sinkCalls = [];
	const record = (...args) => sinkCalls.push(args);
	const log = createLogChannel({
		sink: { debug: record, info: record, warn: record, error: record },
		enqueue: (entry) => entries.push(entry),
		now: () => 0
	});
	log.debug(42, 'x');
	log.debug(undefined, 'x');
	log.info('a'.repeat(100), 'x');
	log.debug('', 'x'); // 空字符串非法：长度为 0 → 'unknown'
	log.debug('   ', 'x'); // 长度 >0 的纯空白保留原值（仅截断，不 trim）
	assert.equal(entries[0].scope, 'unknown');
	assert.equal(entries[1].scope, 'unknown');
	assert.equal(entries[2].scope, 'a'.repeat(64));
	assert.equal(entries[2].scope.length, 64);
	assert.equal(entries[3].scope, 'unknown');
	assert.equal(entries[4].scope, '   ');
	assert.deepEqual(sinkCalls[2], ['[dsh-editor]', 'a'.repeat(64), 'x']);
});

test('never throws with broken sink and enqueue', () => {
	// 铁律矩阵：sink 方法抛错 × enqueue 抛错的组合下，四个级别对调用方都不得抛出
	const boom = () => {
		throw new Error('boom');
	};
	const throwEnqueue = () => {
		throw new Error('enqueue broken');
	};
	const matrix = [
		{ sink: { debug: boom, info: boom, warn: boom, error: boom }, enqueue: throwEnqueue },
		{ sink: { debug: boom, info: boom, warn: boom, error: boom }, enqueue: () => {} },
		{ sink: {}, enqueue: throwEnqueue }, // sink 缺全部方法且 enqueue 抛错
		{ sink: { warn: boom }, enqueue: throwEnqueue }, // 入队失败后的 sink.warn 提示也抛错
		{ sink: { get debug() { throw new Error('getter boom'); } }, enqueue: () => {} } // 属性读取本身抛错
	];
	for (const deps of matrix) {
		const log = createLogChannel({ ...deps, now: () => 0 });
		for (const level of ['debug', 'info', 'warn', 'error']) {
			assert.doesNotThrow(() => log[level]('keymap', 'x'), `matrix sink=${JSON.stringify(Object.keys(deps.sink))} level=${level}`);
		}
	}
	// 任意参数值也不得抛：循环引用、getter 抛错对象、symbol、bigint、函数
	const circular = { self: null };
	circular.self = circular;
	const logHostile = createLogChannel({
		sink: { debug() {}, info() {}, warn() {}, error() {} },
		enqueue: () => {},
		now: () => 0
	});
	assert.doesNotThrow(() => logHostile.debug('keymap', circular, { get x() { throw new Error('getter'); } }, Symbol('s'), 10n, () => {}));
	// enqueue 抛错时：走 sink.warn 提示恰好一次（首参仍为前缀），且不外抛
	const warns = [];
	const logDrop = createLogChannel({
		sink: { debug() {}, info() {}, warn: (...args) => warns.push(args), error() {} },
		enqueue: throwEnqueue,
		now: () => 0
	});
	assert.doesNotThrow(() => logDrop.error('keymap', 'x'));
	assert.equal(warns.length, 1);
	assert.equal(warns[0][0], '[dsh-editor]');
	assert.equal(warns[0][1], 'keymap');
});
