/**
 * Bounded in-memory ring buffer for pending log entries — the queue the
 * persistent log channel flush orchestrator (Task 6) drains from. Entries are
 * opaque: the buffer stores whatever it is handed untouched (the channel
 * guarantees shape) and validates nothing.
 *
 * Ordering contract:
 * - `push` appends a new entry at the tail.
 * - `requeue(entries)` prepends a whole flush batch back at the head in its
 *   original order, restoring the global timeline after a failed flush.
 * - `drain` returns every buffered entry in FIFO order and empties the buffer.
 * - `size` reports the current entry count.
 *
 * Whenever the buffer would exceed `cap` (default 500) the OLDEST entries are
 * dropped — after a `requeue` prepend that means the entries pushed earliest.
 * A plain array with `shift` eviction is plenty at this scale (≤500); no deque.
 *
 * @module @dybai/dsh-editor/log-buffer
 */

/** cap 默认 500：超过即丢最老。 */
const DEFAULT_CAP = 500;

/**
 * Create a bounded FIFO log buffer.
 * @param {{ cap?: number }} [opts] - `cap` bounds the buffer (default 500);
 *   `cap: undefined` falls back to the default.
 * @returns {{ push(entry): void; requeue(entries: unknown[]): void;
 *   drain(): unknown[]; size(): number }}
 */
export function createLogBuffer(opts) {
	const cap = opts?.cap ?? DEFAULT_CAP;
	const entries = [];

	/** 超出 cap 从最老端（数组头部）丢弃。 */
	const trim = () => {
		while (entries.length > cap) entries.shift();
	};

	return {
		push(entry) {
			entries.push(entry);
			trim();
		},
		requeue(list) {
			entries.unshift(...list); // 按原序前插回缓冲头部（flush 失败恢复时序用）
			trim();
		},
		drain() {
			return entries.splice(0); // FIFO 全量返回并清空
		},
		size() {
			return entries.length;
		},
	};
}
