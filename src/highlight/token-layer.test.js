/**
 * Token-layer tint rendering (the 0.18.0 token-tint revision's paint half):
 * the behavioral fake-DOM suite for `context.matchTints` — the Map of
 * per-line LINE-relative labeled ranges `mergeLayerRanges` produces, which
 * components.js' syncExtraLayers attaches to the paint context.
 *
 * The contract under test, one span per run:
 *
 * - a tint-carrying run renders as ONE span carrying the tint background
 *   class (`dsh-editor-match-word` / `-match-selection` / `-match-both`)
 *   AND the token's inline color — the ink and the highlight
 *   background can never disagree about the run's advance (the whole point
 *   of the revision: a styled token's measured step is the span's own);
 * - a tint-carrying inherit run (gap under a tint) still needs the class to
 *   paint the background, so it renders as a class-carrying span with NO
 *   inline color (the ink stays inherited);
 * - a tint-null styled run keeps the plain colored span, and a tint-null
 *   inherit run keeps the bare text node — the old path, byte-identical;
 * - `matchTints` null/absent (or a Map missing the painted line, or a
 *   malformed value) takes the `buildTokenRowFragments` old path entirely:
 *   zero match classes, the pre-revision rendering (the plain-text and
 *   match-off editors keep their exact paint).
 *
 * The fake-DOM doubles mirror src/mode-code-highlight.test.js's (the
 * behavioral suite that already drives this descriptor): the layer is
 * React-free and imports cleanly under node:test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTokenLayerDescriptor } from './token-layer.js';
import { EMPTY_LINES } from './engine.js';

/* ----------------------------------------------------- test doubles -- */

/** Minimal document stub — just createElement/createTextNode for the painter. */
function createFakeDocument() {
	const nodes = [];
	const doc = {
		nodes,
		createElement(tag) {
			const node = {
				tag,
				className: '',
				style: {},
				childNodes: [],
				appendChild(child) {
					node.childNodes.push(child);
					return child;
				},
			};
			// Real-DOM textContent semantics: setting it REPLACES the children
			// with one text node (the painter writes run text this way).
			Object.defineProperty(node, 'textContent', {
				get() {
					return node.childNodes.filter((child) => child.textNode).map((child) => child.text).join('');
				},
				set(value) {
					node.childNodes.length = 0;
					if (value !== '') node.childNodes.push({ textNode: true, text: String(value) });
				},
			});
			nodes.push(node);
			return node;
		},
		createTextNode(text) {
			const node = { textNode: true, text: String(text) };
			nodes.push(node);
			return node;
		},
	};
	return doc;
}

/** The layer div stub: textContent = '' clears, appendChild collects. */
function createFakeLayer() {
	const layer = {
		className: '',
		style: {},
		childNodes: [],
		appendChild(child) {
			layer.childNodes.push(child);
			return child;
		},
	};
	Object.defineProperty(layer, 'textContent', {
		get() {
			return '';
		},
		set() {
			layer.childNodes.length = 0;
		},
	});
	return layer;
}

/** The paint context PlainTextMode's syncExtraLayers hands the descriptor. */
function createFakeContext(overrides = {}) {
	const doc = createFakeDocument();
	const context = {
		doc,
		area: { value: 'const x = 1;\nlet y = 2;\n', scrollTop: 0, scrollLeft: 0, offsetParent: {} },
		metrics: { paddingTop: 10, lineHeight: 20 },
		bandWidth: 8,
		wrapEnabled: false,
		firstLine: 0,
		visibleCount: 2,
		wrapRows: undefined,
		...overrides,
	};
	return { doc, layer: createFakeLayer(), context };
}

/** Fake engine: returns the staged token lines from every update. */
function createFakeEngine({ lines = EMPTY_LINES } = {}) {
	return {
		ready: () => Promise.resolve(true),
		createSession(language) {
			return { language, text: '', lines: EMPTY_LINES, states: [], degraded: false, degradedNotified: false, idle: false };
		},
		update(session, text) {
			session.text = text;
			session.lines = lines;
			return session.lines;
		},
		dispose() {},
	};
}

