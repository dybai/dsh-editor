/**
 * Tests for `src/highlight/chunks.js` — the lazy language-group chunk
 * loader: the group→file map, the `requireAsync` transport adapter, the
 * per-group in-flight dedupe and the lifetime negative cache.
 *
 * The loader is a pure adapter over an injected transport (the client
 * entry passes `require.async`); every test drives it with a fake
 * `requireAsync` so the rejection, dedupe and blocked-group behaviors are
 * observed without any real chunk fetch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_GROUP_FILES, createChunkLoader } from './chunks.js';

/** A requireAsync that records calls and resolves whatever it is told to. */
function createFakeTransport() {
	const calls = [];
	const transport = (fileName) => {
		calls.push(fileName);
		return Promise.resolve({ languages: { css: { scopeName: 'source.css' } } });
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

test('CHUNK_GROUP_FILES: frozen map of exactly the four lazy groups', () => {
	assert.equal(Object.isFrozen(CHUNK_GROUP_FILES), true);
	assert.deepEqual(Object.keys(CHUNK_GROUP_FILES).sort(), ['data', 'script', 'system', 'web']);
	assert.deepEqual(CHUNK_GROUP_FILES, {
		web: 'client.lang-web.js',
		script: 'client.lang-script.js',
		system: 'client.lang-system.js',
		data: 'client.lang-data.js',
	});
});

test('loadGroup fetches the mapped chunk file and resolves its languages record', async () => {
	const fake = createFakeTransport();
	const loader = createChunkLoader({ requireAsync: fake.transport });
	assert.equal(loader.isBlocked('web'), false, 'nothing is blocked before any attempt');
	const chunkExports = await loader.loadGroup('web');
	assert.deepEqual(fake.calls, ['client.lang-web.js'], 'the group maps to its chunk file');
	assert.deepEqual(
		chunkExports.languages,
		{ css: { scopeName: 'source.css' } },
		'loadGroup resolves the chunk exports carrying the languages record',
	);
});

test('a rejected transport blocks the group for the loader lifetime', async () => {
	const recorder = createLogRecorder();
	let calls = 0;
	const requireAsync = (fileName) => {
		calls += 1;
		if (fileName === 'client.lang-web.js') return Promise.reject(new Error('network down'));
		return Promise.resolve({ languages: { python: { scopeName: 'source.python' } } });
	};
	const loader = createChunkLoader({ requireAsync, log: recorder.log });
	await assert.rejects(() => loader.loadGroup('web'), /network down/);
	assert.equal(loader.isBlocked('web'), true, 'the failed group is blocked');
	await assert.rejects(() => loader.loadGroup('web'), /blocked/);
	assert.equal(calls, 1, 'requireAsync is never called again for a blocked group');
	assert.equal(loader.isBlocked('script'), false, 'the block is per-group');
	const scriptExports = await loader.loadGroup('script');
	assert.deepEqual(scriptExports.languages, { python: { scopeName: 'source.python' } }, 'other groups keep loading');
	assert.equal(calls, 2, 'only the script fetch was added');
	assert.ok(
		recorder.entries.some((entry) => entry.level === 'warn' && entry.scope === 'highlight'),
		'the transport failure is logged, never thrown',
	);
});

test('concurrent loadGroup calls for one group share a single transport call', async () => {
	const calls = [];
	let resolveChunk;
	const chunk = new Promise((resolve) => {
		resolveChunk = resolve;
	});
	const requireAsync = (fileName) => {
		calls.push(fileName);
		return chunk;
	};
	const loader = createChunkLoader({ requireAsync });
	const first = loader.loadGroup('script');
	const second = loader.loadGroup('script');
	resolveChunk({ languages: { python: { scopeName: 'source.python' } } });
	const [firstExports, secondExports] = await Promise.all([first, second]);
	assert.deepEqual(calls, ['client.lang-script.js'], 'one transport call serves both callers');
	assert.equal(firstExports, secondExports, 'both callers get the same chunk exports');
	assert.deepEqual(firstExports.languages, { python: { scopeName: 'source.python' } });
});

test('a chunk without a usable languages record rejects and blocks the group', async () => {
	let calls = 0;
	const requireAsync = async () => {
		calls += 1;
		return { somethingElse: true };
	};
	const loader = createChunkLoader({ requireAsync });
	await assert.rejects(() => loader.loadGroup('system'), /languages/);
	assert.equal(loader.isBlocked('system'), true, 'a broken chunk blocks like a failed fetch');
	await assert.rejects(() => loader.loadGroup('system'));
	assert.equal(calls, 1, 'the broken chunk is never fetched again');
});

test('an unknown group rejects without touching the transport', async () => {
	const fake = createFakeTransport();
	const loader = createChunkLoader({ requireAsync: fake.transport });
	await assert.rejects(() => loader.loadGroup('warmup'), /unknown language group/);
	await assert.rejects(() => loader.loadGroup('nosuchgroup'), /unknown language group/);
	assert.equal(loader.isBlocked('warmup'), false, 'an unknown group was never attempted');
	assert.deepEqual(fake.calls, [], 'the transport is never called');
});

test('a missing log degrades to silence instead of throwing', async () => {
	let calls = 0;
	const requireAsync = () => {
		calls += 1;
		return Promise.reject(new Error('offline'));
	};
	const loader = createChunkLoader({ requireAsync });
	await assert.rejects(() => loader.loadGroup('data'), /offline/);
	assert.equal(loader.isBlocked('data'), true);
	assert.equal(calls, 1);
});
