/**
 * Bundle the browser half into `client.js` in the `__ModuleLoader__` shape.
 *
 * - Walks `src/client-entry.js` and its relative imports (files under `src/`
 *   only), ordered topologically: dependencies first, entry last.
 * - Each dependency is wrapped as a closure `const <id> = (function () { … })()`
 *   (identifier from the basename, kebab-case → camelCase) whose named export
 *   declarations are assigned onto its `module.exports`; its import lines are
 *   rewritten to destructuring bindings of the dependency closures.
 * - Closure identifiers are internal to the bundle: when one would collide
 *   with an import binding (e.g. `import * as lines from './lines.js'`), the
 *   closure is renamed (`lines$`) and every generated reference follows.
 * - The entry body is inlined directly inside `factory(require)` so it may
 *   call `require('react')` for bare packages, and its exports are assigned
 *   onto the factory's `module.exports`, which the loader returns.
 * - One loader chunk per vendored language group (`client.lang-web.js`,
 *   `client.lang-script.js`, `client.lang-system.js`, `client.lang-data.js`)
 *   is emitted next to `client.js`: each is its own
 *   `window.__ModuleLoader__.load(...)` script wrapping the self-contained
 *   vendored body (gated import-free by scripts/chunk-gate.js) and exporting
 *   `{ languages }` for the client's lazy chunk loader. Chunks deliberately
 *   skip the module-graph walk — they have no relative imports.
 * - Supported module syntax: single-line `import { a, b as c } from './x.js'`
 *   or `import * as ns from './x.js'` (relative, under src/), named export
 *   declarations, and esbuild's minified `export{<ident> as <name>};` blocks
 *   (the vendored files' shape, reduced to plain bindings); anything else
 *   fails the build with the offending line.
 * - The build stamp (the build fingerprint): the entry's
 *   `'@@BUILD_STAMP@@'` placeholder literal is swapped for
 *   `<git short SHA>.<UTC HHmm>` (fallback `yyyyMMdd.HHmm` when the git
 *   subprocess fails or times out) and any surviving placeholder fails the
 *   build, so every shipped bundle carries a distinguishable stamp.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script, createContext } from 'node:vm';
import { IMPORT_FROM_RE, assertChunkSelfContained } from './chunk-gate.js';

const PACKAGE_ID = '@dybai/dsh-editor';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const ENTRY = path.join(SRC_DIR, 'client-entry.js');
const OUT = path.join(ROOT, 'client.js');
const FACTORY_RESERVED = new Set(['require', 'module', 'exports']);

/**
 * The lazy language groups and their vendored sources, one emitted loader
 * chunk per group (`client.lang-<group>.js` next to `client.js`). Group
 * names and chunk file names must stay in sync with `CHUNK_GROUP_FILES` in
 * src/highlight/chunks.js — the table the client's chunk loader reads.
 */
const CHUNK_SOURCES = {
	web: 'src/vendor/lang-web.js',
	script: 'src/vendor/lang-script.js',
	system: 'src/vendor/lang-system.js',
	data: 'src/vendor/lang-data.js'
};

const EXPORT_NAME_RE = /^export (?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DECLARE_RE = /^export (?=(?:async\s+)?(?:function|const|class|let|var)\b)/gm;

/**
 * esbuild's minified export statement — `export{<ident> as <name>, <ident2>};`
 * — the shape the vendored files (src/vendor/*) ship. It is no export
 * DECLARATION, so the scanner above never sees it; loadModule reduces it to
 * plain binding declarations (`var <name> = <ident>;…`): the names join
 * exportedNames and the closure emit's `Object.assign(module.exports, …)`
 * picks them up unchanged. Machine-generated vendored files only — the match
 * is deliberately simple (no brace nesting, no comments inside the block).
 */
const EXPORT_BLOCK_RE = /\bexport\s*\{([^}]*)\}\s*;/g;

