/**
 * Word-wrap line measurer — the DOM adapter that turns a logical source line
 * into the number of visual rows the browser will render for it.
 *
 * Why a mirror: a textarea's content is not DOM-addressable, so the only
 * reliable way to count wrapped rows is to render the same text in an
 * identically styled, hidden element and divide its height by one line's
 * height. That element is the "mirror": a fixed, off-screen, invisible div
 * whose width is set to the textarea's usable content width each time.
 *
 * Same-source contract: the wrapping rules (`WRAP_LINE_STYLES`) live in ONE
 * exported frozen constant. The textarea's wrap CSS class (added by the
 * component layer) and this mirror both read that constant, so a future
 * change to the wrap rules cannot drift between the two. The typographic
 * context — font shorthand and family, size, weight and style, line height,
 * letter and word spacing, tab size — is copied verbatim from the textarea's
 * computed style on `attach`, plus `box-sizing: content-box` so the measured
 * width means the same thing on both sides.
 *
 * Everything reaches the DOM through injected ports, so the whole module is
 * unit-testable under `node --test` with no browser:
 *
 * - `mirrorFactory()` → a mirror port
 *   `{ setStyle(styleObj), setWidth(px), measure(text) → heightPx,
 *      measureWidth(text) → widthPx, detach() }`.
 *   `measureWidth` answers the `chWidthPx` probe (the height-only
 *   `measure` cannot report a width); a port without it makes `chWidthPx`
 *   degrade to `0`, which the estimation layer treats as unusable.
 * - `readStyles(area)` → a computed-style-like object; only
 *   `paddingLeft`/`paddingRight` and the copied font properties are read.
 * - `schedule(callback)` → the frame scheduler (`requestAnimationFrame` by
 *   default). `measureAll` only ever uses it to yield between time slices.
 * - `budgetMs` → the per-slice time budget (default 12 ms).
 *
 * `measureAll` walks the document from the first line in bounded time
 * slices, reporting the exact-measured prefix after each slice
 * (`onChunk(countsSnapshot, doneUpTo0)`) and the completed counts once
 * (`onDone(counts)`). The controller paints estimates for the not-yet-exact
 * tail, so first paint never stalls on a huge file.
 *
 * Never-throw: every method degrades unusable state (detached, disposed,
 * unusable line height or width, a broken mirror port) to a safe answer —
 * `false`, `0`, `[]`, or one row per line — so the component layer can call
 * it unconditionally without a guard or a crash.
 *
 * Zero imports: platform APIs are read directly, and every DOM touchpoint is
 * reachable through the injected ports.
 *
 * @module @dybai/dsh-editor/wrap-measure
 */

/**
 * The wrapping rules shared by the textarea's wrap CSS class and the mirror —
 * the same-source contract. `pre-wrap` keeps explicit whitespace while
 * allowing soft breaks, `break-word` hard-breaks a word that cannot fit (a
 * long URL or minified JSON), and `normal` keeps ordinary word boundaries
 * preferred. Frozen: neither side may mutate the shared rules at runtime.
 */
export const WRAP_LINE_STYLES = Object.freeze({
	whiteSpace: 'pre-wrap',
	overflowWrap: 'break-word',
	wordBreak: 'normal'
});

/**
 * Computed-style properties copied verbatim from the textarea onto the
 * mirror, so the mirror renders every glyph with the same metrics as the
 * textarea. Listed explicitly rather than inherited: a UA default that
 * happens to match today is not a contract.
 */
const FONT_STYLE_KEYS = [
	'font',
	'fontSize',
	'fontWeight',
	'fontStyle',
	'fontFamily',
	'lineHeight',
	'letterSpacing',
	'wordSpacing',
	'tabSize'
];

/**
 * The real mirror's own layout: fixed and off-screen (so it can never
 * influence scrolling or layout of the page), invisible, and content-box so
 * `setWidth` means the same content width as the textarea's usable width.
 */
const MIRROR_POSITION_STYLES = Object.freeze({
	position: 'fixed',
	left: '-9999px',
	top: '0',
	visibility: 'hidden',
	boxSizing: 'content-box'
});

