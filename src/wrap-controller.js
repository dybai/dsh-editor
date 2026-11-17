/**
 * Word-wrap controller — the facade the plain-text component drives for
 * soft-wrapped layout, and the single place where "what is on screen" state
 * lives.
 *
 * Why a facade: three consumers (the active-line bar, the gutter, and the
 * jump/End landing) all need wrapped-layout answers, and all three must agree
 * on the same per-line row counts even while the exact measurements are still
 * streaming in. The controller therefore owns one authoritative `counts[]`
 * array with a value for EVERY source line — an exact measurement where one
 * has landed, an estimate everywhere else — so a query never waits, never
 * throws, and never sees a hole. Queries answer from a `buildWrapGeometry`
 * model that is rebuilt lazily behind a dirty flag: a burst of same-frame
 * reads costs one prefix-sum rebuild, not one per read.
 *
 * The estimate layer is honest by construction: it is derived from
 * `estimateAllRows` at `charsPerRow = floor(usableWidth / chWidthPx)`, and it
 * only ever fills a line that no exact measurement has covered yet. An exact
 * value overwrites its estimate and never the other way around.
 *
 * Smoothing: `syncDraft` diffs the text (`changedLineRange`) and, when the
 * layout is already exact, re-measures only the changed lines; an edit that
 * covers the whole document (a reload, draft restore, or full paste) is
 * treated as a wholesale replacement and re-measured in full, so a stale
 * prefix sum cannot survive. `syncViewport` re-estimates against the new
 * width immediately (the drag reads as near-real-time) and debounces the
 * expensive full re-measure (200 ms by default) so a drag settles once.
 *
 * Everything platform-specific arrives injected: the measurer (Task 5), the
 * timer pair, and the optional gutter layer port. That makes the whole
 * controller unit-testable under `node --test` with no DOM, and lets the
 * component supply the real layer (Task 8) without this module importing it.
 * Only `wrap-geometry` is imported — never `wrap-measure`, never an existing
 * editor module.
 *
 * Line height: the row counts do not depend on it, but pixels and the
 * `endLandingInputs()` contract do. The controller reads it from the optional
 * `lineHeightPx` dep (a number or a provider function) and, failing that,
 * from an optional `lineHeightPx` number/function on the measurer. The
 * component knows the value from `metricsOfArea()` and is expected to pass
 * it; when it is unavailable, geometry falls back to
 * `FALLBACK_LINE_HEIGHT_PX` so query shapes stay safe while readiness gates
 * the exact-only answers.
 *
 * Paint notification: the optional `onCountsChange` dep fires after every
 * measurement callback that commits row counts (`onChunk`, and `onDone` on
 * both its completion and its retry path) so the component can repaint its
 * paint surfaces — the gutter spans and the caret bar — from the fresh
 * geometry. Without it an idle reader would keep estimate-positioned paint
 * forever, because no DOM event necessarily follows the async measurement.
 * The callback is invoked synchronously inside the measurer's callback with
 * no arguments, after the counts are committed and the geometry is dirty; it
 * may READ geometry and paint, but it must NOT call a mutating controller
 * method (the controller does not support re-entry there). It fires even
 * when a merged row value happens to be unchanged (every commit dirties the
 * geometry), and never for estimate-only updates, enable/disable, dispose,
 * or queries.
 *
 * Never-throw: malformed or misbehaving ports (a measurer that throws, a
 * gutter layer that throws, a timer that throws, a paint observer that
 * throws), unusable text, and every call after `dispose()` degrade to a safe
 * answer instead of an exception. The measurement callbacks are additionally
 * wrapped so a controller bug can never abort the measurer's run (a thrown
 * callback would otherwise stop the measurer's scheduler for good).
 *
 * @module @dybai/dsh-editor/wrap-controller
 */

import { buildWrapGeometry, changedLineRange, estimateAllRows } from './wrap-geometry.js';

/** Default settle time for a viewport-width change, in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 200;

/** Tab-stop width assumed by the estimate layer (the classic terminal default). */
const DEFAULT_TAB_COLUMNS = 8;

/**
 * The px height used to build a geometry when no line height is available yet
 * (the wrap-off editor's own `(line) × 20` convention). Only reached before
 * the first usable metrics arrive; exact-only answers are gated separately.
 */
const FALLBACK_LINE_HEIGHT_PX = 20;

