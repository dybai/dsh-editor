/**
 * Client-side flush orchestrator for the persistent log channel: debounced
 * (5 s, reset on every push) or immediate-at-batchSize (50) drains of the
 * Task 2 ring buffer into the Host RPC endpoint `dshEditor/appendLogs`.
 *
 * Everything time- or transport-shaped is INJECTED (`call`, `schedule`,
 * `cancel`, `now`) so tests drive the clock and the wire by hand; Task 7
 * binds them to `rpcCall`, `setTimeout`/`clearTimeout` and `Date.now`.
 *
 * Ordering contract (spec §6/§8):
 * - single flight — at most ONE `call` in flight; entries pushed meanwhile
 *   queue in the buffer, and after the in-flight send settles a follow-up
 *   flush drains them (order preserved: an unsent remainder is `requeue`d
 *   BEFORE entries pushed during the flight, because requeue prepends);
 * - each flush drains once and sends in ≤200-entry CHUNKS (the Host rejects
 *   oversized RPC payloads as `logs/invalid` — one drain must never become
 *   one call);
 * - on a transport-style failure the unsent remainder (failed chunk + every
 *   later chunk, original order) goes back to the buffer head for the NEXT
 *   round — never a hot retry loop.
 *
 * Failure semantics (spec §8 铁律: the flusher NEVER throws to its caller):
 * - envelope `ok === true` → chunk sent; a fully settled sequence without a
 *   transport failure resets the consecutive-failure counter;
 * - `ok === false` whose `error.code`/`error.message` matches
 *   `/logs\/invalid/` → only that CHUNK is dropped (invalid payloads are
 *   never retried) with exactly one `onWarn` per flush; the sequence
 *   continues with the next chunk;
 * - anything else (transport rejection, `ok === false` with another code,
 *   a malformed envelope) → `buffer.requeue` of the unsent remainder and
 *   the counter advances ONCE per flush, warning on the 1st and then every
 *   50th failure (1, 50, 100, …).
 *
 * `dispose()` cancels the pending debounce timer (wired into the plugin's
 * effect cleanup by Task 7).
 *
 * @module @dybai/dsh-editor/log-flush
 */

/** 防抖默认 5000ms：每次 push 重置。 */
const DEFAULT_DEBOUNCE_MS = 5000;
/** 满批立即 flush 的默认批量。 */
const DEFAULT_BATCH_SIZE = 50;
/** 单次 RPC 条目上限（Host 契约）：超出按 logs/invalid 整批拒绝。 */
const MAX_RPC_ENTRIES = 200;
/** 无效载荷判别：Host `logs/invalid` 拒绝码。 */
const INVALID_PATTERN = /logs\/invalid/;
/** 连续失败 warn 节流步长：第 1 次与之后每 50 次。 */
const WARN_EVERY = 50;

/**
 * Create the flush orchestrator.
 * @param deps - injected collaborators:
 *   `call(endpoint, args)` → the RPC gateway envelope
 *   `{ ok: true } | { ok: false, error: { code?; message? } }`;
 *   `buffer` — a Task 2 `createLogBuffer()` instance;
 *   `schedule(fn, ms)` → timer handle / `cancel(handle)` (setTimeout pair);
 *   `now()` — injected clock, accepted for the deps contract (all flusher
 *   timing itself flows through schedule/cancel);
 *   `onWarn(msg)` — degrade sink (default `console.warn`);
 *   `debounceMs` (default 5000), `batchSize` (default 50).
 * @returns the flusher: `{ push(entry), flush(), dispose() }`.
 */
