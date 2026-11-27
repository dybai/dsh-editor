/**
 * Task 7 guard tests — the code-highlight mode's wiring, in two halves:
 *
 * 1. Behavioral (the token layer is React-free, so it imports cleanly under
 *    node:test): `createTokenLayerDescriptor` is driven through a fake
 *    engine + a minimal DOM stub — descriptor shape, windowed painting
 *    (plain + wrap), the EMPTY_LINES plain-rendering skip, the degradation
 *    rAF retry (exactly one frame per blowout, a retry blowout stays plain),
 *    the per-language session lifecycle (dispose old / create new), the
 *    not-ready auto-recolor path and the dispose teardown. The tokenizer is
 *    never mocked for real — here the ENGINE seam is fake (the layer's own
 *    logic is the unit under test), the same injected-seam discipline
 *    engine.test.js uses for `core`.
 *
 * 2. Source-level markers (the established discipline for React-requiring
 *    modules, as in client-entry.test.js / components.test.js): the
 *    components factory returns CodeHighlightMode, the composition shell
 *    forwards all 16 mode props, the entry's registration block, the single
 *    `require.async` transport, the STYLES rules, and the locale keys (the
 *    dual-source sync itself lives in client-entry.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EMPTY_LINES } from './highlight/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS_TEXT = readFileSync(path.join(HERE, 'components.js'), 'utf8');
const ENTRY_TEXT = readFileSync(path.join(HERE, 'client-entry.js'), 'utf8');
// mode-code-highlight.js is read INSIDE its marker test: until the module
// exists the other suites still run and show their own RED evidence.

/* ------------------------------------------- token-layer test doubles -- */

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
			// with one text node (the painter writes token text this way).
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

/** Fake engine: records calls; `linesUntilLoaded` lets tests stage the not-ready → ready arc. */
function createFakeEngine({ lines = EMPTY_LINES } = {}) {
	const calls = { ready: [], createSession: [], update: [], dispose: [] };
	const state = { loaded: true, readyResolver: null };
	const engine = {
		calls,
		state,
		ready(language) {
			calls.ready.push(language);
			if (state.readyResolver !== null) {
				return new Promise((resolve) => state.readyResolver({ language, resolve }));
			}
			return Promise.resolve(state.loaded);
		},
		createSession(language) {
			const session = {
				language,
				text: '',
				lines: EMPTY_LINES,
				states: [],
				degraded: false,
				degradedNotified: false,
				idle: false,
			};
			calls.createSession.push(session);
			return session;
		},
		update(session, text) {
			calls.update.push({ session, text });
			session.text = text;
			session.lines = state.loaded ? lines : EMPTY_LINES;
			return session.lines;
		},
		dispose(session) {
			calls.dispose.push(session);
		},
	};
	return engine;
}

/** requestFrame recorder: counts schedules and fires them on demand. */
function createFrameRecorder() {
	const frames = [];
	const requestFrame = (fn) => {
		frames.push(fn);
	};
	return {
		requestFrame,
		frames,
		count() {
			return frames.length;
		},
		fireAll() {
			while (frames.length > 0) frames.shift()();
		},
	};
}

/** A token row for 'const x = 1;': 'const' c1 italic, ' =' c2; gaps inherit. */
const TOKEN_LINES = [
	[
		{ start: 0, end: 5, color: '#c1', fontStyle: 1 },
		{ start: 7, end: 9, color: '#c2', fontStyle: 0 },
	],
	[{ start: 0, end: 3, color: '#k', fontStyle: 2 }],
];

/** The descriptor arrives via dynamic import so a missing module fails only the behavioral tests. */
async function loadTokenLayer() {
	return await import('./highlight/token-layer.js');
}

/* ------------------------------------------------ descriptor shape -- */

