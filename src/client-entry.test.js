import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
 * Match-highlight dictionary keys: the settings-center rows read their copy
 * through these seven keys, so BOTH inline dictionaries must carry them
 * (locale/*.json is intentionally NOT extended — the one-way sync tests
 * above only require the inline dictionaries to be supersets).
 */
const MATCH_HIGHLIGHT_KEYS = [
	'settings.matchHighlightGroup',
	'settings.wordHighlight',
	'settings.wordHighlightTitle',
	'settings.wordHighlightNote',
	'settings.selectionHighlight',
	'settings.selectionHighlightTitle',
	'settings.selectionHighlightNote'
];

test('the match-highlight keys exist in both inline zh and en dictionaries', () => {
	for (const name of ['zh', 'en']) {
		const span = dictionarySpan(ENTRY_TEXT, name);
		assert.ok(span !== null, `the ${name} dictionary was found in src/client-entry.js`);
		const missing = MATCH_HIGHLIGHT_KEYS.filter((key) => !span.includes(`'${key}':`));
		assert.deepEqual(
			missing,
			[],
			`match-highlight keys missing from the inline ${name} dictionary (the settings panel would show raw key names)`
		);
	}
});

/**
 * Build-fingerprint dictionary keys (the build stamp shown by the settings
 * center's About tail): BOTH inline dictionaries must carry the group title
 * and the row label, or `t()` ships raw key names. locale/*.json is
 * intentionally NOT extended — the same one-way sync as the match-highlight
 * keys above (the sync tests only require the inline dictionaries to be
 * supersets).
 */
const BUILD_INFO_KEYS = ['settings.buildInfoGroup', 'settings.buildInfo'];

test('the build-info keys exist in both inline zh and en dictionaries', () => {
	for (const name of ['zh', 'en']) {
		const span = dictionarySpan(ENTRY_TEXT, name);
		assert.ok(span !== null, `the ${name} dictionary was found in src/client-entry.js`);
		const missing = BUILD_INFO_KEYS.filter((key) => !span.includes(`'${key}':`));
		assert.deepEqual(
			missing,
			[],
			`build-info keys missing from the inline ${name} dictionary (the settings panel would show raw key names)`
		);
	}
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
	// Deleted-red scoping, components side: the red classes live on the TEXT
	// span only, and the deleted flag flows into the pure builder (whose tree
	// is asserted in tab-title-nodes.test.js) — never onto the icon span.
	assert.ok(
		COMPONENTS_TEXT.includes('buildTabTitleChildren({ h, iconNode, glyphHtml: TAB_TITLE_DISC_GLYPH_HTML, deleted, name })'),
		'the deleted flag flows into the pure builder call in src/components.js'
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
	// Edit badge wiring (0.16.0 follow-up): the title children are
	// built by the pure `buildTabTitleChildren` builder — the TREE assertions
	// live in `tab-title-nodes.test.js` (fake-h element tree); this file keeps
	// the wiring marker (call shape AND result usage), the CSS rules and the
	// red-scope rules.
	assert.ok(
		COMPONENTS_TEXT.includes('buildTabTitleChildren({ h, iconNode, glyphHtml: TAB_TITLE_DISC_GLYPH_HTML, deleted, name })'),
		'the tab title children builder is called in src/components.js'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('...children'),
		'the built children are actually spread into the rendered title span (guards a discarded result)'
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

/**
 * Match-highlight layer CSS (the `matchHighlight` prop's paint half): the
 * underlay must keep the textarea's exact advance widths (the whitespace
 * layer's declaration-for-declaration font quartet) or the tints drift off
 * their characters, the row ink stays transparent (the textarea paints the
 * glyphs), and the three run classes tint through the theme aliases —
 * word under label-primary, selection under brand-primary, both under the
 * two mixed. Class names and alias references are the contract; the mix
 * ratios are tuned look, deliberately not pinned.
 */
test('the match-highlight layer CSS is wired with the shared metrics and theme aliases', () => {
	const start = ENTRY_TEXT.indexOf('.dsh-editor-match {');
	assert.ok(start !== -1, 'the .dsh-editor-match container rule is present in src/client-entry.js');
	// The block sits between the highlight-bar rules and the whitespace
	// layer rules (the insertion contract), so it is scoped by the next
	// whitespace rule occurrence.
	const end = ENTRY_TEXT.indexOf('.dsh-editor-whitespace', start);
	assert.ok(end !== -1, 'the match rules sit before the whitespace layer rules');
	const block = ENTRY_TEXT.slice(start, end);
	for (const selector of ['.dsh-editor-match-row', '.dsh-editor-match-word', '.dsh-editor-match-selection', '.dsh-editor-match-both']) {
		assert.ok(block.includes(selector), `${selector} is present`);
	}
	const container = /\.dsh-editor-match\s*\{([^}]*)\}/.exec(block);
	assert.ok(container !== null, 'the container rule body was extracted');
	for (const decl of [
		'font-family: var(--dsw-font-mono, ui-monospace, monospace);',
		'font-size: 13px;',
		'line-height: 1.5;',
		'tab-size: 4;'
	]) {
		assert.ok(container[1].includes(decl), `the container carries ${decl}`);
	}
	const row = /\.dsh-editor-match-row\s*\{([^}]*)\}/.exec(block);
	assert.ok(row !== null, 'the row rule body was extracted');
	assert.ok(row[1].includes('white-space: pre;'), 'rows keep the exact advance (white-space: pre)');
	assert.ok(row[1].includes('color: transparent;'), 'the row ink stays invisible (the textarea paints the glyphs)');
	// Three references inside the block: selection + both + active for
	// brand-primary (the active tint — the live selection — is the
	// 2026-11-26 revision's strongest brand wash).
	assert.equal(
		(block.match(/color-mix\(in srgb, var\(--dsw-alias-label-primary\)/g) || []).length,
		2,
		'two label-primary mixes (the word tint and the both mix\'s base)'
	);
	assert.equal(
		(block.match(/color-mix\(in srgb, var\(--dsw-alias-brand-primary\)/g) || []).length,
		3,
		'three brand-primary mixes (the selection tint, the both mix, and the active tint)'
	);
});

/**
 * Active-tint CSS (2026-11-26 revision): the inkless variant's NATIVE
 * selection background is suppressed — it lays out on the invisible
 * regular-weight text, so with the token ink carrying styled advances it
 * floats off the glyphs (the user-visible misalignment this revision
 * fixes). The live selection's replacement visual — the -match-active
 * tint riding the token fragment stream — is the STRONGEST brand wash:
 * 30% vs the selection tint's 18% (the live selection reads stronger
 * than other matches, VS Code convention). The suppression is
 * inkless-scoped ONLY: plain-text mode keeps its native selection (it
 * aligns there — the zero-regression contract).
 */
test('the inkless ::selection suppression and the active tint rule are wired', () => {
	const inklessAt = ENTRY_TEXT.indexOf('.dsh-editor-area-inkless {');
	assert.ok(inklessAt !== -1, 'the inkless variant rule is present in src/client-entry.js');
	const suppression = '.dsh-editor-area-inkless::selection { background: transparent; }';
	const suppressionAt = ENTRY_TEXT.indexOf(suppression);
	assert.ok(suppressionAt !== -1, 'the inkless ::selection rule is present verbatim');
	assert.ok(
		suppressionAt > inklessAt && suppressionAt - inklessAt < 400,
		'the suppression sits with the inkless rule (the variant it scopes)'
	);
	assert.equal(
		(ENTRY_TEXT.match(/::selection/g) || []).length,
		1,
		'exactly ONE ::selection rule exists — scoped to the inkless variant only (plain-text keeps its native, aligned selection)'
	);
	const start = ENTRY_TEXT.indexOf('.dsh-editor-match {');
	assert.ok(start !== -1, 'the .dsh-editor-match container rule is present');
	const end = ENTRY_TEXT.indexOf('.dsh-editor-whitespace', start);
	assert.ok(end !== -1, 'the match rules sit before the whitespace layer rules');
	const block = ENTRY_TEXT.slice(start, end);
	assert.ok(
		block.includes('.dsh-editor-match-active { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }'),
		'the active tint rule sits with the match classes as the strongest brand wash (30% > the selection tint\'s 18%)'
	);
});

/* --------------------------- cm6 content-surface wiring (Task 10) -- */

/**
 * The code-highlight surface swap (Task 10): the built-in mode now mounts
 * `createCodeMirrorMode` (src/cm6/component.js), and the ENTRY keeps its
 * precedent discipline — it owns the ONLY lazy chunk transports (the
 * engine's language groups and the CM6 chunk) and hands the cm6 loader to
 * the component runtime, which `createEditorComponents` threads into the
 * mode factory (the factory marker itself lives in components.test.js).
 */
test('the entry wires the cm6 loader into the component runtime', () => {
	assert.ok(
		ENTRY_TEXT.includes("import { createCm6Loader } from './cm6/chunks.js'"),
		'the entry imports createCm6Loader from src/cm6/chunks.js'
	);
	const loaderAt = ENTRY_TEXT.indexOf('const cm6Loader = createCm6Loader({');
	assert.ok(loaderAt !== -1, 'the entry creates the cm6 loader beside the highlight engine singleton');
	const loaderEnd = ENTRY_TEXT.indexOf('});', loaderAt);
	assert.ok(loaderEnd !== -1, 'the loader creation is delimited');
	const loaderSpan = ENTRY_TEXT.slice(loaderAt, loaderEnd);
	assert.ok(
		loaderSpan.includes("requireAsync: (f) => require.async('./' + f)"),
		"the loader's transport is the entry-owned require.async('./' + f) call site"
	);
	assert.ok(loaderSpan.includes('log'), 'the loader logs through the entry log channel');
	const runtimeStart = ENTRY_TEXT.indexOf('const componentRuntime = {');
	assert.ok(runtimeStart !== -1, 'the component runtime object exists');
	const runtimeEnd = ENTRY_TEXT.indexOf('\n\t};', runtimeStart);
	assert.ok(runtimeEnd !== -1, 'the component runtime object is delimited');
	assert.ok(
		ENTRY_TEXT.slice(runtimeStart, runtimeEnd).includes('cm6Loader'),
		'the component runtime carries the cm6 loader (createEditorComponents threads it into the CM6 mode factory)'
	);
	// Transport discipline, Task 10 shape: exactly TWO require.async call
	// sites remain — the engine's language-group loader and the cm6 loader.
	assert.equal(
		(ENTRY_TEXT.match(/require\.async\('\.\//g) || []).length,
		2,
		"exactly two require.async('./' ...) transports exist (the engine's language groups + the cm6 chunk)"
	);
});

test('the retired code-highlight DOM shell is gone', () => {
	assert.equal(
		existsSync(path.join(HERE, 'mode-code-highlight.js')),
		false,
		'src/mode-code-highlight.js is deleted (the composition seam moved to src/cm6/component.js)'
	);
	assert.equal(
		COMPONENTS_TEXT.includes("from './mode-code-highlight.js'"),
		false,
		'components.js no longer imports the retired shell'
	);
	assert.equal(
		COMPONENTS_TEXT.includes('createCodeHighlightMode'),
		false,
		'the retired shell factory is no longer referenced'
	);
});

/**
 * R11 host CSS: the CM6 component renders `.dsh-editor-cm6` (root) and
 * `.dsh-editor-cm6-host` (the div the CodeMirror view mounts into with
 * `parent: host`), which have no layout rules of their own. The block
 * makes the root fill the mode slot exactly the way PlainTextMode's
 * `-inputwrap` does, the host fill the root, and the mounted
 * `.cm-editor` fill the host — otherwise the pane collapses.
 */
test('the STYLES template carries the cm6 root and host layout rules', () => {
	const root = /\.dsh-editor-cm6\s*\{([^}]*)\}/.exec(ENTRY_TEXT);
	assert.ok(root !== null, 'the .dsh-editor-cm6 root rule is present in src/client-entry.js');
	assert.ok(root[1].includes('flex: 1 1 auto;'), 'the root fills the mode slot');
	assert.ok(root[1].includes('min-height: 0;'), 'the root may shrink inside the pane');
	assert.ok(root[1].includes('display: flex;'), 'the root lays out its children');
	assert.ok(root[1].includes('flex-direction: column;'), 'the root stacks the loading visual above the host');
	assert.ok(root[1].includes('position: relative;'), 'the root positions its children');
	assert.ok(root[1].includes('background: var(--dsw-alias-bg-base);'), 'the root carries the base background (house tokens only)');
	const host = /\.dsh-editor-cm6-host\s*\{([^}]*)\}/.exec(ENTRY_TEXT);
	assert.ok(host !== null, 'the .dsh-editor-cm6-host rule is present');
	assert.ok(host[1].includes('flex: 1 1 auto;'), 'the host fills the root');
	assert.ok(host[1].includes('min-height: 0;'), 'the host may shrink inside the root');
	assert.ok(host[1].includes('position: relative;'), 'the host positions the view');
	const editor = /\.dsh-editor-cm6-host \.cm-editor\s*\{([^}]*)\}/.exec(ENTRY_TEXT);
	assert.ok(editor !== null, 'the .cm-editor sizing rule is present');
	assert.ok(editor[1].includes('height: 100%;'), 'the mounted CodeMirror editor fills the host');
});

/**
 * Migrated from src/mode-code-highlight.test.js (retired with the Task 10
 * surface swap): the registration block is pinned FIELD FOR FIELD — the
 * built-in `code-highlight` descriptor keeps its exact contract while the
 * component behind it changed surfaces (the effect name and all six
 * fields stay byte-identical; the plan's Global Constraints).
 */
test("the client entry registers 'code-highlight' with the builtin descriptor contract", () => {
	const start = ENTRY_TEXT.indexOf("id: 'code-highlight'");
	assert.ok(start !== -1, "a 'code-highlight' registration block exists in src/client-entry.js");
	const end = ENTRY_TEXT.indexOf("'dsh-editor: code-highlight mode'");
	assert.ok(end !== -1, "the registration effect is named 'dsh-editor: code-highlight mode'");
	const block = ENTRY_TEXT.slice(start, end);
	assert.ok(block.includes("priority: 'builtin'"), 'priority is builtin');
	assert.ok(block.includes('globs: deriveGlobs()'), 'globs come verbatim from deriveGlobs()');
	assert.ok(block.includes("contentKind: 'text'"), 'contentKind is text');
	assert.ok(block.includes('activeLine: true'), 'activeLine is declared');
	assert.ok(block.includes("label: () => boundT('mode.code')"), 'the label reads mode.code through boundT');
	assert.ok(block.includes('component: editorComponents.CodeHighlightMode'), 'the component is the editor components CodeHighlightMode');
	// Registration order: the code-highlight effect sits immediately after the plain-text one.
	const plainAt = ENTRY_TEXT.indexOf("'dsh-editor: plain-text mode'");
	assert.ok(plainAt !== -1 && plainAt < start, 'the plain-text registration exists before it');
});

/**
 * Migrated from src/mode-code-highlight.test.js: the label the
 * registration block above reads (`boundT('mode.code')`) needs both
 * inline dictionaries — the registration survived the surface swap, so
 * its translation guard survives with it.
 */
test('the inline zh/en dictionaries carry mode.code in both languages', () => {
	for (const [dictionary, value] of [
		['zh', '代码高亮'],
		['en', 'Code highlight'],
	]) {
		const start = ENTRY_TEXT.indexOf(`const ${dictionary} = {`);
		assert.ok(start !== -1, `the ${dictionary} dictionary exists`);
		const end = ENTRY_TEXT.indexOf('\n};', start);
		const span = ENTRY_TEXT.slice(start, end);
		assert.ok(span.includes(`'mode.code': '${value}'`), `the inline ${dictionary} dictionary carries mode.code = ${value}`);
	}
});