/** requestFrame recorder: collects scheduled frames, fires on demand. */
function createFrameRecorder() {
	const frames = [];
	const requestFrame = (fn) => {
		frames.push(fn);
	};
	return { requestFrame, frames, count: () => frames.length, fireAll: () => { while (frames.length > 0) frames.shift()(); } };
}

/** A token row for 'const x = 1;': 'const' #c1 italic, ' =' #c2; gaps inherit. */
const TOKEN_LINES = [
	[
		{ start: 0, end: 5, color: '#c1', fontStyle: 1 },
		{ start: 7, end: 9, color: '#c2', fontStyle: 0 },
	],
	[{ start: 0, end: 3, color: '#k', fontStyle: 2 }],
];

/**
 * One painted run, summarized for structural assertions: the text, and the
 * className (null for a bare text node — the old path's inherit runs).
 */
function summarize(child) {
	return {
		text: child.textNode ? child.text : child.childNodes[0].text,
		className: child.textNode ? null : child.className,
	};
}

/** A mounted descriptor over the two-line fixture, paint-ready. */
function createPaintableDescriptor(overrides = {}) {
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	const descriptor = createTokenLayerDescriptor({
		engine,
		getPath: () => '/tmp/a.js',
		requestFrame: frame.requestFrame,
		...overrides,
	});
	return { frame, engine, descriptor };
}

/* --------------------------------------------- tint rendering (new) -- */

test('a matchTints Map paints one span per run: the tint class AND the token ink together', () => {
	const { descriptor } = createPaintableDescriptor();
	const { layer, context } = createFakeContext();
	context.matchTints = new Map([
		[0, [{ start: 4, end: 8, layer: 'selection' }]],
		[1, [{ start: 0, end: 3, layer: 'word' }]],
	]);
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, 2, 'one row per windowed line');
	const [row0, row1] = layer.childNodes;
	// Row 0 ('const x = 1;', tokens [0,5) #c1 italic / [7,9) #c2, tint [4,8)):
	// runs split at the tint edges; every covered run is ONE span carrying
	// the -match-selection class, the gap under the tint stays a span (the
	// background needs the class) with inherited color, the uncovered runs
	// keep exactly the old shapes.
	assert.deepEqual(
		row0.childNodes.map(summarize),
		[
			{ text: 'cons', className: '' },
			{ text: 't', className: 'dsh-editor-match-selection' },
			{ text: ' x', className: 'dsh-editor-match-selection' },
			{ text: ' ', className: 'dsh-editor-match-selection' },
			{ text: '=', className: '' },
			{ text: ' 1;', className: null },
		],
		'runs split at the tint edges; covered runs carry the tint class, uncovered runs stay old-path'
	);
	// The SAME span carries the ink and the tint: a styled run under the tint
	// keeps its color on the class-carrying span (advance-invariant inline
	// set — applyFontStyle drops the italic/bold bits).
	const tintedToken = row0.childNodes[1];
	assert.equal(tintedToken.childNodes[0].text, 't');
	assert.equal(tintedToken.style.color, '#c1', 'the tint span keeps the token color (ink + background, one advance)');
	assert.equal('fontStyle' in tintedToken.style, false, 'the tint span renders advance-invariant: no italic');
	const tintedGap = row0.childNodes[2];
	assert.equal(tintedGap.style.color, undefined, 'an inherit run under a tint sets no inline color');
	assert.equal(tintedGap.childNodes[0].text, ' x');
	const tintedToken2 = row0.childNodes[3];
	assert.equal(tintedToken2.style.color, '#c2', 'the second token run under the tint keeps its color');
	assert.equal('fontStyle' in tintedToken2.style, false, 'fontStyle 0 stays unset');
	// Row 1 ('let y = 2;', token [0,3) #k bold bits, tint [0,3) 'word'): the
	// whole token is ONE class-carrying span with color (bold dropped at
	// render — the advance-invariant ink).
	const letSpan = row1.childNodes[0];
	assert.equal(letSpan.className, 'dsh-editor-match-word', "a word-layer run carries the -match-word class");
	assert.equal(letSpan.style.color, '#k', 'the word-tinted span keeps the token color');
	assert.equal('fontWeight' in letSpan.style, false, 'the word-tinted span renders advance-invariant: no bold');
	assert.deepEqual(summarize(row1.childNodes[1]), { text: ' y = 2;', className: null }, 'the untinted tail stays a bare text node');
});

