/**
 * Session file address grammar (`dsh-resource://file/session/<sessionId>/<path>`)
 * and the editability policy for the editor framework.
 *
 * Ported from the v0.1 browser half; pure functions only.
 */

/** `dsh-resource://file/` addresses this module reads and builds. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

/** Hard editor limit: files above this size are refused (textarea budget). */
export const MAX_EDIT_CHARS = 4 * 1024 * 1024;

/** Encode one address segment, keeping `:` literal for drive letters. */
function encodeSegment(segment) {
	return encodeURIComponent(segment).replace(/%3A/gi, ':');
}

/** Encode a `/`-separated path segment by segment. */
function encodePathForAddress(path) {
	return path.split('/').map(encodeSegment).join('/');
}

/**
 * Read a session file address back into its parts without resolving `.` or `..`.
 * @param {string} address - a candidate `dsh-resource://file/` URI.
 * @returns {{ scope: 'session', sessionId: string, path: string } | undefined}
 *   the session parts, or undefined for anything that is not a session file
 *   address (other scopes, malformed input, undecodable escapes).
 */
export function parseFileAddress(address) {
	if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
	try {
		const end = address.search(/[?#]/);
		const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/');
		if (scope !== 'session') return undefined;
		const [id, ...segments] = rest;
		if (id === undefined || id === '' || segments.length === 0) return undefined;
		return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
	} catch {
		return undefined;
	}
}

/**
 * The tab chip text for an address: its decoded basename.
 * @param {string} address
 * @returns {string}
 */
export function basenameOf(address) {
	const name = address.slice(address.lastIndexOf('/') + 1);
	if (name === '') return address;
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/**
 * Build the `dsh-resource://file/session/<sessionId>/<path>` address for a
 * file: workspace-relative when the path lives inside the Session's cwd
 * (comparison is case-insensitive for Windows spellings), otherwise its
 * absolute path carried inside the Session address.
 * @param {string | undefined} cwd - the Session's workspace root, when known.
 * @param {string} sessionId - the Session whose Host workspace resolves the path.
 * @param {string} absolutePath - the file's absolute path.
 * @returns {string} the session file address.
 */
export function sessionAddressFor(cwd, sessionId, absolutePath) {
	let target = String(absolutePath).replace(/\\/g, '/');
	if (typeof cwd === 'string' && cwd.length > 0) {
		const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
		if (root !== '') {
			const lower = target.toLowerCase();
			const lowerRoot = root.toLowerCase();
			if (lower === lowerRoot) target = '';
			else if (lower.startsWith(`${lowerRoot}/`)) target = target.slice(root.length + 1);
		}
	}
	return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePathForAddress(target)}`;
}

const EDITABLE_EXTENSIONS = new Set([
	'ai', 'astro', 'bash', 'bat', 'babelrc', 'c', 'cc', 'cfg', 'clj', 'cmd', 'conf', 'config', 'cpp', 'cs',
	'css', 'cts', 'csv', 'cxx', 'dart', 'diff', 'editorconfig', 'eex', 'el', 'env', 'erb', 'erl', 'eslintrc',
	'ex', 'exs', 'fish', 'fs', 'gitattributes', 'gitignore', 'go', 'gradle', 'groovy', 'gql', 'graphql', 'h',
	'handlebars', 'hbs', 'hpp', 'hs', 'htm', 'html', 'hxx', 'ini', 'ipynb', 'java', 'js', 'json', 'json5',
	'jsonc', 'jsp', 'jsx', 'kt', 'kts', 'less', 'lock', 'log', 'lua', 'm', 'make', 'markdown', 'md', 'mdx',
	'mjs', 'ml', 'mm', 'mts', 'nix', 'patch', 'php', 'pl', 'pm', 'prettierrc', 'prisma', 'properties',
	'proto', 'ps1', 'psd1', 'psm1', 'py', 'pyw', 'r', 'rb', 'rs', 'rst', 's', 'sass', 'scala', 'scss',
	'sh', 'svelte', 'svg', 'sql', 'swift', 'toml', 'ts', 'tsx', 'tsv', 'tt', 'twig', 'txt', 'vim', 'vue',
	'xml', 'yaml', 'yml', 'zig', 'zsh'
]);

const EDITABLE_BASENAMES = new Set([
	'.babelrc', '.editorconfig', '.eslintignore', '.eslintrc', '.gitattributes', '.gitconfig', '.gitignore',
	'.npmrc', '.nvmrc', '.prettierignore', '.prettierrc', 'brewfile', 'changelog', 'cmakelists.txt',
	'contributors', 'dockerfile', 'gemfile', 'license', 'makefile', 'notice', 'procfile', 'readme', 'rakefile',
	'version'
]);

/**
 * Whether a file path looks editable: a conservative text allowlist, so
 * binary and unknown formats keep their shipped viewers. Dotfiles without a
 * second dot and known extensionless basenames are editable.
 * @param {string} path - the address's decoded path.
 * @returns {boolean} whether the editor will open it.
 */
export function isEditablePath(path) {
	const name = path.split('/').filter(Boolean).at(-1);
	if (name === undefined || name === '') return false;
	const lower = name.toLowerCase();
	if (lower.startsWith('.') && !lower.includes('.', 1)) return true;
	if (EDITABLE_BASENAMES.has(lower)) return true;
	const dot = lower.lastIndexOf('.');
	if (dot <= 0) return true;
	return EDITABLE_EXTENSIONS.has(lower.slice(dot + 1));
}
