import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWrapMeasurer, WRAP_LINE_STYLES } from './wrap-measure.js';

/**
 * A programmable fake mirror port: `heights` maps the text handed to
 * `measure` onto a deterministic rendered height (default `10`, so the
 * default `lineHeightPx` of `10` yields one row per line). It records every
 * style object, width and probe so a test can assert what the measurer
 * actually asked the DOM to do. `measureWidth` reports `6` px per character,
 * i.e. `600` px for the 100-zero `chWidthPx` probe.
 * @param {Map<string, number>} [heights] - text → rendered height in px.
 * @returns {object} the fake mirror with its recorded state.
 */
function createFakeMirror(heights = new Map()) {
	const mirror = {
		style: {},
		widths: [],
		texts: [],
		widthProbes: [],
		detached: false,
		setStyle(next) {
			Object.assign(mirror.style, next);
		},
		setWidth(px) {
			mirror.widths.push(px);
		},
		measure(text) {
			mirror.texts.push(text);
			return heights.has(text) ? heights.get(text) : 10;
		},
		measureWidth(text) {
			mirror.widthProbes.push(text);
			return text.length * 6;
		},
		detach() {
			mirror.detached = true;
		}
	};
	return mirror;
}

/**
 * Manual scheduler queue: `schedule` captures the callbacks, the test drains
 * them one at a time (`drainSteps`) or all the way (`drain`), exactly like a
 * real `requestAnimationFrame` loop would.
 * @returns {object} the queue with `schedule`, `drain`, `drainSteps`, `size`.
 */
function createQueue() {
	const queue = [];
	return {
		schedule(callback) {
			queue.push(callback);
		},
		drain() {
			while (queue.length > 0) queue.shift()();
		},
		drainSteps(steps) {
			for (let i = 0; i < steps && queue.length > 0; i++) queue.shift()();
		},
		size() {
			return queue.length;
		}
	};
}

/**
 * Build a measurer over a fake mirror and a manual queue, already attached
 * to a 100 px-wide fake area with 10 + 5 px horizontal padding.
 * @param {object} fakeMirror - the fake mirror to hand to `mirrorFactory`.
 * @param {object} queue - the manual scheduler queue.
 * @param {object} [deps] - extra/overriding measurer deps.
 * @returns {object} the attached measurer.
 */
function attachedMeasurer(fakeMirror, queue, deps = {}) {
	const measurer = createWrapMeasurer({
		mirrorFactory: () => fakeMirror,
		readStyles: () => ({ paddingLeft: 10, paddingRight: 5 }),
		schedule: (callback) => queue.schedule(callback),
		...deps
	});
	measurer.attach({ clientWidth: 100 }, { lineHeightPx: 10 });
	return measurer;
}

/** A deterministic 40-line fixture, every line one row tall. */
const FORTY_LINES = Array.from({ length: 40 }, (_, index) => `line ${index}`);

/** A fake textarea area: only `clientWidth` is read by the measurer. */
const fakeArea = { clientWidth: 100 };