test('createTokenLayerDescriptor exports a tokens descriptor with the dsh-editor class', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const descriptor = createTokenLayerDescriptor({
		engine: createFakeEngine(),
		getPath: () => '/tmp/a.js',
		requestFrame: frame.requestFrame,
	});
	assert.equal(descriptor.key, 'tokens', "the descriptor key is 'tokens'");
	assert.ok(typeof descriptor.className === 'string' && descriptor.className.endsWith('-tokens'), 'the className ends with -tokens');
	assert.equal(descriptor.className, 'dsh-editor-tokens', 'the className mirrors the components CLASS prefix');
	assert.equal(typeof descriptor.paint, 'function', 'the descriptor carries a paint callback');
	assert.equal(typeof descriptor.dispose, 'function', 'the descriptor exposes a dispose hook for unmount teardown');
});

/* ------------------------------------------------------- guard rails -- */

test('paint never throws on missing or broken inputs and schedules no frame', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine();
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/a.js', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	// A throwing getPath, a null layer and a null context must all degrade to silence.
	const throwing = createTokenLayerDescriptor({ engine, getPath: () => { throw new Error('no path'); }, requestFrame: frame.requestFrame });
	assert.doesNotThrow(() => throwing.paint(layer, context), 'a throwing getPath degrades to a silent paint');
	assert.doesNotThrow(() => descriptor.paint(null, context), 'a null layer is skipped');
	assert.doesNotThrow(() => descriptor.paint(layer, null), 'a null context is skipped');
	assert.doesNotThrow(() => descriptor.paint(undefined, undefined), 'missing layer+context are skipped');
	assert.equal(frame.count(), 0, 'no repaint frame is scheduled by guarded-out paints');
	const nullEngineDescriptor = createTokenLayerDescriptor({ engine: null, getPath: () => '/a.js', requestFrame: frame.requestFrame });
	assert.doesNotThrow(() => nullEngineDescriptor.paint(layer, context), 'a null engine degrades to plain rendering');
	assert.equal(layer.childNodes.length, 2, 'without an engine the window still paints plain runs (readable inkless text)');
	assert.equal(frame.count(), 0, 'still no frames without an engine');
});

test('a path outside the language table renders plain text without an engine session', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/Makefile', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	descriptor.paint(layer, context);
	assert.equal(engine.calls.createSession.length, 0, 'no session is created without a table language');
	assert.equal(engine.calls.update.length, 0, 'no update runs without a table language');
	assert.equal(layer.childNodes.length, 2, 'plain rows still paint (the inkless textarea needs the layer for readable ink)');
	assert.ok(layer.childNodes.every((row) => row.childNodes.every((child) => child.textNode)), 'plain rows carry only inherit runs');
	assert.equal(frame.count(), 0, 'no repaint is scheduled');
});

/* --------------------------------------------------- plain windowing -- */

test('plain mode paints firstLine..firstLine+visibleCount rows at the whitespace-painter geometry', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.js', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	// Window: lines 1..2 (0-based 0..1), scrolled down one line height.
	context.area.scrollTop = 20;
	context.area.scrollLeft = 30;
	context.firstLine = 0;
	context.visibleCount = 2;
	descriptor.paint(layer, context);
	assert.equal(engine.calls.update.length, 1, 'update runs inside paint');
	assert.equal(engine.calls.update[0].text, 'const x = 1;\nlet y = 2;\n', 'update receives the whole area value');
	assert.equal(layer.childNodes.length, 2, 'one row span per windowed line');
	const [row0, row1] = layer.childNodes;
	assert.equal(row0.className, 'dsh-editor-token-row', 'rows carry the token-row class');
	assert.equal(row0.style.top, '-10px', 'top = paddingTop + line*lineHeight - scrollTop (line 0 sits above the box)');
	assert.equal(row1.style.top, '10px', 'top = paddingTop + line*lineHeight - scrollTop (line 1 at the padding edge)');
	assert.equal(row0.style.left, '8ch', 'rows pin to the band-width left edge');
	assert.equal(layer.style.transform, 'translateX(-30px)', 'the layer translates against scrollLeft like the whitespace layer');
	// Row 0 fragments: 'const' colored span (fontStyle bit 1 renders as
	// font-style italic — advance-safe in monospace contexts), ' x' bare gap,
	// ' =' colored span, ' 1;' bare gap.
	assert.deepEqual(
		row0.childNodes.map((child) => (child.textNode ? { text: child.text } : { text: child.childNodes[0].text, color: child.style.color })),
		[
			{ text: 'const', color: '#c1' },
			{ text: ' x' },
			{ text: ' =', color: '#c2' },
			{ text: ' 1;' },
		],
		'token runs carry color spans, gaps are bare inherit text nodes'
	);
	assert.equal(row0.childNodes[0].style.fontStyle, 'italic', 'fontStyle bit 1 renders as font-style italic (advance-invariant ink)');
	assert.equal('fontWeight' in row0.childNodes[0].style, false, 'no font-weight alongside the italic');
});