test("a 'both' tint renders the single merged -match-both class on the token span", () => {
	const { descriptor } = createPaintableDescriptor();
	const { layer, context } = createFakeContext();
	context.matchTints = new Map([[1, [{ start: 0, end: 3, layer: 'both' }]]]);
	descriptor.paint(layer, context);
	const letSpan = layer.childNodes[1].childNodes[0];
	assert.equal(letSpan.className, 'dsh-editor-match-both', 'a both-layers run carries the single merged class (never two stacked)');
	assert.equal(letSpan.style.color, '#k', 'the merged run keeps the token color');
	assert.equal('fontWeight' in letSpan.style, false, 'the merged run renders advance-invariant: no bold');
	assert.equal(layer.childNodes[0].childNodes.every((child) => child.textNode || !child.className.includes('match')), true, 'the untinted line paints no match class');
});

test("an 'active' tint renders the -match-active class on the token span (the live selection)", () => {
	// 2026-11-26 active-tint 修订：当前选区是一等 tint——标签 'active' 渲
	// 染为 -match-active（更强品牌色），墨色/字体样式同 span 保持：墨与
	// 底色共享同一步进，原生选区背景（按隐形常规排版绘制）被抑制后不再
	// 浮离字形。
	const { descriptor } = createPaintableDescriptor();
	const { layer, context } = createFakeContext();
	context.matchTints = new Map([[0, [{ start: 4, end: 8, layer: 'active' }]]]);
	descriptor.paint(layer, context);
	const [row0] = layer.childNodes;
	assert.deepEqual(
		row0.childNodes.map(summarize),
		[
			{ text: 'cons', className: '' },
			{ text: 't', className: 'dsh-editor-match-active' },
			{ text: ' x', className: 'dsh-editor-match-active' },
			{ text: ' ', className: 'dsh-editor-match-active' },
			{ text: '=', className: '' },
			{ text: ' 1;', className: null },
		],
		'the active-tinted runs carry the -match-active class; uncovered runs stay old-path'
	);
	const tintedToken = row0.childNodes[1];
	assert.equal(tintedToken.style.color, '#c1', 'the active span keeps the token color (ink + background, one advance)');
	assert.equal('fontStyle' in tintedToken.style, false, 'the active span renders advance-invariant: no italic');
	const tintedGap = row0.childNodes[2];
	assert.equal(tintedGap.style.color, undefined, 'an inherit run under the active tint sets no inline color');
});

test('wrap mode tints: line-relative ranges split the runs inside the row slice', () => {
	const { descriptor } = createPaintableDescriptor();
	const { layer, context } = createFakeContext();
	context.wrapEnabled = true;
	context.wrapRows = [{ line: 1, start: 2, end: 9, top: 27 }];
	context.firstLine = 99;
	context.visibleCount = 0;
	context.matchTints = new Map([[0, [{ start: 3, end: 6, layer: 'word' }]]]);
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, 1, 'exactly one row per wrapRows entry');
	const row = layer.childNodes[0];
	// Slice [2,9) of 'const x = 1;': token [2,5) 'nst' #c1 italic, gap [5,7)
	// ' x', token [7,9) ' =' #c2 — tint [3,6) splits 'nst' at 3 and ' x' at 6.
	assert.deepEqual(
		row.childNodes.map(summarize),
		[
			{ text: 'n', className: '' },
			{ text: 'st', className: 'dsh-editor-match-word' },
			{ text: ' ', className: 'dsh-editor-match-word' },
			{ text: 'x', className: null },
			{ text: ' =', className: '' },
		],
		'the tint edges split runs inside the slice; the slice edges stay exact'
	);
	assert.equal(row.childNodes[1].style.color, '#c1', 'the tinted token run keeps its color');
	assert.equal('fontStyle' in row.childNodes[1].style, false, 'the tinted token run renders advance-invariant: no italic');
	assert.equal(row.childNodes[2].style.color, undefined, 'the tinted gap run inherits its color');
});

