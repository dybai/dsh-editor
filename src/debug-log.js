/**
 * Debug logging — the `[dsh-editor]`-prefixed console channel shared by the
 * self-managed keymap dispatch path, the go-to-line popover and the keymap
 * migration (v0.6.0). Debug level only: browsers hide it unless "verbose" is
 * enabled, so the traces never pollute a normal console yet stay available
 * when diagnosing what state the hotkey path saw (dispatch, bail reason,
 * parse result, navigation verdict, migration fills).
 *
 * `createDebugLog(sink)` injects the console (unit-testable); the module
 * default `debugLog` binds to the global console and degrades to a silent
 * no-op when no console exists.
 *
 * v2 adds `createLogChannel(deps)`: the leveled (debug/info/warn/error)
 * persistent log channel the log-manager assembles. Every call mirrors to
 * the injected console-like sink (prefixed, per-level method) AND enqueues
 * one entry (`{ ts, level, source: 'client', scope, text }`, text via
 * `serializeLogArgs`) for the bounded buffer / flush orchestrator. Iron
 * rule: the four channel methods NEVER throw — a throwing or missing sink
 * method, a throwing enqueue (one `sink.warn` drop notice, itself guarded)
 * and any argument values all degrade silently.
 *
 * Single import (`serializeLogArgs`): pure functions only, unit-testable
 * without DOM.
 *
 * @module @dybai/dsh-editor/debug-log
 */

import { serializeLogArgs } from './serialize-log.js';

/** Prefix every console line carries, shared by the debug logger and the channel. */
const PREFIX = '[dsh-editor]';

/** Scope cap: longer scopes are sliced to this many characters. */
const MAX_SCOPE_CHARS = 64;

/** Scope recorded when the caller passes a non-string scope. */
const UNKNOWN_SCOPE = 'unknown';

/** Log levels the channel exposes; each maps to the sink method of the same name. */
const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Build a prefixed debug logger over an injected console-like sink.
 * @param {{ debug?: (...args: any[]) => void } | null} [sink] - the console
 *   to write through; `null`/`undefined`/debug-less sinks degrade to a
 *   silent no-op.
 * @returns {(scope: string, ...args: any[]) => void}
 */
export function createDebugLog(sink) {
	const debug =
		sink !== null && typeof sink === 'object' && typeof sink.debug === 'function' ? sink.debug.bind(sink) : null;
	return function debugLog(scope, ...args) {
		if (debug === null) return;
		debug('[dsh-editor]', scope, ...args);
	};
}

/**
 * Build the leveled persistent log channel: each call mirrors to the
 * console-like sink's same-named method (missing method → console skipped,
 * entry still enqueued) and enqueues exactly one entry shaped
 * `{ ts: now(), level, source: 'client', scope, text: serializeLogArgs(args) }`.
 *
 * Scope normalization: non-string → `'unknown'`; longer than 64 chars →
 * sliced to 64 (both the console line and the entry carry the normalized
 * scope).
 *
 * Iron rule: `debug`/`info`/`warn`/`error` NEVER throw. A throwing (or
 * property-reading-broken) sink method is swallowed; a throwing `enqueue`
 * is swallowed after one guarded `sink.warn` drop notice that is itself
 * wrapped in try/catch.
 *
 * @param {{ sink?: Console-like; enqueue?: (entry: object) => void; now?: () => number }} [deps]
 *   - `sink`: console-like object with optional debug/info/warn/error methods.
 *   - `enqueue`: receives each entry (the bounded log buffer's `push`).
 *   - `now`: timestamp source for `entry.ts` (defaults to `Date.now`).
 * @returns {{ debug(scope: string, ...args: unknown[]): void; info(...): void;
 *   warn(...): void; error(...): void }}
 */
export function createLogChannel(deps) {
	const sink = deps?.sink ?? null;
	const enqueue = deps?.enqueue ?? null;
	const now = deps?.now ?? Date.now;

	/** Non-string scope → 'unknown'；超 64 字符截到 64。纯字符串操作，不会抛。 */
	const normalizeScope = (scope) =>
		typeof scope === 'string'
			? scope.length > MAX_SCOPE_CHARS
				? scope.slice(0, MAX_SCOPE_CHARS)
				: scope
			: UNKNOWN_SCOPE;

	/** 单级别发射：console 镜像 + 入队；任何一步故障都不得向调用方外抛。 */
	const emit = (level, scope, args) => {
		const normalizedScope = normalizeScope(scope);
		// console 侧：方法缺失即跳过（含属性读取抛错的病态 sink，一并吞掉）
		try {
			const method = sink?.[level];
			if (typeof method === 'function') method.call(sink, PREFIX, normalizedScope, ...args);
		} catch {
			// 铁律：console 抛错直接吞掉，不影响入队
		}
		const entry = { ts: now(), level, source: 'client', scope: normalizedScope, text: serializeLogArgs(args) };
		try {
			enqueue(entry);
		} catch {
			// 铁律：入队失败不得外抛；尝试 sink.warn 提示一次，该提示本身也包 try/catch
			try {
				const warn = sink?.warn;
				if (typeof warn === 'function') warn.call(sink, PREFIX, normalizedScope, '[log-channel] enqueue failed; entry dropped');
			} catch {
				// 连提示通道也坏了：彻底沉默
			}
		}
	};

	const channel = {};
	for (const level of LEVELS) {
		channel[level] = (scope, ...args) => emit(level, scope, args);
	}
	return channel;
}

/** The shared production logger (global console; silent when unavailable). */
export const debugLog = createDebugLog(typeof console !== 'undefined' ? console : null);
