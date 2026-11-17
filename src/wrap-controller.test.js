import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWrapController } from './wrap-controller.js';

/**
 * A programmable fake measurer in the shape `createWrapMeasurer` produces.
 * `state` holds the knobs a test flips (readiness, usable width, char width,
 * line height, the per-line range rule) plus the recorded calls: every
 * `measureRange` range, every `measureAll` document, the captured handlers
 * and the cancel count. `lineHeightPx` is exposed as a read-only property —
 * the controller's optional line-height fallback port.
 * @param {object} [settings] - initial overrides.
 * @returns {object} the fake measurer with its test helpers.
 */
function createFakeMeasurer(settings = {}) {
	const state = {
		ready: settings.ready !== false,
		width: typeof settings.width === 'number' ? settings.width : 100,
		chWidth: typeof settings.chWidth === 'number' ? settings.chWidth : 10,
		lineHeightPx: typeof settings.lineHeightPx === 'number' ? settings.lineHeightPx : 10,
		rangeRows:
			typeof settings.rangeRows === 'function'
				? settings.rangeRows
				: (lineText) => Math.max(1, Math.ceil(String(lineText).length / 10)),
		rangeCalls: [],
		allCalls: 0,
		allLines: [],
		cancelCalls: 0,
		handlers: null
	};
	const fake = {
		ready() {
			return state.ready;
		},
		usableWidth() {
			return state.width;
		},
		chWidthPx() {
			return state.chWidth;
		},
		measureRange(lines, from0, to0Excl) {
			state.rangeCalls.push({ lines: lines.slice(), from0, to0Excl });
			const rows = [];
			for (let index = from0; index < to0Excl; index++) rows.push(state.rangeRows(lines[index]));
			return rows;
		},
		measureAll(lines, handlers) {
			state.allCalls++;
			state.allLines.push(lines.slice());
			state.handlers = handlers !== null && typeof handlers === 'object' ? handlers : null;
			return () => {
				state.cancelCalls++;
				state.handlers = null;
			};
		},
		state
	};
	Object.defineProperty(fake, 'lineHeightPx', { get: () => state.lineHeightPx });
	/**
	 * Deliver one exact-prefix chunk through the captured `onChunk`.
	 * @param {number[]} prefix - the exact prefix counts.
	 */
	fake.chunk = (prefix) => {
		assert.notEqual(state.handlers, null, 'measureAll must be running');
		state.handlers.onChunk(prefix.slice(), prefix.length);
	};
	/**
	 * Deliver the final full counts through the captured `onDone`.
	 * @param {any} full - the counts array (a test may pass malformed data).
	 */
	fake.done = (full) => {
		assert.notEqual(state.handlers, null, 'measureAll must be running');
		const handlers = state.handlers;
		state.handlers = null;
		handlers.onDone(full);
	};
	/**
	 * Convenience for the brief's fixture shape: one or more chunk snapshots,
	 * the last of which is the full document.
	 * @param {number[][]} chunks - chunk prefixes, last one complete.
	 */
	fake.finish = (chunks) => {
		for (const chunk of chunks) fake.chunk(chunk);
		fake.done(chunks[chunks.length - 1]);
	};
	return fake;
}

/**
 * A manual timer queue: `setTimer` captures callbacks, `pump` runs the ones
 * pending, `size` / `delay` let a test assert the debounce was scheduled with
 * the 200 ms default. Nothing runs until the test pumps it.
 * @returns {object} the timer harness.
 */
function createManualTimers() {
	const pending = new Map();
	let nextId = 1;
	return {
		setTimer(callback, delay) {
			const id = nextId++;
			pending.set(id, { callback, delay });
			return id;
		},
		clearTimer(id) {
			pending.delete(id);
		},
		size() {
			return pending.size;
		},
		delay() {
			const first = pending.values().next();
			return first.done ? null : first.value.delay;
		},
		pump() {
			const entries = [...pending.values()];
			pending.clear();
			for (const entry of entries) entry.callback();
		}
	};
}

/**
 * A fake gutter layer: records every `append(line, topPx)` (both the whole
 * history and the window since the last `clear`), every `translate(px)` and
 * the number of `clear()` calls.
 * @returns {object} the fake layer.
 */
function createFakeGutter() {
	const layer = {
		appends: [],
		visible: [],
		translates: [],
		clears: 0,
		append(line, topPx) {
			const entry = { line, topPx };
			layer.appends.push(entry);
			layer.visible.push(entry);
		},
		clear() {
			layer.clears++;
			layer.visible = [];
		},
		translate(px) {
			layer.translates.push(px);
		}
	};
	return layer;
}

/**
 * Build a controller over the fake measurer and the manual timer queue.
 * @param {object} fake - the fake measurer.
 * @param {object} timers - the manual timer harness.
 * @param {object} [extra] - extra controller deps (e.g. `gutterFactory`).
 * @returns {object} the controller.
 */
