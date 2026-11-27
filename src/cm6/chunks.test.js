/**
 * Tests for `src/cm6/chunks.js` — the CM6 chunk transport adapter: the
 * fixed chunk file name, the injected `requireAsync` transport, the
 * in-flight dedupe and the lifetime negative cache.
 *
 * The loader is a pure adapter over an injected transport (the client
 * entry passes `require.async`); every test drives it with a fake
 * `requireAsync` so the rejection, dedupe and blocked behaviors are
 * observed without any real chunk fetch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CM6_CHUNK_FILE, createCm6Loader } from './chunks.js';

/** A requireAsync that records calls and resolves whatever it is told to. */
function createFakeTransport() {
	const calls = [];
	const transport = (fileName) => {
		calls.push(fileName);
		return Promise.resolve({ cm6: { EditorView: {} } });
	};
	return { transport, calls };
}

/** Records leveled log calls so failure paths can assert the log wiring. */
function createLogRecorder() {
	const entries = [];
	const record = (level) => (scope, ...args) => {
		entries.push({ level, scope, text: args.map(String).join(' ') });
	};
	return {
		log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
		entries,
	};
}

test('CM6_CHUNK_FILE: the single fixed chunk the build emits', () => {
	assert.equal(CM6_CHUNK_FILE, 'client.editor-cm6.js');
});

test('loadCm6 fetches the fixed chunk file and resolves its cm6 record', async () => {
	const fake = createFakeTransport();
	const loader = createCm6Loader({ requireAsync: fake.transport });
	assert.equal(loader.isBlocked(), false, 'nothing is blocked before any attempt');
	const chunkExports = await loader.loadCm6();
	assert.deepEqual(fake.calls, ['client.editor-cm6.js'], 'the loader fetches the one cm6 chunk');
	assert.deepEqual(
		chunkExports.cm6,
		{ EditorView: {} },
		'loadCm6 resolves the chunk exports carrying the cm6 record',
	);
	assert.equal(loader.isBlocked(), false, 'a clean load never blocks');
});

test('a rejected transport blocks the loader for its lifetime', async () => {
	const recorder = createLogRecorder();
	let calls = 0;
	const requireAsync = () => {
		calls += 1;
		return Promise.reject(new Error('network down'));
	};
	const loader = createCm6Loader({ requireAsync, log: recorder.log });
	await assert.rejects(() => loader.loadCm6(), /network down/);
	assert.equal(loader.isBlocked(), true, 'the failed chunk is blocked');
	await assert.rejects(() => loader.loadCm6(), /blocked/);
	assert.equal(calls, 1, 'requireAsync is never called again for a blocked loader');
	assert.ok(
		recorder.entries.some((entry) => entry.level === 'warn' && entry.scope === 'cm6'),
		'the transport failure is logged under the cm6 scope, never thrown',
	);
});

test('concurrent loadCm6 calls share one transport call; the settled entry is forgotten', async () => {
	const calls = [];
	let resolveChunk;
	const chunk = new Promise((resolve) => {
		resolveChunk = resolve;
	});
	const requireAsync = (fileName) => {
		calls.push(fileName);
		return chunk;
	};
	const loader = createCm6Loader({ requireAsync });
	const first = loader.loadCm6();
	const second = loader.loadCm6();
	resolveChunk({ cm6: { EditorView: {} } });
	const [firstExports, secondExports] = await Promise.all([first, second]);
	assert.deepEqual(calls, ['client.editor-cm6.js'], 'one transport call serves both callers');
	assert.equal(firstExports, secondExports, 'both callers get the same chunk exports');
	await loader.loadCm6();
	assert.deepEqual(calls, ['client.editor-cm6.js', 'client.editor-cm6.js'], 'a settled load is forgotten, not result-cached');
});

test('a chunk without a usable cm6 record rejects and blocks the loader', async () => {
	for (const chunkExports of [{ somethingElse: true }, { cm6: null }, { cm6: {} }, null]) {
		let calls = 0;
		const requireAsync = async () => {
			calls += 1;
			return chunkExports;
		};
		const loader = createCm6Loader({ requireAsync });
		await assert.rejects(() => loader.loadCm6(), /cm6/, `a chunk exporting ${JSON.stringify(chunkExports)} rejects`);
		assert.equal(loader.isBlocked(), true, 'a broken chunk blocks like a failed fetch');
		await assert.rejects(() => loader.loadCm6());
		assert.equal(calls, 1, 'the broken chunk is never fetched again');
	}
});

test('a missing log degrades to silence instead of throwing', async () => {
	let calls = 0;
	const requireAsync = () => {
		calls += 1;
		return Promise.reject(new Error('offline'));
	};
	const loader = createCm6Loader({ requireAsync });
	await assert.rejects(() => loader.loadCm6(), /offline/);
	assert.equal(loader.isBlocked(), true);
	assert.equal(calls, 1);
});
