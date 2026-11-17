import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWrapController } from './wrap-controller.js';

/**
 * A programmable fake measurer in the shape `createWrapMeasurer` produces.
 * `state` holds the knobs a test flips (readiness, usable width, char width,
 * line height, the per-line range rule, the prefix-row rule) plus the
 * recorded calls: every `measureRange` range, every `measureAll` document,
 * every `measureTextRows` probe, the captured handlers and the cancel count.
 * `lineHeightPx` is exposed as a read-only property — the controller's
 * optional line-height fallback port.
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
		textRows:
			typeof settings.textRows === 'function'
				? settings.textRows
				: (prefix) => Math.max(0, Math.ceil(String(prefix).length / 10)),
		rangeCalls: [],
		textRowsCalls: [],
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
		measureTextRows(prefix, widthPx) {
			state.textRowsCalls.push({ text: prefix, widthPx });
			return state.textRows(prefix, widthPx);
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

test('onCountsChange fires when a chunk lands during measureAll progress', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	const seen = [];
	let c = null;
	c = createController(fake, timers, {
		onCountsChange: () => {
			// Read through the public API: the notification must arrive AFTER the
			// chunk's counts are committed, so the observer repaints exact rows.
			seen.push([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)]);
		}
	});
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc'); // estimates answer immediately, measureAll streams
	assert.deepEqual(seen, [], 'estimating a draft is not a measurement completion');
	fake.chunk([2]); // exact prefix of length 1
	assert.deepEqual(seen, [[2, 1, 1]], 'the committed prefix is observable when the callback runs');
	fake.chunk([2, 1]); // exact prefix of length 2
	assert.deepEqual(seen, [[2, 1, 1], [2, 1, 1]], 'every landed chunk notifies once');
});

test('onCountsChange fires again when onDone commits the full measurement', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	let calls = 0;
	let lastSeen = null;
	let c = null;
	c = createController(fake, timers, {
		onCountsChange: () => {
			calls++;
			lastSeen = [c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)];
		}
	});
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc');
	fake.chunk([2]);
	assert.equal(calls, 1);
	fake.done([2, 1, 3]); // the measurer reports its last slice through onDone only
	assert.equal(calls, 2, 'the completion notifies even with no trailing chunk');
	assert.deepEqual(lastSeen, [2, 1, 3]);
	assert.equal(c.endLandingInputs().contentHeight, (2 + 1 + 3) * 10);
});

test('a throwing onCountsChange does not break the run', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	let calls = 0;
	const c = createController(fake, timers, {
		onCountsChange: () => {
			calls++;
			throw new Error('paint exploded');
		}
	});
	c.setEnabled(true);
	c.syncDraft('a\nbb\nccc');
	assert.doesNotThrow(() => fake.chunk([2]), 'a broken paint observer must not reach the measurer');
	assert.equal(c.rowsOf(1), 2, 'the chunk still merged');
	assert.doesNotThrow(() => fake.chunk([2, 1]));
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2)], [2, 1], 'later chunks still merge');
	assert.doesNotThrow(() => fake.done([2, 1, 3]));
	assert.deepEqual([c.rowsOf(1), c.rowsOf(2), c.rowsOf(3)], [2, 1, 3], 'the completion still commits');
	assert.equal(calls, 3);
	assert.equal(fake.state.allCalls, 1, 'the measurer run is unaffected');
});

test('onCountsChange stays quiet while disabled or disposed', () => {
	const fake = createFakeMeasurer();
	const timers = createManualTimers();
	let calls = 0;
	const c = createController(fake, timers, { onCountsChange: () => calls++ });
	c.setEnabled(true);
	c.syncDraft('a\nbb');
	fake.finish([[2, 1]]);
	assert.equal(calls, 2, 'positive control: a live enabled run announces');

	c.syncDraft('x\ny'); // a fresh run captures a new handler pair
	const live = fake.state.handlers;
	c.setEnabled(false); // invalidates the run; a late callback must be ignored
	live.onChunk([3], 1);
	live.onDone([3, 1]);
	assert.equal(calls, 2, 'counts delivered to a disabled controller are never announced');

	c.setEnabled(true);
	c.syncDraft('p\nq');
	const second = fake.state.handlers;
	c.dispose();
	second.onChunk([4], 1);
	second.onDone([4, 1]);
	assert.equal(calls, 2, 'a disposed controller never announces');
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
test("caretVisualRowIndex answers the caret's visual row inside a wrapped line", () => {
	const fake = createFakeMeasurer({
		rangeRows: (lineText) => (lineText === 'abcdefgh' ? 4 : 1),
		textRows: (prefix) => {
			if (prefix === '') return 0;
			if (prefix === 'ab') return 2;
			return 99;
		}
	});
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('zero\nabcdefgh\nlast');
	fake.finish([[1, 4, 1]]);
	assert.equal(c.rowsOf(2), 4);
	assert.equal(c.caretVisualRowIndex(5), 1, 'an empty prefix is row 0 of the line, i.e. rowsBefore(2)');
	assert.deepEqual(fake.state.textRowsCalls[0], { text: '', widthPx: 100 });
	assert.equal(c.caretVisualRowIndex(7), 2, 'a two-row prefix puts the caret on the line\'s second visual row');
	assert.deepEqual(fake.state.textRowsCalls[1], { text: 'ab', widthPx: 100 });
	assert.equal(c.caretVisualRowIndex(13), 4, 'a prefix is clamped to rowsOf(line) − 1');
	assert.equal(c.caretVisualRowIndex(-5), 0, 'an out-of-range offset clamps to the document start');
	assert.equal(c.caretVisualRowIndex(Number.NaN), 0, 'a non-finite offset clamps to the document start');
});
test('a caret on a wrap boundary lands on the previous visual row', () => {
	const fake = createFakeMeasurer({
		rangeRows: (lineText) => (lineText === 'abcdefgh' ? 5 : 1),
		textRows: (prefix) => (prefix === 'abcdefgh' ? 4 : 1)
	});
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('zero\nabcdefgh\nlast');
	fake.finish([[1, 5, 1]]);
	assert.equal(c.rowsOf(2), 5);
	// Offset 13 is the newline that terminates line 2: the caret belongs to
	// line 2, and its full-line prefix measures the line's LAST visual row
	// (N = 4) rather than a sixth row past it.
	assert.equal(c.caretVisualRowIndex(13), 4, 'rowsBefore(2) + N − 1');
	assert.deepEqual(fake.state.textRowsCalls, [{ text: 'abcdefgh', widthPx: 100 }]);
	assert.equal(c.visualTop(2), 10);
});
test('not-ready or missing text falls back to the line start', () => {
	const fake = createFakeMeasurer({ rangeRows: (lineText) => (lineText === 'abcdefgh' ? 4 : 1) });
	const timers = createManualTimers();
	const c = createController(fake, timers);
	assert.equal(c.caretVisualRowIndex(7), 0, 'a disabled controller has no synced text');
	c.setEnabled(true);
	assert.equal(c.caretVisualRowIndex(7), 0, 'enabled without a draft still has no text to locate');
	c.syncDraft('zero\nabcdefgh\nlast');
	fake.finish([[1, 4, 1]]);
	assert.equal(c.rowsOf(2), 4, 'positive control: the line really is wrapped');
	fake.state.ready = false;
	assert.equal(c.caretVisualRowIndex(7), 1, 'an unready measurer falls back to the line start row');
	assert.equal(fake.state.textRowsCalls.length, 0, 'not-ready never measures a prefix');
	assert.equal(c.caretVisualRowIndex(13), 1, 'the wrap-boundary fallback is the same line start row');
});
test('a throwing measurement falls back and never throws', () => {
	const fake = createFakeMeasurer({
		rangeRows: (lineText) => (lineText === 'abcdefgh' ? 4 : 1),
		textRows: () => {
			throw new Error('mirror exploded');
		}
	});
	const timers = createManualTimers();
	const c = createController(fake, timers);
	c.setEnabled(true);
	c.syncDraft('zero\nabcdefgh\nlast');
	fake.finish([[1, 4, 1]]);
	assert.equal(c.rowsOf(2), 4);
	let answer = -1;
	assert.doesNotThrow(() => {
		answer = c.caretVisualRowIndex(7);
	});
	assert.equal(answer, 1, 'the fallback is the row above the wrapped line start');
	assert.equal(fake.state.textRowsCalls.length, 1, 'the measurement was attempted once');
});