/* ------------------------------------------ old path (regression) -- */

test('without matchTints the paint stays the old byte-identical token path', () => {
	const { descriptor } = createPaintableDescriptor();
	const { layer, context } = createFakeContext();
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, 2, 'one row per windowed line');
	const [row0, row1] = layer.childNodes;
	assert.deepEqual(
		row0.childNodes.map(summarize),
		[
			{ text: 'const', className: '' },
			{ text: ' x', className: null },
			{ text: ' =', className: '' },
			{ text: ' 1;', className: null },
		],
		'no matchTints: the exact pre-revision run shapes'
	);
	assert.deepEqual(
		row1.childNodes.map(summarize),
		[
			{ text: 'let', className: '' },
			{ text: ' y = 2;', className: null },
		],
		'no matchTints: the second line paints old-path too'
	);
	assert.equal(row0.childNodes[0].style.color, '#c1', 'token runs keep their color');
	assert.equal('fontStyle' in row0.childNodes[0].style, false, 'token runs render advance-invariant: no fontStyle inline');
	assert.equal(
		layer.childNodes.every((row) => row.childNodes.every((child) => child.textNode || !child.className.includes('dsh-editor-match'))),
		true,
		'no run anywhere carries a match tint class'
	);
});

test('an empty matchTints Map and a Map missing the painted line both degrade to no tint', () => {
	const { descriptor } = createPaintableDescriptor();
	// Empty Map: non-null, so the tinted builder runs — with no entry for any
	// line every run degrades to tint null (Map.get → undefined → null), and
	// the rendering is byte-identical to the old path.
	const empty = createFakeContext();
	empty.context.matchTints = new Map();
	descriptor.paint(empty.layer, empty.context);
	assert.deepEqual(
		empty.layer.childNodes[0].childNodes.map(summarize),
		[
			{ text: 'const', className: '' },
			{ text: ' x', className: null },
			{ text: ' =', className: '' },
			{ text: ' 1;', className: null },
		],
		'an empty Map paints the old shapes'
	);
	// A Map keyed for a line outside the window: the painted lines get
	// undefined → null → no tint.
	const foreign = createFakeContext();
	foreign.context.matchTints = new Map([[5, [{ start: 0, end: 4, layer: 'word' }]]]);
	descriptor.paint(foreign.layer, foreign.context);
	assert.deepEqual(
		foreign.layer.childNodes[0].childNodes.map(summarize),
		[
			{ text: 'const', className: '' },
			{ text: ' x', className: null },
			{ text: ' =', className: '' },
			{ text: ' 1;', className: null },
		],
		'a Map missing the painted line paints the old shapes'
	);
});

