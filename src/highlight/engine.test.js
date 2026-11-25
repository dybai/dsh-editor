/**
 * Tests for `src/highlight/engine.js` — the highlight engine's session
 * lifecycle, spec §8 guards and the full-re tokenize path (Task 3; Task 4
 * appends the incremental convergence tests to this file).
 *
 * Per spec §9 the tokenizer under test is NEVER mocked: every test drives
 * the real vendored Shiki core (`src/vendor/shiki-core.js`), and lazy-group
 * tests resolve their `loadGroup` gate with the real vendored
 * `lang-script.js` chunk exports (`{ languages }`). Only the transport
 * timing, the clock and the log channel are injected seams.
 *
 * The clock seam is the budget test's lever: a `now` that returns 0 for the
 * pass's first two calls (start + first line check) and 51 for every later
 * call blows the 50ms budget mid-update, then freezes so the retry update
 * re-baselines and tokenizes normally. Degradation is read off the session
 * flags (`degraded` / `degradedNotified`), never off a callback.
 *
 * Shared fixture: one module-level facade, warm for the warmup languages.
 * Tests that care about a lazy group's loaded state build their own facade
 * so the group's registration is theirs alone; everything else (javascript
 * sessions, guards) shares the warm one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreFacade } from '../vendor/shiki-core.js';
import {
	createEngine,
	EMPTY_LINES,
	MAX_FILE_BYTES,
	MAX_FILE_LINES,
	MAX_TOKEN_LINE_LENGTH,
	TOKENIZE_BUDGET_MS,
} from './engine.js';

/* The real vendored core, warm for the warmup languages (javascript,
 * typescript, json). isLanguageLoaded() is false on a cold facade even for
 * warmup languages, so tests that assert "renders empty until loaded" need
 * a cold or group-clean facade of their own. */
const core = createCoreFacade();
await core.ensureReady();

/**
 * A loadGroup that always rejects. Warmup-only engines must never call it,
 * and a wrong call fails the test fast (ready resolves false) instead of
 * hanging on a never-resolving promise.
 */
const failLoadGroup = () => Promise.reject(new Error('unexpected group load'));

/** Records leveled log calls so failure paths can assert the log wiring. */
function createLogRecorder() {
	const entries = [];
	const record = (level) => (scope, ...args) => {
		entries.push({ level, scope, text: args.map(String).join(' ') });
	};
	const log = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
	return { log, entries };
}

/** Engine over the shared warm facade with quiet default seams. */
function createTestEngine(overrides = {}) {
	return createEngine({ core, loadGroup: failLoadGroup, log: createLogRecorder().log, now: () => 0, ...overrides });
}

/** Await one macrotask turn: every pending microtask chain (a cold
 * ensureReady(), an in-flight ready()) settles before the next assert. */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------ constants -- */

test('guard constants match the spec §8 values and EMPTY_LINES is a frozen empty array', () => {
	assert.equal(MAX_TOKEN_LINE_LENGTH, 1000);
	assert.equal(MAX_FILE_BYTES, 1048576);
	assert.equal(MAX_FILE_LINES, 200000);
	assert.equal(TOKENIZE_BUDGET_MS, 50);
	assert.ok(Array.isArray(EMPTY_LINES));
	assert.equal(EMPTY_LINES.length, 0);
	assert.equal(Object.isFrozen(EMPTY_LINES), true);
});

/* ----------------------------------------------------- lifecycle -- */

test('lifecycle: warmup ready, session shape, tokenize and the same-text cache', async () => {
	const engine = createTestEngine();
	assert.equal(await engine.ready('javascript'), true);
	const session = engine.createSession('javascript');
	assert.deepEqual(session, {
		language: 'javascript',
		text: '',
		lines: EMPTY_LINES,
		states: [],
		degraded: false,
		degradedNotified: false,
		idle: false,
	});
	const text = 'const x = 1;\nlet y = 2;';
	const lines = engine.update(session, text);
	assert.equal(lines.length, 2, 'two lines');
	assert.ok(lines[0].length > 0, 'line 0 tokenized');
	assert.ok(lines[1].length > 0, 'line 1 tokenized');
	assert.ok(lines[0][0].color.startsWith('var(--shiki-'), 'css-variables theme colors');
	assert.deepEqual(
		Object.keys(lines[0][0]).sort(),
		['color', 'end', 'fontStyle', 'start'],
		'Token is exactly { start, end, color, fontStyle } — no content field',
	);
	assert.equal(session.text, text, 'session caches the tokenized text');
	assert.equal(session.states.length, 2, 'one grammar state per line');
	const again = engine.update(session, text);
	assert.equal(again, lines, 'unchanged text returns the identical cached array');
	assert.equal(session.lines, lines, 'session.lines IS the returned array');
});

