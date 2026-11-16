/**
 * Debug logging — the `[dsh-editor]`-prefixed `console.debug` channel shared
 * by the self-managed keymap dispatch path, the go-to-line popover and the
 * keymap migration (v0.6.0). Debug level only: browsers hide it unless
 * "verbose" is enabled, so the traces never pollute a normal console yet
 * stay available when diagnosing what state the hotkey path saw (dispatch,
 * bail reason, parse result, navigation verdict, migration fills).
 *
 * `createDebugLog(sink)` injects the console (unit-testable); the module
 * default `debugLog` binds to the global console and degrades to a silent
 * no-op when no console exists.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/debug-log
 */

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

/** The shared production logger (global console; silent when unavailable). */
export const debugLog = createDebugLog(typeof console !== 'undefined' ? console : null);