test('a malformed matchTints value degrades to the old path and never throws', () => {
	const { descriptor } = createPaintableDescriptor();
	for (const malformed of [null, 'garbage', { get: 'not a function' }, 42]) {
		const probe = createFakeContext();
		probe.context.matchTints = malformed;
		assert.doesNotThrow(() => descriptor.paint(probe.layer, probe.context), `a malformed matchTints (${String(malformed)}) never throws`);
		assert.equal(probe.layer.childNodes.length, 2, 'the window still paints');
		assert.deepEqual(
			probe.layer.childNodes[0].childNodes.map(summarize),
			[
				{ text: 'const', className: '' },
				{ text: ' x', className: null },
				{ text: ' =', className: '' },
				{ text: ' 1;', className: null },
			],
			'a malformed matchTints paints the old shapes'
		);
	}
	// A Map whose entry is garbage (not an array of usable ranges): the tint
	// builder's own defenses degrade every run to tint null.
	const garbageEntry = createFakeContext();
	garbageEntry.context.matchTints = new Map([[0, 'not ranges']]);
	assert.doesNotThrow(() => descriptor.paint(garbageEntry.layer, garbageEntry.context), 'a garbage Map entry never throws');
	assert.deepEqual(
		garbageEntry.layer.childNodes[0].childNodes.map(summarize),
		[
			{ text: 'const', className: '' },
			{ text: ' x', className: null },
			{ text: ' =', className: '' },
			{ text: ' 1;', className: null },
		],
		'a garbage Map entry paints the old shapes'
	);
});

/* ------------------------ advance-invariant ink (fontStyle mask) -- */

/**
 * A descriptor over an engine staged with CUSTOM token lines — the
 * advance-invariance tests control the fontStyle bits themselves (the
 * shared TOKEN_LINES fixture exists to exercise the tint paths).
 */
function createDescriptorWithLines(lines) {
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines });
	const descriptor = createTokenLayerDescriptor({
		engine,
		getPath: () => '/tmp/a.md',
		requestFrame: frame.requestFrame,
	});
	return { frame, engine, descriptor };
}

test('a fontStyle 3 (italic|bold) token renders advance-invariant: color kept, no fontStyle/fontWeight inline', () => {
	// 步进不变式：隐形 textarea 按常规字重排版，鼠标映射/光标/原生选区都锚
	// 在那份布局上；CJK 回退字体里 italic/bold 会改变字形步进，token 墨色
	// 若渲染它们就会漂离每一个像素锚定的 affordance。渲染丢弃位 1/2——
	// token 类型依旧靠颜色区分。
	const { descriptor } = createDescriptorWithLines([[{ start: 0, end: 5, color: '#t', fontStyle: 3 }]]);
	const { layer, context } = createFakeContext();
	context.area.value = 'bold!';
	context.visibleCount = 1;
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, 1, 'one row for the single line');
	const span = layer.childNodes[0].childNodes[0];
	assert.equal(span.className, '', 'the token run paints the old-path colored span');
	assert.equal(span.style.color, '#t', 'the token color keeps the token-type distinction');
	assert.equal('fontStyle' in span.style, false, 'no inline font-style — italic glyphs would change advance');
	assert.equal('fontWeight' in span.style, false, 'no inline font-weight — bold advance would drift the ink off the regular-weight layout');
});

test('a fontStyle 4 token keeps its underline decoration (decorations do not change advance)', () => {
	const { descriptor } = createDescriptorWithLines([[{ start: 0, end: 4, color: '#u', fontStyle: 4 }]]);
	const { layer, context } = createFakeContext();
	context.area.value = 'link';
	context.visibleCount = 1;
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, 1, 'one row for the single line');
	const span = layer.childNodes[0].childNodes[0];
	assert.equal(span.style.color, '#u', 'the token color stays');
	assert.equal(span.style.textDecoration, 'underline', 'underline survives the mask — decoration adds no advance');
	assert.equal('fontStyle' in span.style, false, 'no italic slips through with the decoration');
	assert.equal('fontWeight' in span.style, false, 'no bold slips through with the decoration');
});

test('a fontStyle 0 token stays the plain color span (baseline unchanged)', () => {
	const { descriptor } = createDescriptorWithLines([[{ start: 0, end: 3, color: '#c', fontStyle: 0 }]]);
	const { layer, context } = createFakeContext();
	context.area.value = 'abc';
	context.visibleCount = 1;
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, 1, 'one row for the single line');
	const span = layer.childNodes[0].childNodes[0];
	assert.deepEqual(span.style, { color: '#c' }, 'fontStyle 0 paints exactly the pure color span — nothing else inline');
});