function createController(fake, timers, extra = {}) {
	return createWrapController({
		measurer: fake,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		...extra
	});
}

test('estimates answer queries before measurement lands, exact after', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc'); // triggers measureAll
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [1, 1, 1]); // estimates
	fake.finish([[1, 2, 3]]); // onChunk → onDone, full exact
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [1, 2, 3]); // exact replaces
	assert.equal(c.endLandingInputs().contentHeight, 60);
});

test('a small edit re-measures only the changed range', () => {
	const fake = createFakeMeasurer({ rangeRows: (lineText) => (lineText === 'XX' ? 2 : 1) });
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc');
	fake.finish([[2, 1, 3]]);
	assert.equal(fake.state.allCalls, 1);

	// changedLineRange('a\nbb\nccc', 'a\nXX\nccc') === { start: 2, end: 2 }
	c.syncDraft('a\nXX\nccc');
	assert.equal(fake.state.allCalls, 1, 'a narrow edit must not re-measure the whole document');
	assert.equal(fake.state.rangeCalls.length, 1);
	assert.equal(fake.state.rangeCalls[0].from0, 1);
	assert.equal(fake.state.rangeCalls[0].to0Excl, 2);
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [2, 2, 3]);
	assert.equal(c.endLandingInputs().contentHeight, (2 + 2 + 3) * 10);
});

test('a wholesale replacement rebuilds all counts (no stale prefix sums)', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc');
	fake.finish([[2, 1, 3]]);
	assert.equal(fake.state.allCalls, 1);
	assert.equal(c.visibleLines(0, 1000, 0).length, 3);

	c.syncDraft('w\nx\ny\nz'); // completely different, one line longer
	assert.equal(fake.state.allCalls, 2, 'a wholesale replacement re-measures the document');
	// During the estimate window every query answers safely and reflects the new line count.
	assert.deepEqual([c.rowsOf(1), c.rowsOf(3), c.rowsOf(4)], [1, 1, 1]);
	assert.equal(c.visibleLines(0, 1000, 0).length, 4);
	assert.equal(c.endLandingInputs().contentHeight, 40);

	fake.finish([[1, 2, 1, 3]]);
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3), c.rowsOf(4)], [1, 2, 1, 3]);
	assert.equal(c.visibleLines(0, 1000, 0).length, 4);
	assert.equal(c.endLandingInputs().contentHeight, (1 + 2 + 1 + 3) * 10);
});

test('viewport width change estimates now and re-measures after debounce', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('aaaaaaaaaa'); // 10 columns at charsPerRow 10 → one estimated row
	fake.finish([[1]]);
	assert.equal(c.rowsOf(1), 1);

	c.syncViewport(); // width unchanged → no-op
	assert.equal(timers.size(), 0);

	fake.state.width = 40; // charsPerRow 4 → ceil(10 / 4) = 3 estimated rows
	c.syncViewport();
	assert.equal(c.rowsOf(1), 3, 'the estimate follows the new width immediately');
	assert.equal(fake.state.allCalls, 1, 'the full re-measure waits for the debounce');
	assert.equal(timers.size(), 1);
	assert.equal(timers.delay(), 200);
	timers.pump();
	assert.equal(fake.state.allCalls, 2, 'the debounce kicks the full re-measure');
	fake.finish([[3]]);
	assert.equal(c.rowsOf(1), 3);
});

test('visibleLines windows the gutter to the viewport', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc');
	fake.finish([[2, 1, 3]]); // counts = [2, 1, 3], lineHeight 10

	assert.deepEqual(c.visibleLines(20, 10, 0), [
		{ line: 2, contentTop: 20 },
		{ line: 3, contentTop: 30 }
	]);
	assert.ok(c.visibleLines(20, 10, 0).length <= 3, 'never the whole file');
	assert.deepEqual(
		c.visibleLines(20, 10, 1).map((entry) => entry.line),
		[1, 2, 3]
	);
	assert.deepEqual(c.visibleLines(0, 0, 0), [{ line: 1, contentTop: 0 }]);
});

test('syncGutter renders only the visible window into the layer', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const layer = createFakeGutter();
	const c = createController(fake, timers, { gutterFactory: () => layer });
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc');
	fake.finish([[2, 1, 3]]);

	c.syncGutter(20, 10);
	assert.equal(layer.clears, 1);
	assert.equal(layer.visible.length, 2, 'only the visible window is appended');
	assert.deepEqual(layer.visible, [
		{ line: 2, topPx: 0 },
		{ line: 3, topPx: 10 }
	]);
	assert.deepEqual(layer.translates, [-20]);

	// A long document still renders only the viewport window.
	const longText = Array.from({ length: 100 }, (_, index) => `l${index}`).join('\n');
	c.syncDraft(longText);
	fake.finish([new Array(100).fill(1)]);
	c.syncGutter(0, 50);
	assert.equal(layer.visible.length, 6);
	assert.ok(layer.appends.length < 100, 'the layer never receives the whole file');
});

