/**
 * Tests for the build's language-chunk emission (spec task 5).
 *
 * Two layers:
 * - `scripts/chunk-gate.js` unit tests: the self-containment gate throws on a
 *   relative import line (any line the bundler would parse as an import) and
 *   passes a clean, self-contained source.
 * - End-to-end: spawning `node scripts/build.mjs` (the real build) must exit 0
 *   and materialize the four `client.lang-*.js` loader chunks next to
 *   `client.js`, each registering under its own chunk name and exporting the
 *   vendored `languages` record, with the entry bundle still carrying the
 *   `apply` export.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChunkSelfContained } from './chunk-gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_GROUPS = ['web', 'script', 'system', 'data'];

test('the chunk gate throws on a relative import line', () => {
	assert.throws(
		() => assertChunkSelfContained("import x from './y.js';\nexport const a = 1;", 't'),
		/not self-contained/,
		'a source with a relative import must not pass the gate'
	);
});

test('the chunk gate passes a self-contained source', () => {
	assert.doesNotThrow(() => assertChunkSelfContained('export const a = 1;', 't'));
});

test('the chunk gate error names the offending import', () => {
	assert.throws(
		() => assertChunkSelfContained("const a = 1;\nimport { b as c } from './b.js';\nconst d = 2;", 'fixture.js'),
		/from '\.\/b\.js'/,
		'the gate error should point at the import line it rejected'
	);
});

test('build emits four self-contained language chunks next to client.js', () => {
	const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, encoding: 'utf8' });
	assert.equal(result.status, 0, `the build failed:\n${result.stdout}\n${result.stderr}`);
	for (const group of CHUNK_GROUPS) {
		const chunkFile = `client.lang-${group}.js`;
		const source = readFileSync(path.join(ROOT, chunkFile), 'utf8');
		assert.ok(source.includes(`chunk: '${chunkFile}'`), `${chunkFile} must register under its own chunk name`);
		assert.ok(source.includes("id: '@dybai/dsh-editor'"), `${chunkFile} must register under the plugin id`);
		assert.ok(
			source.includes('Object.assign(module.exports, { languages })'),
			`${chunkFile} must export the languages record onto the factory's module.exports`
		);
	}
	const client = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
	assert.ok(
		client.includes('Object.assign(module.exports, { inject, apply });'),
		'client.js still carries the entry apply export'
	);
	assert.ok(
		client.includes('Object.assign(module.exports, { createCoreFacade });'),
		'the vendored facade export rides the module graph (esbuild export-block form reduces to a binding)'
	);
});

/**
 * The build-stamp gate (the build fingerprint): the bundler swaps the
 * `'@@BUILD_STAMP@@'` placeholder literal for `<git short SHA>.<content
 * hash8>` — hash8 being the first 8 hex chars of a sha256 over the ASSEMBLED
 * bundle (deterministic per source state; the time-based `yyyyMMdd.HHmm`
 * fallback fires ONLY when the git subprocess fails or times out) — so a
 * shipped bundle always carries a stamp that tells WHICH build is running
 * and never the raw placeholder. Same invocation discipline as the chunk
 * end-to-end test above.
 */
test('build injects the stamp: no @@BUILD_STAMP@@ residue, git/content-hash shape present', () => {
	const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, encoding: 'utf8' });
	assert.equal(result.status, 0, `the build failed:\n${result.stdout}\n${result.stderr}`);
	const client = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
	assert.equal(
		client.includes('@@BUILD_STAMP@@'),
		false,
		'the placeholder must never survive into the shipped bundle'
	);
	const stamp = /const BUILD_STAMP = "([^"]*)";/.exec(client)?.[1];
	assert.ok(stamp !== undefined, 'the bundle carries the replaced build stamp literal');
	assert.match(
		stamp,
		/^[0-9a-f]{7,40}\.[0-9a-f]{8}$/,
		'the stamp is <git short SHA>.<content hash8> (e.g. 16497eb.1a2b3c4d) — deterministic per source state'
	);
});

/**
 * The determinism pin: the stamp's second component is a hash over the
 * ASSEMBLED bundle output, not wall-clock time, so two builds of the same
 * sources at the same HEAD produce the same stamp and BYTE-IDENTICAL
 * client.js — a test run can no longer dirty the tree. Only a new commit
 * changes the SHA half, by design. Two consecutive real builds, same
 * invocation discipline as the tests above.
 */
test('build is deterministic: two consecutive builds stamp and byte-match', () => {
	const first = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, encoding: 'utf8' });
	assert.equal(first.status, 0, `the first build failed:\n${first.stdout}\n${first.stderr}`);
	const firstBundle = readFileSync(path.join(ROOT, 'client.js'));
	const second = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, encoding: 'utf8' });
	assert.equal(second.status, 0, `the second build failed:\n${second.stdout}\n${second.stderr}`);
	const secondBundle = readFileSync(path.join(ROOT, 'client.js'));
	const firstStamp = /const BUILD_STAMP = "([^"]*)";/.exec(firstBundle.toString('utf8'))?.[1];
	const secondStamp = /const BUILD_STAMP = "([^"]*)";/.exec(secondBundle.toString('utf8'))?.[1];
	assert.ok(firstStamp !== undefined && secondStamp !== undefined, 'both bundles carry the stamp literal');
	assert.equal(
		secondStamp,
		firstStamp,
		'same sources at the same HEAD must stamp identically — the stamp must carry no wall-clock component'
	);
	assert.ok(
		firstBundle.equals(secondBundle),
		'same sources at the same HEAD must rebuild a byte-identical client.js (the tree stays clean after a test run)'
	);
});
