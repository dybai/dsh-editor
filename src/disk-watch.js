/**
 * Disk-watch — the per-tab external-change detection channel.
 *
 * One watch owns HOW a single editor tab learns about disk truth. Two modes:
 *
 * - `'streaming'` — the Host's `workspaceFiles/changes` push stream (opened
 *   through the injected `openChanges()`, the `remote.$stream` supervised
 *   shape: async-iterable + `dispose()`). Frames translate directly into
 *   notices: `{ kind: 'ready' }` is accepted (and marks the mode), a
 *   `{ kind: 'change', change: { version } | { absent: true } }` frame
 *   becomes `{ version }` / `{ absent: true }`. Zero polling cost.
 * - `'manual'` — no push available (the remote face lacks `$stream`, the
 *   backend reports watch-unsupported, or the stream failed/ended). The
 *   owner drives `checkNow()` (wired to window focus/visibility) and each
 *   call performs ONE `stat` via the injected `stat()`: a not-found
 *   rejection reports `{ absent: true }`, other rejections stay silent
 *   (the next check retries). Concurrent `checkNow()` calls coalesce into
 *   one follow-up stat instead of stampeding.
 *
 * Degrading is one-way and self-resyncing: any stream termination (error,
 * clean end, unusable handle) flips the mode to `'manual'` and immediately
 * runs one `checkNow()`, so nothing the stream missed before dying goes
 * unnoticed. The watch never interprets versions — it reports FACTS; all
 * policy (dedup, asks, settings) lives in the tab machine's
 * `notifyDiskState`.
 *
 * Lifecycle: an optional `signal` (the tab occurrence AbortSignal) disposes
 * the watch — the stream is disposed, no further stats or notices run.
 * `onNotice` exceptions are isolated (a throwing consumer never breaks the
 * pump). Malformed frames/notices are dropped silently.
 *
 * Zero imports: every capability is injected, so the module is
 * unit-testable with scripted stream fakes.
 *
 * @module @dybai/dsh-editor/disk-watch
 */

/**
 * Create one tab's disk watch.
 * @param {{
 *   signal?: AbortSignal,
 *   openChanges?: () => { [Symbol.asyncIterator]: () => AsyncIterator<{ value: any, accept?: () => void }>, dispose?: () => void },
 *   stat?: () => Promise<{ version: string }>,
 *   onNotice(notice: { version: string } | { absent: true }): void,
 * }} deps
 * @returns {{ mode(): 'pending'|'streaming'|'manual', checkNow(): Promise<void>, dispose(): void }}
 */
export function createDiskWatch({ signal, openChanges, stat, onNotice }) {
	let mode = 'pending'; // until the stream proves itself; then 'streaming' | 'manual'
	let disposed = false;
	let streamHandle = null;
	let statInFlight = false;
	let statQueued = false;

	/** Subscriber isolation: a throwing consumer never breaks the pump. */
	function safeNotify(notice) {
		try {
			onNotice(notice);
		} catch {
			// swallow
		}
	}

	/** Whether a rejection means "the file is not on disk" (host `FS_NOT_FOUND`, ENOENT). */
	function isNotFound(error) {
		const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
		const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error ?? '');
		return /FS_NOT_FOUND|ENOENT|not.?found/i.test(`${code} ${message}`);
	}

	/** One stat + report; in-flight calls coalesce into a single follow-up. */
	async function checkNow() {
		if (disposed) return;
		if (signal !== undefined && signal !== null && signal.aborted) return;
		if (typeof stat !== 'function') return;
		if (statInFlight) {
			statQueued = true;
			return;
		}
		statInFlight = true;
		try {
			do {
				statQueued = false;
				let outcome;
				try {
					outcome = await stat();
				} catch (error) {
					if (isNotFound(error)) safeNotify({ absent: true });
					return; // other failures stay silent; the next check retries
				}
				if (disposed) return;
				if (outcome === null || typeof outcome !== 'object') return;
				if (outcome.absent === true) safeNotify({ absent: true });
				else if (typeof outcome.version === 'string' && outcome.version !== '') safeNotify({ version: outcome.version });
			} while (statQueued);
		} finally {
			statInFlight = false;
		}
	}

	/** One-way degrade: no more push, drive `checkNow` from the owner; resync immediately. */
	function degrade() {
		if (disposed || mode === 'manual') return;
		mode = 'manual';
		checkNow(); // catch whatever the stream missed before it died
	}

	async function pump() {
		try {
			for await (const item of streamHandle) {
				if (disposed) break;
				if (signal !== undefined && signal !== null && signal.aborted) break;
				const frame = item === null || typeof item !== 'object' ? null : item.value;
				if (frame === null || typeof frame !== 'object') continue;
				if (frame.kind === 'ready') {
					if (typeof item.accept === 'function') {
						try {
							item.accept();
						} catch {
							// protocol bookkeeping only
						}
					}
					mode = 'streaming';
					continue;
				}
				if (frame.kind === 'change' && frame.change !== null && typeof frame.change === 'object') {
					if ('absent' in frame.change && frame.change.absent === true) safeNotify({ absent: true });
					else if (typeof frame.change.version === 'string' && frame.change.version !== '') safeNotify({ version: frame.change.version });
				}
			}
			degrade(); // clean end: the host closed the feed
		} catch {
			degrade(); // terminal failure (watch-unsupported, carrier death, …)
		}
	}

	function onAbort() {
		dispose();
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
			signal.removeEventListener('abort', onAbort);
		}
		if (streamHandle !== null && typeof streamHandle.dispose === 'function') {
			try {
				streamHandle.dispose();
			} catch {
				// best-effort teardown
			}
		}
	}

	const aborted = signal !== undefined && signal !== null && signal.aborted === true;
	if (!aborted && signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
		signal.addEventListener('abort', onAbort, { once: true });
	}
	if (aborted) {
		disposed = true;
	} else if (typeof openChanges === 'function') {
		try {
			const handle = openChanges();
			if (handle !== null && handle !== undefined && typeof handle[Symbol.asyncIterator] === 'function') {
				streamHandle = handle;
				pump(); // async: degrade() flips the mode when it terminates
			} else {
				mode = 'manual';
			}
		} catch {
			mode = 'manual';
		}
	} else {
		mode = 'manual';
	}

	return {
		mode: () => mode,
		checkNow,
		dispose,
	};
}