test('measureRange returns per-line row counts', () => {
	const fakeMirror = createFakeMirror(new Map([['de', 20]]));
	const m = createWrapMeasurer({ mirrorFactory: () => fakeMirror, readStyles: () => ({ paddingLeft: 10, paddingRight: 5 }) });
	m.attach(fakeArea, { lineHeightPx: 10 });
	assert.equal(m.ready(), true);
	assert.deepEqual(m.measureRange(['ab', 'c', '', 'de'], 0, 4), [1, 1, 1, 2]);
});
test('measureAll progresses in chunks and reports exact prefixes', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue, { budgetMs: 0 });
	const chunks = [];
	const dones = [];
	const cancel = m.measureAll(FORTY_LINES, {
		onChunk(countsSnapshot, doneUpTo0) {
			chunks.push({ countsSnapshot, doneUpTo0 });
		},
		onDone(counts) {
			dones.push(counts);
		}
	});
	assert.equal(typeof cancel, 'function');
	assert.equal(dones.length, 0);
	queue.drainSteps(2);
	assert.equal(chunks.length, 2);
	assert.equal(dones.length, 0);
	queue.drain();
	assert.equal(dones.length, 1);
	assert.deepEqual(dones[0], m.measureRange(FORTY_LINES, 0, FORTY_LINES.length));
	assert.deepEqual(dones[0], new Array(FORTY_LINES.length).fill(1));
	assert.ok(chunks.length > 0);
	let previousDone = 0;
	for (const { countsSnapshot, doneUpTo0 } of chunks) {
		assert.ok(doneUpTo0 > previousDone, 'doneUpTo0 is strictly increasing');
		assert.equal(countsSnapshot.length, doneUpTo0, 'a chunk snapshots exactly the exact prefix');
		assert.deepEqual(countsSnapshot, dones[0].slice(0, doneUpTo0));
		previousDone = doneUpTo0;
	}
	assert.equal(queue.size(), 0);
});
test('the mirror receives the shared WRAP_LINE_STYLES', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	attachedMeasurer(fakeMirror, queue);
	assert.equal(fakeMirror.style.whiteSpace, 'pre-wrap');
	assert.equal(fakeMirror.style.overflowWrap, 'break-word');
	assert.equal(fakeMirror.style.wordBreak, 'normal');
	for (const [property, value] of Object.entries(WRAP_LINE_STYLES)) {
		assert.equal(fakeMirror.style[property], value);
	}
});
test('WRAP_LINE_STYLES is the frozen shared constant', () => {
	assert.deepEqual({ ...WRAP_LINE_STYLES }, { whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal' });
	assert.equal(Object.isFrozen(WRAP_LINE_STYLES), true);
	assert.throws(() => {
		'use strict';
		WRAP_LINE_STYLES.whiteSpace = 'pre';
	});
});
test('attach copies the textarea typographic context and hides the mirror off-screen', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = createWrapMeasurer({
		mirrorFactory: () => fakeMirror,
		readStyles: () => ({
			paddingLeft: 10,
			paddingRight: 5,
			font: '13px monospace',
			fontSize: '13px',
			fontWeight: '400',
			fontStyle: 'normal',
			fontFamily: 'monospace',
			lineHeight: '19.5px',
			letterSpacing: 'normal',
			wordSpacing: '0px',
			tabSize: '4'
		}),
		schedule: (callback) => queue.schedule(callback)
	});
	m.attach({ clientWidth: 100 }, { lineHeightPx: 19.5 });
	assert.equal(fakeMirror.style.position, 'fixed');
	assert.equal(fakeMirror.style.left, '-9999px');
	assert.equal(fakeMirror.style.top, '0');
	assert.equal(fakeMirror.style.visibility, 'hidden');
	assert.equal(fakeMirror.style.boxSizing, 'content-box');
	assert.equal(fakeMirror.style.font, '13px monospace');
	assert.equal(fakeMirror.style.fontSize, '13px');
	assert.equal(fakeMirror.style.fontWeight, '400');
	assert.equal(fakeMirror.style.fontStyle, 'normal');
	assert.equal(fakeMirror.style.fontFamily, 'monospace');
	assert.equal(fakeMirror.style.lineHeight, '19.5px');
	assert.equal(fakeMirror.style.letterSpacing, 'normal');
	assert.equal(fakeMirror.style.wordSpacing, '0px');
	assert.equal(fakeMirror.style.tabSize, '4');
});
test('ready requires an attached area with a usable lineHeightPx', () => {
	const queue = createQueue();
	const m = attachedMeasurer(createFakeMirror(), queue);
	assert.equal(m.ready(), true);
	const detached = createWrapMeasurer({ mirrorFactory: () => createFakeMirror(), readStyles: () => ({}) });
	assert.equal(detached.ready(), false);
	for (const lineHeightPx of [0, -10, NaN, Infinity, '10', null, undefined]) {
		const measurer = createWrapMeasurer({ mirrorFactory: () => createFakeMirror(), readStyles: () => ({}) });
		measurer.attach({ clientWidth: 100 }, { lineHeightPx });
		assert.equal(measurer.ready(), false, `lineHeightPx ${String(lineHeightPx)} is unusable`);
	}
	const withoutOptions = createWrapMeasurer({ mirrorFactory: () => createFakeMirror(), readStyles: () => ({}) });
	withoutOptions.attach({ clientWidth: 100 });
	assert.equal(withoutOptions.ready(), false);
	withoutOptions.attach({ clientWidth: 100 }, null);
	assert.equal(withoutOptions.ready(), false);
});
test('usableWidth subtracts the horizontal padding and degrades to 0', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue);
	assert.equal(m.usableWidth(), 85);
	m.measureRange(['ab'], 0, 1);
	assert.equal(fakeMirror.widths[fakeMirror.widths.length - 1], m.usableWidth());
	assert.equal(fakeMirror.widths[fakeMirror.widths.length - 1], 85);
	const noArea = createWrapMeasurer({ mirrorFactory: () => createFakeMirror(), readStyles: () => ({ paddingLeft: 10, paddingRight: 5 }) });
	assert.equal(noArea.usableWidth(), 0);
	noArea.attach({}, { lineHeightPx: 10 });
	assert.equal(noArea.usableWidth(), 0);
	noArea.attach({ clientWidth: 12 }, { lineHeightPx: 10 });
	assert.equal(noArea.usableWidth(), 0);
	noArea.detach();
	assert.equal(noArea.usableWidth(), 0);
});
test('chWidthPx divides the 100-zero probe width by 100', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue);
	assert.equal(m.chWidthPx(), 6);
	assert.equal(fakeMirror.widthProbes.length, 1);
	assert.equal(fakeMirror.widthProbes[0], '0'.repeat(100));
	const unattached = createWrapMeasurer({ mirrorFactory: () => createFakeMirror() });
	assert.equal(unattached.chWidthPx(), 0);
	const partialMirror = {
		setStyle() {},
		setWidth() {},
		measure() {
			return 10;
		},
		detach() {}
	};
	const partial = createWrapMeasurer({ mirrorFactory: () => partialMirror, readStyles: () => ({}) });
	partial.attach({ clientWidth: 100 }, { lineHeightPx: 10 });
	assert.equal(partial.chWidthPx(), 0, 'no width probe port ⇒ 0, never a bogus ch width');
});
test('measureRange normalizes bounds and tolerates non-string lines', () => {
	const fakeMirror = createFakeMirror(new Map([['de', 20]]));
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue);
	assert.deepEqual(m.measureRange(['ab', 'de'], 0, 2), [1, 2]);
	assert.deepEqual(m.measureRange(['ab', 'de'], 1, 99), [2]);
	assert.deepEqual(m.measureRange(['ab', 'de'], -5, 1), [1]);
	assert.deepEqual(m.measureRange(['ab', 'de'], 2, 1), []);
	assert.deepEqual(m.measureRange([], 0, 3), []);
	assert.deepEqual(m.measureRange(null, 0, 3), []);
	assert.deepEqual(m.measureRange([null, 'de'], 0, 2), [1, 2]);
});
test('an empty line reaches the mirror as a zero-width space', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue);
	assert.deepEqual(m.measureRange(['', null, 'ab'], 0, 3), [1, 1, 1]);
	assert.deepEqual(fakeMirror.texts, ['\u200b', '\u200b', 'ab']);
});
test('measureAll with no lines completes immediately with an empty snapshot', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue);
	const dones = [];
	const cancel = m.measureAll([], {
		onChunk() {
			assert.fail('an empty document has no chunks');
		},
		onDone(counts) {
			dones.push(counts);
		}
	});
	assert.equal(typeof cancel, 'function');
	assert.deepEqual(dones, [[]]);
	assert.equal(queue.size(), 0);
});
test('cancel and detach stop a running measureAll without further callbacks', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue, { budgetMs: 0 });
	const chunks = [];
	const dones = [];
	const cancel = m.measureAll(FORTY_LINES, {
		onChunk(countsSnapshot, doneUpTo0) {
			chunks.push(doneUpTo0);
		},
		onDone(counts) {
			dones.push(counts);
		}
	});
	queue.drainSteps(1);
	assert.deepEqual(chunks, [1]);
	cancel();
	queue.drain();
	assert.deepEqual(chunks, [1]);
	assert.equal(dones.length, 0);
	const chunksAfterDetach = [];
	const donesAfterDetach = [];
	const queue2 = createQueue();
	const m2 = attachedMeasurer(createFakeMirror(), queue2, { budgetMs: 0 });
	m2.measureAll(FORTY_LINES, {
		onChunk(countsSnapshot, doneUpTo0) {
			chunksAfterDetach.push(doneUpTo0);
		},
		onDone(counts) {
			donesAfterDetach.push(counts);
		}
	});
	queue2.drainSteps(1);
	assert.deepEqual(chunksAfterDetach, [1]);
	m2.detach();
	queue2.drain();
	assert.deepEqual(chunksAfterDetach, [1]);
	assert.equal(donesAfterDetach.length, 0);
});
test('a second measureAll supersedes the first', () => {
	const fakeMirror = createFakeMirror(new Map([['de', 20]]));
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue, { budgetMs: 0 });
	const first = { chunks: [], dones: [] };
	const second = { chunks: [], dones: [] };
	m.measureAll(FORTY_LINES, {
		onChunk(countsSnapshot, doneUpTo0) {
			first.chunks.push(doneUpTo0);
		},
		onDone(counts) {
			first.dones.push(counts);
		}
	});
	queue.drainSteps(1);
	m.measureAll(['ab', 'de'], {
		onChunk(countsSnapshot, doneUpTo0) {
			second.chunks.push(doneUpTo0);
		},
		onDone(counts) {
			second.dones.push(counts);
		}
	});
	queue.drain();
	assert.deepEqual(first.chunks, [1]);
	assert.equal(first.dones.length, 0);
	assert.deepEqual(second.dones, [[1, 2]]);
});
test('detach and dispose degrade every measurement to a safe value', () => {
	const fakeMirror = createFakeMirror();
	const queue = createQueue();
	const m = attachedMeasurer(fakeMirror, queue);
	m.detach();
	assert.equal(fakeMirror.detached, true);
	assert.equal(m.ready(), false);
	assert.equal(m.usableWidth(), 0);
	assert.equal(m.chWidthPx(), 0);
	assert.deepEqual(m.measureRange(['ab', 'de'], 0, 2), [1, 1]);
	let callbacks = 0;
	const cancel = m.measureAll(['ab', 'de'], {
		onChunk() {
			callbacks++;
		},
		onDone() {
			callbacks++;
		}
	});
	assert.equal(typeof cancel, 'function');
	cancel();
	queue.drain();
	assert.equal(callbacks, 0);
	m.dispose();
	assert.equal(m.ready(), false);
	assert.deepEqual(m.measureRange(['ab'], 0, 1), [1]);
	assert.doesNotThrow(() => m.detach());
	assert.doesNotThrow(() => m.dispose());
	assert.equal(typeof m.measureAll(['ab'], {}), 'function');
	assert.equal(typeof m.measureAll(['ab'], null), 'function');
});