/**
 * @param {any} value - a candidate.
 * @returns {boolean} `true` for a finite number > 0.
 */
function isPositiveFinite(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Normalize an optional numeric reading.
 * @param {any} value - a candidate.
 * @param {number} fallback - the value to use when unusable.
 * @returns {number} the reading or the fallback.
 */
function finiteOr(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize one row count into the integer ≥ 1 that `buildWrapGeometry`
 * requires. Anything unusable (non-number, `NaN`, `Infinity`, `0`, negative)
 * degrades to one row so a broken measurement can only under-count a line's
 * wrap, never corrupt the layout.
 * @param {any} value - a measured or estimated row count.
 * @returns {number} an integer ≥ 1.
 */
function rowsValue(value) {
	if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.max(1, Math.round(value));
	return 1;
}

/**
 * Coerce the draft to the string this module can diff. A non-string draft
 * (never expected from the editor) degrades to `''` rather than throwing.
 * @param {any} value - the draft.
 * @returns {string} the text.
 */
function coerceText(value) {
	return typeof value === 'string' ? value : '';
}

/**
 * Normalize the debounce delay: a finite number ≥ 0, otherwise the 200 ms
 * contract default.
 * @param {any} value - the injected `debounceMs`.
 * @returns {number} the delay in milliseconds.
 */
function normalizeDebounceMs(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEBOUNCE_MS;
}

/**
 * Create a wrap controller over the injected ports.
 *
 * @param {object} deps - the injected ports and knobs.
 * @param {object} deps.measurer - the Task 5 measurer
 *   (`ready`, `usableWidth`, `chWidthPx`, `measureRange`, `measureAll`).
 * @param {number} [deps.debounceMs] - viewport settle time, default 200 ms.
 * @param {Function} [deps.setTimer] - `(callback, ms) → handle` (default
 *   `setTimeout`).
 * @param {Function} [deps.clearTimer] - `(handle) → void` (default
 *   `clearTimeout`).
 * @param {Function} [deps.gutterFactory] - `() → layer` where layer is
 *   `{ append(line, topPx), clear(), translate(px) }`; no layer is rendered
 *   when absent (the component supplies the real one, Task 8).
 * @param {number | Function} [deps.lineHeightPx] - one visual row's height in
 *   px, or a provider returning it. Falls back to the measurer's optional
 *   `lineHeightPx` number/function.
 * @param {Function} [deps.onCountsChange] - `() → void`; called after every
 *   measurement callback that commits row counts (never for estimates or
 *   queries). It must only read geometry / paint: mutating controller calls
 *   from inside it are unsupported. A throw is swallowed.
 * @returns {object} the controller facade (see the module docblock).
 */
export function createWrapController(deps) {
	const options = deps !== null && typeof deps === 'object' ? deps : {};
	const measurer = options.measurer !== null && typeof options.measurer === 'object' ? options.measurer : null;
	const gutterFactory = typeof options.gutterFactory === 'function' ? options.gutterFactory : null;
	const debounceMs = normalizeDebounceMs(options.debounceMs);
	const lineHeightOf = options.lineHeightPx;
	const onCountsChange = typeof options.onCountsChange === 'function' ? options.onCountsChange : null;
	const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
	const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;

	let disposed = false;
	let enabled = false;

	let lines = [''];
	let text = '';
	let counts = [1];
	let exactUpTo0 = 0;
	let allExact = false;
	let width = 0;
	let lineHeightPx = NaN;

	let geometry = null;
	let geometryDirty = true;
	let geometryCounts = null;
	let geometryHeight = NaN;

	let runToken = 0;
	let fullRunning = false;
	let fullCancel = null;
	let pendingFull = false;
	let debounceHandle = null;

	let gutter = null;

	/**
	 * Release every per-document value, keeping the ports. Used on both
	 * directions of the enable toggle so a re-enable never answers from the
	 * previous document.
	 */
	function resetState() {
		lines = [''];
		text = '';
		counts = [1];
		exactUpTo0 = 0;
		allExact = false;
		width = 0;
		lineHeightPx = NaN;
		geometry = null;
		geometryDirty = true;
		geometryCounts = null;
		geometryHeight = NaN;
	}

	/**
	 * The optional line-height port on the measurer, read defensively.
	 * @returns {any} a candidate value, or `undefined`.
	 */
	function measurerLineHeight() {
		if (measurer === null) return undefined;
		try {
			const source = measurer.lineHeightPx;
			if (typeof source === 'function') return source();
			if (typeof source === 'number') return source;
		} catch {
			return undefined;
		}
		return undefined;
	}

	/**
	 * Resolve one visual row's height: the injector's `lineHeightPx` port
	 * (number or provider) first, then the measurer's optional one.
	 * @returns {number} the px height, or `NaN` when unavailable.
	 */
	function resolveLineHeight() {
		let candidate;
		if (typeof lineHeightOf === 'function') {
			try {
				candidate = lineHeightOf();
			} catch {
				candidate = undefined;
			}
		} else if (typeof lineHeightOf === 'number') {
			candidate = lineHeightOf;
		}
		if (!isPositiveFinite(candidate)) candidate = measurerLineHeight();
		return isPositiveFinite(candidate) ? candidate : NaN;
	}

	/**
	 * Refresh the cached line height and dirty the geometry when it moved.
	 */
	function syncLineHeight() {
		const next = resolveLineHeight();
		if (Object.is(next, lineHeightPx)) return;
		lineHeightPx = next;
		geometryDirty = true;
	}

	/**
	 * The height geometry is built with: the real value, or the fallback while
	 * metrics are still missing (estimates still answer rows correctly).
	 * @returns {number} px > 0.
	 */
	function effectiveLineHeight() {
		return isPositiveFinite(lineHeightPx) ? lineHeightPx : FALLBACK_LINE_HEIGHT_PX;
	}

	/**
	 * Whether the measurer can answer exactly right now: ready AND a usable
	 * width. `ready()` alone is not enough — the measurer silently no-ops
	 * when `usableWidth()` is 0, so both are required before a kick.
	 * @returns {boolean} `true` when measuring would be exact.
	 */
	function canMeasure() {
		if (measurer === null) return false;
		try {
			if (typeof measurer.ready !== 'function' || measurer.ready() !== true) return false;
		} catch {
			return false;
		}
		return usableWidthSafe() > 0;
	}

	/**
	 * The textarea's usable content width, reading the measurer defensively.
	 * @returns {number} finite px > 0, or `0`.
	 */
	function usableWidthSafe() {
		if (measurer === null) return 0;
		try {
			const value = typeof measurer.usableWidth === 'function' ? measurer.usableWidth() : 0;
			return isPositiveFinite(value) ? value : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * One character's width in the mirror's font, read defensively.
	 * @returns {number} finite px > 0, or `0` when unavailable.
	 */
	function chWidthSafe() {
		if (measurer === null) return 0;
		try {
			const value = typeof measurer.chWidthPx === 'function' ? measurer.chWidthPx() : 0;
			return isPositiveFinite(value) ? value : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Estimate the row count of every line at the given width. `charsPerRow`
	 * is `floor(usableWidth / chWidthPx)`; when either is unusable it becomes
	 * `0`, which `estimateRows` maps to the safe one-row-per-line path.
	 * @param {string[]} sourceLines - the source lines.
	 * @param {number} widthPx - the usable content width in px.
	 * @returns {number[]} one integer row count per line.
	 */
	function estimateCounts(sourceLines, widthPx) {
		const chWidth = chWidthSafe();
		const charsPerRow = widthPx > 0 && chWidth > 0 ? Math.floor(widthPx / chWidth) : 0;
		const estimated = estimateAllRows(sourceLines, charsPerRow, DEFAULT_TAB_COLUMNS);
		const normalized = new Array(sourceLines.length);
		for (let index = 0; index < sourceLines.length; index++) {
			normalized[index] = rowsValue(estimated[index]);
		}
		if (normalized.length === 0) normalized.push(1);
		return normalized;
	}

	/**
	 * The current geometry, rebuilt lazily: the dirty flag plus a reference
	 * check on `counts` means a burst of same-frame queries rebuilds the
	 * prefix sums once. Lines are converted to pixels by the geometry; the
	 * controller only adds the line height decision.
	 * @returns {object | null} the geometry, or `null` for unusable state.
	 */
	function ensureGeometry() {
		syncLineHeight();
		const height = effectiveLineHeight();
		if (!geometryDirty && geometry !== null && geometryCounts === counts && geometryHeight === height) return geometry;
		geometryCounts = counts;
		geometryHeight = height;
		geometryDirty = false;
		geometry = buildWrapGeometry(counts, height);
		return geometry;
	}

	/**
	 * Cancel any in-flight full run and invalidate its callbacks: the token
	 * makes a late chunk from a superseded run a no-op even if the measurer's
	 * cancel could not stop it.
	 */
	function invalidateRun() {
		runToken++;
		pendingFull = false;
		const cancel = fullCancel;
		fullCancel = null;
		fullRunning = false;
		if (typeof cancel === 'function') {
			try {
				cancel();
			} catch {
				// a broken cancel must not take the editor down
			}
		}
	}

	/**
	 * Clear the pending viewport settle timer, if any.
	 */
	function clearDebounce() {
		if (debounceHandle === null) return;
		const handle = debounceHandle;
		debounceHandle = null;
		try {
			clearTimer(handle);
		} catch {
			// a broken timer port must not take the editor down
		}
	}

	/**
	 * Arm the debounced full re-measure that settles a viewport-width change.
	 */
	function scheduleFull() {
		clearDebounce();
		if (disposed || !enabled) return;
		try {
			debounceHandle = setTimer(() => {
				debounceHandle = null;
				if (disposed || !enabled) return;
				kickFull();
			}, debounceMs);
		} catch {
			debounceHandle = null;
			pendingFull = true;
		}
	}

	/**
	 * Tell the optional paint observer that committed row counts moved. The
	 * callback takes no arguments and must not call a mutating controller
	 * method (it may read geometry, which lazily rebuilds the dirty model).
	 * Wrapped so a broken observer can never abort the measurer's run — the
	 * same reason every other port call is wrapped.
	 */
	function notifyCountsChange() {
		if (onCountsChange === null) return;
		try {
			onCountsChange();
		} catch {
			// a broken paint observer must not stop the measurement
		}
	}

	/**
	 * Merge one exact-prefix chunk into `counts[]`. The chunk length is the
	 * exact-prefix boundary the measurer reported; the estimated tail is left
	 * untouched. Never throws (the measurer aborts its run if a callback does).
	 * @param {number} token - the run token this chunk belongs to.
	 * @param {any} chunk - the exact-prefix row counts.
	 * @param {any} doneUpTo0 - the exact prefix length.
	 */
	function applyChunk(token, chunk, doneUpTo0) {
		if (disposed || !enabled || token !== runToken) return;
		if (!Array.isArray(chunk)) return;
		const declared =
			typeof doneUpTo0 === 'number' && Number.isFinite(doneUpTo0) ? Math.floor(doneUpTo0) : chunk.length;
		const limit = Math.max(0, Math.min(declared, chunk.length, counts.length));
		for (let index = 0; index < limit; index++) counts[index] = rowsValue(chunk[index]);
		exactUpTo0 = Math.max(exactUpTo0, limit);
		geometryDirty = true;
		notifyCountsChange();
	}

	/**
	 * Commit a completed full measurement. The measurer reports its last slice
	 * through `onDone` only (no trailing `onChunk`), so the geometry rebuild —
	 * and the paint notification — lives here as well as in `applyChunk`. The
	 * malformed-completion retry path dirties the geometry too (it drops
	 * exactness), so it notifies as well. Never throws.
	 * @param {number} token - the run token this completion belongs to.
	 * @param {any} full - the full row counts.
	 */
	function applyDone(token, full) {
		if (disposed || !enabled || token !== runToken) return;
		fullRunning = false;
		fullCancel = null;
		if (Array.isArray(full) && full.length === lines.length) {
			const next = new Array(full.length);
			for (let index = 0; index < full.length; index++) next[index] = rowsValue(full[index]);
			counts = next;
			exactUpTo0 = counts.length;
			allExact = true;
			geometryDirty = true;
			notifyCountsChange();
			return;
		}
		// A malformed completion keeps the estimates and marks a retry: the
		// next sync re-kicks, so a transient failure still converges.
		allExact = false;
		exactUpTo0 = 0;
		pendingFull = true;
		geometryDirty = true;
		notifyCountsChange();
	}

	/**
	 * Start (or restart) the full document measurement. The controller gates
	 * on `ready()` AND `usableWidth() > 0` because `measureAll` silently
	 * no-ops without either and never calls `onDone`; when the gate is closed
	 * the request is remembered and retried by the next sync or query kick.
	 */
	function kickFull() {
		clearDebounce();
		if (disposed || !enabled) return;
		if (measurer === null || typeof measurer.measureAll !== 'function' || !canMeasure()) {
			pendingFull = true;
			return;
		}
		invalidateRun();
		const token = runToken;
		const snapshot = lines;
		pendingFull = false;
		fullRunning = true;
		let cancel = null;
		try {
			cancel = measurer.measureAll(snapshot.slice(), {
				onChunk(chunk, doneUpTo0) {
					try {
						applyChunk(token, chunk, doneUpTo0);
					} catch {
						// never abort the measurer's run
					}
				},
				onDone(full) {
					try {
						applyDone(token, full);
					} catch {
						// never abort the measurer's run
					}
				}
			});
		} catch {
			fullRunning = false;
			pendingFull = true;
			return;
		}
		// A synchronous onDone (the empty-document path) already retired the
		// run; only adopt the cancel function while this run is still current.
		if (token === runToken && fullRunning) fullCancel = typeof cancel === 'function' ? cancel : null;
	}

	/**
	 * Replace every row count with an estimate at the current width. Used
	 * whenever the exact layout is invalidated (enable, width change,
	 * wholesale replacement) so queries keep answering immediately.
	 */
	function updateEstimates() {
		counts = estimateCounts(lines, width);
		exactUpTo0 = 0;
		allExact = false;
		geometryDirty = true;
	}

	/**
	 * Cancel the in-flight run, drop exactness, and start a fresh full
	 * measurement (estimates answer until it lands).
	 */
	function restartFull() {
		invalidateRun();
		updateEstimates();
		kickFull();
	}

	/**
	 * Whether an edit's change range covers the whole NEW document, the
	 * wholesale-replacement signal (reload, draft restore, full paste) that
	 * requires a full re-measure so no stale prefix sum can survive. A
	 * one-line document is excluded: with a single line there is nothing
	 * else to keep, so the range splice remains exact and cheaper.
	 * @param {{start: number, end: number}} range - the changed line range.
	 * @param {number} lineCount - the new document's line count.
	 * @returns {boolean} `true` when the edit is a wholesale replacement.
	 */
	function isWholesale(range, lineCount) {
		return range.start <= 1 && range.end >= lineCount && lineCount > 1;
	}

	/**
	 * Splice a narrow edit: reuse the exact counts of the unchanged prefix
	 * and suffix, estimate the changed lines, measure them synchronously, and
	 * commit. Returns `false` when an exact measurement is not possible right
	 * now, so the caller can fall back to a full re-measure.
	 * @param {{start: number, end: number}} range - 1-based inclusive range.
	 * @returns {boolean} `true` when the layout is exact afterwards.
	 */
	function applyRange(range) {
		if (!canMeasure() || typeof measurer.measureRange !== 'function') return false;
		const previousCounts = counts;
		const nextLines = lines;
		const estimates = estimateCounts(nextLines, width);
		const nextCounts = new Array(nextLines.length);
		for (let index = 0; index < nextCounts.length; index++) nextCounts[index] = estimates[index];
		const prefixLength = Math.min(Math.max(0, range.start - 1), nextCounts.length, previousCounts.length);
		for (let index = 0; index < prefixLength; index++) nextCounts[index] = previousCounts[index];
		const suffixStart = Math.max(0, range.end);
		const suffixLength = Math.max(0, nextCounts.length - suffixStart);
		const previousSuffixStart = previousCounts.length - suffixLength;
		if (previousSuffixStart >= 0) {
			for (let index = 0; index < suffixLength; index++) {
				nextCounts[suffixStart + index] = previousCounts[previousSuffixStart + index];
			}
		}
		const from0 = Math.min(Math.max(0, range.start - 1), nextCounts.length);
		const to0 = Math.min(Math.max(from0, range.end), nextCounts.length);
		if (to0 > from0) {
			let measured = null;
			try {
				measured = measurer.measureRange(nextLines, from0, to0);
			} catch {
				return false;
			}
			if (!Array.isArray(measured) || measured.length !== to0 - from0) return false;
			for (let index = 0; index < measured.length; index++) nextCounts[from0 + index] = rowsValue(measured[index]);
		}
		counts = nextCounts;
		exactUpTo0 = nextCounts.length;
		allExact = true;
		geometryDirty = true;
		return true;
	}

	/**
	 * The injected gutter layer, created lazily on first use. A factory that
	 * is absent or returns nothing makes rendering a no-op (the component
	 * owns the real DOM; the controller never touches it).
	 * @returns {object | null} the layer port, or `null`.
	 */
	function ensureGutter() {
		if (gutter !== null) return gutter;
		if (gutterFactory === null) return null;
		let created = null;
		try {
			created = gutterFactory();
		} catch {
			created = null;
		}
		if (created !== null && typeof created === 'object') gutter = created;
		return gutter;
	}

	/**
	 * Clear the layer, tolerating a missing or broken method.
	 * @param {object} layer - the gutter layer.
	 */
	function layerClear(layer) {
		try {
			if (typeof layer.clear === 'function') layer.clear();
		} catch {
			// a broken layer must not take the editor down
		}
	}

	/**
	 * Append one line number at a viewport-relative top, tolerating failure.
	 * @param {object} layer - the gutter layer.
	 * @param {number} line - 1-based source line.
	 * @param {number} topPx - px from the top of the visible gutter.
	 */
	function layerAppend(layer, line, topPx) {
		try {
			if (typeof layer.append === 'function') layer.append(line, topPx);
		} catch {
			// a broken layer must not take the editor down
		}
	}

	/**
	 * Translate the layer group, tolerating failure.
	 * @param {object} layer - the gutter layer.
	 * @param {number} px - the group offset.
	 */
	function layerTranslate(layer, px) {
		try {
			if (typeof layer.translate === 'function') layer.translate(px);
		} catch {
			// a broken layer must not take the editor down
		}
	}

	/**
	 * Empty the gutter layer (used when wrapping turns off or unmounts).
	 */
	function clearGutterLayer() {
		if (gutter === null) return;
		layerClear(gutter);
		layerTranslate(gutter, 0);
	}

	/**
	 * Turn wrapping on or off. Idempotent: re-enabling a live controller keeps
	 * the measured layout and only retries a deferred full measure.
	 * @param {any} on - `true` enables, anything else disables.
	 */
	function setEnabled(on) {
		if (disposed) return;
		const next = on === true;
		if (next === enabled) {
			if (next && pendingFull) kickFull();
			return;
		}
		enabled = next;
		invalidateRun();
		clearDebounce();
		pendingFull = false;
		resetState();
		if (!next) clearGutterLayer();
	}

	/**
	 * Synchronize the draft. A narrow edit over an exact layout re-measures
	 * only the changed lines; a first sync, a width baseline change, or a
	 * wholesale replacement rebuilds every count (estimates first, then a
	 * full re-measure).
	 * @param {any} nextText - the new draft text.
	 */
	function syncDraft(nextText) {
		if (disposed || !enabled) return;
		syncLineHeight();
		const next = coerceText(nextText);
		const nextLines = next.split('\n');
		const nextWidth = usableWidthSafe();

		if (nextWidth !== width) {
			// The counts were computed for a different width: re-estimate now
			// and measure the whole document (a first sync, or a resize that
			// reached this path before `syncViewport` did).
			width = nextWidth;
			lines = nextLines;
			text = next;
			restartFull();
			return;
		}

		const range = changedLineRange(text, next);
		const textChanged = range !== null;
		const lineCountChanged = nextLines.length !== lines.length;
		lines = nextLines;
		text = next;

		if (textChanged && isWholesale(range, nextLines.length)) {
			restartFull();
			return;
		}
		if (!textChanged && !lineCountChanged) {
			if (pendingFull) kickFull();
			return;
		}
		if (!allExact) {
			// Never measured, or a run is already streaming: restart so the
			// run measures the current text, never the superseded one.
			restartFull();
			return;
		}
		if (!applyRange(range)) restartFull();
	}

	/**
	 * Synchronize the viewport width. A changed width re-estimates every line
	 * immediately and debounces the full re-measure; an unchanged width is a
	 * no-op apart from retrying a deferred full measure (the metrics-arrived
	 * kick).
	 */
	function syncViewport() {
		if (disposed || !enabled) return;
		syncLineHeight();
		const nextWidth = usableWidthSafe();
		if (nextWidth === width) {
			if (pendingFull) kickFull();
			return;
		}
		width = nextWidth;
		invalidateRun();
		updateEstimates();
		scheduleFull();
	}

	/**
	 * The visual rows source line `line` renders, from the current geometry.
	 * @param {any} line - 1-based source line.
	 * @returns {number} row count (≥ 1).
	 */
	function rowsOf(line) {
		if (disposed) return 1;
		const current = ensureGeometry();
		return current === null ? 1 : current.rowsOf(line);
	}

	/**
	 * The content-relative px offset of a line's first visual row (padding
	 * excluded; the component adds its own box offsets).
	 * @param {any} line - 1-based source line.
	 * @returns {number} px ≥ 0.
	 */
	function visualTop(line) {
		if (disposed) return 0;
		const current = ensureGeometry();
		return current === null ? 0 : current.visualTop(line);
	}

	/**
	 * The source line covering a content-relative px offset.
	 * @param {any} px - offset in px.
	 * @returns {number} 1-based source line.
	 */
	function lineAtVisualOffset(px) {
		if (disposed) return 1;
		const current = ensureGeometry();
		return current === null ? 1 : current.lineAtVisualOffset(px);
	}

	/**
	 * The lines whose visual extent overlaps the viewport, widened by
	 * `marginRows` rows on each side. Content tops are content-relative.
	 * @param {any} scrollTop - the textarea's scrollTop in px.
	 * @param {any} clientHeight - the viewport height in px.
	 * @param {any} marginRows - extra rows above and below (0 when unusable).
	 * @returns {Array<{line: number, contentTop: number}>} the window.
	 */
	function visibleLines(scrollTop, clientHeight, marginRows) {
		if (disposed) return [];
		const current = ensureGeometry();
		if (current === null) return [];
		const scroll = finiteOr(scrollTop, 0);
		const viewport = Math.max(0, finiteOr(clientHeight, 0));
		const margin =
			typeof marginRows === 'number' && Number.isFinite(marginRows) && marginRows > 0
				? marginRows * geometryHeight
				: 0;
		const first = current.lineAtVisualOffset(scroll - margin);
		const last = current.lineAtVisualOffset(scroll + viewport + margin);
		const window = [];
		for (let line = first; line <= last; line++) window.push({ line, contentTop: current.visualTop(line) });
		return window;
	}

	/**
	 * Render just the visible line numbers into the injected gutter layer:
	 * `append(line, contentTop − scrollTop)` per visible line and a group
	 * `translate(−scrollTop)`. Disabled or disposed states clear the layer.
	 * @param {any} scrollTop - the textarea's scrollTop in px.
	 * @param {any} clientHeight - the viewport height in px.
	 */
	function syncGutter(scrollTop, clientHeight) {
		if (disposed) return;
		if (!enabled) {
			clearGutterLayer();
			return;
		}
		const layer = ensureGutter();
		if (layer === null) return;
		const scroll = finiteOr(scrollTop, 0);
		const viewport = Math.max(0, finiteOr(clientHeight, 0));
		const window = visibleLines(scroll, viewport, 0);
		layerClear(layer);
		for (const entry of window) layerAppend(layer, entry.line, entry.contentTop - scroll);
		layerTranslate(layer, -scroll);
	}

	/**
	 * The inputs the End-key landing formula needs for wrapped layout, or
	 * `null` while wrapping is disabled or the measurer cannot measure.
	 * @returns {{contentHeight: number, lineHeight: number} | null} the inputs.
	 */
	function endLandingInputs() {
		if (disposed || !enabled) return null;
		syncLineHeight();
		if (!canMeasure()) return null;
		if (!isPositiveFinite(lineHeightPx)) return null;
		const current = ensureGeometry();
		if (current === null) return null;
		return { contentHeight: current.totalRows() * lineHeightPx, lineHeight: lineHeightPx };
	}

	/**
	 * Release the controller for good: cancel the running measurement, clear
	 * the debounce, empty the gutter layer, and make every method a safe
	 * no-op. Idempotent.
	 */
	function dispose() {
		if (disposed) return;
		disposed = true;
		enabled = false;
		invalidateRun();
		clearDebounce();
		pendingFull = false;
		resetState();
		clearGutterLayer();
		gutter = null;
	}

	return {
		setEnabled,
		syncDraft,
		syncViewport,
		visualTop,
		rowsOf,
		lineAtVisualOffset,
		visibleLines,
		syncGutter,
		endLandingInputs,
		dispose
	};
}
