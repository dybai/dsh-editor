/**
 * Workspace file-write service — the Host half's editor save path.
 *
 * `createFileService(fs, sandboxPolicy, sessions)` builds the whole-file text
 * write with optimistic version checking that the browser editor calls as
 * `dshEditor/writeFile`. Moved verbatim from the plugin entry (`index.js`)
 * into this unit-testable module; every capability is injected, so the module
 * imports nothing.
 *
 * The sandbox policy is resolved for the OWNING session
 * (`sandboxPolicy.resolve({ session })`), so the write is evaluated against
 * the session's own workspace boundary exactly like the agent's own file
 * tools; an omitted policy would classify the gateway call as agentless and
 * check it against the deployment fallback root.
 *
 * @module @dybai/dsh-editor/host/write-service
 */

/** Character cap for one editor write. */
const MAX_CONTENT_CHARS = 4 * 1024 * 1024;

/**
 * Build the file-write service.
 * @param fs - the Host filesystem service (`resolve`/`writeText`).
 * @param sandboxPolicy - the sandbox-policy service (`resolve`).
 * @param sessions - the session registry (`get`).
 * @returns the service instance (method on its prototype for SRC discovery).
 */
export function createFileService(fs, sandboxPolicy, sessions) {
	const NUL = /\u0000/;
	return Object.create({
		/**
		 * Write one whole text file inside the Session's workspace.
		 * @param workspaceFileScope - Gateway-resolved `{ sessionId, workspaceRoot }` for the wire session id.
		 * @param path - absolute path or workspace-relative path, as `workspaceFiles.read` accepts.
		 * @param content - complete replacement text.
		 * @param baseVersion - version the edit was based on; an empty string writes unconditionally.
		 * @param signal - caller cancellation (last parameter, SRC convention).
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
			const scope =
				workspaceFileScope !== null && typeof workspaceFileScope === 'object' ? workspaceFileScope : {};
			const cwd = scope.workspaceRoot;
			const session = typeof scope.sessionId === 'string' ? sessions.get(scope.sessionId) : undefined;
			// The write must be evaluated under the OWNING session's policy: a
			// gateway call without a policy is classified as agentless and checked
			// against the deployment fallback root (`process.cwd()`), which denies
			// files that sit inside the session workspace.
			const policy = sandboxPolicy.resolve(session === undefined ? {} : { session });
			const target = await fs.resolve(path, cwd === undefined ? { signal } : { cwd, signal });
			const expected =
				typeof baseVersion === 'string' && baseVersion.length > 0
					? { kind: 'replaceIfVersion', version: baseVersion }
					: undefined;
			let outcome;
			try {
				outcome = await fs.writeText(target, content, expected, signal, policy);
			} catch (error) {
				throw remoteOf(error);
			}
			return { operation: outcome.operation, version: outcome.version };
		}
	});
}

/**
 * Translate a thrown error into the wire failure the Typert Gateway keeps
 * intact. The Gateway's failure encoder preserves `code` ONLY for errors
 * carrying the structural RemoteError marker; everything else degrades to
 * `gateway/internal` with just the message. The fs layer's `FsError` has no
 * marker, so a stale-version rejection (`FS_STALE_VERSION`) would reach the
 * browser as an anonymous failure and the editor's `/stale/i` conflict
 * detection would never fire — so stale rejections are re-wrapped here with
 * the marker (code, message, empty details) and everything else propagates
 * unchanged.
 * @param error - the caught rejection.
 * @returns the same rejection when it is already marker-carrying, a
 * marker-carrying twin of it when its `code` is `FS_STALE_VERSION`, otherwise
 * the original error.
 */
function remoteOf(error) {
	if (
		error !== null &&
		typeof error === 'object' &&
		error.isDSHRemoteError !== true &&
		error.code === 'FS_STALE_VERSION'
	) {
		const remote = new Error(error instanceof Error ? error.message : String(error));
		remote.name = 'RemoteError';
		remote.isDSHRemoteError = true;
		remote.code = 'FS_STALE_VERSION';
		remote.details = {};
		return remote;
	}
	return error;
}
