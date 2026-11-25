/**
 * Self-containment gate for the generated language chunks (spec task 5).
 *
 * The four vendored group modules (`src/vendor/lang-<group>.js`) ship as
 * standalone loader chunks: each chunk file is its own
 * `window.__ModuleLoader__.load(...)` script, fetched and evaluated at web
 * runtime with no bundler around it — so a single relative import would break
 * the dynamic load. `build.mjs` gates every chunk source through
 * `assertChunkSelfContained` before emission.
 *
 * This is its own module (instead of living inside build.mjs) so the gate is
 * unit-testable without running a build: build.mjs is a script with top-level
 * side effects and cannot be imported.
 *
 * `IMPORT_FROM_RE` is THE bundler's import syntax — the exact pattern
 * build.mjs uses to recognize (and rewrite) import lines during the
 * module-graph walk. It lives here and build.mjs imports it, so the gate and
 * the bundler share one regex object and cannot drift apart.
 */

/** The bundler's import line: `import <clause> from '<specifier>';` */
export const IMPORT_FROM_RE = /^[ \t]*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/;

/**
 * Throw unless `source` is free of import lines.
 * @param {string} source - full text of a vendored chunk source.
 * @param {string} label - human-readable file identity for the error message.
 */
export function assertChunkSelfContained(source, label) {
	const lines = String(source).split('\n');
	for (let index = 0; index < lines.length; index++) {
		if (IMPORT_FROM_RE.test(lines[index])) {
			throw new Error(`${label}: chunk source is not self-contained — import on line ${index + 1}: "${lines[index].trim()}"`);
		}
	}
}
