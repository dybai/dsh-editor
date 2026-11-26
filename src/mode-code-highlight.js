/**
 * CodeHighlightMode — the thin composition shell behind the built-in
 * `code-highlight` mode (Task 7, spec §3.2).
 *
 * ALL highlight mechanics live in `src/highlight/token-layer.js` and the
 * engine; this file only composes: it forwards the FULL mode-prop set to
 * `PlainTextMode` unchanged and adds `extraBackdropLayers: [descriptor]` —
 * the Task 6 seam — so the token ink paints under the overlay textarea on
 * every repaint path the whitespace layer already serves. No state, no
 * handlers, no React tree of its own: a plain-text editor that gained a
 * token backdrop.
 *
 * The token-layer descriptor is created ONCE per mounted component (a ref,
 * not a per-render value — keys index the seam's ref map and the lifetime
 * drop set) with a props-backed path accessor: `props.path` lands in a ref
 * updated during render, and the descriptor re-reads it on every paint, so
 * a path change (session move, rename) re-resolves the language without
 * re-creating the descriptor or its session mid-flight.
 *
 * Teardown: the seam renders descriptor divs but has no descriptor unmount
 * hook, so this shell owns it — an effect cleanup calls `descriptor.dispose()`
 * on unmount (tab close, mode switch, keepMounted teardown), which hands the
 * engine session to `engine.dispose` (the engine drops its caches into a
 * WeakSet; the session becomes collectable). Language switches are covered
 * inside the descriptor itself (dispose old, create new, per paint). React
 * StrictMode's dev-only simulated unmount+remount runs that cleanup and then
 * re-runs the effect on the SAME descriptor instance, so the effect body
 * re-arms it (`descriptor.reset()`) — a remount always yields a live
 * descriptor instead of an inkless overlay that paints nothing.
 *
 * Degradation: when the runtime carries no engine (never in the shipped
 * wiring, but a defensive must — the components factory is a public seam),
 * no descriptor is created and the shell renders a plain-text editor with
 * no extra layers: byte-identical to the absent-prop path.
 *
 * React-requiring (the bundler resolves `require('react')` in factory
 * scope, exactly like components.js) — not importable under node:test; the
 * guard test reads this file's text.
 *
 * @module @dybai/dsh-editor/mode-code-highlight
 */

const React = require('react');
const h = React.createElement;

/**
 * Build the CodeHighlightMode component for one plugin activation.
 *
 * @param {object} deps - injected collaborators, all from the components
 *   runtime (created in `src/client-entry.js`, consumed by
 *   `createEditorComponents`):
 * - `engine`: the highlight engine singleton (`componentRuntime.highlightEngine`).
 * - `PlainTextMode`: the built-in mode component this shell composes
 *   (passed rather than imported to keep the module graph one-directional —
 *   components.js owns both halves).
 * - `createTokenLayerDescriptor`: the token-layer descriptor builder
 *   (src/highlight/token-layer.js), passed for the same reason.
 * @returns {(props: any) => any} the CodeHighlightMode component.
 */
export function createCodeHighlightMode({ engine, PlainTextMode, createTokenLayerDescriptor, subscribeProgress }) {
	/**
	 * The `code-highlight` mode component. Receives the full mode-prop set
	 * the framework hands every mode (see components.js's mode mount) and
	 * forwards it verbatim.
	 * @param {object} props - controller, t, address, path, sessionId,
	 *   highlightActiveLine, showLineNumbers, scrollBeyondLastLine, wordWrap,
	 *   showWhitespace, indentSettings, ruler, initialScroll, onScrollChange, log.
	 */
	return function CodeHighlightMode(props) {
		// The live mode path, ref-backed: the descriptor reads it at paint
		// time, so `props.path` changes are visible without re-creating the
		// descriptor (the ref is refreshed during render, before children
		// render — the same ref-during-render pattern components.js uses).
		const pathRef = React.useRef(null);
		pathRef.current = props.path;
		// One descriptor per mount. Created lazily so a runtime without an
		// engine (or a future variant without the token layer) simply renders
		// no extra layers instead of crashing the tab.
		const descriptorRef = React.useRef(null);
		if (descriptorRef.current === null && engine !== null && engine !== undefined && typeof createTokenLayerDescriptor === 'function') {
			descriptorRef.current = createTokenLayerDescriptor({
				engine,
				getPath: () => (typeof pathRef.current === 'string' ? pathRef.current : ''),
				// 0.18.0: progressive files repaint on every engine advance.
				subscribeProgress
			});
		}
		// Teardown (see module doc): the seam has no descriptor unmount hook,
		// so the shell hands the session back on unmount. Guarded — a throwing
		// dispose must never break the unmount. The effect BODY re-arms the
		// descriptor: React StrictMode (dev) simulates unmount+remount by
		// running the cleanup and then re-running THIS effect on the same
		// instance — without the re-arm the disposed descriptor would keep
		// the inkless overlay active on the textarea while painting nothing
		// (invisible text for every dev-mode code-highlight tab).
		React.useEffect(() => {
			const descriptor = descriptorRef.current;
			if (descriptor !== null && typeof descriptor.reset === 'function') {
				try {
					descriptor.reset();
				} catch {
					// re-arming never breaks the mount
				}
			}
			return () => {
				if (descriptor !== null && typeof descriptor.dispose === 'function') {
					try {
						descriptor.dispose();
					} catch {
						// teardown never breaks unmount
					}
				}
			};
		}, []);
		const extraBackdropLayers = descriptorRef.current === null ? undefined : [descriptorRef.current];
		// The full mode-prop set, forwarded verbatim (each named — the guard
		// test pins the list) plus the token layer. `log` rides along: it is
		// the paint-containment channel syncExtraLayers degrades a broken
		// descriptor through (0.17.0), additive and absent-safe like the rest.
		return h(PlainTextMode, {
			controller: props.controller,
			t: props.t,
			address: props.address,
			path: props.path,
			sessionId: props.sessionId,
			highlightActiveLine: props.highlightActiveLine,
			showLineNumbers: props.showLineNumbers,
			scrollBeyondLastLine: props.scrollBeyondLastLine,
			wordWrap: props.wordWrap,
			showWhitespace: props.showWhitespace,
			indentSettings: props.indentSettings,
			ruler: props.ruler,
			matchHighlight: props.matchHighlight,
			initialScroll: props.initialScroll,
			onScrollChange: props.onScrollChange,
			log: props.log,
			extraBackdropLayers,
		});
	};
}
