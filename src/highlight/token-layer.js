/**
 * Token layer — the syntax-highlight backdrop descriptor behind the
 * code-highlight mode (Task 7, spec §3.2's React-adjacent shell).
 *
 * `createTokenLayerDescriptor({ engine, getPath, requestFrame })` builds the
 * Task 6 extra-backdrop-layer descriptor (`{ key, className, paint }` plus a
 * `dispose` teardown hook): the mode component mounts it once per editor and
 * PlainTextMode's `syncExtraLayers` hands `paint(layer, context)` the live
 * window on every repaint path the whitespace layer already serves.
 *
 * The descriptor closure owns everything highlight-related for its tab:
 *
 * - Language resolution (`languageOf(getPath())`) — `getPath` is re-read on
 *   every paint, so the caller supplies a props-backed ref accessor and the
 *   descriptor survives mode-path changes without being re-created. A
 *   language change disposes the previous engine session and lazily creates
 *   a fresh one (sessions are per tab, one per resolved language).
 * - The engine session: `engine.update(session, context.area.value)` runs
 *   inside paint (idempotent for unchanged text — the engine's cache hit
 *   returns the identical array). `engine.ready(language)` is requested once
 *   per language while the tab renders plain; its resolution schedules ONE
 *   repaint of the LATEST (layer, context) pair so text that loaded while
 *   the user was idle still colors (spec §5.1's "加载完成自动上色" — the UI has
 *   no loading state, plain rendering simply upgrades in place; a scroll
 *   between ask and arrival repaints the scrolled window, never the mount
 *   paint). A failed load resolves false, schedules nothing and is never
 *   re-asked (the chunk loader's negative cache owns retry policy).
 * - The DOM painting: a full clear + windowed rebuild, the whitespace
 *   painter's exact discipline and geometry — one `-token-row` span per
 *   visual row (`top` in px, `left: ${bandWidth}ch`), token runs as colored
 *   spans (fontStyle bitmask 4/8 → underline / line-through — the italic /
 *   bold bits are dropped at RENDER time, see applyFontStyle's
 *   advance-invariance note), gaps as bare text nodes inheriting the
 *   layer's color.
 *   Match tints (the 0.18.0 token-tint revision) ride the SAME spans: the
 *   context's `matchTints` Map supplies line-relative labeled ranges and a
 *   covered run renders as one span carrying the tint background class
 *   (`-match-word` / `-match-selection` / `-match-both`) plus its inline
 *   color/text-decoration — the ink and the background share the span's
 *   advance,
 *   so a styled token's step can never misalign its highlight the way a
 *   separately-positioned overlay row's could. The active tint (the
 *   2026-11-26 revision) adds the `'active'` label → `-match-active` (the
 *   strongest brand wash): the current selection paints through the token
 *   fragment stream, replacing the inkless variant's SUPPRESSED native
 *   selection background — which laid out on the invisible regular-weight
 *   text and floated off the styled glyphs (the misalignment this fixes).
 *   Wrap mode paints `context.wrapRows` ALONE (review carry-forward:
 *   visibleCount counts slice-null lines absent from wrapRows); plain mode
 *   paints the `firstLine` run at `paddingTop + line × lineHeight −
 *   scrollTop` — the same arithmetic `syncWhitespace` uses, so token ink and
 *   glyph rows can never disagree about where a row sits. The layer
 *   translates against scrollLeft in plain mode and resets in wrap mode,
 *   mirroring the whitespace layer's two branches.
 * - Degradation (spec §8): the engine signals a tokenize-budget blowout on
 *   the session (`degraded = true`, `degradedNotified = false`) and stays
 *   callback-free; this layer reads the flags, marks `degradedNotified`,
 *   and schedules ONE `requestFrame` repaint of the LATEST (layer, context)
 *   pair ("rAF 下一帧重试一次"). A blowout during the retry repaint stays
 *   plain — the pending repaint is the retry, and the next NORMAL paint
 *   after a fresh blowout re-arms one frame (flags clear at the top of every
 *   engine update, so each new episode looks fresh to the layer). At most
 *   one frame is ever pending: a second detection in the same frame window
 *   only refreshes the latest pair, never piles up frames.
 *
 * Plain rendering paints, it does not skip: while tokens are unavailable
 * (not loaded, degraded, idle-big-file, unknown language, no engine) the
 * window still repaints as inherit runs. The textarea's own text is
 * transparent while a token layer is mounted (the `-area-inkless` overlay
 * variant), so an empty layer would leave the text invisible — the layer is
 * the ink provider for the whole surface, colored when tokens exist and
 * plain when they do not, which is exactly spec §8's "体验等同 plain-text".
 *
 * The paint NEVER throws (the seam's containment would drop the descriptor
 * for the tab's lifetime): every input is guarded, every engine/DOM touch is
 * wrapped, and unusable input degrades to a silent partial paint.
 *
 * React-free by design — `node --test` drives it with a fake engine and a
 * minimal DOM stub. The `CLASS` literal mirrors components.js's prefix;
 * importing components.js here would drag React into every highlight test.
 *
 * @module @dybai/dsh-editor/highlight/token-layer
 */