test('wrap mode paints wrapRows alone: one row per entry, slice-clamped fragments, no scroll translate', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.js', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	// CONTROLLER REVIEW CARRY-FORWARD: wrap mode leans on wrapRows ALONE —
	// visibleCount counts slice-null lines absent from wrapRows, so a zero
	// count must not suppress the wrap window and a stale firstLine must not
	// extend it.
	context.wrapEnabled = true;
	context.wrapRows = [
		{ line: 1, start: 0, end: 5, top: 7 },
		{ line: 2, start: 2, end: 9, top: 27 },
	];
	context.firstLine = 99;
	context.visibleCount = 0;
	context.area.scrollLeft = 40;
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, 2, 'exactly one row per wrapRows entry');
	assert.equal(layer.childNodes[0].style.top, '7px', 'wrap row tops come from the entry verbatim');
	assert.equal(layer.childNodes[1].style.top, '27px', 'wrap row tops come from the entry verbatim');
	assert.equal(layer.style.transform, 'translateX(0px)', 'wrap never translates (rows reflow instead)');
	// Row 2 slice [2..9) of 'let y = 2;' with token 0..3: '#k' clipped to [2..3), then inherit tail.
	const row1 = layer.childNodes[1];
	assert.deepEqual(
		row1.childNodes.map((child) => (child.textNode ? { text: child.text } : { text: child.childNodes[0].text, color: child.style.color })),
		[{ text: 't', color: '#k' }, { text: ' y = 2' }],
		'the wrap slice splits token fragments exactly at the row edges'
	);
	assert.equal('webkitTextStroke' in row1.childNodes[0].style, false, 'fontStyle bit 2 stays inkless — the faux-bold stroke synthesis was removed (user-rejected blur)');
	assert.equal('fontWeight' in row1.childNodes[0].style, false, 'no font-weight — real bold would change glyph advance');
});

test('fontStyle bits 4 and 8 map to text-decoration, and combined bits compose', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const lines = [
		[
			{ start: 0, end: 1, color: '#u', fontStyle: 4 },
			{ start: 2, end: 3, color: '#s', fontStyle: 8 },
			{ start: 4, end: 5, color: '#us', fontStyle: 12 },
			{ start: 6, end: 7, color: '#all', fontStyle: 15 },
		],
	];
	const engine = createFakeEngine({ lines });
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.md', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	context.area.value = 'u s us all';
	descriptor.paint(layer, context);
	const row = layer.childNodes[0];
	const spans = row.childNodes.filter((child) => !child.textNode);
	assert.equal(spans.length, 4, 'four token spans');
	assert.equal(spans[0].style.textDecoration, 'underline');
	assert.equal('fontWeight' in spans[0].style, false, 'underline alone sets no weight');
	assert.equal(spans[1].style.textDecoration, 'line-through');
	assert.equal(spans[2].style.textDecoration, 'underline line-through', 'bits 4|8 compose one declaration');
	assert.equal(spans[3].style.fontStyle, 'italic', 'bit 1 renders as font-style italic');
	assert.equal('webkitTextStroke' in spans[3].style, false, 'bit 2 stays inkless — the faux-bold stroke synthesis was removed (user-rejected blur)');
	assert.equal('fontWeight' in spans[3].style, false, 'bits 1|2 never surface as a font-weight (advance-invariant ink)');
	assert.equal(spans[3].style.textDecoration, 'underline line-through');
});

/* ------------------------------------------------- plain rendering -- */

