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
});
