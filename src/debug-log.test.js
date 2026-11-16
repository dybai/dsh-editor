import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugLog } from './debug-log.js';

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