test('ready on a cold core: ensureReady runs and the warmup language tokenizes', async () => {
	const coldCore = createCoreFacade();
	const engine = createEngine({ core: coldCore, loadGroup: failLoadGroup, log: createLogRecorder().log, now: () => 0 });
	assert.equal(coldCore.isLanguageLoaded('javascript'), false, 'no highlighter before ready');
	assert.equal(await engine.ready('javascript'), true);
	assert.equal(coldCore.isLanguageLoaded('javascript'), true);
	const session = engine.createSession('javascript');
	assert.ok(engine.update(session, 'const x = 1;').length > 0, 'tokenizes after ready');
});

test('unknown language: ready resolves false and its session renders EMPTY_LINES', async () => {
	const recorder = createLogRecorder();
	const engine = createEngine({ core, loadGroup: failLoadGroup, log: recorder.log, now: () => 0 });
	assert.equal(await engine.ready('nosuchlang'), false);
	const session = engine.createSession('nosuchlang');
	assert.equal(engine.update(session, 'const x = 1;'), EMPTY_LINES);
	assert.equal(session.idle, false, 'unknown language is not the big-file idle path');
	assert.ok(
		recorder.entries.some((entry) => entry.level === 'warn' && entry.scope === 'highlight'),
		'the miss is logged, never thrown',
	);
});

/* ------------------------------------------------ lazy group loads -- */

test('lazy group in flight: update renders EMPTY_LINES, then tokenizes once the chunk registers', async () => {
	const coldCore = createCoreFacade();
	let gateResolve;
	const gate = new Promise((resolve) => {
		gateResolve = resolve;
	});
	const loadGroupCalls = [];
	const loadGroup = (group) => {
		loadGroupCalls.push(group);
		return gate;
	};
	const engine = createEngine({ core: coldCore, loadGroup, log: createLogRecorder().log, now: () => 0 });
	const session = engine.createSession('python');
	const first = engine.ready('python');
	const second = engine.ready('python');
	assert.equal(first, second, 'concurrent ready calls share the in-flight promise');
	await flushAsync();
	assert.deepEqual(loadGroupCalls, ['script'], 'the group fetch is in flight');
	assert.equal(engine.update(session, 'def f():\n\treturn 1'), EMPTY_LINES, 'group pending — empty, no throw');
	gateResolve(await import('../vendor/lang-script.js'));
	assert.equal(await first, true, 'ready resolves true once the grammars register');
	assert.equal(coldCore.isLanguageLoaded('python'), true);
	const lines = engine.update(session, 'def f():\n\treturn 1');
	assert.equal(lines.length, 2, 'the same text tokenizes after registration — no cache poisoning');
	assert.ok(lines[0].length > 0);
	assert.ok(lines[0][0].color.startsWith('var(--shiki-'), 'python tokens carry theme colors');
});

test('ready: concurrent languages of one in-flight group share a single loadGroup call', async () => {
	const ownCore = createCoreFacade();
	await ownCore.ensureReady();
	const calls = [];
	let gateResolve;
	const gate = new Promise((resolve) => {
		gateResolve = resolve;
	});
	const loadGroup = (group) => {
		calls.push(group);
		return gate;
	};
	const engine = createEngine({ core: ownCore, loadGroup, log: createLogRecorder().log, now: () => 0 });
	const pythonReady = engine.ready('python');
	const rubyReady = engine.ready('ruby');
	await flushAsync();
	assert.equal(calls.length, 1, 'one transport call serves the whole in-flight group');
	gateResolve(await import('../vendor/lang-script.js'));
	assert.equal(await pythonReady, true);
	assert.equal(await rubyReady, true);
	assert.equal(calls.length, 1, 'settling did not trigger a second fetch');
});

test('loadGroup rejection: ready resolves false with a warn and never throws', async () => {
	const recorder = createLogRecorder();
	const attempts = [];
	const loadGroup = (group) => {
		attempts.push(group);
		return Promise.reject(new Error('chunk blocked'));
	};
	const engine = createEngine({ core, loadGroup, log: recorder.log, now: () => 0 });
	assert.equal(await engine.ready('css'), false, 'web group — never loaded on the shared facade');
	assert.equal(core.isLanguageLoaded('css'), false, 'nothing registered');
	assert.equal(await engine.ready('css'), false, 'the engine keeps no negative cache — the chunk loader owns that');
	assert.equal(attempts.length, 2, 'a settled failure is retried on the next ready call');
	assert.ok(
		recorder.entries.some((entry) => entry.level === 'warn' && entry.text.includes('"web"')),
		'the failure is logged, never thrown',
	);
});