export function createLogFlusher(deps) {
	const {
		call,
		buffer,
		schedule,
		cancel,
		now,
		onWarn = (message) => console.warn(message),
		debounceMs = DEFAULT_DEBOUNCE_MS,
		batchSize = DEFAULT_BATCH_SIZE
	} = deps;

	/** 当前防抖计时器句柄；timerArmed 区分「0 号句柄」与「无计时器」。 */
	let timerHandle;
	let timerArmed = false;
	/** 单飞行：正在跑的 flush 周期 promise；null 表示空闲。 */
	let inFlight = null;
	/** 连续失败计数；任何成功清零。 */
	let failures = 0;

	/**
	 * 上报一次降级告警。铁律：上报通道自身失败只吞不抛。
	 * @param message - 告警文本。
	 */
	function warn(message) {
		try {
			onWarn(message);
		} catch {
			// 铁律：onWarn 抛出不得外溢
		}
	}

	/** 重置防抖计时：先撤销旧计时器再排新的。 */
	function armTimer() {
		if (timerArmed) {
			timerArmed = false;
			cancel(timerHandle);
		}
		timerHandle = schedule(() => {
			timerArmed = false;
			void flush();
		}, debounceMs);
		timerArmed = true;
	}

	/**
	 * 信封是否为 `logs/invalid` 拒绝（code 或 message 命中即算）。
	 * @param result - call 的返回值（可能畸形）。
	 * @returns 是否为无效载荷拒绝。
	 */
	function isInvalidRejection(result) {
		if (result === null || typeof result !== 'object' || result.ok !== false) return false;
		const error = result.error;
		if (error === null || typeof error !== 'object') return false;
		const code = typeof error.code === 'string' ? error.code : '';
		const message = typeof error.message === 'string' ? error.message : '';
		return INVALID_PATTERN.test(code) || INVALID_PATTERN.test(message);
	}

	/**
	 * 一个 flush 周期：drain 一次 → 按 Host 单次 RPC ≤200 条拆块顺序发送。
	 * 单飞行覆盖整个块序列（中途新 push 只入缓冲等待）。块级语义：
	 * - 成功 → 继续下一块；整个序列落定且无传输失败 → 成功清零计数，
	 *   缓冲仍非空（飞行期间新 push）时自动续排，直到缓冲排空；
	 * - `logs/invalid` → 只丢本块（无效载荷不重试），按 flush 事件只
	 *   onWarn 一次，序列继续；
	 * - 其他失败（reject / ok:false 不匹配 / 畸形信封）→ 失败块连同后续
	 *   未发送块原序 requeue 前插恢复全局时序，本轮终止——下轮触发再试，
	 *   绝不热重试；计数整个 flush 只加一。
	 * 周期整体包在 try/catch 里：铁律，flush 永不 reject。
	 */
	async function runCycle() {
		try {
			for (;;) {
				const entries = buffer.drain();
				if (!Array.isArray(entries) || entries.length === 0) return;
				/** 本轮是否已为 invalid 丢弃告警过（按 flush 事件只一次）。 */
				let invalidWarned = false;
				for (let offset = 0; offset < entries.length; offset += MAX_RPC_ENTRIES) {
					const chunk = entries.slice(offset, offset + MAX_RPC_ENTRIES);
					let result;
					try {
						result = await call('dshEditor/appendLogs', { entries: chunk });
					} catch {
						result = undefined; // 传输层 reject：归入其他失败
					}
					if (result !== null && typeof result === 'object' && result.ok === true) {
						continue; // 本块已送达，继续下一块
					}
					if (isInvalidRejection(result)) {
						if (!invalidWarned) {
							invalidWarned = true;
							warn(`dsh-editor log-flush: appendLogs rejected ${chunk.length} entries as logs/invalid; chunk dropped`);
						}
						continue; // 只丢本块，序列继续
					}
					// 其他失败：失败块 + 后续未发送块原序前插，本轮终止
					failures += 1;
					if (failures === 1 || failures % WARN_EVERY === 0) {
						warn(`dsh-editor log-flush: appendLogs failed (${failures} consecutive failures); entries requeued for the next flush`);
					}
					buffer.requeue(entries.slice(offset));
					return;
				}
				failures = 0; // 序列全部落定且无传输失败（含 invalid 丢弃）→ 成功清零
				continue; // 缓冲非空 → 自动续排（保序）
			}
		} catch {
			// 铁律：周期内任何意外（含 buffer 故障）都不得外抛
		} finally {
			inFlight = null;
		}
	}

	/**
	 * 手动触发一次 flush（防抖到期 / 满批 / hide 事件共用）。单飞行：
	 * 已有周期在跑时搭现有班次（其循环会捞走新缓冲条目）。永不 reject。
	 * @returns 周期结束后 resolve 的 promise。
	 */
	function flush() {
		if (inFlight !== null) return inFlight;
		inFlight = runCycle();
		return inFlight;
	}

	return {
		/**
		 * 入一条日志：进缓冲并重置防抖计时；满 batchSize 时立即 flush。
		 * 铁律：永不 throw（单飞行期间的立即 flush 由续排兜住）。
		 * @param entry - 已过 channel 校验的条目（对本模块不透明）。
		 */
		push(entry) {
			try {
				buffer.push(entry);
				armTimer(); // 每次 push 重置防抖
				if (buffer.size() >= batchSize) {
					void flush(); // 满批立即发（flush 永不 reject）
				}
			} catch {
				// 铁律：push 永不外抛
			}
		},

		flush,

		/**
		 * 取消挂起的防抖计时器（插件 effect 清理时调用）。
		 */
		dispose() {
			if (timerArmed) {
				timerArmed = false;
				cancel(timerHandle);
			}
		}
	};
}