test('EMPTY_LINES renders plain: stale ink clears and the window repaints as readable plain runs', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: EMPTY_LINES });
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.js', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	// Pre-fill the layer with stale ink from a previous paint: the plain pass must clear it.
	context.doc.createElement('span');
	layer.appendChild(context.doc.nodes[0]);
	descriptor.paint(layer, context);
	// The textarea's text is transparent while the token layer is mounted (the
	// -area-inkless overlay variant), so plain rendering MUST paint the window
	// as inherit runs — a skipped paint would leave the text invisible.
	assert.equal(layer.childNodes.length, 2, 'the window repaints as plain runs');
	assert.ok(layer.childNodes.every((row) => row.childNodes.every((child) => child.textNode)), 'plain rendering paints only inherit runs');
	assert.equal(engine.calls.update.length, 1, 'update still runs (it feeds the session)');
	assert.equal(frame.count(), 0, 'a not-loaded language schedules no frame (plain until ready)');
});

/* ------------------------------------------------- degradation retry -- */

test('a budget blowout schedules exactly one rAF repaint; a retry blowout stays plain', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const sessionOf = {};
	const engine = {
		ready: () => Promise.resolve(true),
		createSession(language) {
			const session = { language, text: '', lines: EMPTY_LINES, states: [], degraded: false, degradedNotified: false, idle: false };
			sessionOf[language] = session;
			return session;
		},
		update(session, text) {
			// Every update of this engine blows the budget fresh: flags re-arm,
			// exactly like the real engine's top-of-update clear.
			session.degraded = true;
			session.degradedNotified = false;
			return EMPTY_LINES;
		},
		dispose() {},
	};
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.js', requestFrame: frame.requestFrame });
	const first = createFakeContext();
	descriptor.paint(first.layer, first.context);
	assert.equal(sessionOf.javascript.degradedNotified, true, 'the layer marks the blowout notified');
	assert.equal(frame.count(), 1, 'exactly one rAF repaint is scheduled');
	// A second paint in the same frame window (draft effect + observer) detects the
	// fresh blowout too but must not pile up another frame.
	const second = createFakeContext();
	descriptor.paint(second.layer, second.context);
	assert.equal(frame.count(), 1, 'a pending frame is reused, requestFrame stays at one call');
	// The retry repaint: the frame callback repaints the saved pair; its own blowout
	// must NOT schedule again (one retry, then plain).
	const updatesSeen = [];
	const originalUpdate = engine.update;
	engine.update = (session, text) => {
		updatesSeen.push(text);
		return originalUpdate(session, text);
	};
	frame.fireAll();
	assert.equal(updatesSeen.length, 1, 'the retry repaint runs exactly one update');
	assert.equal(frame.count(), 0, 'the retry blowout schedules nothing further (fireAll drained the one pending frame)');
	// The next NORMAL paint after the retry is a fresh blowout episode: it re-arms.
	const third = createFakeContext();
	descriptor.paint(third.layer, third.context);
	assert.equal(frame.count(), 1, 'the next blowout after the consumed retry re-arms one fresh frame');
});

/* ---------------------------------------------- session lifecycle -- */

test('a language change disposes the old session and creates a fresh one', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	let path = '/tmp/a.js';
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => path, requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	descriptor.paint(layer, context);
	assert.equal(engine.calls.createSession.length, 1);
	assert.equal(engine.calls.createSession[0].language, 'javascript');
	path = '/tmp/b.py';
	descriptor.paint(layer, context);
	assert.equal(engine.calls.dispose.length, 1, 'the old session is disposed on the language change');
	assert.equal(engine.calls.dispose[0], engine.calls.createSession[0], 'the disposed session is the previous one');
	assert.equal(engine.calls.createSession.length, 2, 'a fresh session is created');
	assert.equal(engine.calls.createSession[1].language, 'python');
	// Same language again: the session is reused (idempotent update).
	descriptor.paint(layer, context);
	assert.equal(engine.calls.createSession.length, 2, 'no session churn within one language');
	assert.equal(engine.calls.dispose.length, 1, 'no dispose without a language change');
});