/** Reduce every export block to `var` declarations, collecting the names. */
function reduceExportBlocks(body, file, names) {
	return body.replace(EXPORT_BLOCK_RE, (raw, specifiers) => {
		const parts = specifiers
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part !== '');
		if (parts.length === 0) throw new Error(`${rel(file)}: empty export block "${raw.trim()}"`);
		const declarations = [];
		for (const part of parts) {
			const renamed = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
			const source = renamed !== null ? renamed[1] : part;
			const local = renamed !== null ? renamed[2] : part;
			if (!/^[A-Za-z_$][\w$]*$/.test(source) || !/^[A-Za-z_$][\w$]*$/.test(local)) {
				throw new Error(`${rel(file)}: unsupported export specifier "${part}"`);
			}
			names.push(local);
			declarations.push(`var ${local} = ${source};`);
		}
		return declarations.join('');
	});
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

function parseImportClause(clause, file) {
	const trimmed = clause.trim();
	const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
	if (namespace !== null) return { kind: 'namespace', local: namespace[1] };
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		const specifiers = trimmed
			.slice(1, -1)
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part !== '')
			.map((part) => {
				const renamed = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
				if (renamed !== null) return { imported: renamed[1], local: renamed[2] };
				if (/^[A-Za-z_$][\w$]*$/.test(part)) return { imported: part, local: part };
				throw new Error(`${rel(file)}: unsupported import specifier "${part}"`);
			});
		return { kind: 'named', specifiers };
	}
	throw new Error(`${rel(file)}: unsupported import "${trimmed}" — named or namespace imports only; require() bare packages in the module body`);
}

function resolveRelative(specifier, importer) {
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
		throw new Error(`${rel(importer)}: bare import "${specifier}" is not bundled; import only relative './x.js' paths and require() bare packages in the module body`);
	}
	const target = path.resolve(path.dirname(importer), specifier);
	const within = path.relative(SRC_DIR, target);
	if (within.startsWith('..') || path.isAbsolute(within)) {
		throw new Error(`${rel(importer)}: import "${specifier}" escapes src/; only files under src/ are bundled`);
	}
	return target;
}

function baseIdOf(file) {
	const base = path.basename(file, '.js');
	const id = base
		.split('-')
		.map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join('');
	if (!/^[A-Za-z_$][\w$]*$/.test(id)) throw new Error(`${rel(file)}: cannot derive a closure identifier from "${base}"`);
	return id;
}

/** Strip imports/exports from one module's source and record its bindings. */
function loadModule(file) {
	const source = readFileSync(file, 'utf8');
	const importBindings = [];
	const dependencies = [];
	const lines = [];
	for (const line of source.split('\n')) {
		const from = IMPORT_FROM_RE.exec(line);
		if (from !== null) {
			const [, clause, specifier] = from;
			const dependency = resolveRelative(specifier, file);
			dependencies.push(dependency);
			importBindings.push({ dependency, ...parseImportClause(clause, file) });
			continue;
		}
		lines.push(line);
	}
	const body = lines.join('\n');
	// esbuild export statements (the vendored files' shape) reduce to plain
	// bindings BEFORE everything else reads the body — the names land in
	// exportedNames, the unsupported-syntax check never sees them, and the
	// closure emit assigns them exactly like `export const` declarations.
	const exportBlockNames = [];
	const reducedBody = reduceExportBlocks(body, file, exportBlockNames);
	const exportedNames = [...reducedBody.matchAll(EXPORT_NAME_RE)].map((match) => match[1]).concat(exportBlockNames);
	const stripped = reducedBody.replace(EXPORT_DECLARE_RE, '');
	const unsupported = stripped.match(/^[ \t]*(?:export|import)\b[^\n]*/m);
	if (unsupported !== null) {
		throw new Error(
			`${rel(file)}: unsupported module syntax for the bundler: "${unsupported[0].trim()}" (single-line named imports and named export declarations only)`
		);
	}
	return { file, baseId: baseIdOf(file), importBindings, body: stripped, exportedNames, dependencies };
}

const modules = new Map();
const order = [];

function collect(file, trail) {
	if (trail.includes(file)) throw new Error(`import cycle: ${[...trail, file].map(rel).join(' -> ')}`);
	if (modules.has(file)) return;
	const mod = loadModule(file);
	modules.set(file, mod);
	for (const dependency of mod.dependencies) collect(dependency, [...trail, file]);
	order.push(file);
}

collect(ENTRY, []);