/* ---------------------------------------------------- spec guards -- */

test('over-long line: one plain token for that line, neighbors still tokenized', async () => {
	const engine = createTestEngine();
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	const longLine = 'x'.repeat(MAX_TOKEN_LINE_LENGTH + 500);
	const lines = engine.update(session, `const a = 1;\n${longLine}\nconst b = 2;`);
	assert.equal(lines.length, 3);
	assert.ok(lines[0].length > 0, 'the line before still tokenizes');
	assert.equal(lines[1].length, 1, 'the over-long line yields exactly one token');
	assert.equal(lines[1][0].color, '', 'plain color, not a var() reference');
	assert.equal(lines[1][0].start, 0);
	assert.equal(lines[1][0].end, longLine.length, 'the single token spans the whole line');
	assert.ok(lines[2].length > 0, 'the line after still tokenizes');
});

test('big file by UTF-8 bytes: CJK text under the char ceiling idles the session', async () => {
	const engine = createTestEngine();
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	const text = '汉'.repeat(600000); // 600k chars, ~1.8 MB in UTF-8 — over the byte ceiling only
	assert.ok(text.length < MAX_FILE_BYTES, 'precondition: char count is under the ceiling');
	assert.equal(engine.update(session, text), EMPTY_LINES);
	assert.equal(session.idle, true, 'the tab goes idle');
	assert.equal(engine.update(session, 'const x = 1;'), EMPTY_LINES, 'idle is sticky for the session');
});

test('line-count guard: 200_001 lines idle the session', async () => {
	const engine = createTestEngine();
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	const text = `${'x\n'.repeat(MAX_FILE_LINES)}x`;
	assert.equal(engine.update(session, text), EMPTY_LINES);
	assert.equal(session.idle, true, 'the tab goes idle');
});

test('char-count guard and the exact boundary: one char over idles, at-limit does not', async () => {
	const engine = createTestEngine();
	await engine.ready('javascript');
	const over = engine.createSession('javascript');
	assert.equal(engine.update(over, 'a'.repeat(MAX_FILE_BYTES + 1)), EMPTY_LINES, 'one char over the ceiling idles');
	assert.equal(over.idle, true);
	const atLimit = engine.createSession('javascript');
	const lines = engine.update(atLimit, 'a'.repeat(MAX_FILE_BYTES));
	assert.equal(atLimit.idle, false, 'exactly at the ceiling is not over');
	assert.equal(lines.length, 1, 'single line');
	assert.equal(lines[0].length, 1, 'maxLineLength semantics: one plain token for the 1 MiB line');
	assert.equal(lines[0][0].color, '');
});

test('tokenize budget: a mid-update blowout degrades; the retry update tokenizes', async () => {
	let calls = 0;
	const now = () => {
		calls += 1;
		return calls <= 2 ? 0 : 51; // start + first line check at t=0, then +51ms mid-update
	};
	const engine = createTestEngine({ now });
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	const text = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;';
	const blown = engine.update(session, text);
	assert.equal(blown, EMPTY_LINES, 'the partial result is discarded');
	assert.equal(session.degraded, true, 'degradation is signalled on the session');
	assert.equal(session.degradedNotified, false, 'the token layer has not been notified yet');
	assert.equal(session.text, '', 'a blown update commits nothing');
	const retried = engine.update(session, text);
	assert.equal(session.degraded, false, 'flags clear at the top of every update');
	assert.equal(session.degradedNotified, false);
	assert.equal(retried.length, 4, 'the retry tokenizes normally');
	assert.ok(retried[0].length > 0);
});

test('dispose is idempotent and makes update an EMPTY_LINES no-op', async () => {
	const engine = createTestEngine();
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	assert.ok(engine.update(session, 'const x = 1;').length > 0, 'tokenizes before dispose');
	engine.dispose(session);
	engine.dispose(session);
	assert.doesNotThrow(() => {
		assert.equal(engine.update(session, 'x'), EMPTY_LINES, 'disposed session no-ops');
	});
	assert.equal(session.text, '', 'caches dropped');
	assert.equal(session.lines, EMPTY_LINES);
	assert.deepEqual(session.states, []);
});

/* ------------------------------------------------------ line text -- */

test('CRLF text splits on \\n only: \\r stays line content', async () => {
	const engine = createTestEngine();
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	const lines = engine.update(session, 'const x = 1;\r\nlet y = 2;\r');
	assert.equal(lines.length, 2, 'one \\n separator — \\r is not a line break');
	assert.equal(
		Math.max(...lines[0].map((token) => token.end)),
		13,
		'tokens cover the trailing \\r as line content (line length 13)',
	);
	assert.ok(lines[1].length > 0, 'second line tokenized');
});