test('dispose tears the session down and later paints stay no-ops', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.js', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	descriptor.paint(layer, context);
	const session = engine.calls.createSession[0];
	assert.doesNotThrow(() => descriptor.dispose(), 'dispose is safe to call');
	assert.equal(engine.calls.dispose.length, 1, 'dispose hands the session to the engine');
	assert.equal(engine.calls.dispose[0], session);
	const childCountBefore = layer.childNodes.length;
	descriptor.dispose();
	assert.equal(engine.calls.dispose.length, 1, 'dispose is idempotent');
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, childCountBefore, 'a disposed descriptor paints nothing');
	assert.equal(engine.calls.createSession.length, 1, 'a disposed descriptor never resurrects a session');
});

test('reset re-arms a disposed descriptor (StrictMode unmount-remount cycle)', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.js', requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	descriptor.paint(layer, context);
	assert.equal(engine.calls.createSession.length, 1);
	// StrictMode's simulated unmount: dispose, then the effect re-runs on the
	// SAME instance and re-arms it — the remount must paint again.
	descriptor.dispose();
	descriptor.reset();
	descriptor.paint(layer, context);
	assert.equal(engine.calls.createSession.length, 2, 'the re-armed descriptor lazily recreates its session');
	assert.ok(
		layer.childNodes.some((row) => row.childNodes.some((child) => !child.textNode)),
		'the re-armed descriptor paints token rows again'
	);
	// And the cycle is repeatable: dispose again stays disposed until reset.
	descriptor.dispose();
	const rowsAfterDispose = layer.childNodes.length;
	descriptor.paint(layer, context);
	assert.equal(layer.childNodes.length, rowsAfterDispose, 'still disposed after the second dispose');
	descriptor.reset();
	descriptor.paint(layer, context);
	assert.equal(engine.calls.createSession.length, 3, 'the cycle repeats');
});

/* ------------------------------------------- not-ready auto-recolor -- */

test('a not-loaded language asks ready once and repaints the saved pair when the chunk lands', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	let path = '/tmp/a.py';
	let releaseReady;
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	const armResolver = () => {
		engine.state.readyResolver = ({ resolve }) => {
			releaseReady = (loaded) => resolve(loaded);
		};
	};
	engine.state.loaded = false;
	armResolver();
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => path, requestFrame: frame.requestFrame });
	const { layer, context } = createFakeContext();
	descriptor.paint(layer, context);
	assert.equal(engine.calls.ready.length, 1, 'ready is requested for the session language');
	assert.equal(engine.calls.ready[0], 'python');
	assert.equal(frame.count(), 0, 'nothing schedules while the chunk is in flight');
	// A second paint while still loading must not re-ask or re-schedule.
	descriptor.paint(layer, context);
	assert.equal(engine.calls.ready.length, 1, 'ready is deduped while unresolved');
	assert.equal(frame.count(), 0);
	// The chunk lands: auto-colors — one repaint of the saved pair, no user event needed.
	engine.state.loaded = true;
	releaseReady(true);
	await flush();
	assert.equal(frame.count(), 1, 'the ready arrival schedules one repaint');
	frame.fireAll();
	assert.equal(engine.calls.update.length >= 2, true, 'the repaint re-runs update');
	assert.equal(layer.childNodes.length, 2, 'token rows paint after the language loads');
	assert.ok(
		layer.childNodes.some((row) => row.childNodes.some((child) => !child.textNode)),
		'the repaint colors the text: colored token spans replace the plain runs'
	);
	// A failed load on a later language stays plain, asks once and schedules nothing.
	engine.state.loaded = false;
	armResolver();
	path = '/tmp/b.yaml';
	const frameCountBefore = frame.count();
	const readyCountBefore = engine.calls.ready.length;
	descriptor.paint(layer, context);
	assert.equal(engine.calls.ready.length, readyCountBefore + 1, 'the new language asks ready');
	assert.equal(engine.calls.ready[readyCountBefore], 'yaml');
	releaseReady(false);
	await flush();
	assert.equal(frame.count(), frameCountBefore, 'a failed load schedules no repaint');
});