/** The zero-width space an empty line is rendered as — an empty string has
 * no measurable height, while this placeholder still occupies exactly one
 * line box. */
const EMPTY_LINE_TEXT = '\u200b';

/** The `chWidthPx` probe: 100 zero glyphs, averaged to one character width. */
const CH_PROBE_TEXT = '0'.repeat(100);

/** Default per-slice budget for `measureAll`, in milliseconds. */
const DEFAULT_BUDGET_MS = 12;

/**
 * Normalize a CSS px reading (`"12px"`, `12`, garbage) to a finite number.
 * @param {any} value - a computed-style value or a number.
 * @returns {number} the parsed px, or `0` when unusable.
 */
function toPx(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	if (typeof value === 'string') {
		const px = parseFloat(value);
		return Number.isFinite(px) ? px : 0;
	}
	return 0;
}

/**
 * The current time in milliseconds, preferring the high-resolution clock
 * `measureAll` uses to bound a slice.
 * @returns {number} monotonic-ish milliseconds.
 */
function nowMs() {
	if (typeof performance !== 'undefined' && performance !== null && typeof performance.now === 'function') {
		return performance.now();
	}
	return Date.now();
}

/**
 * The default scheduler: `requestAnimationFrame` when the platform has it,
 * otherwise a zero-delay `setTimeout`. With neither available the run simply
 * never advances (never-throw is preferred over a synchronous recursion
 * through every line of a huge document).
 * @param {Function} callback - the slice to run on the next frame.
 */
function defaultSchedule(callback) {
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(callback);
		return;
	}
	if (typeof setTimeout === 'function') setTimeout(callback, 0);
}

/**
 * The default style reader: the textarea's computed style. Guarded so the
 * module still loads (and degrades safely) where no DOM exists.
 * @param {any} area - the textarea.
 * @returns {object} a computed-style-like object; `{}` without a DOM.
 */
function defaultReadStyles(area) {
	if (typeof getComputedStyle !== 'function') return {};
	return getComputedStyle(area);
}

/**
 * The default mirror: a hidden fixed div appended to `document.body`, ported
 * as the `{ setStyle, setWidth, measure, measureWidth, detach }` shape.
 * @returns {object | null} the mirror port, or `null` where no DOM exists.
 */
function createDomMirror() {
	if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') return null;
	const element = document.createElement('div');
	element.setAttribute('aria-hidden', 'true');
	if (document.body !== null && typeof document.body === 'object' && typeof document.body.appendChild === 'function') {
		document.body.appendChild(element);
	}
	return {
		/**
		 * Apply a style object (camelCase CSSOM property names). `undefined`
		 * entries are skipped so an absent computed property never writes the
		 * literal string "undefined".
		 * @param {object} style - the styles to apply.
		 */
		setStyle(style) {
			for (const property of Object.keys(style)) {
				if (style[property] !== undefined) element.style[property] = style[property];
			}
		},
		/**
		 * Set the mirror's content-box width.
		 * @param {number} px - the textarea's usable content width.
		 */
		setWidth(px) {
			element.style.width = `${px}px`;
		},
		/**
		 * Render one line and report its height.
		 * @param {string} text - the line's text (`'\u200b'` for an empty line).
		 * @returns {number} `offsetHeight` in px.
		 */
		measure(text) {
			element.textContent = text;
			return element.offsetHeight;
		},
		/**
		 * The un-wrapped width of one text run: white-space goes back to
		 * `pre` (no soft breaks) and the width to `max-content` for the
		 * probe, so the answer is the content width of the glyphs alone.
		 * @param {string} text - the text to measure.
		 * @returns {number} content width in px.
		 */
		measureWidth(text) {
			const previousWhiteSpace = element.style.whiteSpace;
			const previousWidth = element.style.width;
			element.style.whiteSpace = 'pre';
			element.style.width = 'max-content';
			element.textContent = text;
			const width = element.offsetWidth;
			element.style.whiteSpace = previousWhiteSpace;
			element.style.width = previousWidth;
			return width;
		},
		/** Remove the mirror from the document. */
		detach() {
			if (element.parentNode !== null) element.parentNode.removeChild(element);
		}
	};
}

