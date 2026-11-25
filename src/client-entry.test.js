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
const COMPONENTS_TEXT = readFileSync(path.join(HERE, 'components.js'), 'utf8');

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

/**
 * Tab-title icon guard (0.15.0, final-review fix): the wiring markers AND the
 * deleted-red scoping are pinned at source-text level — the same discipline
 * as the locale guard above. `src/components.js` is React-requiring and not
 * importable under node:test, so its wiring is guarded textually.
 */
test('the tab-title icon wiring and deleted-red scoping survive refactors', () => {
	// Wiring layer (spec §9): degradation depends on these three markers —
	// without them a refactor silently drops the icon or its fallback.
	assert.ok(
		COMPONENTS_TEXT.includes("require('@deepseek-ai/dsh-client-ui-primitives')"),
		'the guarded primitives require is present in src/components.js'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('resolveFileTypeIconApi('),
		'the api resolver is wired in src/components.js'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('tabTitleIconProps('),
		'the icon props builder is wired in src/components.js'
	);
	assert.ok(
		ENTRY_TEXT.includes('.dsh-editor-tabtitle-icon { flex: none; }'),
		'the title-icon CSS rule is present in src/client-entry.js'
	);
	// Deleted-red scoping: CSS color inherits through `display: contents`, and
	// the host draws monochrome icon kinds with `currentColor` — so the error
	// color / line-through must live on a TEXT-ONLY descendant span, never on
	// the span that contains the icon.
	assert.equal(
		COMPONENTS_TEXT.includes('${CLASS}-tabtitle-deleted'),
		false,
		'the deleted variant must not sit on the icon-bearing title span in src/components.js'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('${CLASS}-tabtitle-text-deleted'),
		'the deleted variant targets the text-only inner span in src/components.js'
	);
	assert.ok(
		ENTRY_TEXT.includes('.dsh-editor-tabtitle-text-deleted'),
		'the text-scoped deleted rule is present in src/client-entry.js'
	);
	assert.equal(
		ENTRY_TEXT.includes('.dsh-editor-tabtitle-deleted {'),
		false,
		'the old icon-bearing deleted rule is gone from src/client-entry.js'
	);
	// Edit badge wiring (0.16.0): the iconwrap + editdisc nodes ride the same
	// gate as the icon itself, and the derived glyph constant is referenced.
	assert.ok(
		COMPONENTS_TEXT.includes('TAB_TITLE_DISC_GLYPH_HTML'),
		'the disc glyph constant is referenced in src/components.js'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('${CLASS}-tabtitle-iconwrap'),
		'the iconwrap wrapper is wired in src/components.js'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('${CLASS}-tabtitle-editdisc'),
		'the editdisc node is wired in src/components.js'
	);
	const editdiscProps = COMPONENTS_TEXT.match(/tabtitle-editdisc`,\s*\n\s*([\s\S]*?)\n\s*\}\)/);
	assert.ok(editdiscProps !== null, 'the editdisc node props are present in src/components.js');
	assert.ok(
		editdiscProps[1].includes('aria-hidden'),
		'the editdisc node is aria-hidden (decorative), like every other decorative svg in this file'
	);
	assert.ok(
		ENTRY_TEXT.includes('.dsh-editor-tabtitle-iconwrap'),
		'the iconwrap CSS rule is present in src/client-entry.js'
	);
	assert.ok(
		ENTRY_TEXT.includes('.dsh-editor-tabtitle-editdisc'),
		'the editdisc CSS rule is present in src/client-entry.js'
	);
	assert.equal(
		ENTRY_TEXT.includes('data-ds-dark-theme] .dsh-editor-tabtitle-editdisc'),
		false,
		'the disc is theme-invariant by ruling — no dark override may exist in src/client-entry.js'
	);
});