// Every import binding is validated against what its dependency exports, so
// a typo fails the build instead of shipping an undefined binding.
for (const file of order) {
	for (const binding of modules.get(file).importBindings) {
		if (binding.kind !== 'named') continue;
		const available = modules.get(binding.dependency).exportedNames;
		for (const { imported } of binding.specifiers) {
			if (!available.includes(imported)) {
				throw new Error(`${rel(file)}: "${imported}" is not exported by ${rel(binding.dependency)} (available: ${available.join(', ') || 'none'})`);
			}
		}
	}
}

const entry = modules.get(ENTRY);
if (!entry.exportedNames.includes('apply')) {
	throw new Error(`${rel(ENTRY)}: the client entry must export "apply" (the loader calls exports.apply(ctx))`);
}

// Import binding locals share scope with the dependency closures (the entry's
// bindings sit in the factory body; a dependency's bindings sit in its own
// closure whose initializer still reads the outer closure identifier), and the
// entry's own export declarations sit in the factory body too — so no closure
// identifier may equal any of those names.
const reserved = new Set(entry.exportedNames);
for (const file of order) {
	for (const binding of modules.get(file).importBindings) {
		const locals = binding.kind === 'namespace' ? [binding.local] : binding.specifiers.map((s) => s.local);
		for (const local of locals) {
			if (FACTORY_RESERVED.has(local)) {
				throw new Error(`${rel(file)}: import binding "${local}" collides with the factory scope; pick another local name`);
			}
			reserved.add(local);
		}
	}
}

const ids = new Map();
for (const file of order) {
	let id = modules.get(file).baseId;
	while (reserved.has(id) || ids.has(id)) id += '$';
	ids.set(file, id);
}

/** The rewritten import statements of a module, as emitted code lines. */
function bindingLines(mod) {
	return mod.importBindings.map((binding) => {
		const id = ids.get(binding.dependency);
		if (binding.kind === 'namespace') return `const ${binding.local} = ${id};`;
		const properties = binding.specifiers.map((s) => (s.local === s.imported ? s.imported : `${s.imported}: ${s.local}`));
		return `const { ${properties.join(', ')} } = ${id};`;
	});
}

function indentBlock(text, prefix) {
	return text
		.split('\n')
		.map((line) => (line.trim() === '' ? '' : prefix + line))
		.join('\n');
}

function moduleBody(mod) {
	const bindings = bindingLines(mod);
	return bindings.length === 0 ? mod.body : `${bindings.join('\n')}\n\n${mod.body}`;
}

/** The generated `export{<ident> as languages};` of an esbuild-bundled group. */
const LANG_BLOCK_EXPORT_RE = /[ \t]*export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+languages\s*\}\s*;?[ \t]*(?=\n?$)/;

/**
 * The closure body of one language chunk. The source is run through the
 * regular `loadModule` (whose import stripping the gate has already made a
 * no-op — a vendor file with an import line fails the gate above), then its
 * single export becomes a plain `languages` binding so the emitted
 * `Object.assign(module.exports, { languages })` picks the grammar table up.
 * The vendored files are esbuild ESM output, so the export is a trailing
 * `export{<ident> as languages};` rather than an `export const` declaration;
 * both shapes reduce to the same binding.
 */
function chunkBodyOf(file) {
	assertChunkSelfContained(readFileSync(file, 'utf8'), rel(file));
	const mod = loadModule(file);
	if (mod.exportedNames.includes('languages')) return mod.body; // `export const languages = …` — loadModule already stripped the keyword
	const trailing = LANG_BLOCK_EXPORT_RE.exec(mod.body);
	if (trailing === null) {
		throw new Error(`${rel(file)}: no languages export — expected \`export const languages = …\` or a trailing \`export{<ident> as languages};\``);
	}
	// Replacer function, so a `$`-bearing minified identifier survives verbatim.
	return mod.body.replace(LANG_BLOCK_EXPORT_RE, () => `var languages = ${trailing[1]};`);
}

/** The full loader script for one language chunk (same shape as `client.js`). */
function chunkOutput(group, body) {
	return `/* Generated by scripts/build.mjs - do not edit. */
window.__ModuleLoader__.load({
	id: '${PACKAGE_ID}',
	chunk: 'client.lang-${group}.js',
	factory(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

${indentBlock(body, '			')}
		Object.assign(module.exports, { languages });
		return module.exports;
	}
});
`;
}

