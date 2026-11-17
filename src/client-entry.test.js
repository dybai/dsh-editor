import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locale dual-source sync guard: the settings panel's `t()` reads the
 * dictionaries REGISTERED BY THE CLIENT — the `const zh` / `const en`
 * objects inlined in `src/client-entry.js` (bundled at build time) — while
 * `locale/*.json` carries the same strings for the Host-side plugin-manager
 * display. The two sources must stay key-identical: adding a row to the
 * JSON files without the inline dictionary ships raw key names in the UI
 * (`t()` falls back to the key). This test reads the entry FILE TEXT (the
 * module itself is React-dependent and not importable under node:test).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_TEXT = readFileSync(path.join(HERE, 'client-entry.js'), 'utf8');

/** Flatten a nested JSON object into dot-joined key paths. */
function flattenKeys(node, prefix, out) {
	for (const key of Object.keys(node)) {
		const value = node[key];
		const path = prefix === '' ? key : `${prefix}.${key}`;
		if (value !== null && typeof value === 'object') flattenKeys(value, path, out);
		else out.push(path);
	}
	return out;
}

/** The source span of one inline dictionary (`const zh = {` … its closing brace). */
function dictionarySpan(source, name) {
	const start = source.indexOf(`const ${name} = {`);
	if (start === -1) return null;
	const end = source.indexOf('\n};', start);
	if (end === -1) return null;
	return source.slice(start, end);
}

function assertDictionariesInSync(dictionaryName, jsonFileName) {
	const json = JSON.parse(readFileSync(path.join(HERE, '../locale', jsonFileName), 'utf8'));
	const keys = flattenKeys(json, '', []);
	const span = dictionarySpan(ENTRY_TEXT, dictionaryName);
	assert.ok(span !== null, `the ${dictionaryName} dictionary was found in src/client-entry.js`);
	const missing = keys.filter((key) => !span.includes(`'${key}':`));
	assert.deepEqual(missing, [], `keys present in locale/${jsonFileName} but missing from the inline ${dictionaryName} dictionary (the settings panel would show raw key names)`);
}

test('the inline zh dictionary carries every locale/zh.json key', () => {
	assertDictionariesInSync('zh', 'zh.json');
});

test('the inline en dictionary carries every locale/en.json key', () => {
	assertDictionariesInSync('en', 'en.json');
});