test('a scroll between ask and arrival repaints the LATEST window, never the stale first pair', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const engine = createFakeEngine({ lines: TOKEN_LINES });
	engine.state.loaded = false;
	let releaseReady;
	engine.state.readyResolver = ({ resolve }) => {
		releaseReady = (loaded) => resolve(loaded);
	};
	const descriptor = createTokenLayerDescriptor({ engine, getPath: () => '/tmp/a.py', requestFrame: frame.requestFrame });
	// First (mount) paint: asks ready, captures its own pair.
	const first = createFakeContext();
	first.context.area.value = 'first\nwindow';
	descriptor.paint(first.layer, first.context);
	assert.equal(engine.calls.ready.length, 1, 'ready asked on the first paint');
	// The user scrolls before the chunk lands: a later paint refreshes the live pair.
	const second = createFakeContext();
	second.context.area.value = 'a\nb\nc\nd\ne\nf\ng\nh';
	second.context.area.scrollTop = 200;
	second.context.firstLine = 5;
	second.context.visibleCount = 2;
	descriptor.paint(second.layer, second.context);
	assert.equal(engine.calls.ready.length, 1, 'no re-ask while unresolved');
	// The chunk lands: the repaint must consume the LATEST pair — the second
	// window's geometry — not the stale mount paint (whose rows would land
	// outside the scrolled viewport and leave the inkless text invisible).
	engine.state.loaded = true;
	releaseReady(true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(frame.count(), 1, 'one repaint scheduled on arrival');
	frame.fireAll();
	const lastUpdate = engine.calls.update[engine.calls.update.length - 1];
	assert.equal(lastUpdate.text, 'a\nb\nc\nd\ne\nf\ng\nh', 'the repaint re-read the latest context');
	assert.equal(second.layer.childNodes.length, 2, 'rows landed in the latest layer');
	assert.equal(second.layer.childNodes[0].style.top, '-90px', 'top uses the latest scrollTop/firstLine (10 + 5*20 - 200)');
	assert.equal(second.layer.childNodes[1].style.top, '-70px', 'top uses the latest scrollTop/firstLine (10 + 6*20 - 200)');
	assert.equal(
		first.layer.childNodes.every((row) => row.childNodes.every((child) => child.textNode)),
		true,
		'the stale first pair was never repainted (its plain rows are untouched)'
	);
});

/* ------------------------------------------- components.js markers -- */

test('createEditorComponents returns CodeHighlightMode built from the mode module + token layer', () => {
	assert.ok(
		COMPONENTS_TEXT.includes("from './mode-code-highlight.js'"),
		'components.js imports the composition shell from mode-code-highlight.js'
	);
	assert.ok(
		COMPONENTS_TEXT.includes("from './highlight/token-layer.js'"),
		'components.js imports the token-layer descriptor builder'
	);
	assert.ok(COMPONENTS_TEXT.includes('createTokenLayerDescriptor'), 'createTokenLayerDescriptor is referenced in components.js');
	assert.ok(
		COMPONENTS_TEXT.includes('CodeHighlightMode: createCodeHighlightMode('),
		'createEditorComponents returns CodeHighlightMode built by the shell factory'
	);
	assert.ok(
		COMPONENTS_TEXT.includes('highlightEngine'),
		'the runtime highlight engine is handed to the shell (the components runtime owns it)'
	);
});

/* -------------------------------------- mode-code-highlight.js markers -- */