const parts = [];
for (const file of order) {
	if (file === ENTRY) continue;
	const mod = modules.get(file);
	parts.push(`		/* ${rel(file)} */`);
	parts.push(`		const ${ids.get(file)} = (function () {`);
	parts.push(`			var module = { exports: {} };`);
	parts.push(`			var exports = module.exports;`);
	parts.push(indentBlock(moduleBody(mod), '			'));
	parts.push(`			Object.assign(module.exports, { ${mod.exportedNames.join(', ')} });`);
	parts.push(`			return module.exports;`);
	parts.push(`		})();`);
	parts.push('');
}
parts.push(`		/* ${rel(ENTRY)} (entry; inlined: require() is in scope here) */`);
parts.push(indentBlock(moduleBody(entry), '		'));
parts.push(`		Object.assign(module.exports, { ${entry.exportedNames.join(', ')} });`);

let output = `/* Generated by scripts/build.mjs - do not edit. */
window.__ModuleLoader__.load({
	id: '${PACKAGE_ID}',
	factory(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

${parts.join('\n')}
		return module.exports;
	}
});
`;

/**
 * The build stamp (the build fingerprint): `<git short SHA>.<UTC HHmm>` — the
 * UTC minutes slice straight off the ISO time, the short SHA from one
 * `git rev-parse --short HEAD` subprocess (5s timeout). A failed or timed-out
 * subprocess (git missing, no repo, wedged checkout) degrades to the ISO
 * date + the same UTC minutes (`yyyyMMdd.HHmm`), so a portable build never
 * blocks on git and the stamp always carries SOME build-time signal.
 */
function buildStamp() {
	const iso = new Date().toISOString();
	const utcHmm = iso.slice(11, 16).replace(':', '');
	const fallback = `${iso.slice(0, 10).replace(/-/g, '')}.${utcHmm}`;
	const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 });
	const sha = typeof result.stdout === 'string' ? result.stdout.trim() : '';
	return result.error === undefined && result.status === 0 && /^[0-9a-f]{7,40}$/.test(sha) ? `${sha}.${utcHmm}` : fallback;
}

// The bundle must never SHIP the placeholder: swap the quoted literal (the
// exact source shape `const BUILD_STAMP = '@@BUILD_STAMP@@';`) for the JSON
// string, then gate — any residue (quoting drift in the source, a second
// literal) fails the build instead of shipping a build the user cannot tell
// apart from another.
output = output.replace("'@@BUILD_STAMP@@'", JSON.stringify(buildStamp()));
if (output.includes('@@BUILD_STAMP@@')) {
	throw new Error(`${rel(OUT)}: the build stamp placeholder survived the bundle — failing the build (stamp gate)`);
}

// An inert stand-in for anything the browser supplies: callable,
// constructable (React.Component is used as a superclass), and safe to read
// any property from. Symbol keys are forwarded so @@toPrimitive etc. stay
// out of the way.
function inertStub() {
	const stub = new Proxy(function () {}, {
		get(target, key) {
			if (typeof key === 'symbol') return Reflect.get(target, key);
			return stub;
		},
		apply: () => stub,
		construct: () => stub
	});
	return stub;
}

/**
 * Execute a generated loader script exactly the way web boot does: register
 * through `window.__ModuleLoader__` in a stub browser context and hand back
 * the recorded registration plus a stub `require` — callable and
 * constructable like `inertStub`, with an `.async` function property matching
 * `ClientBundleRequire` (the lazy chunk loader calls `require.async`).
 * Syntax checking alone is not enough — a stray backtick inside a stylesheet
 * template literal can produce valid JS (`` `css` - gutter - rule `css` ``)
 * that throws a ReferenceError at module evaluation, which still fails the
 * dynamic import.
 * @param script - the compiled loader script.
 */
