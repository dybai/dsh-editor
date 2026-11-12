/* @dybai/dsh-editor — browser half.
 *
 * Registers an `extension`-band right-Sidebar tab type that claims session
 * file addresses for text-like files, and mounts the tab body: a save/reload
 * text editor. Reads go through the shipped `workspaceFiles` Remote
 * namespace; writes go through this bundle's own `dshEditorFiles` namespace,
 * which the Host half exposes in source mode and this half mounts as a
 * hand-written Typert contribution.
 */
window.__ModuleLoader__.load({
	id: '@dybai/dsh-editor',
	factory(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const React = require('react');
		const h = React.createElement;

		/* --------------------------------------------------------- identity -- */

		const PKG = '@dybai/dsh-editor';
		const NS = 'dshEditor';
		const SERVICE_KEY = 'dshEditorFiles';
		const EDITOR_KIND = 'editor';
		const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
		const MAX_EDIT_CHARS = 4 * 1024 * 1024;
		const CLASS_PREFIX = 'dsh-editor';

		/* ----------------------------------------------------------- locale -- */

		const zh = {
			'meta.title': '文件编辑器',
			'meta.description': '让分栏里的文本文件可以直接编辑：打开文件就地修改并保存到磁盘（Ctrl+S），带版本冲突提示与重新加载。',
			'action.save': '保存',
			'action.saveTitle': '保存到磁盘（Ctrl+S）',
			'action.edit': '编辑此文件',
			'action.editTitle': '在编辑器中打开此文件（保留只读预览）',
			'action.reload': '重新加载',
			'action.reloadTitle': '从磁盘重新加载该文件',
			'action.reloadDiscard': '重新加载并丢弃本地修改',
			'action.saveAnyway': '仍要保存（覆盖磁盘）',
			'state.dirty': '未保存',
			'state.saved': '已保存',
			'state.saving': '正在保存…',
			'state.loading': '正在加载…',
			'error.unsupported': '此文件无法在这里编辑。',
			'error.loadFailed': '加载文件失败',
			'error.saveFailed': '保存失败',
			'error.notText': '此文件不是有效的 UTF-8 文本，无法编辑。',
			'error.tooLarge': '文件超过 4 MB，无法在此编辑。',
			'conflict.banner': '文件在加载后被修改过。重新加载会丢弃本地修改；仍要保存会覆盖磁盘上的文件。'
		};

		const en = {
			'meta.title': 'File editor',
			'meta.description':
				'Makes text files in the side pane editable: open a file, edit it in place, and save back to disk with Ctrl+S, with stale-version conflict prompts and reload.',
			'action.save': 'Save',
			'action.saveTitle': 'Save to disk (Ctrl+S)',
			'action.edit': 'Edit this file',
			'action.editTitle': 'Open this file in the editor (keeps the read-only preview)',
			'action.reload': 'Reload',
			'action.reloadTitle': 'Reload the file from disk',
			'action.reloadDiscard': 'Reload and discard local changes',
			'action.saveAnyway': 'Save anyway (overwrite on disk)',
			'state.dirty': 'Unsaved changes',
			'state.saved': 'Saved',
			'state.saving': 'Saving…',
			'state.loading': 'Loading…',
			'error.unsupported': 'This file cannot be edited here.',
			'error.loadFailed': 'Failed to load the file',
			'error.saveFailed': 'Save failed',
			'error.notText': 'This file is not valid UTF-8 text and cannot be edited.',
			'error.tooLarge': 'This file is larger than 4 MB and cannot be edited here.',
			'conflict.banner':
				'The file changed on disk since it was loaded. Reloading discards local changes; saving anyway overwrites the file on disk.'
		};

		/** Client services this module needs at activation, in order. */
		const inject = ['slots', 'locale', 'remote', 'connection', 'sessions', 'sidebarRight', 'sidebarRightTabs'];

		/* --------------------------------------------------- address grammar -- */

		/** Encode one address segment, keeping `:` literal for drive letters. */
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ':');
		}

		/**
		 * Read a file address back into its parts without resolving `.` or `..`.
		 * @param address - a candidate `dsh-resource://file/` URI.
		 * @returns `{ scope: 'session', sessionId, path }` or `{ scope: 'absolute', path }`, or undefined.
		 */
		function parseFileAddress(address) {
			if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
			try {
				const end = address.search(/[?#]/);
				const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/');
				if (scope === 'session') {
					const [id, ...segments] = rest;
					if (id === undefined || id === '' || segments.length === 0) return undefined;
					return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
				}
				return undefined;
			} catch {
				return undefined;
			}
		}

		/** The tab chip text for an address: its decoded basename. */
		function basenameOf(address) {
			const name = address.slice(address.lastIndexOf('/') + 1);
			if (name === '') return address;
			try {
				return decodeURIComponent(name);
			} catch {
				return name;
			}
		}

		/** Encode a `/`-separated path segment by segment, keeping `:` literal for drive letters. */
		function encodePathForAddress(path) {
			return path.split('/').map(encodeSegment).join('/');
		}

		/**
		 * Build the `dsh-resource://file/session/<sessionId>/<path>` address for a
		 * previewed file: workspace-relative when the path lives inside the
		 * Session's cwd (comparison is case-insensitive for Windows spellings),
		 * otherwise its absolute path carried inside the Session address, matching
		 * the reference grammar the shipped viewers accept.
		 * @param cwd - the Session's workspace root, when known.
		 * @param sessionId - the Session whose Host workspace resolves the path.
		 * @param absolutePath - the previewed file's absolute path.
		 * @returns the session file address.
		 */
		function sessionAddressFor(cwd, sessionId, absolutePath) {
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

		/* ----------------------------------------------------- edit policy -- */

		const EDITABLE_EXTENSIONS = new Set([
			'ai', 'astro', 'bash', 'bat', 'babelrc', 'c', 'cc', 'cfg', 'clj', 'cmd', 'conf', 'config', 'cpp', 'cs',
			'css', 'cts', 'csv', 'cxx', 'dart', 'diff', 'editorconfig', 'eex', 'el', 'env', 'erb', 'erl', 'eslintrc',
			'ex', 'exs', 'fish', 'fs', 'gitattributes', 'gitignore', 'go', 'gradle', 'groovy', 'gql', 'graphql', 'h',
			'handlebars', 'hbs', 'hpp', 'hs', 'htm', 'html', 'hxx', 'ini', 'ipynb', 'java', 'js', 'json', 'json5',
			'jsonc', 'jsp', 'jsx', 'kt', 'kts', 'less', 'lock', 'log', 'lua', 'm', 'make', 'markdown', 'md', 'mdx',
			'mjs', 'ml', 'mm', 'mjs', 'mts', 'nix', 'patch', 'php', 'pl', 'pm', 'prettierrc', 'prisma', 'properties',
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
		 * binary and unknown formats keep their shipped viewers.
		 * @param path - the address's decoded path.
		 * @returns whether the editor will open it.
		 */
		function isEditablePath(path) {
			const name = path.split('/').filter(Boolean).at(-1);
			if (name === undefined || name === '') return false;
			const lower = name.toLowerCase();
			if (lower.startsWith('.') && !lower.includes('.', 1)) return true;
			if (EDITABLE_BASENAMES.has(lower)) return true;
			const dot = lower.lastIndexOf('.');
			if (dot <= 0) return true;
			return EDITABLE_EXTENSIONS.has(lower.slice(dot + 1));
		}

		/* ----------------------------------------------------- remote face -- */

		/** The plugin apply context and captured service handles, set once. */
		let facade = null;

		/** The Session's workspace root from the sessions facade snapshot, or undefined. */
		function sessionCwdOf(sessions, sessionId) {
			try {
				if (sessions === undefined || sessions === null) return undefined;
				return sessions.list.getSnapshot().byId[sessionId]?.cwd;
			} catch {
				return undefined;
			}
		}

		/**
		 * Resolve one mounted Client Remote namespace.
		 *
		 * Read through `ctx.get` (`reflect.get`), which the Cordis docs define as
		 * "read a service from the store without the inject requirement": the
		 * property path `ctx.remote.<name>` would run a namespace-keyed inject
		 * gate ("cannot get property … without inject"). Only used for the
		 * shipped `workspaceFiles` reads; the editor's own write endpoint goes
		 * through `rpcCall` and needs no mounted namespace.
		 * @param name - namespace (`workspaceFiles`).
		 * @returns the namespace service carrying its methods.
		 */
		function remoteNamespace(name) {
			const ctx = facade === null ? undefined : facade.ctx;
			if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') {
				throw new Error('dsh-editor: the plugin context is unavailable');
			}
			const ns = ctx.get(`remote.${name}`);
			if (ns !== undefined && ns !== null) return ns;
			throw new Error(`dsh-editor: remote.${name} is not mounted`);
		}

		/** Unwrap one RemoteResult envelope; a failure carries its message. */
		function unwrapResult(result, what) {
			if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
			const failure = result !== null && typeof result === 'object' ? result.error : null;
			const message =
				failure !== null && failure !== undefined && typeof failure.message === 'string' && failure.message.length > 0
					? failure.message
					: `dsh-editor: ${what} failed`;
			throw new Error(message);
		}

		/**
		 * Read one complete file as UTF-8 text plus its version.
		 * @returns `{ text, version }` with CRLF and lone CR normalized to LF.
		 */
		async function readWholeFile(sessionId, path, signal) {
			const ns = remoteNamespace('workspaceFiles');
			const value = unwrapResult(await ns.readBytes(sessionId, path, {}, signal), 'read');
			const bytes = typeof value?.bytes === 'number' ? value.bytes : undefined;
			if (bytes !== undefined && bytes > MAX_EDIT_CHARS) {
				const tooLarge = new Error('too-large');
				tooLarge.kind = 'too-large';
				throw tooLarge;
			}
			const data = value?.data;
			if (!(data instanceof Uint8Array)) {
				const unreadable = new Error('dsh-editor: the file read returned no bytes');
				unreadable.kind = 'load-failed';
				throw unreadable;
			}
			let text;
			try {
				text = new TextDecoder('utf-8', { fatal: true }).decode(data);
			} catch {
				const notText = new Error('not utf-8');
				notText.kind = 'not-text';
				throw notText;
			}
			return {
				text: text.replace(/\r\n?/g, '\n'),
				version: typeof value.version === 'string' ? value.version : ''
			};
		}

		/** Write one file through the generic gateway carrier; returns the result envelope. */
		async function writeFile(sessionId, path, content, baseVersion, signal) {
			return await rpcCall(`${SERVICE_KEY}/writeFile`, {
				workspaceFileScopeId: sessionId,
				path,
				content,
				baseVersion
			}, signal);
		}

		/**
		 * Call one Host Remote endpoint through the generic gateway carrier
		 * (`connection.rpc.call`, the exact channel every generated namespace
		 * method uses). The endpoint resolves on the Host through the editor's
		 * source-mode service, so no client-side namespace has to be mounted.
		 * @param endpoint - `<namespace>/<method>`.
		 * @param args - named wire arguments.
		 * @param signal - caller cancellation.
		 * @returns the `{ ok, value | error }` envelope.
		 */
		async function rpcCall(endpoint, args, signal) {
			const ctx = facade === null ? undefined : facade.ctx;
			if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') {
				throw new Error('dsh-editor: the plugin context is unavailable');
			}
			const connection = ctx.get('connection');
			const rpc = connection !== undefined && connection !== null ? connection.rpc : undefined;
			if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
				throw new Error('dsh-editor: the Client connection service with rpc.call is unavailable');
			}
			return await rpc.call('/api', endpoint, { args }, signal);
		}

		/** Whether one save failure is the optimistic-version conflict. */
		function isStaleFailure(failure) {
			if (failure === null || failure === undefined || typeof failure !== 'object') return false;
			const code = typeof failure.code === 'string' ? failure.code : '';
			const message = typeof failure.message === 'string' ? failure.message : '';
			return /stale/iu.test(code) || /stale/iu.test(message);
		}

		/* -------------------------------------------------------- tab type -- */

		/**
		 * The tab-type registry definition.
		 *
		 * The editor claims nothing by itself: it names no `patterns`, so the
		 * shipped viewers keep every file open, and it runs only when the preview
		 * toolbar's edit button names this kind explicitly (`openResource(address,
		 * { kind })` skips the globs but still honors `canOpen`).
		 */
		function editorDefinition() {
			return {
				id: PKG,
				kind: EDITOR_KIND,
				keepMounted: true,
				canOpen: (address) => {
					const parsed = parseFileAddress(address);
					return parsed !== undefined && parsed.scope === 'session' && isEditablePath(parsed.path);
				},
				title: basenameOf
			};
		}

		/* ------------------------------------------------------------ styles -- */

		const STYLES = `
.${CLASS_PREFIX}-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.${CLASS_PREFIX}-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); min-height: 36px; flex: none; }
.${CLASS_PREFIX}-name { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.${CLASS_PREFIX}-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.${CLASS_PREFIX}-dirty { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
.${CLASS_PREFIX}-dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); }
.${CLASS_PREFIX}-btn { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; white-space: nowrap; flex: none; }
.${CLASS_PREFIX}-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.${CLASS_PREFIX}-btn:disabled { opacity: 0.45; cursor: default; }
.${CLASS_PREFIX}-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.${CLASS_PREFIX}-banner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); font-size: 12px; color: var(--dsw-alias-label-primary); flex: none; }
.${CLASS_PREFIX}-banner-text { flex: 1 1 auto; min-width: 0; }
.${CLASS_PREFIX}-area { flex: 1 1 auto; min-height: 0; width: 100%; resize: none; border: none; outline: none; padding: 10px 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; white-space: pre; overflow: auto; tab-size: 4; }
.${CLASS_PREFIX}-area::placeholder { color: var(--dsw-alias-label-secondary); }
.${CLASS_PREFIX}-center { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px; color: var(--dsw-alias-label-secondary); font-size: 13px; text-align: center; }
.${CLASS_PREFIX}-center-stack { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 90%; }
.${CLASS_PREFIX}-status { display: flex; align-items: center; gap: 12px; padding: 4px 10px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 11px; color: var(--dsw-alias-label-secondary); min-height: 24px; flex: none; }
.${CLASS_PREFIX}-status-meta { flex: none; white-space: nowrap; }
.${CLASS_PREFIX}-status-notice { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.${CLASS_PREFIX}-notice-ok { color: var(--dsw-alias-state-success-primary); }
.${CLASS_PREFIX}-notice-error { color: var(--dsw-alias-state-error-primary); }
.${CLASS_PREFIX}-tool-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.${CLASS_PREFIX}-tool-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.${CLASS_PREFIX}-seat { display: flex; align-items: center; gap: 4px; min-width: 0; }
`;

const STYLE_ID = 'dsh-editor-styles';

/**
 * Insert the plugin stylesheet once into the document head, for the plugin's
 * whole lifetime. Components render in foreign hosts (the preview toolbar has
 * no style slot of its own), so component-local style tags cannot cover them.
 * @returns the style-tag remover.
 */
function ensureStyles() {
	if (document.getElementById(STYLE_ID) !== null) return () => {};
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLES;
	document.head.appendChild(tag);
	return () => tag.remove();
}

		/* -------------------------------------------------------- components -- */

		/**
		 * Keep one broken render from silently deleting the editor: the boundary
		 * logs the failure and drops only the body.
		 */
		const EditorBoundary =
			typeof React.Component === 'function'
				? class EditorBoundary extends React.Component {
					constructor(props) {
						super(props);
						this.state = { failed: false };
					}
					static getDerivedStateFromError() {
						return { failed: true };
					}
					componentDidCatch(error) {
						console.error('[dsh-editor] editor body render failed:', error);
					}
					render() {
						return this.state.failed ? null : this.props.children;
					}
				}
				: function EditorBoundary({ children }) {
					return children;
				};

		/** Offset of the start of a 1-based line, or the text end past it. */
		function offsetOfLine(text, line) {
			if (line <= 1) return 0;
			let remaining = line - 1;
			let index = -1;
			while (remaining > 0) {
				index = text.indexOf('\n', index + 1);
				if (index === -1) return text.length;
				remaining -= 1;
			}
			return index + 1;
		}

		function timeNow() {
			try {
				return new Date().toLocaleTimeString();
			} catch {
				return '';
			}
		}

		function describeLoadError(t, error) {
			if (error !== null && typeof error === 'object' && error.kind === 'not-text') return t('error.notText');
			if (error !== null && typeof error === 'object' && error.kind === 'too-large') return t('error.tooLarge');
			const message = error instanceof Error ? error.message : String(error);
			return `${t('error.loadFailed')}: ${message}`;
		}

		/**
		 * The editor body for `sidebar.right.pane.tab`, keyed by the package name.
		 * Reads only fixed React hooks; every other read happens inside effects or
		 * event handlers.
		 */
		function EditorTab(props) {
			const t = props.t;
			const renderSlot = props.renderSlot;
			const { tab } = props.useTabInfo();
			const address = tab.contentId;
			const parsed = React.useMemo(() => parseFileAddress(address), [address]);
			const sessionId = parsed !== undefined && parsed.scope === 'session' ? parsed.sessionId : null;
			const path = sessionId !== null ? parsed.path : null;
			const signal = tab.signal;

			const [model, setModel] = React.useState(() => ({ phase: 'loading', text: '', version: '' }));
			const [draft, setDraft] = React.useState('');
			const [caret, setCaret] = React.useState({ line: 1, column: 1 });
			const [saving, setSaving] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [conflict, setConflict] = React.useState(false);
			const areaRef = React.useRef(null);
			const runRef = React.useRef(0);

			const dirty = model.phase === 'ready' && draft !== model.text;

			const load = React.useCallback(async () => {
				if (sessionId === null || path === null) return;
				const run = runRef.current + 1;
				runRef.current = run;
				setModel({ phase: 'loading', text: '', version: '' });
				setDraft('');
				setNotice(null);
				setConflict(false);
				try {
					const { text, version } = await readWholeFile(sessionId, path, signal);
					if (runRef.current !== run) return;
					setModel({ phase: 'ready', text, version });
					setDraft(text);
				} catch (error) {
					if (runRef.current !== run) return;
					setModel({ phase: 'failed', text: '', version: '', error });
				}
			}, [sessionId, path, signal]);

			React.useEffect(() => {
				load();
			}, [load]);

			const save = React.useCallback(
				async (force) => {
					if (sessionId === null || path === null || model.phase !== 'ready' || saving) return;
					if (force !== true && draft === model.text) return;
					setSaving(true);
					setNotice(null);
					try {
						const result = await writeFile(sessionId, path, draft, force === true ? '' : model.version, signal);
						if (result !== null && typeof result === 'object' && result.ok === true) {
							const version =
								result.value !== null && typeof result.value === 'object' && typeof result.value.version === 'string'
									? result.value.version
									: model.version;
							setModel({ phase: 'ready', text: draft, version });
							setConflict(false);
							setNotice({ tone: 'ok', text: `${t('state.saved')} ${timeNow()}` });
						} else {
							const failure = result !== null && typeof result === 'object' ? result.error : null;
							const message =
								failure !== null && failure !== undefined && typeof failure.message === 'string' && failure.message.length > 0
									? failure.message
									: t('error.saveFailed');
							if (isStaleFailure(failure)) {
								setConflict(true);
								setNotice({ tone: 'error', text: message });
							} else {
								setNotice({ tone: 'error', text: `${t('error.saveFailed')}: ${message}` });
							}
						}
					} catch (error) {
						setNotice({
							tone: 'error',
							text: `${t('error.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
						});
					} finally {
						setSaving(false);
					}
				},
				[sessionId, path, model, draft, saving, signal, t]
			);

			const onSelectionChange = React.useCallback(() => {
				const area = areaRef.current;
				if (area === null) return;
				const upto = area.value.slice(0, area.selectionStart);
				const line = (upto.match(/\n/g) || []).length + 1;
				const column = upto.length - upto.lastIndexOf('\n');
				setCaret({ line, column });
			}, []);

			React.useEffect(() => {
				onSelectionChange();
			}, [draft, onSelectionChange]);

			React.useEffect(() => {
				if (model.phase !== 'ready') return;
				const params = tab.navigation !== undefined ? tab.navigation.params : undefined;
				const file = params !== undefined && params !== null ? params.file : undefined;
				const line = file !== undefined && file !== null && typeof file.line === 'number' ? file.line : null;
				if (line === null || line < 1) return;
				const area = areaRef.current;
				if (area === null) return;
				const offset = offsetOfLine(model.text, line);
				area.focus();
				area.setSelectionRange(offset, offset);
				area.scrollTop = Math.max(0, (line - 6) * 20);
			}, [model.phase, model.text, tab.navigation]);

			if (sessionId === null || path === null) {
				return h('div', { className: `${CLASS_PREFIX}-root` }, h('div', { className: `${CLASS_PREFIX}-center` }, t('error.unsupported')));
			}

			const title = basenameOf(address);

			let body;
			if (model.phase === 'failed') {
				body = h(
					'div',
					{ className: `${CLASS_PREFIX}-center` },
					h(
						'div',
						{ className: `${CLASS_PREFIX}-center-stack` },
						h('div', null, describeLoadError(t, model.error)),
						h(
							'button',
							{ className: `${CLASS_PREFIX}-btn`, type: 'button', title: t('action.reloadTitle'), onClick: () => load() },
							t('action.reload')
						)
					)
				);
			} else {
				body = [
					conflict
						? h(
							'div',
							{ key: 'conflict', className: `${CLASS_PREFIX}-banner` },
							h('span', { key: 'text', className: `${CLASS_PREFIX}-banner-text` }, t('conflict.banner')),
							h(
								'button',
								{
									key: 'reload',
									className: `${CLASS_PREFIX}-btn`,
									type: 'button',
									disabled: saving,
									title: t('action.reloadTitle'),
									onClick: () => {
										setConflict(false);
										load();
									}
								},
								t('action.reloadDiscard')
							),
							h(
								'button',
								{
									key: 'force',
									className: `${CLASS_PREFIX}-btn`,
									type: 'button',
									disabled: saving,
									onClick: () => save(true)
								},
								t('action.saveAnyway')
							)
						)
						: null,
					h('textarea', {
						key: 'area',
						ref: areaRef,
						className: `${CLASS_PREFIX}-area`,
						value: model.phase === 'ready' ? draft : '',
						readOnly: model.phase !== 'ready',
						spellCheck: false,
						wrap: 'off',
						placeholder: model.phase === 'loading' ? t('state.loading') : undefined,
						'aria-label': title,
						'data-dsh-editor-input': '',
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
								event.preventDefault();
								save(false);
							}
						},
						onSelect: onSelectionChange,
						onClick: onSelectionChange,
						onKeyUp: onSelectionChange
					})
				];
			}

			const lineCount = draft.length === 0 ? 1 : draft.split('\n').length;
			// The generic integrator seat: occupants receive `{ address, path, sessionId }`
			// as owner props plus the session standard props, exactly like the shipped
			// preview's document.actions seat.
			const seat =
				typeof renderSlot === 'function'
					? renderSlot('dsh-editor.actions', { address, path, sessionId })
					: null;

			return h(
				'div',
				{
					className: `${CLASS_PREFIX}-root`,
					'data-dsh-editor-address': address,
					'data-dsh-editor-session': sessionId === null ? '' : sessionId,
					'data-dsh-editor-visible': tab.visible === true ? 'true' : 'false'
				},
				h(
					'div',
					{ className: `${CLASS_PREFIX}-toolbar` },
					h('span', { key: 'name', className: `${CLASS_PREFIX}-name` }, title),
					h('span', { key: 'path', className: `${CLASS_PREFIX}-path`, title: path }, path),
					h('div', { key: 'seat', className: `${CLASS_PREFIX}-seat` }, seat),
					dirty
						? h(
							'span',
							{ key: 'dirty', className: `${CLASS_PREFIX}-dirty`, title: t('state.dirty') },
							h('span', { className: `${CLASS_PREFIX}-dirty-dot` }),
							t('state.dirty')
						)
						: null,
					h(
						'button',
						{
							key: 'reload',
							className: `${CLASS_PREFIX}-btn`,
							type: 'button',
							disabled: saving || model.phase !== 'ready',
							title: t('action.reloadTitle'),
							onClick: () => {
								setConflict(false);
								load();
							}
						},
						saving && !dirty ? t('state.saving') : t('action.reload')
					),
					h(
						'button',
						{
							key: 'save',
							className: `${CLASS_PREFIX}-btn primary`,
							type: 'button',
							disabled: !dirty || saving,
							title: t('action.saveTitle'),
							onClick: () => save(false)
						},
						saving ? t('state.saving') : t('action.save')
					)
				),
				body,
				h(
					'div',
					{ className: `${CLASS_PREFIX}-status` },
					h(
						'span',
						{ key: 'meta', className: `${CLASS_PREFIX}-status-meta` },
						`Ln ${caret.line}, Col ${caret.column} · ${lineCount} lines · ${draft.length} chars`
					),
					notice !== null
						? h(
							'span',
							{
								key: 'notice',
								className: `${CLASS_PREFIX}-status-notice ${notice.tone === 'error' ? `${CLASS_PREFIX}-notice-error` : `${CLASS_PREFIX}-notice-ok`}`,
								title: notice.text
							},
							notice.text
						)
						: null
				)
			);
		}

		function EditorTabGuarded(props) {
			return h(EditorBoundary, null, h(EditorTab, props));
		}

		/* ------------------------------------------------- preview edit button -- */

		const ICON_EDIT = h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
			h('path', {
				d: 'M2.9 13.1l.5-2.3 6.9-6.9a1.2 1.2 0 0 1 1.7 0l.2.2a1.2 1.2 0 0 1 0 1.7l-6.9 6.9-2.4.5Z',
				stroke: 'currentColor',
				strokeWidth: 1.2,
				strokeLinejoin: 'round'
			}),
			h('path', { d: 'M9.8 4.2l2 2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' })
		);

		/**
		 * Toolbar occupant for `sidebar.right.tab.document.actions`.
		 *
		 * Owner props: `{ absolutePath }`; session standard props supply
		 * `sessionId` and `t`. Renders nothing until the previewed file's Host
		 * path is known, and nothing at all for files the editor cannot edit, so
		 * image and PDF previews stay untouched. Clicking opens the file in the
		 * editor tab type through `openResource(address, { kind })`; an editor tab
		 * for the same file is revealed, and the read-only preview stays open.
		 */
		function EditButton(props) {
			const t = props.t;
			const absolutePath = props.absolutePath;
			const sessionId = props.sessionId;
			const editable =
				typeof absolutePath === 'string' &&
				absolutePath.length > 0 &&
				sessionId !== undefined &&
				sessionId !== null &&
				isEditablePath(absolutePath.replace(/\\/g, '/'));
			if (!editable) return null;
			const open = () => {
				const sidebarRight = facade === null ? undefined : facade.sidebarRight;
				if (sidebarRight === undefined || sidebarRight === null) {
					console.warn('[dsh-editor] the right-Sidebar service is unavailable');
					return;
				}
				try {
					const sessions = facade === null ? undefined : facade.sessions;
					const address = sessionAddressFor(sessionCwdOf(sessions, sessionId), sessionId, absolutePath);
					sidebarRight.openResource(address, { kind: EDITOR_KIND });
				} catch (error) {
					console.warn('[dsh-editor] opening the editor failed:', error);
				}
			};
			return h('button', {
				className: `${CLASS_PREFIX}-tool-btn`,
				type: 'button',
				title: t('action.editTitle'),
				'aria-label': t('action.edit'),
				onClick: open
			}, ICON_EDIT);
		}

		function EditButtonGuarded(props) {
			return h(EditorBoundary, null, h(EditButton, props));
		}

		/* -------------------------------------------------------------- apply -- */

		function apply(ctx) {
			facade = {
				ctx,
				sidebarRight: ctx.get('sidebarRight'),
				sessions: ctx.get('sessions')
			};

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-editor: dictionaries');

			ctx.effect(() => ensureStyles(), 'dsh-editor: styles');

			ctx.effect(() => ctx.sidebarRightTabs.register(editorDefinition()), 'dsh-editor: tab type');

			ctx.slots.inject('sidebar.right.pane.tab', function* () {
				yield ctx.slots.register({
					name: 'sidebar.right.pane.tab',
					key: PKG,
					locale: NS,
					children: {
						'dsh-editor.actions': { kind: 'list', scope: 'session' }
					}
				}, EditorTabGuarded);
			});

			ctx.slots.inject('sidebar.right.tab.document.actions', function* () {
				yield ctx.slots.register(
					{ name: 'sidebar.right.tab.document.actions', id: 'dsh-editor-edit', order: 5, locale: NS },
					EditButtonGuarded
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