test('CodeHighlightMode forwards all 16 mode props plus the extra backdrop layer', () => {
	const MODE_TEXT = readFileSync(path.join(HERE, 'mode-code-highlight.js'), 'utf8');
	const FORWARDED = [
		'controller: props.controller',
		't: props.t',
		'address: props.address',
		'path: props.path',
		'sessionId: props.sessionId',
		'highlightActiveLine: props.highlightActiveLine',
		'showLineNumbers: props.showLineNumbers',
		'scrollBeyondLastLine: props.scrollBeyondLastLine',
		'wordWrap: props.wordWrap',
		'showWhitespace: props.showWhitespace',
		'indentSettings: props.indentSettings',
		'ruler: props.ruler',
		'matchHighlight: props.matchHighlight',
		'initialScroll: props.initialScroll',
		'onScrollChange: props.onScrollChange',
		'log: props.log',
	];
	for (const marker of FORWARDED) {
		assert.ok(MODE_TEXT.includes(marker), `the shell forwards ${marker.split(':')[0]} to PlainTextMode`);
	}
	assert.ok(MODE_TEXT.includes('extraBackdropLayers:'), 'the shell passes extraBackdropLayers to PlainTextMode');
	assert.ok(MODE_TEXT.includes('PlainTextMode'), 'the shell composes PlainTextMode');
});

test('the shell re-arms the descriptor on effect re-run (StrictMode remount safety)', () => {
	const MODE_TEXT = readFileSync(path.join(HERE, 'mode-code-highlight.js'), 'utf8');
	const start = MODE_TEXT.indexOf('React.useEffect(() => {');
	assert.ok(start !== -1, 'the shell owns a teardown effect');
	const end = MODE_TEXT.indexOf('}, []);', start);
	assert.ok(end !== -1, 'the teardown effect is delimited');
	const effectSpan = MODE_TEXT.slice(start, end);
	assert.ok(effectSpan.includes('descriptor.reset'), 'the effect BODY re-arms the descriptor (StrictMode re-runs it after the simulated unmount)');
	assert.ok(effectSpan.includes('descriptor.dispose'), 'the cleanup disposes the descriptor');
	assert.ok(
		effectSpan.indexOf('descriptor.reset') < effectSpan.indexOf('descriptor.dispose'),
		're-arm happens before the cleanup registration, so the first mount is a no-op and the remount revives'
	);
});

/* ------------------------------------------- client-entry.js markers -- */

test("the client entry registers 'code-highlight' with the builtin descriptor contract", () => {
	const start = ENTRY_TEXT.indexOf("id: 'code-highlight'");
	assert.ok(start !== -1, "a 'code-highlight' registration block exists in src/client-entry.js");
	const end = ENTRY_TEXT.indexOf("'dsh-editor: code-highlight mode'");
	assert.ok(end !== -1, "the registration effect is named 'dsh-editor: code-highlight mode'");
	const block = ENTRY_TEXT.slice(start, end);
	assert.ok(block.includes("priority: 'builtin'"), 'priority is builtin');
	assert.ok(block.includes('globs: deriveGlobs()'), 'globs come verbatim from deriveGlobs()');
	assert.ok(block.includes("contentKind: 'text'"), 'contentKind is text');
	assert.ok(block.includes('activeLine: true'), 'activeLine is declared');
	assert.ok(block.includes("label: () => boundT('mode.code')"), 'the label reads mode.code through boundT');
	assert.ok(block.includes('component: editorComponents.CodeHighlightMode'), 'the component is the editor components CodeHighlightMode');
	// Registration order: the code-highlight effect sits immediately after the plain-text one.
	const plainAt = ENTRY_TEXT.indexOf("'dsh-editor: plain-text mode'");
	assert.ok(plainAt !== -1 && plainAt < start, 'the plain-text registration exists before it');
});