test('dispose makes every method a safe no-op', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const layer = createFakeGutter();
	const c = createController(fake, timers, { gutterFactory: () => layer });
	c.setEnabled(true);
	c.syncDraft('a\nbb');
	assert.equal(fake.state.allCalls, 1);
	fake.state.width = 40;
	c.syncViewport();
	assert.equal(timers.size(), 1, 'a debounce is pending');
	c.dispose();
	assert.equal(timers.size(), 0, 'dispose clears the pending debounce');
	assert.equal(fake.state.cancelCalls, 1, 'dispose cancels the in-flight measurement');
	assert.equal(fake.state.handlers, null);

	c.setEnabled(true);
	c.setEnabled(false);
	c.syncDraft('x\ny');
	c.syncViewport();
	c.syncGutter(0, 100);
	assert.equal(c.rowsOf(1), 1);
	assert.equal(c.visualTop(1), 0);
	assert.equal(c.lineAtVisualOffset(0), 1);
	assert.deepEqual(c.visibleLines(0, 100, 0), []);
	assert.equal(c.endLandingInputs(), null);
	c.dispose();
	assert.equal(fake.state.allCalls, 1, 'dispose must not restart measurement');
});

test('the full measure waits for a ready measurer and a usable width', () => {
	const fake = createFakeMeasurer({ ready: false });
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('a\nbb');
	assert.equal(fake.state.allCalls, 0, 'an unready measurer is never kicked');
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2)], [1, 1]);
	assert.equal(c.endLandingInputs(), null, 'not ready → no landing inputs');

	fake.state.ready = true;
	c.syncDraft('a\nbb'); // same text: this is the readiness re-kick
	assert.equal(fake.state.allCalls, 1, 'the pending full measure retries once ready');

	fake.state.width = 0; // ready alone is not enough: usableWidth must be > 0
	c.syncDraft('a\nbb\nccc');
	assert.equal(fake.state.allCalls, 1, 'a zero usable width is never measured');

	fake.state.width = 100;
	c.syncDraft('a\nbb\nccc');
	assert.equal(fake.state.allCalls, 2, 'the gate reopens once the width returns');
});

test('an exact-prefix chunk replaces only its prefix, the estimated tail survives', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc'); // estimated [1, 1, 1]
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [1, 1, 1]);
	fake.chunk([2]); // exact prefix of length 1
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [2, 1, 1]);
	fake.chunk([2, 1]); // exact prefix of length 2
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [2, 1, 1]);
	fake.done([2, 1, 3]);
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [2, 1, 3]);
});

test('malformed measurement callbacks degrade instead of throwing', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('a\nbb');
	fake.chunk([NaN]); // an unusable row count
	assert.equal(c.rowsOf(1), 1, 'an unusable count degrades to one row');
	assert.ok(Number.isFinite(c.visualTop(1)));
	fake.done('not-an-array'); // unusable completion
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2)], [1, 1]);
	assert.equal(c.endLandingInputs().contentHeight, 20);
	c.syncDraft('a\nbb'); // the next sync retries the failed run
	assert.equal(fake.state.allCalls, 2, 'a failed run is retried on the next sync');
});

test('setEnabled toggles identity answers and is idempotent', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const layer = createFakeGutter();
	const c = createController(fake, timers, { gutterFactory: () => layer });
	c.setEnabled(true);
	c.syncDraft('a\nbb');
	fake.finish([[1, 2]]);
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2)], [1, 2]);

	c.setEnabled(true); // idempotent: the measured layout survives
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2)], [1, 2]);
	assert.equal(fake.state.allCalls, 1);

	c.syncGutter(0, 100);
	const clearsBeforeDisable = layer.clears;
	c.setEnabled(false); // releases the geometry, answers as identity counts = [1]
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2)], [1, 1]);
	assert.ok(c.visibleLines(0, 100, 0).length <= 1);
	assert.equal(c.endLandingInputs(), null);
	assert.equal(layer.clears, clearsBeforeDisable + 1, 'disabling clears the gutter layer');

	c.setEnabled(true);
	c.syncDraft('a\nbb'); // a fresh enable is driven by the next syncDraft
	assert.equal(fake.state.allCalls, 2);
});

test('the line height can come from the controller port instead of the measurer', () => {
	const fake = createFakeMeasurer({ lineHeightPx: NaN });
	const timers = createManualTimers();
	const c = createController(fake, timers, { lineHeightPx: () => 12 });
	c.setEnabled(true);
	c.syncDraft('a');
	fake.finish([[2]]);
	assert.deepEqual(c.endLandingInputs(), { contentHeight: 24, lineHeight: 12 });
	assert.equal(c.visualTop(2), 24);
});