/**
 * Create a measurer over the injected ports.
 *
 * The returned object is a single per-editor adapter; `attach` is called when
 * wrapping turns on (and re-called when the area's metrics change), `detach`
 * or `dispose` when it turns off / unmounts.
 *
 * @param {object} [deps] - all optional ports and knobs.
 * @param {Function} [deps.mirrorFactory] - → mirror port (default: real div).
 * @param {Function} [deps.readStyles] - `area` → computed-style-like object
 *   (default: `getComputedStyle`).
 * @param {Function} [deps.schedule] - `callback` → void, the frame scheduler
 *   (default: `requestAnimationFrame`).
 * @param {number} [deps.budgetMs] - per-slice time budget; non-finite or
 *   negative falls back to 12.
 * @returns {object} the measurer — `attach`, `detach`, `ready`, `usableWidth`,
 *   `chWidthPx`, `measureRange`, `measureTextRows`, `measureAll`, `dispose`.
 */
export function createWrapMeasurer(deps) {
	const options = deps !== null && typeof deps === 'object' ? deps : {};
	const mirrorFactory = typeof options.mirrorFactory === 'function' ? options.mirrorFactory : createDomMirror;
	const readStyles = typeof options.readStyles === 'function' ? options.readStyles : defaultReadStyles;
	const schedule = typeof options.schedule === 'function' ? options.schedule : defaultSchedule;
	const budgetMs =
		typeof options.budgetMs === 'number' && Number.isFinite(options.budgetMs) && options.budgetMs >= 0
			? options.budgetMs
			: DEFAULT_BUDGET_MS;

	let area = null;
	let mirror = null;
	let paddingLeft = 0;
	let paddingRight = 0;
	let lineHeightPx = NaN;
	let disposed = false;
	let cancelActive = null;

	/** Whether an area and a mirror are currently held. */
	const isAttached = () => area !== null && mirror !== null;

	/**
	 * Whether measurement can answer exactly right now: attached, and one
	 * visual row has a usable height.
	 * @returns {boolean} `true` when `measureRange` / `measureAll` are exact.
	 */
	function ready() {
		return isAttached() && Number.isFinite(lineHeightPx) && lineHeightPx > 0;
	}

	/**
	 * Detach the current mirror (if any), cancel any running full measurement,
	 * and forget the area, its padding and its line height. Idempotent, and
	 * never throws — a stale mirror is simply released.
	 */
	function detach() {
		if (typeof cancelActive === 'function') {
			const cancel = cancelActive;
			cancelActive = null;
			cancel();
		}
		const previous = mirror;
		area = null;
		mirror = null;
		paddingLeft = 0;
		paddingRight = 0;
		lineHeightPx = NaN;
		if (previous !== null) {
			try {
				if (typeof previous.detach === 'function') previous.detach();
			} catch {
				// a broken mirror port must not take the editor down
			}
		}
	}

	/**
	 * Attach to the textarea: read its horizontal padding and copy its
	 * typographic context + the shared wrap rules onto a fresh mirror.
	 * @param {any} nextArea - the textarea (only `clientWidth` is read).
	 * @param {object} [attachOptions] - `{ lineHeightPx }`, one visual row's
	 *   height; anything but a finite positive number leaves `ready()` false
	 *   (the mirror is still attached, so the width probes stay usable).
	 */
	function attach(nextArea, attachOptions) {
		if (disposed) return;
		detach();
		if (nextArea === null || typeof nextArea !== 'object') return;
		const settings = attachOptions !== null && typeof attachOptions === 'object' ? attachOptions : {};
		const nextLineHeightPx =
			typeof settings.lineHeightPx === 'number' && Number.isFinite(settings.lineHeightPx) && settings.lineHeightPx > 0
				? settings.lineHeightPx
				: NaN;
		let styles = {};
		try {
			const read = readStyles(nextArea);
			if (read !== null && typeof read === 'object') styles = read;
		} catch {
			styles = {};
		}
		let created = null;
		try {
			created = mirrorFactory();
		} catch {
			created = null;
		}
		if (created === null || typeof created !== 'object') return;
		area = nextArea;
		mirror = created;
		lineHeightPx = nextLineHeightPx;
		paddingLeft = Math.max(0, toPx(styles.paddingLeft));
		paddingRight = Math.max(0, toPx(styles.paddingRight));
		const style = { ...MIRROR_POSITION_STYLES, ...WRAP_LINE_STYLES };
		for (const property of FONT_STYLE_KEYS) {
			const value = styles[property];
			if (typeof value === 'string' && value !== '') style[property] = value;
			else if (typeof value === 'number' && Number.isFinite(value)) style[property] = value;
		}
		try {
			if (typeof mirror.setStyle === 'function') mirror.setStyle(style);
		} catch {
			// keep going: measurement may still work, and readiness reports honestly
		}
	}

	/**
	 * The textarea's usable content width: `clientWidth` (which already
	 * excludes a scrollbar) minus the horizontal padding.
	 * @returns {number} px ≥ 0; `0` when unattached or unusable.
	 */
	function usableWidth() {
		if (!isAttached()) return 0;
		const clientWidth = typeof area.clientWidth === 'number' ? area.clientWidth : NaN;
		if (!Number.isFinite(clientWidth) || clientWidth <= 0) return 0;
		const width = clientWidth - paddingLeft - paddingRight;
		return Number.isFinite(width) && width > 0 ? width : 0;
	}

	/**
	 * One character's width in the mirror's font, averaged over 100 zero
	 * glyphs. Feeds the estimation layer's chars-per-row.
	 * @returns {number} px > 0; `0` when unattached or the mirror port has no
	 *   width probe (or reports nothing usable).
	 */
	function chWidthPx() {
		if (!isAttached() || typeof mirror.measureWidth !== 'function') return 0;
		let width = NaN;
		try {
			width = mirror.measureWidth(CH_PROBE_TEXT);
		} catch {
			return 0;
		}
		if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return 0;
		return width / CH_PROBE_TEXT.length;
	}

	/**
	 * The text actually rendered for one source line: empty lines become a
	 * zero-width space so they still occupy one line box.
	 * @param {any} lineText - the line's text.
	 * @returns {string} the mirror text.
	 */
	const mirrorTextOf = (lineText) => (typeof lineText === 'string' && lineText !== '' ? lineText : EMPTY_LINE_TEXT);

	/**
	 * Measure one line's rendered rows. A broken measurement degrades to one
	 * row — never more accurate than reality, never a crash.
	 * @param {string} text - the mirror text.
	 * @returns {number} visual rows, integer ≥ 1.
	 */
	function rowsForText(text) {
		let height = NaN;
		try {
			height = mirror.measure(text);
		} catch {
			return 1;
		}
		if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return 1;
		return Math.max(1, Math.round(height / lineHeightPx));
	}

	/**
	 * Synchronously measure a half-open 0-based line range. Out-of-range or
	 * non-finite bounds are clamped; an inverted or empty range yields `[]`.
	 * When the measurer cannot measure exactly (detached, disposed, no usable
	 * line height or width) the same range answers with one row per line, so
	 * a caller can splice the result in without a shape mismatch — those are
	 * placeholders, not measurements.
	 * @param {any} lines - the source lines, newlines stripped.
	 * @param {any} from0 - first 0-based line to measure (inclusive).
	 * @param {any} to0Excl - line to stop at (exclusive).
	 * @returns {number[]} one row count per line in the range.
	 */
	function measureRange(lines, from0, to0Excl) {
		if (!Array.isArray(lines) || lines.length === 0) return [];
		const length = lines.length;
		const from = Number.isFinite(from0) ? Math.max(0, Math.floor(from0)) : 0;
		const to = Number.isFinite(to0Excl) ? Math.min(length, Math.floor(to0Excl)) : length;
		if (from >= to) return [];
		const width = usableWidth();
		if (!ready() || width <= 0) return new Array(to - from).fill(1);
		try {
			if (typeof mirror.setWidth === 'function') mirror.setWidth(width);
		} catch {
			return new Array(to - from).fill(1);
		}
		const counts = new Array(to - from);
		for (let index = from; index < to; index++) counts[index - from] = rowsForText(mirrorTextOf(lines[index]));
		return counts;
	}

	/**
	 * Measure the visual rows an ARBITRARY text prefix renders at a given
	 * width — the caret-row query's building block. Unlike `measureRange`
	 * (one or more rows per source LINE), this is a prefix-row count: empty
	 * text is zero rows and is answered without touching the mirror, and a
	 * text that renders shorter than one row reports `0` rather than a
	 * placeholder `1`. The width is the caller's `widthPx` verbatim (same
	 * convention as `measureRange` uses `usableWidth()`), because a caller
	 * that already knows the usable width must not have it re-derived from a
	 * possibly different mirror.
	 *
	 * @param {any} text - the text to measure.
	 * @param {any} widthPx - the content width to render at, in px.
	 * @returns {number} visual rows, integer ≥ 0; `0` when empty, not ready,
	 *   or measuring is not possible.
	 */
	function measureTextRows(text, widthPx) {
		if (typeof text !== 'string' || text === '') return 0;
		const width = typeof widthPx === 'number' && Number.isFinite(widthPx) && widthPx > 0 ? widthPx : 0;
		if (!ready() || width <= 0) return 0;
		try {
			if (typeof mirror.setWidth === 'function') mirror.setWidth(width);
		} catch {
			return 0;
		}
		let height = NaN;
		try {
			height = mirror.measure(text);
		} catch {
			return 0;
		}
		if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return 0;
		return Math.max(0, Math.round(height / lineHeightPx));
	}

	/**
	 * Measure the whole document in `budgetMs` time slices via `schedule`.
	 * The first slice is scheduled, never run synchronously, so the caller
	 * can paint estimates before measurement starts. After every slice that
	 * does not finish the document, `onChunk(countsSnapshot, doneUpTo0)` is
	 * called with the EXACT prefix measured so far (length `doneUpTo0`);
	 * the slice that reaches the end calls `onDone(counts)` with the full
	 * array. Starting a new run cancels the previous one; so do `detach` and
	 * `dispose`, and a cancelled run never invokes another callback.
	 * @param {any} lines - the source lines, newlines stripped.
	 * @param {object} [handlers] - `{ onChunk?, onDone? }`.
	 * @returns {Function} `cancel()` — idempotent, safe after completion.
	 */
	function measureAll(lines, handlers) {
		if (typeof cancelActive === 'function') {
			const previous = cancelActive;
			cancelActive = null;
			previous();
		}
		let cancelled = false;
		const cancel = () => {
			cancelled = true;
			if (cancelActive === cancel) cancelActive = null;
		};
		if (disposed || !Array.isArray(lines)) return cancel;
		const callbacks = handlers !== null && typeof handlers === 'object' ? handlers : {};
		const onChunk = typeof callbacks.onChunk === 'function' ? callbacks.onChunk : null;
		const onDone = typeof callbacks.onDone === 'function' ? callbacks.onDone : null;
		const total = lines.length;
		if (total === 0) {
			if (ready() && onDone !== null) onDone([]);
			return cancel;
		}
		const width = usableWidth();
		if (!ready() || width <= 0) return cancel;
		try {
			if (typeof mirror.setWidth === 'function') mirror.setWidth(width);
		} catch {
			return cancel;
		}
		const counts = new Array(total);
		let done = 0;
		const slice = () => {
			if (cancelled) return;
			const startedAt = nowMs();
			while (done < total) {
				counts[done] = rowsForText(mirrorTextOf(lines[done]));
				done++;
				if (nowMs() - startedAt >= budgetMs) break;
			}
			if (cancelled) return;
			if (done >= total) {
				if (cancelActive === cancel) cancelActive = null;
				if (onDone !== null) onDone(counts.slice());
				return;
			}
			if (onChunk !== null) onChunk(counts.slice(0, done), done);
			if (cancelled) return;
			schedule(slice);
		};
		cancelActive = cancel;
		schedule(slice);
		return cancel;
	}

	/**
	 * Release the mirror and make the measurer permanently inert (a disposed
	 * measurer ignores a later `attach`). The component calls this on unmount;
	 * everything else degrades to safe answers afterwards.
	 */
	function dispose() {
		detach();
		disposed = true;
	}

	return {
		attach,
		detach,
		ready,
		usableWidth,
		chWidthPx,
		measureRange,
		measureTextRows,
		measureAll,
		dispose
	};
}