test('the require.async chunk transport appears exactly once in the client entry', () => {
	const occurrences = (ENTRY_TEXT.match(/require\.async\('\.\//g) || []).length;
	assert.equal(occurrences, 1, `require.async('./' ...) is the ONLY chunk transport call site (found ${occurrences})`);
	assert.ok(ENTRY_TEXT.includes('createChunkLoader({'), 'the chunk loader is wired in the entry');
	assert.ok(ENTRY_TEXT.includes('createEngine({'), 'the engine is created in the entry');
	assert.ok(ENTRY_TEXT.includes('highlightEngine'), 'the engine singleton rides the component runtime');
});

test('the 0.18.0 progressive wiring: engine frames, progress bridge and descriptor subscription', () => {
	// The engine schedules its own background frames through the entry's rAF
	// and reports every advance through the progress listener bridge; the
	// token layer subscribes via the mode shell's deps.
	assert.ok(ENTRY_TEXT.includes('scheduleFrame: (fn) => requestAnimationFrame(() => fn())'), 'engine background frames ride requestAnimationFrame');
	assert.ok(ENTRY_TEXT.includes('onProgress:'), 'the engine reports progress advances');
	assert.ok(ENTRY_TEXT.includes('onHighlightProgress'), 'the progress listener bridge rides the component runtime');
	const shellText = readFileSync(path.join(HERE, 'mode-code-highlight.js'), 'utf8');
	assert.ok(shellText.includes('subscribeProgress'), 'the shell forwards the progress subscription to the descriptor');
});

test('the engine progress channel repaints the latest pair; dispose unsubscribes', async () => {
	const { createTokenLayerDescriptor } = await loadTokenLayer();
	const frame = createFrameRecorder();
	const listeners = [];
	const subscribeProgress = (fn) => {
		listeners.push(fn);
		return () => {
			const at = listeners.indexOf(fn);
			if (at >= 0) listeners.splice(at, 1);
		};
	};
	const engine = createFakeEngine();
	const descriptor = createTokenLayerDescriptor({
		engine,
		getPath: () => '/a.js',
		requestFrame: frame.requestFrame,
		subscribeProgress
	});
	const { layer, context } = createFakeContext();
	assert.equal(listeners.length, 1, 'the descriptor subscribes exactly once at creation');
	descriptor.paint(layer, context); // saves the latest (layer, context) pair
	const before = frame.count();
	listeners[0]();
	assert.equal(listeners.length, 1, 'the listener stays subscribed while live');
	assert.ok(frame.count() > before, 'a progress advance repaints the latest pair');
	descriptor.dispose();
	assert.equal(listeners.length, 0, 'dispose unsubscribes the progress channel');
});

test('the STYLES template carries the token layer, row and inkless-textarea rules', () => {
	assert.ok(ENTRY_TEXT.includes('.dsh-editor-tokens {'), 'the .dsh-editor-tokens layer rule exists');
	assert.ok(ENTRY_TEXT.includes('.dsh-editor-token-row {'), 'the .dsh-editor-token-row row rule exists');
	const start = ENTRY_TEXT.indexOf('.dsh-editor-tokens {');
	const end = ENTRY_TEXT.indexOf('}', start);
	const rule = ENTRY_TEXT.slice(start, end);
	assert.ok(rule.includes('position: absolute'), 'the layer positions absolutely like the whitespace layer');
	assert.ok(rule.includes('pointer-events: none'), 'the layer never intercepts pointers');
	assert.ok(rule.includes('font-family'), 'the layer carries the textarea font so token ink lands on its columns');
	// The inkless overlay variant (the token layer paints the visible ink, so
	// the textarea's own glyphs go transparent; the caret keeps its color).
	assert.ok(ENTRY_TEXT.includes('.dsh-editor-area-inkless {'), 'the .dsh-editor-area-inkless variant rule exists');
	const inklessStart = ENTRY_TEXT.indexOf('.dsh-editor-area-inkless {');
	const inklessEnd = ENTRY_TEXT.indexOf('}', inklessStart);
	const inklessRule = ENTRY_TEXT.slice(inklessStart, inklessEnd);
	assert.ok(inklessRule.includes('color: transparent'), 'the textarea text goes transparent over the token ink');
	assert.ok(inklessRule.includes('caret-color'), 'the caret keeps an explicit color (it follows currentColor)');
});

test('the inline zh/en dictionaries carry mode.code in both languages', () => {
	for (const [dictionary, value] of [
		['zh', '代码高亮'],
		['en', 'Code highlight'],
	]) {
		const start = ENTRY_TEXT.indexOf(`const ${dictionary} = {`);
		assert.ok(start !== -1, `the ${dictionary} dictionary exists`);
		const end = ENTRY_TEXT.indexOf('\n};', start);
		const span = ENTRY_TEXT.slice(start, end);
		assert.ok(span.includes(`'mode.code': '${value}'`), `the inline ${dictionary} dictionary carries mode.code = ${value}`);
	}
});