function runRegistered(script) {
	const stub = inertStub();
	const require = () => stub;
	require.async = () => Promise.resolve(stub);
	let spec;
	const window = new Proxy(
		{},
		{
			get: (target, key) =>
				key === '__ModuleLoader__' ? { load: (loaded) => (spec = loaded) } : stub
		}
	);
	const document = new Proxy({}, { get: () => stub });
	const context = createContext({
		console,
		window,
		document,
		navigator: stub,
		location: stub,
		localStorage: stub,
		sessionStorage: stub,
		setTimeout: () => 0,
		clearTimeout: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		queueMicrotask: () => {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		fetch: () => stub,
		// Web-standard encoders the vendored Shiki core instantiates at module
		// init (its unicode tables); the real web runtime has them as globals,
		// so the smoke context does too.
		TextEncoder,
		TextDecoder
	});
	script.runInContext(context);
	return { spec, require };
}

/** Entry smoke: the bundle registers and its factory exports `apply(ctx)`. */
function smokeTest(script) {
	const { spec, require } = runRegistered(script);
	if (spec === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load()');
	const api = spec.factory(require);
	if (typeof api?.apply !== 'function') throw new Error('the bundle did not export apply(ctx)');
}

/**
 * Chunk smoke: a chunk must register itself under its own chunk name and its
 * factory must return exports carrying a non-empty `languages` record — the
 * two things the client's chunk loader (`src/highlight/chunks.js`) resolves
 * and the highlight engine consumes.
 * @param script - the compiled chunk script.
 * @param chunkFile - the chunk name the registration must carry.
 */
function smokeChunkTest(script, chunkFile) {
	const { spec, require } = runRegistered(script);
	if (spec === undefined) throw new Error('the chunk never called window.__ModuleLoader__.load()');
	if (spec.chunk !== chunkFile) throw new Error(`the chunk registered ${JSON.stringify(spec.chunk)} instead of ${JSON.stringify(chunkFile)}`);
	const languages = spec.factory(require)?.languages;
	if (languages === null || typeof languages !== 'object' || Object.keys(languages).length === 0) {
		throw new Error('the chunk did not export a non-empty languages record');
	}
}

// Compile AND load before writing: a source-level mistake (e.g. an unescaped
// backtick inside the stylesheet template literal) would otherwise ship as a
// bundle whose dynamic import fails at web boot, taking the whole profile down.
let script;
try {
	script = new Script(output, { filename: rel(OUT) });
} catch (error) {
	throw new Error(`${rel(OUT)}: the generated bundle is not valid JavaScript: ${error?.message ?? String(error)}`);
}
try {
	smokeTest(script);
} catch (error) {
	throw new Error(`${rel(OUT)}: the generated bundle fails to load (what web boot would hit): ${error?.message ?? String(error)}`);
}

// The language chunks: a SEPARATE section that skips the module-graph walk —
// each vendored group is self-contained by construction (gated above), so each
// chunk is just its body wrapped in the same factory shape as the entry.
// Compile AND load every chunk before writing anything, so a broken chunk
// fails the whole build instead of shipping half the set.
const chunks = [];
for (const [group, sourceFile] of Object.entries(CHUNK_SOURCES)) {
	const chunkFile = `client.lang-${group}.js`;
	const generated = chunkOutput(group, chunkBodyOf(path.join(ROOT, sourceFile)));
	let chunkScript;
	try {
		chunkScript = new Script(generated, { filename: chunkFile });
	} catch (error) {
		throw new Error(`${chunkFile}: the generated chunk is not valid JavaScript: ${error?.message ?? String(error)}`);
	}
	try {
		smokeChunkTest(chunkScript, chunkFile);
	} catch (error) {
		throw new Error(`${chunkFile}: the generated chunk fails to load (what web boot would hit): ${error?.message ?? String(error)}`);
	}
	chunks.push([chunkFile, generated]);
}

// client.js is rewritten unconditionally on EVERY build — even when its bytes
// are unchanged — because the loader revision is derived from the entry file:
// advancing it busts the browser caches of the client.lang-*.js chunks fetched
// under that revision whenever chunk bytes change.
writeFileSync(OUT, output);
for (const [chunkFile, generated] of chunks) writeFileSync(path.join(ROOT, chunkFile), generated);

console.log(
	`built ${rel(OUT)} from ${rel(ENTRY)} (${order.length} module${order.length === 1 ? '' : 's'}) + ${chunks.length} language chunk${chunks.length === 1 ? '' : 's'}`
);