import { languageOf } from './languages.js';
import { buildTokenRowFragments, buildTokenRowFragmentsWithTints } from '../token-rows.js';
import { EMPTY_LINES } from './engine.js';

/** CSS class prefix — the same literal components.js defines (`CLASS`). */
const CLASS = 'dsh-editor';

/**
 * Create the token backdrop descriptor.
 *
 * @param {object} deps - injected collaborators:
 * - `engine`: the Task 3 engine (`{ ready, createSession, update, dispose }`).
 *   A missing engine degrades the whole layer to a plain-text renderer.
 * - `getPath(): string`: the live mode path, re-read on every paint (a
 *   props-backed ref accessor from the mode component — the descriptor is
 *   created once per mount, not per render). A throwing accessor is guarded.
 * - `requestFrame(fn)`: the frame-boundary seam, defaulting to the global
 *   `requestAnimationFrame` (injectable for tests; a host without any frame
 *   scheduler degrades to a synchronous call).
 * - `subscribeProgress(fn)`: optional — registers `fn` as an engine-progress
 *   listener (progressive files advance across background frames; every
 *   advance repaints so colors fill in while the user reads). Returns an
 *   unsubscribe function; wired from `runtime.onHighlightProgress`.
 * @returns {{ key: string, className: string, paint: (layer: any, context: any) => void,
 *   dispose: () => void }} the Task 6 descriptor with a teardown hook.
 *   `dispose` drops the current engine session — the mode component calls it
 *   on unmount (tab close / mode switch), since the seam has no descriptor
 *   teardown of its own; it is idempotent and later paints stay no-ops.
 */
