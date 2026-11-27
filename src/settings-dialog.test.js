import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-level guards for `src/settings-dialog.js` — the same discipline as
 * `components.test.js`: the module itself requires React and is not
 * importable under node:test, so the appearance registry wiring whose
 * absence would silently degrade (not crash) is pinned as text markers.
 *
 * This file pins the match-highlight group: the two boolean rows
 * (`wordHighlight` / `selectionHighlight`) appended after the ruler row,
 * the first carrying `groupTitleKey` — the same grouping mechanism the
 * whitespace trio and the ruler row use on their first rows. The row `key`
 * spellings are load-bearing (`BooleanSettingsSection` reads/writes the
 * settings cache by them), so they are asserted verbatim against the
 * settings keys the host validator accepts.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_TEXT = readFileSync(path.join(HERE, 'settings-dialog.js'), 'utf8');
const ENTRY_TEXT = readFileSync(path.join(HERE, 'client-entry.js'), 'utf8');

/** The source span of the frozen APPEARANCE_ROWS array. */
function appearanceRowsSpan() {
	const start = DIALOG_TEXT.indexOf('const APPEARANCE_ROWS = Object.freeze([');
	assert.ok(start !== -1, 'APPEARANCE_ROWS was found in src/settings-dialog.js');
	const end = DIALOG_TEXT.indexOf('\n]);', start);
	assert.ok(end !== -1, 'the APPEARANCE_ROWS array body was delimited');
	return DIALOG_TEXT.slice(start, end);
}

/** A row object's verbatim text (tab-indented like the rest of the array). */
function rowText(properties) {
	return ['\t{', ...properties.map((line) => `\t\t${line}`), '\t}'].join('\n');
}

test('the appearance rows end with the match-highlight group after the ruler row', () => {
	const rows = appearanceRowsSpan();

	// The group title opens on the FIRST new row, in the established
	// property order (groupTitleKey, key, labelKey, titleKey, noteKey).
	assert.ok(
		rows.includes(
			rowText([
				"groupTitleKey: 'settings.matchHighlightGroup',",
				"key: 'wordHighlight',",
				"labelKey: 'settings.wordHighlight',",
				"titleKey: 'settings.wordHighlightTitle',",
				"noteKey: 'settings.wordHighlightNote'"
			])
		),
		'the wordHighlight row (group title + label/title/note keys, in property order) is present in APPEARANCE_ROWS'
	);
	assert.ok(
		rows.includes(
			rowText([
				"key: 'selectionHighlight',",
				"labelKey: 'settings.selectionHighlight',",
				"titleKey: 'settings.selectionHighlightTitle',",
				"noteKey: 'settings.selectionHighlightNote'"
			])
		),
		'the selectionHighlight row (label/title/note keys, in property order) is present in APPEARANCE_ROWS'
	);

	// Ordering: both rows come after the showRuler row (which closes the
	// ruler group), and wordHighlight precedes selectionHighlight.
	const rulerRow = rows.indexOf("key: 'showRuler',");
	const wordHighlightRow = rows.indexOf("key: 'wordHighlight',");
	const selectionHighlightRow = rows.indexOf("key: 'selectionHighlight',");
	assert.ok(rulerRow !== -1, 'the showRuler row was found in APPEARANCE_ROWS');
	assert.ok(wordHighlightRow > rulerRow, 'the wordHighlight row comes AFTER the showRuler row');
	assert.ok(
		selectionHighlightRow > wordHighlightRow,
		'the selectionHighlight row comes AFTER the wordHighlight row'
	);
});

/**
 * The About tail (the build fingerprint): the settings center must show
 * WHICH build is running (same version number, different builds), so the
 * dialog's render tail — after the section registry's content — carries a
 * non-interactive group titled `settings.buildInfoGroup` whose one row shows
 * `<version>+<stamp>` from `runtime.buildInfo`. Same source-guard discipline
 * as above: the module is React-requiring and not importable under
 * node:test.
 */

/** The source span of one inline dictionary (`const zh = {` … its closing brace). */
function entryDictionarySpan(name) {
	const start = ENTRY_TEXT.indexOf(`const ${name} = {`);
	assert.ok(start !== -1, `the ${name} dictionary was found in src/client-entry.js`);
	const end = ENTRY_TEXT.indexOf('\n};', start);
	assert.ok(end !== -1, `the ${name} dictionary body was delimited`);
	return ENTRY_TEXT.slice(start, end);
}

test('the buildInfoGroup entry exists in both inline zh and en dictionaries', () => {
	for (const name of ['zh', 'en']) {
		const span = entryDictionarySpan(name);
		assert.ok(
			span.includes("'settings.buildInfoGroup':"),
			`settings.buildInfoGroup is present in the inline ${name} dictionary (t() would fall back to the raw key)`
		);
	}
});

test('the SettingsDialog render tail carries the About group reading runtime.buildInfo', () => {
	const start = DIALOG_TEXT.indexOf('export function SettingsDialog(props)');
	assert.ok(start !== -1, 'the SettingsDialog component was found in src/settings-dialog.js');
	const render = DIALOG_TEXT.slice(start);
	assert.ok(render.includes("t('settings.buildInfoGroup')"), 'the About group title is rendered through its dictionary key');
	assert.ok(render.includes("t('settings.buildInfo')"), 'the build-version label is rendered through its dictionary key');
	assert.ok(render.includes('runtime.buildInfo'), 'the About row reads runtime.buildInfo');
	assert.ok(
		render.includes('`${runtime.buildInfo.version}+${runtime.buildInfo.stamp}`'),
		'the displayed value is the pinned `<version>+<stamp>` composition (e.g. 0.19.0+16497eb.0231)'
	);
});
