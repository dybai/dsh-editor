/**
 * CM6 view assembly (Task 8) — the thin shell that turns a resolved
 * extension plan plus injected deps into a mounted CodeMirror 6 editor.
 *
 * This module is a MAIN-BUNDLE module: CodeMirror symbols arrive ONLY as
 * the factory parameter (`createCm6ViewFactory(cm6)` — the vendored record
 * the Task 1 loader resolves from the chunk), while the two pure helpers
 * it needs statically (the R6 line ceiling and the glyph SVG spec) are
 * plain main-bundle imports. Every piece of decoration MATH stays in the
 * injected deps (the Task 4–7 pure cores); this shell only calls them,
 * converts their plain descriptors into CodeMirror decorations, and wires
 * the mode obligations:
 *
 * - `resolveExtensionPlan` (view-plan.js) normalizes the props; the plan
 *   slices drive six named Compartments (lineNumbers / activeLine / wrap /
 *   whitespace / ruler / scrollBeyond, plus indentUnit) that
 *   `reconfigure(nextPlan)` re-dispatches so preference flips apply live.
 * - One ViewPlugin merges the token / match / whitespace layers through one
 *   RangeSetBuilder (token ink < match washes < whitespace glyphs at equal
 *   positions); a second, compartment-mounted plugin paints the active-line
 *   line decorations from the pluggable `deps.activeLineRanges()` snapshot.
 * - The ruler rides the vendored layer() primitive, positioned by
 *   `deps.rulerGeometry` over a once-measured character cell.
 * - Edits and selections are reported ONLY from the updateListener (the
 *   docChanged branch is the single onEdit call site — IME composition goes
 *   through CodeMirror's own input pipeline), scroll offsets from a passive
 *   scrollDOM listener; the handle maps the framework's commands
 *   (initial scroll, line navigation, machine content/selection mirrors)
 *   onto transactions, and `destroy()` does nothing but `view.destroy()`.
 * - The keymap binds ONLY Tab/Shift-Tab indentation plus the vendored
 *   history/default keymaps; the framework's self-managed combos stay
 *   unbound and nothing ever stops keydown propagation, so those combos
 *   keep bubbling to the root interceptor.
 *
 * An assembly that throws is contained by the Task 9 component's
 * plain-text degradation path.
 *
 * @module @dybai/dsh-editor/cm6/view
 */

import { visibleTokenLineCeiling } from './match-decorations.js';
import { glyphSvgShape } from '../whitespace.js';
import { scrollBeyondPadding } from '../scroll-beyond.js';

/** Character-cell fallback when the hidden measurer cannot measure (13px × 0.6). */
const FALLBACK_CHAR_WIDTH = 13 * 0.6;

/** Line-box fallback at the content metrics when the view cannot answer (13px × 1.5). */
const FALLBACK_LINE_HEIGHT = 19.5;

/** The CSS custom property carrying the scroll-past-end pad. */
const SCROLL_PAST_VAR = '--dsh-editor-cm6-scroll-past';

/** Whitespace glyph widget box class (geometry via the glyph theme below). */
const GLYPH_CLASS = 'dsh-editor-cm6-glyph';

/** Word-layer match wash class (label-primary 9%, the DOM layer's ratio). */
const MATCH_WORD_CLASS = 'dsh-editor-cm6-match-word';

/** Selection-layer match wash class (brand-primary 18%). */
const MATCH_SELECTION_CLASS = 'dsh-editor-cm6-match-selection';

/** Ruler guide-line class (1px, border-l1, drawn by the layer marker). */
const RULER_LINE_CLASS = 'dsh-editor-cm6-ruler-line';

/** The SVG namespace the glyph widgets build their ink in. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The shell's own always-on styles: the match washes and the ruler ink. */
const SHELL_BASE_THEME = {
	'& .dsh-editor-cm6-match-word': 'background: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);',
	'& .dsh-editor-cm6-match-selection': 'background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);',
	'& .dsh-editor-cm6-ruler-line': 'background: var(--dsw-alias-border-l1); pointer-events: none;',
};

