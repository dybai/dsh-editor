/**
 * @dybai/dsh-editor — Host half.
 *
 * Provides the `dshEditorFiles` workspace file-write service that the browser
 * editor calls through its Typert Remote namespace. The service is registered
 * with `ctx.provide` in source mode: a visible `typertRemote` binding plus a
 * Remote marker on the prototype make the Typert Gateway's conservative SRC
 * discovery claim `dshEditorFiles/writeFile`, so no generated Typert
 * artifacts are needed.
 *
 * Deliberately imports no `@deepseek-ai/*` package: every capability comes
 * from the Cordis context (`fs`), so the bundle loads under any profile
 * node_modules layout.
 *
 * @module @dybai/dsh-editor
 */

/** Cordis service key and wire namespace of the file-write service. */
const SERVICE_KEY = 'dshEditorFiles';
/** Fallback prototype key carrying Remote markers when live discovery fails. */
const REMOTE_DESCRIPTOR_FALLBACK = '@deepseek-ai/dsh-typert-protocol/remote-methods';
/** Character cap for one editor write. */
const MAX_CONTENT_CHARS = 4 * 1024 * 1024;

/** Host services this plugin requires; the plugin parks until they are live. */
export const inject = ['fs'];

/**
 * Discover the prototype property name that carries Remote method markers by
 * reading one live remote service's prototype chain, so the marker stays
 * honest across upstream key renames. Falls back to the known literal.
 * @param hostCtx - the plugin's Host context.
 * @returns the descriptor property key to define on the service prototype.
 */
function remoteMarkerKey(hostCtx) {
	for (const serviceKey of ['workspaceFiles', 'directoryPickerController', 'terminalController']) {
		const service = hostCtx.get(serviceKey);
		if (service === undefined || service === null || typeof service !== 'object') continue;
		let prototype = Object.getPrototypeOf(service);
		while (prototype !== null && prototype !== Object.prototype) {
			for (const name of Object.getOwnPropertyNames(prototype)) {
				let value;
				try {
					value = Object.getOwnPropertyDescriptor(prototype, name)?.value;
				} catch {
					continue;
				}
				if (
					value !== null &&
					typeof value === 'object' &&
					value.version === 1 &&
					Array.isArray(value.methods) &&
					value.methods.every(
						(marker) => marker !== null && typeof marker === 'object' && typeof marker.method === 'string'
					)
				) {
					return name;
				}
			}
			prototype = Object.getPrototypeOf(prototype);
		}
	}
	return REMOTE_DESCRIPTOR_FALLBACK;
}

/**
 * Build the file-write service prototype: a whole-file text write with
 * optimistic version checking, routed through the Host filesystem service so
 * sandbox policy and workspace resolution stay in one place.
 * @param fs - the Host filesystem service.
 * @returns the service instance (methods on its prototype for SRC discovery).
 */
function createFileService(fs) {
	const NUL = /\u0000/;
	return Object.create({
		/**
		 * Write one whole text file inside the Session's workspace.
		 * @param workspaceFileScope - Gateway-resolved `{ sessionId, workspaceRoot }` for the wire session id.
		 * @param path - absolute path or workspace-relative path, as `workspaceFiles.read` accepts.
		 * @param content - complete replacement text.
		 * @param baseVersion - version the edit was based on; an empty string writes unconditionally.
		 * @param signal - caller cancellation.
		 * @returns `{ operation, version }` of the settled write.
		 */
		async writeFile(workspaceFileScope, path, content, baseVersion, signal) {
			if (typeof path !== 'string' || path.length === 0) {
				throw new Error('dsh-editor: "path" must be a non-empty string');
			}
			if (typeof content !== 'string') {
				throw new Error('dsh-editor: "content" must be a string');
			}
			if (content.length > MAX_CONTENT_CHARS) {
				throw new Error(`dsh-editor: content is larger than the ${MAX_CONTENT_CHARS} character write cap`);
			}
			if (NUL.test(content)) {
				throw new Error('dsh-editor: content contains NUL bytes and cannot be written as text');
			}
			const cwd =
				workspaceFileScope !== null && typeof workspaceFileScope === 'object'
					? workspaceFileScope.workspaceRoot
					: undefined;
			const target = await fs.resolve(path, cwd === undefined ? { signal } : { cwd, signal });
			const expected =
				typeof baseVersion === 'string' && baseVersion.length > 0
					? { kind: 'replaceIfVersion', version: baseVersion }
					: undefined;
			const outcome = await fs.writeText(target, content, expected, signal);
			return { operation: outcome.operation, version: outcome.version };
		}
	});
}

/**
 * Plugin entry: registers the file-write service for this fiber's lifetime.
 * @param ctx - the plugin's Host context.
 * @returns the effect disposer cordis owns.
 */
export function apply(ctx) {
	const fs = ctx.get('fs');
	if (fs === undefined || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
		throw new Error('dsh-editor: the Host filesystem service with resolve/writeText is unavailable');
	}

	const service = createFileService(fs);
	const prototype = Object.getPrototypeOf(service);
	const markerKey = remoteMarkerKey(ctx);
	Object.defineProperty(prototype, markerKey, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([
				Object.freeze({ method: 'writeFile', invocation: Object.freeze({ kind: 'direct' }) })
			])
		})
	});
	service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });

	return ctx.effect(() => ctx.provide(SERVICE_KEY, service), 'dsh-editor: workspace file-write service');
}