export function createTokenLayerDescriptor({ engine, getPath, requestFrame, subscribeProgress }) {
	const hasEngine = engine !== null && engine !== undefined;
	const frame =
		typeof requestFrame === 'function'
			? requestFrame
			: typeof requestAnimationFrame === 'function'
				? (fn) => requestAnimationFrame(fn)
				: (fn) => fn();

	/** The live session (one per resolved language), or null. */
	let session = null;
	/** The language `session` tokenizes as (undefined = plain, no session). */
	let language;
	/** The language `ready()` was already requested for (dedupes the ask). */
	let readyAskedLanguage;
	/** Teardown flag: a disposed descriptor paints nothing and owns nothing. */
	let disposed = false;
	/** The progress-channel unsubscriber — set by subscribeProgressChannel(). */
	let unsubscribeOnDispose;
	/**
	 * The LATEST live (layer, context) pair — refreshed on EVERY paint (each
	 * paint stores its own pair after the guards pass). Every scheduled
	 * repaint (degradation retry, ready arrival) repaints THIS pair, never
	 * the pair of the paint that detected the condition: a scroll between ask
	 * and arrival must not repaint a stale line window against the live
	 * scroll (the plan's "repaint of the saved pair" — the saved pair simply
	 * stays current).
	 */
	let latestLayer = null;
	let latestContext = null;
	/** Whether one frame is already scheduled (the single-pending-frame rule). */
	let framePending = false;

	/**
	 * Schedule one repaint of the LATEST (layer, context) pair. At most one
	 * frame is ever pending; the repaint runs as a RETRY (a blowout inside it
	 * never re-schedules — the caller decides via `isRetry`).
	 */
	function scheduleLatestRepaint() {
		if (disposed) return;
		if (framePending) return;
		if (latestLayer === null || latestContext === null) return;
		framePending = true;
		try {
			frame(() => {
				framePending = false;
				const layerToPaint = latestLayer;
				const contextToPaint = latestContext;
				if (layerToPaint === null || contextToPaint === null) return;
				try {
					paintLayer(layerToPaint, contextToPaint, true);
				} catch {
					// the retry is as contained as the paint it retries
				}
			});
		} catch {
			framePending = false;
		}
	}

	/** The mode path, guarded — a throwing accessor degrades to no language. */
	function safePathOf() {
		if (typeof getPath !== 'function') return undefined;
		try {
			return getPath();
		} catch {
			return undefined;
		}
	}

	// Engine progress channel (0.18.0): progressive files advance across
	// background frames; every advance repaints the latest pair so colors
	// fill in while the user reads. Subscribed once per descriptor — dispose
	// unsubscribes, the StrictMode re-arm (reset) re-subscribes, so a live
	// descriptor always has exactly one listener. The repaint itself no-ops
	// while disposed.
	function subscribeProgressChannel() {
		if (typeof subscribeProgress !== 'function') return;
		try {
			const unsubscribe = subscribeProgress(() => scheduleLatestRepaint());
			if (typeof unsubscribe === 'function') unsubscribeOnDispose = unsubscribe;
		} catch {
			// a broken progress channel must not break the layer
		}
	}
	subscribeProgressChannel();

	/**
	 * Ask the engine to make the language tokenizable (chunk load + grammar
	 * registration). Asked once per language while the tab renders plain; the
	 * resolution schedules one repaint of the LATEST pair so idle text colors
	 * when the chunk lands (a scroll that happened meanwhile repaints the
	 * scrolled window, not the mount paint). A failed load stays plain and is
	 * never re-asked.
	 */
	function ensureLanguageReady(lang) {
		if (readyAskedLanguage === lang) return;
		readyAskedLanguage = lang;
		if (!hasEngine) return;
		let promise;
		try {
			promise = engine.ready(lang);
		} catch {
			return;
		}
		if (promise === null || promise === undefined || typeof promise.then !== 'function') return;
		promise.then(
			(loaded) => {
				if (disposed || language !== lang || loaded !== true) return;
				scheduleLatestRepaint();
			},
			() => {
				// a rejected ready (failed init/load) stays plain — the chunk
				// loader's negative cache blocks repeat transport calls anyway
			}
		);
	}

	/**
	 * fontStyle bitmask → inline CSS for a token span. ADVANCE-INVARIANT
	 * RENDERING (2026-11-27): the italic (1) and bold (2) bits are dropped
	 * (`bits &= ~3`) before anything is applied. The inkless architecture
	 * lays the visible token ink against the INVISIBLE textarea text, which
	 * typesets regular weight — mouse mapping, the caret and the native
	 * selection are all anchored on that layout, so ink whose glyphs carry
	 * different ADVANCE widths (italic/bold do, in the CJK fallback font)
	 * drifts off every pixel-anchored affordance (selection highlights
	 * floated off bold glyphs, growing with bold content). The token-type
	 * distinction survives through color alone; underline (4) and
	 * line-through (8) add no advance and stay. The DATA layer keeps the
	 * engine's fontStyle numbers untouched — this mask is renderer policy,
	 * restorable if a future advance-safe font lands.
	 */
	function applyFontStyle(style, fontStyle) {
		const rawBits = typeof fontStyle === 'number' && Number.isFinite(fontStyle) ? Math.floor(fontStyle) : 0;
		const bits = rawBits & ~3;
		const decorations = [];
		if ((bits & 4) !== 0) decorations.push('underline');
		if ((bits & 8) !== 0) decorations.push('line-through');
		if (decorations.length > 0) style.textDecoration = decorations.join(' ');
	}

	/**
	 * One row's fragments: token runs colored, gaps bare inherit text — and,
	 * when the fragments carry tint labels (the token-tint revision), a
	 * covered run renders as ONE span carrying the tint background class
	 * AND the run's inline color/text-decoration (the advance-invariant
	 * inline set — applyFontStyle drops the italic/bold bits). The ink and the highlight
	 * background then share the span's own measured advance, which is the
	 * whole point of the revision: a styled token's step (bold, CJK, ...)
	 * can no longer leave the background drifting off its characters the
	 * way a separately-positioned overlay row's could. A covered INHERIT
	 * run (a gap under a tint) still needs the class to paint the
	 * background, so it renders as a class-carrying span with no inline
	 * color — the ink stays inherited. Uncovered runs keep exactly the
	 * historical shapes: colored spans and bare text nodes.
	 * @param {any} doc - the owner document (from the paint context).
	 * @param {any} layer - the descriptor's mounted div.
	 * @param {number} bandWidth - the line-number band width in ch.
	 * @param {number} topPx - the row's viewport-relative top.
	 * @param {Array<any>} fragments - the builder's runs (with or without a
	 *   `tint` field — a missing field is a null tint, the old path).
	 */
	function appendRow(doc, layer, bandWidth, topPx, fragments) {
		if (fragments === null || fragments === undefined || fragments.length === 0) return;
		const row = doc.createElement('span');
		row.className = `${CLASS}-token-row`;
		row.style.top = `${topPx}px`;
		row.style.left = `${bandWidth}ch`;
		for (const fragment of fragments) {
			if (fragment === null || typeof fragment !== 'object' || typeof fragment.text !== 'string' || fragment.text.length === 0) {
				continue;
			}
			const tint = fragment.tint;
			const colored = typeof fragment.color === 'string' && fragment.color.length > 0;
			// 'active' (the 2026-11-26 revision) joins the recognized labels:
			// the class template already yields -match-active for it — the
			// live selection's replacement visual, the strongest brand wash.
			if (tint === 'word' || tint === 'selection' || tint === 'both' || tint === 'active') {
				// The match background rides the SAME span as the ink: the
				// class carries the tint, the inline styles (when the run is
				// a token run) the ink — one advance, never two.
				const span = doc.createElement('span');
				span.className = `${CLASS}-match-${tint}`;
				span.textContent = fragment.text;
				if (colored) {
					span.style.color = fragment.color;
					applyFontStyle(span.style, fragment.fontStyle);
				}
				row.appendChild(span);
			} else if (colored) {
				const span = doc.createElement('span');
				span.textContent = fragment.text;
				span.style.color = fragment.color;
				applyFontStyle(span.style, fragment.fontStyle);
				row.appendChild(span);
			} else {
				row.appendChild(doc.createTextNode(fragment.text));
			}
		}
		layer.appendChild(row);
	}

	/**
	 * The paint body. `isRetry` marks the scheduled frame's repaint: a blowout
	 * detected there stays plain (one retry per blowout episode).
	 * @param {any} layer - the descriptor's mounted div.
	 * @param {any} context - the seam's ExtraLayerPaintContext.
	 * @param {boolean} isRetry - true when the frame callback drives this paint.
	 */
	function paintLayer(layer, context, isRetry) {
		const contextOk = context !== null && typeof context === 'object';
		const area = contextOk ? context.area : null;
		const metrics = contextOk ? context.metrics : null;
		const doc =
			contextOk && context.doc !== null && context.doc !== undefined
				? context.doc
				: layer !== null && typeof layer === 'object'
					? layer.ownerDocument
					: null;
		if (area === null || typeof area !== 'object' || typeof area.value !== 'string') return;
		if (metrics === null || typeof metrics !== 'object') return;
		if (doc === null || typeof doc.createElement !== 'function' || typeof doc.createTextNode !== 'function') return;
		// The guards passed: this pair is the live mounted surface. Store it
		// as the LATEST pair so every scheduled repaint (degradation retry,
		// ready arrival) repaints the current window, never the pair of an
		// earlier paint (a scroll between ask and arrival must not repaint a
		// stale line window against the live scroll).
		latestLayer = layer;
		latestContext = context;
		const bandWidth = contextOk && Number.isFinite(context.bandWidth) ? context.bandWidth : 0;
		const paddingTop = Number.isFinite(metrics.paddingTop) ? metrics.paddingTop : 0;
		const lineHeight = Number.isFinite(metrics.lineHeight) ? metrics.lineHeight : 0;

		// Language resolution + per-language session lifecycle: a change
		// disposes the old session before a new one is lazily created.
		const lang = languageOf(safePathOf());
		if (lang !== language) {
			if (session !== null && hasEngine) {
				try {
					engine.dispose(session);
				} catch {
					// teardown never breaks the paint
				}
			}
			session = null;
			language = lang;
			readyAskedLanguage = undefined;
		}
		if (lang !== undefined && session === null && hasEngine) {
			try {
				session = engine.createSession(lang);
			} catch {
				session = null;
			}
		}

		// Tokenize (idempotent for unchanged text). Every degraded path of the
		// engine answers EMPTY_LINES; a throwing engine degrades to it too.
		let lines = EMPTY_LINES;
		if (session !== null && hasEngine) {
			try {
				const updated = engine.update(session, area.value);
				lines = Array.isArray(updated) ? updated : EMPTY_LINES;
			} catch {
				lines = EMPTY_LINES;
			}
		}

		// Degradation + not-ready bookkeeping, read off the session AFTER the
		// update (the engine re-arms both flags at the top of every update).
		if (lines === EMPTY_LINES && session !== null) {
			if (session.degraded === true && session.degradedNotified === false) {
				// Budget blowout: mark notified, ONE repaint of the latest pair.
				session.degradedNotified = true;
				if (isRetry !== true) scheduleLatestRepaint();
			} else if (session.idle !== true) {
				// Not loaded yet: plain until the chunk lands, then auto-color.
				ensureLanguageReady(lang);
			}
		}

		// The window: wrap mode leans on wrapRows ALONE (visibleCount counts
		// slice-null lines absent from wrapRows); plain mode is the
		// firstLine/visibleCount run at the whitespace painter's arithmetic.
		const docLines = area.value.split('\n');
		const wrapRows = contextOk && context.wrapEnabled === true && Array.isArray(context.wrapRows) ? context.wrapRows : null;
		const rowsToPaint = [];
		if (wrapRows !== null) {
			for (const row of wrapRows) {
				if (row === null || typeof row !== 'object') continue;
				const line = row.line;
				if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) continue;
				const lineIndex = Math.floor(line) - 1;
				if (lineIndex < 0 || lineIndex >= docLines.length) continue;
				if (typeof row.top !== 'number' || !Number.isFinite(row.top)) continue;
				rowsToPaint.push({
					top: row.top,
					lineIndex,
					slice: {
						start: typeof row.start === 'number' && Number.isFinite(row.start) ? Math.max(0, Math.floor(row.start)) : 0,
						end: typeof row.end === 'number' && Number.isFinite(row.end) ? Math.max(0, Math.floor(row.end)) : undefined,
					},
				});
			}
		} else {
			const firstLine = contextOk && Number.isFinite(context.firstLine) ? Math.floor(context.firstLine) : 0;
			const visibleCount = contextOk && Number.isFinite(context.visibleCount) ? Math.floor(context.visibleCount) : docLines.length;
			const scrollTop = Number.isFinite(area.scrollTop) ? area.scrollTop : 0;
			for (let index = firstLine; index < firstLine + visibleCount; index += 1) {
				if (index < 0 || index >= docLines.length) continue;
				rowsToPaint.push({ top: paddingTop + index * lineHeight - scrollTop, lineIndex: index, slice: undefined });
			}
		}

		// Full clear, then windowed rebuild — the whitespace painter's
		// discipline. Plain rendering (EMPTY_LINES, no session) paints the
		// window as inherit runs: the inkless textarea relies on this layer
		// for readable text whenever it is mounted.
		//
		// Match tints (the token-tint revision): the context may carry
		// `matchTints` — a Map<lineIndex, line-relative labeled ranges> the
		// components side builds from the SAME layer match arrays the
		// standalone match layer would paint. The ranges share the slice's
		// coordinate system (line-relative), so the row's fragments fold
		// them in through `buildTokenRowFragmentsWithTints` and the covered
		// runs render with their background in the token span itself. The
		// Map is validated defensively (a non-Map value degrades to the old
		// path); a line with no entry answers undefined → null → no tint
		// for that row, so a partially-populated Map costs nothing extra.
		// With no usable matchTints the row builds through the ORIGINAL
		// `buildTokenRowFragments` — the pre-revision rendering, byte
		// identical (plain-text and match-off editors keep their exact
		// paint; the existing token-layer suites pin it).
		//
		// The active-tint revision (2026-11-26): the labeled ranges may
		// carry `'active'` — the current selection's per-line clipped spans
		// (components' third mergeLayerRanges source). They fold in through
		// the same fragment stream and paint as `-match-active`, the
		// replacement for the native selection background the inkless
		// variant's stylesheet suppresses.
		const matchTints = contextOk && context.matchTints instanceof Map ? context.matchTints : null;
		layer.textContent = '';
		for (const row of rowsToPaint) {
			const lineText = docLines[row.lineIndex];
			const tokens = lines === EMPTY_LINES ? undefined : lines[row.lineIndex];
			const fragments =
				matchTints === null
					? buildTokenRowFragments(lineText, tokens, row.slice)
					: buildTokenRowFragmentsWithTints(lineText, tokens, row.slice, matchTints.get(row.lineIndex) ?? null);
			appendRow(doc, layer, bandWidth, row.top, fragments);
		}
		// Horizontal half of the scroll sync, the whitespace layer's two
		// branches: wrap reflows instead of translating (reset whatever a
		// wrap-off pass left), plain translates against scrollLeft.
		if (wrapRows !== null) {
			layer.style.transform = 'translateX(0px)';
		} else {
			const scrollLeft = Number.isFinite(area.scrollLeft) ? area.scrollLeft : 0;
			layer.style.transform = `translateX(${-scrollLeft}px)`;
		}
	}

	return {
		key: 'tokens',
		className: `${CLASS}-tokens`,
		/**
		 * Paint the token window. Never throws — the seam's containment would
		 * drop the descriptor for the tab's lifetime, so every failure here
		 * degrades to a silent partial paint instead.
		 * @param {any} element - the descriptor's mounted div (or null).
		 * @param {any} context - the seam's ExtraLayerPaintContext (or null).
		 */
		paint(element, context) {
			if (disposed) return;
			if (element === null || element === undefined || typeof element !== 'object') return;
			if (context === null || context === undefined || typeof context !== 'object') return;
			try {
				paintLayer(element, context, false);
			} catch {
				// containment: a broken paint must never reach the seam's catch —
				// one glitch degrades to a stale window, not a dropped layer
			}
		},
		/**
		 * Teardown: drop the engine session (idempotent). The mode component
		 * calls this on unmount; later paints (and pending frames) no-op.
		 * The not-ready ask is forgotten too, so a re-armed descriptor
		 * re-requests a still-unloaded language.
		 */
		dispose() {
			disposed = true;
			latestLayer = null;
			latestContext = null;
			readyAskedLanguage = undefined;
			if (typeof unsubscribeOnDispose === 'function') {
				try {
					unsubscribeOnDispose();
				} catch {
					// teardown never throws
				}
				unsubscribeOnDispose = undefined;
			}
			if (session !== null && hasEngine) {
				try {
					engine.dispose(session);
				} catch {
					// teardown never throws
				}
			}
			session = null;
		},
		/**
		 * Re-arm after dispose — React StrictMode's simulated unmount runs the
		 * shell's cleanup (dispose) and then re-runs its effect on the SAME
		 * descriptor instance; without re-arming, the disposed descriptor
		 * would keep the inkless overlay active on the textarea while painting
		 * nothing (invisible text for every dev-mode code-highlight tab). The
		 * session dropped by dispose is lazily recreated on the next paint and
		 * a still-unloaded language is re-asked. The progress channel is
		 * re-subscribed the same way. Idempotent; a real unmount never calls
		 * it, so dispose stays final there.
		 */
		reset() {
			disposed = false;
			subscribeProgressChannel();
		},
	};
}