/** Kebab-case a shape-spec attribute key (strokeWidth → stroke-width). */
function svgAttributeName(key) {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Build the SVG element tree from a glyphSvgShape spec, in `doc`. */
function buildGlyphSvg(doc, shape) {
	const svg = doc.createElementNS(SVG_NAMESPACE, 'svg');
	svg.setAttribute('viewBox', shape.viewBox);
	svg.setAttribute('aria-hidden', 'true');
	for (const element of shape.elements) {
		const node = doc.createElementNS(SVG_NAMESPACE, element.tag);
		for (const [attribute, value] of Object.entries(element)) {
			if (attribute === 'tag') continue;
			node.setAttribute(svgAttributeName(attribute), String(value));
		}
		svg.appendChild(node);
	}
	return svg;
}

/** Measure one character cell via a hidden probe mounted in `host` once. */
function measureCharWidth(host) {
	try {
		if (host === null || typeof host !== 'object' || host.ownerDocument === null || typeof host.ownerDocument !== 'object') {
			return FALLBACK_CHAR_WIDTH;
		}
		const doc = host.ownerDocument;
		const probe = doc.createElement('span');
		probe.textContent = '0000000000';
		probe.style.cssText = 'position: absolute; visibility: hidden; white-space: pre; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px;';
		host.appendChild(probe);
		const width = probe.getBoundingClientRect().width / 10;
		host.removeChild(probe);
		return Number.isFinite(width) && width > 0 ? width : FALLBACK_CHAR_WIDTH;
	} catch {
		return FALLBACK_CHAR_WIDTH;
	}
}

/** The text origin's offset from the scroller's scroll origin (gutter + padding). */
function measureTextOrigin(view) {
	try {
		const line = view.contentDOM.querySelector('.cm-line');
		if (line === null) return 0;
		const scroller = view.scrollDOM;
		const origin = line.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
		return Number.isFinite(origin) ? origin : 0;
	} catch {
		return 0;
	}
}

/**
 * Sync the scroll-past-end pad from the PANE's real height: the pad is
 * `scrollBeyondPadding(clientHeight, lineHeight)` — the pure core behind
 * the DOM layer's `clientHeight − lineHeight` — written as the CSS custom
 * property the scrollBeyond theme rule consumes, so the last line can rise
 * to the pane top without the viewport-height overshoot a static rule
 * would have. A value-diff short-circuits the write; an unmeasurable pane
 * (clientHeight 0) keeps the rule's fallback instead of pinning 0.
 */
function syncScrollBeyondPad(view) {
	try {
		const clientHeight = view.scrollDOM.clientHeight;
		if (clientHeight <= 0) return;
		const lineHeight = Number.isFinite(view.defaultLineHeight) && view.defaultLineHeight > 0 ? view.defaultLineHeight : FALLBACK_LINE_HEIGHT;
		const pad = scrollBeyondPadding(clientHeight, lineHeight);
		if (view.dom.style.getPropertyValue(SCROLL_PAST_VAR) === `${pad}px`) return;
		view.dom.style.setProperty(SCROLL_PAST_VAR, `${pad}px`);
	} catch {
		// Unmeasurable (detached or hidden) — the theme rule's fallback stands.
	}
}

/** The indent unit string for one plan indent slice (tabs, or N spaces). */
function indentUnitOf(indent) {
	if (indent.mode === 'tabs') return '\t';
	const width = Number.isInteger(indent.width) && indent.width > 0 ? indent.width : 4;
	return ' '.repeat(width);
}

/**
 * The whitespace scan window: the viewport's lines widened by 2 rows on
 * each side, clamped into the document — the DOM layer's own windowing
 * convention (its `visibleWindow` margin, components.js ~404-411). The
 * window, not the document, is what the whitespace scan covers; the
 * margin keeps fast scrolling painting a buffer around the visible
 * region so the boundary lines never show un-glyphed mid-scroll.
 * @param {object} view - the editor view.
 * @returns {{ first: number, last: number }} the 1-based inclusive line
 *   range the scan covers.
 */
function whitespaceWindow(view) {
	const doc = view.state.doc;
	const first = Math.max(1, doc.lineAt(view.viewport.from).number - 2);
	const last = Math.min(doc.lines, doc.lineAt(view.viewport.to).number + 2);
	return { first, last };
}

/** Builder feed order: position, then side, then end, then layer tie-break. */
function byPosition(a, b) {
	return a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to || a.layer - b.layer;
}

/** Map one match layer's descriptors to builder entries under its mark. */
function matchEntriesOf(descriptors, mark) {
	const entries = [];
	if (!Array.isArray(descriptors)) return entries;
	for (const descriptor of descriptors) {
		entries.push({ layer: 1, deco: mark, from: descriptor.from, to: descriptor.to });
	}
	return entries;
}

/**
 * Whether a match layer's cached entries read as viewport-RESTRICTED —
 * the conservative half of the per-layer dirty decision (I2). The pure
 * core's return carries the descriptor arrays only; its per-layer cap
 * flags are internal, so the shell infers the restriction from the
 * cached result's own geometry: the core's viewport fallback produces
 * exactly the entries inside the viewport span it was handed, so a
 * non-empty result reaching OUTSIDE its span proves the layer ignored
 * the viewport (an under-cap, doc-global result), while a result
 * contained in the span — or an EMPTY one, which is ambiguous (an
 * over-cap layer with no viewport hits, or a layer with no matches at
 * all) — conservatively counts as viewport-restricted and recomputes on
 * viewport changes: the pre-fix behavior, never a skipped repaint.
 * @param {any} entries - the layer's cached entries.
 * @param {any} span - `{ from, to }` document offsets of the viewport
 *   span the cached result was computed against.
 * @returns {boolean} true when the layer must treat viewport changes as
 *   input changes.
 */
function viewportRestricted(entries, span) {
	if (!Array.isArray(entries) || entries.length === 0) return true;
	if (span === null || typeof span !== 'object') return true;
	for (const entry of entries) {
		if (entry.from < span.from || entry.to > span.to) return false;
	}
	return true;
}

/** A caret offset clamped into [0, length]. */
function clampOffset(value, length) {
	const offset = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
	return Math.max(0, Math.min(offset, length));
}

/** The normalized machine-facing selection shape for one view state. */
function normalizedSelection(view) {
	const range = view.state.selection.main;
	const start = Math.min(range.from, range.to);
	const end = Math.max(range.from, range.to);
	const doc = view.state.doc;
	return {
		start,
		end,
		lineStart: doc.lineAt(start).number,
		lineEnd: doc.lineAt(end).number,
		text: start === end ? null : doc.sliceString(start, end),
	};
}

/**
 * Mint the view factory for one vendored CM6 record (per chunk activation).
 * Everything the assembly touches lives behind the parameter — this module
 * never imports the facade or any package directly.
 * @param {object} cm6 - the vendored 35-symbol whitelist record.
 * @returns {(options: { plan: object, deps: object, docText: string, host: object }) =>
 *   { view: object, reconfigure: (nextPlan: object) => void, handle: object }} the view factory.
 */
export function createCm6ViewFactory(cm6) {
	// Mark decorations are immutable and reusable — one shared instance per class.
	const wordMark = cm6.Decoration.mark({ class: MATCH_WORD_CLASS });
	const selectionMark = cm6.Decoration.mark({ class: MATCH_SELECTION_CLASS });
	const activeLineMark = cm6.Decoration.line({ class: 'cm-activeLine' });

	/** One token descriptor's attrs as a mark decoration. */
	function markOf(attrs) {
		const spec = { class: attrs.class };
		if (attrs.style !== undefined) spec.attributes = { style: attrs.style };
		return cm6.Decoration.mark(spec);
	}

	/**
	 * The whitespace glyph widget. A replace glyph (tab, CRLF) centers its
	 * SVG over its own box of `advanceCh` character cells; a point glyph
	 * (space, line end) is zero-advance and paints over the cell that
	 * follows its insertion point. Both honor the shape spec's vertical
	 * center (yCenterEm above the text baseline).
	 */
	class GlyphWidget extends cm6.WidgetType {
		constructor(glyph, advanceCh) {
			super();
			this.glyph = glyph;
			this.advanceCh = advanceCh;
		}

		eq(other) {
			return other instanceof GlyphWidget && other.glyph === this.glyph && other.advanceCh === this.advanceCh;
		}

		toDOM(view) {
			const doc = view.dom.ownerDocument;
			const box = doc.createElement('span');
			box.className = GLYPH_CLASS;
			const shape = glyphSvgShape(this.glyph);
			if (shape === null) {
				box.textContent = this.glyph;
				return box;
			}
			const svg = buildGlyphSvg(doc, shape);
			const centered = this.advanceCh !== null;
			svg.style.left = centered ? '50%' : '0';
			svg.style.top = '0';
			svg.style.transform = `translate(${centered ? '-50%' : '0'}, calc(-50% - ${shape.yCenterEm}em))`;
			box.appendChild(svg);
			if (centered) box.style.width = `${this.advanceCh}ch`;
			return box;
		}
	}

	/** The ruler guide-line layer marker: a 1px vertical line at a fixed x. */
	class RulerMarker {
		constructor(doc, x, height) {
			this.doc = doc;
			this.x = x;
			this.height = height;
		}

		eq(other) {
			return other instanceof RulerMarker && other.x === this.x && other.height === this.height;
		}

		draw() {
			const dom = this.doc.createElement('div');
			dom.className = RULER_LINE_CLASS;
			this.place(dom);
			return dom;
		}

		update(dom) {
			this.place(dom);
			return true;
		}

		place(dom) {
			dom.style.cssText = `left: ${this.x}px; top: 0px; width: 1px; height: ${this.height}px;`;
		}
	}

	/**
	 * Build the mounted editor for one mode instance.
	 * @param {object} options - `plan` (the resolveExtensionPlan output),
	 * `deps` (the Task 9 seam), `docText` (the initial document), `host`
	 * (the mount element).
	 */
	function createCm6View({ plan, deps, docText, host }) {
		let currentPlan = plan;
		const charWidth = measureCharWidth(host);

		const lineNumbersComp = new cm6.Compartment();
		const activeLineComp = new cm6.Compartment();
		const wrapComp = new cm6.Compartment();
		const whitespaceComp = new cm6.Compartment();
		const rulerComp = new cm6.Compartment();
		const scrollBeyondComp = new cm6.Compartment();
		// indentUnit is not one of the six named families but still plan-live.
		const indentComp = new cm6.Compartment();

		function anyWhitespace(slice) {
			return slice.spaces === true || slice.tabs === true || slice.newlines === true;
		}

		/** The glyph box geometry (mirrors the DOM layer's proven shapes). */
		function glyphTheme() {
			return cm6.EditorView.theme({
				'& .dsh-editor-cm6-glyph': 'display: inline-block; width: 0; height: 0; position: relative; opacity: 0.25; color: var(--dsw-alias-label-primary); pointer-events: none;',
				'& .dsh-editor-cm6-glyph svg': 'position: absolute; width: 1ch; height: 1ch; overflow: visible;',
			});
		}

		/** Scroll-beyond padding: the last line can reach the pane top. */
		function scrollBeyondTheme() {
			return cm6.EditorView.theme({ '& .cm-content': 'padding-bottom: var(--dsh-editor-cm6-scroll-past, 19.5px);' });
		}

		/** The ruler as a layer over the content, driven by the pure geometry. */
		function rulerLayerExtension() {
			return cm6.layer({
				above: true,
				class: 'dsh-editor-cm6-ruler-layer',
				// Always re-mark: the geometry is one line plus two cheap
				// measurements, and eq() keeps the DOM untouched between equals.
				update: () => true,
				markers: (view) => {
					const geometry = deps.rulerGeometry({
						enabled: currentPlan.ruler.enabled === true,
						column: currentPlan.ruler.column,
						charWidth,
						gutterWidth: measureTextOrigin(view),
						viewportWidth: view.scrollDOM.clientWidth,
					});
					if (geometry === null) return [];
					return [new RulerMarker(view.dom.ownerDocument, geometry.x, view.contentHeight)];
				},
			});
		}

		/** Token decorations for the visible window, gated by the session. */
		function tokenEntries(view) {
			const session = deps.session;
			if (session === null || typeof session !== 'object') return [];
			// R6 flag gate FIRST: degraded/idle sessions release nothing at all.
			if (session.degraded === true || session.idle === true) return [];
			if (Array.isArray(session.lines) !== true || session.lines.length === 0) return [];
			const doc = view.state.doc;
			const fromLine = doc.lineAt(view.viewport.from).number - 1;
			// R6: the ceiling is consumed EXCLUSIVELY — decorate [fromLine, ceiling).
			// lastLine is the viewport's exclusive line end, so a fully-tokenized
			// session releases every visible line while a progressive one still
			// stops at progressLine (the count of tokenized lines).
			const lastLine = doc.lineAt(view.viewport.to).number;
			// Task 5 handoff: never index past session.lines — a null row inside
			// bounds is the not-yet-tokenized sentinel and is skipped, not crashed.
			const ceiling = Math.min(visibleTokenLineCeiling(session, fromLine, lastLine), session.lines.length, doc.lines);
			const entries = [];
			for (let line = fromLine; line < ceiling; line++) {
				const row = session.lines[line];
				if (row === null || row === undefined) continue;
				const docLine = doc.line(line + 1);
				for (const descriptor of deps.lineTokenDecorations(row, docLine.from, docLine.text)) {
					const attrs = descriptor.attrs;
					if ((attrs.class === '' || attrs.class === undefined) && attrs.style === undefined) continue;
					entries.push({ layer: 0, deco: markOf(attrs), from: descriptor.from, to: descriptor.to });
				}
			}
			return entries;
		}

		/**
		 * The two match washes for the current text, selection and viewport —
		 * refreshed PER LAYER (I2): each dirty layer gets its own core call
		 * with the other layer's switch off (computeMatchHighlights skips a
		 * disabled layer's scan), so a dirty word layer never pays the
		 * selection layer's scan and vice versa. Each layer's entries AND
		 * the viewport span they were computed against cache on the plugin:
		 * the span is what the next viewport-only update reads to tell a
		 * viewport-restricted result (an over-cap layer's fallback slices
		 * exactly that span) from a doc-global one (an under-cap layer
		 * ignores the viewport).
		 */
		function matchEntries(view, plugin, refresh) {
			const switches = currentPlan.matchHighlight;
			if (switches.selection !== true && switches.word !== true) {
				plugin.matchWordEntries = [];
				plugin.matchSelectionEntries = [];
				return [];
			}
			const doc = view.state.doc;
			const range = view.state.selection.main;
			const selection = { start: Math.min(range.from, range.to), end: Math.max(range.from, range.to) };
			const viewport = {
				fromLine: doc.lineAt(view.viewport.from).number - 1,
				toLine: doc.lineAt(view.viewport.to).number - 1,
			};
			const text = doc.toString();
			// The document-offset span the core's viewport fallback slices
			// for this viewport. The shell's own fromLine/toLine are
			// doc-derived (valid line indices), so the core's defensive
			// clamp is the identity on them — no clamp math is mirrored.
			const span = { from: doc.line(viewport.fromLine + 1).from, to: doc.line(viewport.toLine + 1).to };
			if (refresh.word) {
				const layers = deps.matchDecorationDescriptors({
					text,
					selection,
					viewport,
					selectionEnabled: false,
					wordEnabled: switches.word === true,
				});
				plugin.matchWordEntries = matchEntriesOf(layers.word, wordMark);
				plugin.matchWordSpan = span;
			}
			if (refresh.selection) {
				const layers = deps.matchDecorationDescriptors({
					text,
					selection,
					viewport,
					selectionEnabled: switches.selection === true,
					wordEnabled: false,
				});
				plugin.matchSelectionEntries = matchEntriesOf(layers.selection, selectionMark);
				plugin.matchSelectionSpan = span;
			}
			return [...plugin.matchWordEntries, ...plugin.matchSelectionEntries];
		}

		/** Whitespace glyphs: point widgets and replace widgets per descriptor. */
		function whitespaceEntries(view, window) {
			const show = currentPlan.whitespace;
			if (anyWhitespace(show) !== true) return [];
			const doc = view.state.doc;
			// Windowed scan (I1): mirror the DOM layer's windowed
			// semantics — the pure core's descriptor production stays
			// untouched, but the text it scans is the WINDOW's lines,
			// joined through the doc's own line API (`doc.line(n).text`
			// per line) instead of a whole-document materialization. The
			// shell owns the windowing: it shifts the slice-local offsets
			// back into document coordinates. The window's LAST line
			// reads as the slice's last line to the core (no break glyph)
			// — it sits 2 rows past the viewport, so it is never rendered;
			// a scroll re-windows and the line paints its glyph as it
			// becomes interior.
			let slice = '';
			for (let line = window.first; line <= window.last; line += 1) {
				if (line > window.first) slice += '\n';
				slice += doc.line(line).text;
			}
			const base = doc.line(window.first).from;
			const descriptors = deps.whitespaceDecorationDescriptors({ text: slice, show });
			const entries = [];
			for (const descriptor of descriptors) {
				// Replace glyph: a tab spans its widthCols cells; the CRLF
				// glyph replaces the carriage byte with one cell (Task 7 handoff).
				const replace = descriptor.to > descriptor.from;
				const advance = replace ? (Number.isFinite(descriptor.widthCols) ? descriptor.widthCols : 1) : null;
				entries.push({
					layer: 2,
					deco: replace
						? cm6.Decoration.replace({ widget: new GlyphWidget(descriptor.glyph, advance) })
						: cm6.Decoration.widget({ widget: new GlyphWidget(descriptor.glyph, null), side: -1 }),
					from: descriptor.from + base,
					to: descriptor.to + base,
				});
			}
			return entries;
		}

		/**
		 * Rebuild the merged decoration set: one RangeSetBuilder fed with the
		 * token, match and whitespace layers in (from, startSide, to, layer)
		 * order, so a match wash and a token ink at the same range coexist as
		 * separate decorations and token ink wins exact ties. Whitespace is
		 * WINDOWED (I1): the scan covers the viewport ± 2 lines, so its cache
		 * keys on the doc, the switches AND the window — a doc change or a
		 * viewport move rescans the visible slice, everything else reuses the
		 * cached entries.
		 */
		function rebuildDecorations(view, plugin, refresh) {
			const entries = [];
			for (const entry of tokenEntries(view)) entries.push(entry);
			if (refresh.word || refresh.selection) plugin.matchEntries = matchEntries(view, plugin, refresh);
			for (const entry of plugin.matchEntries) entries.push(entry);
			const wsKey = `${currentPlan.whitespace.spaces}|${currentPlan.whitespace.tabs}|${currentPlan.whitespace.newlines}`;
			const wsWindow = whitespaceWindow(view);
			const wsWindowKey = `${wsWindow.first}:${wsWindow.last}`;
			if (plugin.wsDoc !== view.state.doc || plugin.wsKey !== wsKey || plugin.wsWindowKey !== wsWindowKey) {
				plugin.wsDoc = view.state.doc;
				plugin.wsKey = wsKey;
				plugin.wsWindowKey = wsWindowKey;
				plugin.wsEntries = whitespaceEntries(view, wsWindow);
			}
			for (const entry of plugin.wsEntries) entries.push(entry);
			entries.sort(byPosition);
			const builder = new cm6.RangeSetBuilder();
			for (const entry of entries) builder.add(entry.from, entry.to, entry.deco);
			return builder.finish();
		}

		/** The merged token/match/whitespace decoration plugin. */
		const decorationPlugin = cm6.ViewPlugin.fromClass(
			class {
				constructor(view) {
					this.wsDoc = null;
					this.wsKey = '';
					this.wsWindowKey = '';
					this.wsEntries = [];
					this.matchEntries = [];
					this.matchWordEntries = [];
					this.matchSelectionEntries = [];
					this.matchWordSpan = null;
					this.matchSelectionSpan = null;
					this.matchDoc = null;
					this.matchStart = -1;
					this.matchEnd = -1;
					this.matchWordKey = null;
					this.matchSelectionKey = null;
					this.decorations = rebuildDecorations(view, this, { word: true, selection: true });
				}

				update(update) {
					// Pane resizes ride the existing measure cycle: a geometry change
					// re-syncs the scroll-past-end pad before the decorations rebuild.
					if (update.geometryChanged) syncScrollBeyondPad(update.view);
					const doc = update.view.state.doc;
					const range = update.view.state.selection.main;
					const start = Math.min(range.from, range.to);
					const end = Math.max(range.from, range.to);
					// The per-layer match signature (I2): the DOM seam's
					// signature-dedupe discipline — a layer recomputes when its
					// inputs move (the doc, the selection, its own switch), and a
					// viewport change joins ONLY for a layer whose cached result
					// is viewport-restricted. The core's return carries the
					// descriptor arrays only (its cap flags are internal), so the
					// restriction is inferred conservatively from the cached
					// result's own geometry: the core's viewport fallback slices
					// exactly the viewport span it was handed, so a result that
					// reaches OUTSIDE that span proves the layer ignored the
					// viewport (under cap, doc-global), while an empty or
					// viewport-contained result is ambiguous and recomputes — the
					// pre-fix behavior, never a missed repaint.
					const inputsMoved = this.matchDoc !== doc || this.matchStart !== start || this.matchEnd !== end;
					const wordKey = currentPlan.matchHighlight.word === true;
					const selectionKey = currentPlan.matchHighlight.selection === true;
					const refresh = {
						word:
							inputsMoved ||
							this.matchWordKey !== wordKey ||
							(update.viewportChanged && viewportRestricted(this.matchWordEntries, this.matchWordSpan)),
						selection:
							inputsMoved ||
							this.matchSelectionKey !== selectionKey ||
							(update.viewportChanged && viewportRestricted(this.matchSelectionEntries, this.matchSelectionSpan)),
					};
					this.matchDoc = doc;
					this.matchStart = start;
					this.matchEnd = end;
					this.matchWordKey = wordKey;
					this.matchSelectionKey = selectionKey;
					this.decorations = rebuildDecorations(update.view, this, refresh);
				}
			},
			{ decorations: (plugin) => plugin.decorations }
		);

		/** The active-line plugin: line decorations from the pluggable source. */
		const activeLinePlugin = cm6.ViewPlugin.fromClass(
			class {
				constructor(view) {
					this.decorations = this.rebuild(view);
				}

				update(update) {
					this.decorations = this.rebuild(update.view);
				}

				rebuild(view) {
					// The component's hook carries the selection snapshot; no hook →
					// no line decorations (the default derives from nothing).
					if (typeof deps.activeLineRanges !== 'function') return cm6.Decoration.none;
					const ranges = [];
					for (const range of deps.activeLineRanges()) {
						if (range === null || typeof range !== 'object') continue;
						const from = clampOffset(range.from, view.state.doc.length);
						ranges.push(activeLineMark.range(view.state.doc.lineAt(from).from));
					}
					return cm6.Decoration.set(ranges, true);
				}
			},
			{ decorations: (plugin) => plugin.decorations }
		);

		/** Tab per the plan: a literal tab in tabs mode, indentMore otherwise. */
		function tabIndent(view) {
			const indent = currentPlan.indent;
			if (indent.mode === 'tabs') {
				// A literal tab through an insertText-style transaction; the
				// selection maps through the change and lands after the byte.
				view.dispatch({
					changes: view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to, insert: '\t' })),
				});
				return true;
			}
			return cm6.indentMore(view);
		}

		// The obligation listener: edits and selections are reported ONLY here
		// (the docChanged branch is the single onEdit call site).
		const reportChanges = cm6.EditorView.updateListener.of((update) => {
			if (update.docChanged) deps.onEdit(update.view.state.doc.toString());
			if (update.selectionSet) deps.onSelection(normalizedSelection(update.view));
		});

		const view = new cm6.EditorView({
			state: cm6.EditorState.create({
				doc: typeof docText === 'string' ? docText : '',
				extensions: [
					cm6.EditorView.theme(typeof deps.cm6BaseTheme === 'function' ? deps.cm6BaseTheme() : {}),
					cm6.EditorView.baseTheme(SHELL_BASE_THEME),
					cm6.drawSelection(),
					cm6.dropCursor(),
					cm6.rectangularSelection(),
					cm6.crosshairCursor(),
					cm6.history(),
					cm6.keymap.of([
						{ key: 'Tab', run: tabIndent },
						{ key: 'Shift-Tab', run: (view) => cm6.indentLess(view) },
						...cm6.historyKeymap,
						...cm6.defaultKeymap,
					]),
					reportChanges,
					decorationPlugin,
					lineNumbersComp.of(currentPlan.lineNumbers === true ? cm6.lineNumbers() : []),
					activeLineComp.of(currentPlan.activeLine === true ? activeLinePlugin : []),
					wrapComp.of(currentPlan.wrap === true ? cm6.EditorView.lineWrapping : []),
					whitespaceComp.of(anyWhitespace(currentPlan.whitespace) ? glyphTheme() : []),
					rulerComp.of(currentPlan.ruler.enabled === true ? rulerLayerExtension() : []),
					scrollBeyondComp.of(currentPlan.scrollBeyondLastLine === true ? scrollBeyondTheme() : []),
					indentComp.of(cm6.indentUnit.of(indentUnitOf(currentPlan.indent))),
				],
			}),
			parent: host,
		});

		// Measure the pad once now (an already-laid-out host answers immediately;
		// a hidden one keeps the rule's fallback until the first geometry change).
		syncScrollBeyondPad(view);

		const reportScroll = () => {
			if (typeof deps.onScroll !== 'function') return;
			deps.onScroll({ top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft });
		};
		view.scrollDOM.addEventListener('scroll', reportScroll, { passive: true });

		function reconfigure(nextPlan) {
			currentPlan = nextPlan;
			// Every live-toggle family re-dispatches its compartment in one
			// transaction; the decoration plugin reads the new slices during
			// the same update, so flips apply live.
			view.dispatch({
				effects: [
					lineNumbersComp.reconfigure(currentPlan.lineNumbers === true ? cm6.lineNumbers() : []),
					activeLineComp.reconfigure(currentPlan.activeLine === true ? activeLinePlugin : []),
					wrapComp.reconfigure(currentPlan.wrap === true ? cm6.EditorView.lineWrapping : []),
					whitespaceComp.reconfigure(anyWhitespace(currentPlan.whitespace) ? glyphTheme() : []),
					rulerComp.reconfigure(currentPlan.ruler.enabled === true ? rulerLayerExtension() : []),
					scrollBeyondComp.reconfigure(currentPlan.scrollBeyondLastLine === true ? scrollBeyondTheme() : []),
					indentComp.reconfigure(cm6.indentUnit.of(indentUnitOf(currentPlan.indent))),
				],
			});
		}

		const handle = {
			/** Restore the framework's saved scroll offsets once. */
			applyInitialScroll(target) {
				if (target === null || typeof target !== 'object') return;
				const top = typeof target.top === 'number' && Number.isFinite(target.top) ? target.top : 0;
				const left = typeof target.left === 'number' && Number.isFinite(target.left) ? target.left : 0;
				view.scrollDOM.scrollTo(left, top);
			},

			/** Claim a line navigation: cursor to the line start, target scrolled in. */
			navigateToLine(line) {
				const target = Math.max(1, Math.floor(Number(line)));
				const lineStart = view.state.doc.line(Math.min(target, view.state.doc.lines)).from;
				view.dispatch({
					selection: cm6.EditorSelection.cursor(lineStart),
					effects: cm6.EditorView.scrollIntoView(lineStart, { y: 'start' }),
				});
				return true;
			},

			/** Replace the whole document (a machine write), optionally selecting. */
			setContent(text, selection) {
				const next = typeof text === 'string' ? text : '';
				const range = selection === null || typeof selection !== 'object' ? null : selection;
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: next },
					selection: range === null ? undefined : cm6.EditorSelection.range(clampOffset(range.start, next.length), clampOffset(range.end, next.length)),
					// A machine write is not a user edit: keep it OUT of the
					// undo history so Ctrl+Z reverts the user's last edit,
					// never the framework's last write (M1 — the DOM seam's
					// programmatic writes were never in any history either).
					annotations: cm6.Transaction.addToHistory.of(false),
				});
			},

			/** Mirror a machine selection into the view (skipping no-op writes). */
			mirrorMachineSelection(selection) {
				if (selection === null || typeof selection !== 'object') return;
				const length = view.state.doc.length;
				const start = clampOffset(selection.start, length);
				const end = clampOffset(selection.end, length);
				const current = view.state.selection.main;
				if (Math.min(current.from, current.to) === start && Math.max(current.from, current.to) === end) return;
				view.dispatch({
					selection: cm6.EditorSelection.range(start, end),
					// Same M1 discipline: a machine-driven selection is not
					// history either.
					annotations: cm6.Transaction.addToHistory.of(false),
				});
			},

			destroy() {
				view.destroy();
			},
		};

		return { view, reconfigure, handle };
	}

	return createCm6View;
}
