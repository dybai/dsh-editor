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
 * - Supported module syntax: single-line `import { a, b as c } from './x.js'`
 *   or `import * as ns from './x.js'` (relative, under src/) and named export
 *   declarations only; anything else fails the build with the offending line.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';

const PACKAGE_ID = '@dybai/dsh-editor';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const ENTRY = path.join(SRC_DIR, 'client-entry.js');
const OUT = path.join(ROOT, 'client.js');
const FACTORY_RESERVED = new Set(['require', 'module', 'exports']);

const IMPORT_FROM_RE = /^[ \t]*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/;
const EXPORT_NAME_RE = /^export (?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DECLARE_RE = /^export (?=(?:async\s+)?(?:function|const|class|let|var)\b)/gm;

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
	const exportedNames = [...body.matchAll(EXPORT_NAME_RE)].map((match) => match[1]);
	const stripped = body.replace(EXPORT_DECLARE_RE, '');
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

const output = `/* Generated by scripts/build.mjs - do not edit. */
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
 * Execute the bundle exactly the way web boot does: register through
 * `window.__ModuleLoader__`, then run the factory. Syntax checking alone is
 * not enough — a stray backtick inside a stylesheet template literal can
 * produce valid JS (`` `css` - gutter - rule `css` ``) that throws a
 * ReferenceError at module evaluation, which still fails the dynamic import.
 * @param script - the compiled bundle.
 */
function smokeTest(script) {
	const stub = inertStub();
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
		fetch: () => stub
	});
	script.runInContext(context);
	if (spec === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load()');
	const api = spec.factory(() => stub);
	if (typeof api?.apply !== 'function') throw new Error('the bundle did not export apply(ctx)');
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

writeFileSync(OUT, output);
console.log(`built ${rel(OUT)} from ${rel(ENTRY)} (${order.length} module${order.length === 1 ? '' : 's'})`);
