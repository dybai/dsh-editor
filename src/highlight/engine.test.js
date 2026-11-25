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

/* ------------------------------------------------ Task 4: incremental --
 * The convergence, non-convergence and property tests pin the incremental
 * tokenize path: a warm session re-tokenizes only from the first differing
 * line and stops at grammar-state convergence. The tokenizer itself stays
 * REAL (the vendored facade); incrementality is measured through a
 * counting wrapper around `tokenizeLine` injected as the engine's `core`
 * dep, so production code carries no instrumentation. */

/**
 * Wrap the real facade with a `tokenizeLine` call counter. The wrapper is
 * the engine's `core` dep for tests that measure how many lines one update
 * re-tokenizes; `reset()` re-arms it around a single update.
 */
function createCountingCore(base) {
	let calls = 0;
	const counting = {
		...base,
		tokenizeLine: (line, options) => {
			calls += 1;
			return base.tokenizeLine(line, options);
		},
	};
	return { core: counting, reset: () => { calls = 0; }, read: () => calls };
}

/** 30-line javascript sample: plain statements, no block-comment text. */
const JS30_LINES = [
	"const title = 'quarterly report';",
	'const rows = 40;',
	'let cache = new Map();',
	'',
	'function format(line, index) {',
	"\tconst prefix = index % 2 === 0 ? 'even' : 'odd';",
	"\treturn prefix + '-' + line.trim();",
	'}',
	'',
	'class Report {',
	'\tconstructor(name) {',
	'\t\tthis.name = name;',
	'\t\tthis.lines = [];',
	'\t}',
	'\tadd(line) {',
	'\t\tif (line.length === 0) return false;',
	'\t\tthis.lines.push(format(line, this.lines.length));',
	'\t\treturn true;',
	'\t}',
	'\tsummary() {',
	"\t\treturn this.name + ': ' + this.lines.length + ' lines';",
	'\t}',
	'}',
	'',
	'const report = new Report(title);',
	'for (let i = 0; i < rows; i += 1) {',
	"\tconst label = 'row' + i;",
	'\treport.add(label);',
	'}',
	'console.log(report.summary());',
];

test('convergence: a one-char edit on line 1 stops early and matches a fresh full tokenize', async () => {
	const counter = createCountingCore(core);
	const engine = createTestEngine({ core: counter.core });
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	const warm = engine.update(session, JS30_LINES.join('\n'));
	assert.equal(warm.length, 30, 'the warm cache has 30 line rows');
	const editedLines = [...JS30_LINES];
	editedLines[1] = 'const rows = 400;'; // one char inserted on line 1
	const editedText = editedLines.join('\n');
	const judge = engine.createSession('javascript');
	const baseline = engine.update(judge, editedText); // fresh session — full tokenize
	counter.reset();
	const result = engine.update(session, editedText);
	assert.deepEqual(result, baseline, 'incremental rows deep-equal the full tokenize of the new text');
	assert.equal(result.length, 30, 'still one row per line');
	assert.ok(counter.read() < 30, `stopped early: ${counter.read()} of 30 lines re-tokenized`);
	assert.equal(result[0], warm[0], 'the untouched prefix row is reused verbatim');
	assert.equal(result[2], warm[2], 'the converged tail rows are copied verbatim');
	assert.equal(session.lines, result, 'session.lines IS the returned array');
	assert.equal(session.states.length, 30, 'one state per line');
	assert.equal(session.text, editedText, 'the session caches the new text');
	const oldJudge = engine.createSession('javascript');
	assert.deepEqual(
		warm,
		engine.update(oldJudge, JS30_LINES.join('\n')),
		'the cached array the tail was copied from stays untouched',
	);
});

test('non-convergence: an unclosed block comment on line 1 spreads and re-tokenizes to the end', async () => {
	const counter = createCountingCore(core);
	const engine = createTestEngine({ core: counter.core });
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	engine.update(session, JS30_LINES.join('\n'));
	const before = session.lines[5].map((token) => ({ ...token }));
	assert.ok(
		new Set(before.map((token) => token.color)).size > 1,
		'line 5 carries several colors before the edit',
	);
	const commented = [JS30_LINES[0], '/*' + JS30_LINES[1], ...JS30_LINES.slice(2)].join('\n');
	counter.reset();
	const result = engine.update(session, commented);
	assert.equal(counter.read(), 29, 'no convergence — lines 1..29 re-tokenized to the end');
	const judge = engine.createSession('javascript');
	assert.deepEqual(result, engine.update(judge, commented), 'the result still equals the full baseline');
	const after = result[5];
	assert.notDeepEqual(after, before, 'the downstream line actually changed');
	assert.ok(
		after.length > 0 && after.every((token) => token.color === 'var(--shiki-token-comment)'),
		'line 5 is swallowed by the comment color',
	);
});

test('two distant edits in one update: convergence never copies rows for changed tail lines', async () => {
	const counter = createCountingCore(core);
	const engine = createTestEngine({ core: counter.core });
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	engine.update(session, JS30_LINES.join('\n'));
	const twiceEdited = [...JS30_LINES];
	twiceEdited[1] = 'const rows = 400;'; // line 1's state re-converges with the cache
	twiceEdited[20] = "\t\treturn this.name + ': ' + this.lines.length + ' lines!';"; // a later line changed too
	const editedText = twiceEdited.join('\n');
	counter.reset();
	const result = engine.update(session, editedText);
	assert.ok(
		counter.read() >= 20,
		`the pass ran through line 20 (${counter.read()} lines) — line 1's convergence must not stop it while line 20 differs`,
	);
	const judge = engine.createSession('javascript');
	assert.deepEqual(
		result,
		engine.update(judge, editedText),
		'the batched two-region edit still equals the full baseline',
	);
});

test('tokenize budget on the incremental path: a mid-pass blowout degrades and commits nothing', async () => {
	let clock = () => 0;
	const engine = createTestEngine({ now: () => clock() });
	await engine.ready('javascript');
	const session = engine.createSession('javascript');
	const text = 'const a = 1;\nconst b = 2;\nconst c = 3;';
	const warm = engine.update(session, text);
	// Re-arm the clock: 0 for the pass start and the first line check, 51
	// from the second re-tokenized line on — the blowout lands mid-increment.
	let calls = 0;
	clock = () => {
		calls += 1;
		return calls <= 2 ? 0 : 51;
	};
	const edited = 'const a = 1;\n/*const b = 2;\nconst c = 3;';
	const blown = engine.update(session, edited);
	assert.equal(blown, EMPTY_LINES, 'the partial incremental result is discarded');
	assert.equal(session.degraded, true, 'degradation is signalled on the session');
	assert.equal(session.degradedNotified, false);
	assert.equal(session.text, text, 'a blown update commits nothing — text stays cached');
	assert.equal(session.lines, warm, 'the warm cache stays cached');
	assert.equal(session.states.length, 3, 'the warm states stay cached');
	clock = () => 0;
	const retried = engine.update(session, edited);
	assert.equal(session.degraded, false, 'flags clear at the top of every update');
	const judge = engine.createSession('javascript');
	assert.deepEqual(retried, engine.update(judge, edited), 'the retry incrementalizes the same edit correctly');
});

/* ------------------------------------------------- property harness -- */

/**
 * mulberry32 — the deterministic PRNG driving the property test
 * (seed 20261125, per the plan).
 */
function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The edit-op alphabet: letters, digits, punctuation and whitespace,
 * newlines included — so the random run splits and joins lines, not just
 * edits within one line.
 */
const OP_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 \t;:=(){}[]<>"\'`+-*/_.,!?\n\r';

/** One random edit: insert or delete 1-8 chars at a random offset. */
function applyRandomOp(text, random) {
	const inserting = random() < 0.5 || text.length === 0;
	if (inserting) {
		const offset = Math.floor(random() * (text.length + 1));
		const length = 1 + Math.floor(random() * 8);
		let inserted = '';
		for (let index = 0; index < length; index += 1) {
			inserted += OP_ALPHABET[Math.floor(random() * OP_ALPHABET.length)];
		}
		return text.slice(0, offset) + inserted + text.slice(offset);
	}
	const offset = Math.floor(random() * text.length);
	const length = Math.min(1 + Math.floor(random() * 8), text.length - offset);
	return text.slice(0, offset) + text.slice(offset + length);
}

/** Corpus snippets — each at least 20 lines, with multi-line constructs
 * (template literals, docstrings, block comments, block scalars) so the
 * grammar state genuinely carries across lines. */
const CORPUS_JAVASCRIPT_LINES = [
	"const project = 'dsh-editor';",
	'const version = 3;',
	'',
	'function banner(name, major) {',
	'\tconst line = "-".repeat(name.length + 4);',
	'\treturn `',
	'${line}',
	'  ${name} v${major}',
	'${line}',
	'`;',
	'}',
	'',
	'class Bundle {',
	'\tconstructor(entry) {',
	'\t\tthis.entry = entry;',
	'\t\tthis.chunks = new Map();',
	'\t}',
	'\tadd(name, size) {',
	'\t\tif (size < 0) throw new Error("negative size: " + size);',
	'\t\tthis.chunks.set(name, size);',
	'\t\treturn this.chunks.size;',
	'\t}',
	'\ttotal() {',
	'\t\tlet sum = 0;',
	'\t\tfor (const size of this.chunks.values()) sum += size;',
	'\t\treturn sum;',
	'\t}',
	'}',
	'export { banner, Bundle, project, version };',
];

const CORPUS_PYTHON_LINES = [
	'import os',
	'import re',
	'',
	'DEFAULTS = {',
	"\t'name': 'editor',",
	"\t'version': '0.16.0',",
	'}',
	'',
	'def load(path):',
	'\t"""Load settings from disk.',
	'',
	'\tBlank lines and comments are skipped.',
	'\t"""',
	'\tif not os.path.exists(path):',
	'\t\treturn dict(DEFAULTS)',
	'\tresult = {}',
	'\twith open(path, encoding="utf-8") as handle:',
	'\t\tfor raw in handle:',
	'\t\t\tline = raw.strip()',
	'\t\t\tif not line or line.startswith("#"):',
	'\t\t\t\tcontinue',
	'\t\t\tkey, sep, value = line.partition("=")',
	'\t\t\tif not sep:',
	'\t\t\t\traise ValueError(f"bad line: {line}")',
	'\t\t\tresult[key.strip()] = value.strip()',
	'\treturn result',
];

const CORPUS_CSS_LINES = [
	':root {',
	'\t--accent: #4a90d9;',
	'\t--muted: #7a7a7a;',
	'\t--panel: #16181d;',
	'}',
	'',
	'.panel {',
	'\tcolor: var(--muted);',
	'\tbackground: var(--panel);',
	'\tborder: 1px solid rgba(255, 255, 255, 0.08);',
	'\tborder-radius: 6px;',
	'\tpadding: 12px 16px;',
	'}',
	'',
	'/* a sheet comment spanning',
	'   two lines */',
	'.panel h2,',
	'.panel h3 {',
	'\tmargin: 0 0 8px;',
	'\tfont-weight: 600;',
	'\tletter-spacing: 0.02em;',
	'}',
	'',
	'@media (max-width: 720px) {',
	'\t.panel { padding: 8px; }',
	'}',
];

const CORPUS_MARKDOWN_LINES = [
	'# dsh-editor release notes',
	'',
	'## 0.16.0',
	'',
	'- code highlight with lazy language chunks',
	'- incremental tokenizer with early stop',
	'- fixed the **wrap ruler** alignment',
	'',
	'> Editing large files now stays smooth:',
	'> the engine re-tokenizes only changed lines.',
	'',
	'1. open a file',
	'2. type anywhere',
	'3. watch the colors converge',
	'',
	'| feature | state |',
	'| --- | --- |',
	'| highlight | done |',
	'| chunks | done |',
	'',
	'A fenced block:',
	'',
	'```js',
	'const x = 1;',
	'```',
];

const CORPUS_YAML_LINES = [
	'name: deploy',
	'version: 3',
	'',
	'steps:',
	'  - name: install',
	'    run: |',
	'      npm ci',
	'      npm run build',
	'  - name: test',
	'    run: npm test',
	'    env:',
	'      CI: "true"',
	'',
	'cache:',
	'  paths:',
	'    - node_modules',
	'    - .cache',
	'',
	'notify:',
	'  slack: "#builds"',
	'  when: on_failure',
	'',
	'retry:',
	'  strategy: exponential',
	'  max_attempts: 3',
];

/** The five plan snippets plus CRLF variants of javascript and yaml. */
const PROPERTY_CORPORA = [
	{ name: 'javascript', language: 'javascript', lines: CORPUS_JAVASCRIPT_LINES, eol: '\n' },
	{ name: 'python', language: 'python', lines: CORPUS_PYTHON_LINES, eol: '\n' },
	{ name: 'css', language: 'css', lines: CORPUS_CSS_LINES, eol: '\n' },
	{ name: 'markdown', language: 'markdown', lines: CORPUS_MARKDOWN_LINES, eol: '\n' },
	{ name: 'yaml', language: 'yaml', lines: CORPUS_YAML_LINES, eol: '\n' },
	{ name: 'javascript-crlf', language: 'javascript', lines: CORPUS_JAVASCRIPT_LINES, eol: '\r\n' },
	{ name: 'yaml-crlf', language: 'yaml', lines: CORPUS_YAML_LINES, eol: '\r\n' },
];

test('property: random edits and IME-like typing — incremental always equals a fresh full tokenize', async (t) => {
	// Own facade + the real vendored chunks as the group transport, so the
	// lazy-group registrations never leak into the shared module core.
	const counter = createCountingCore(createCoreFacade());
	const loadVendoredGroup = (group) => import(`../vendor/lang-${group}.js`);
	const engine = createEngine({
		core: counter.core,
		loadGroup: loadVendoredGroup,
		log: createLogRecorder().log,
		now: () => 0,
	});
	const random = mulberry32(20261125);
	for (const corpus of PROPERTY_CORPORA) {
		assert.ok(corpus.lines.length >= 20, `${corpus.name}: at least 20 lines`);
		assert.equal(await engine.ready(corpus.language), true, `${corpus.name}: language ready`);
		const session = engine.createSession(corpus.language);
		let text = corpus.lines.join(corpus.eol);
		engine.update(session, text); // warm the cache
		counter.reset();
		let incrementalCalls = 0;
		let baselineCalls = 0;
		for (let op = 0; op < 200; op += 1) {
			text = applyRandomOp(text, random);
			const beforeUpdate = counter.read();
			const result = engine.update(session, text);
			const afterUpdate = counter.read();
			const judge = engine.createSession(corpus.language);
			const baseline = engine.update(judge, text);
			incrementalCalls += afterUpdate - beforeUpdate;
			baselineCalls += counter.read() - afterUpdate;
			assert.deepEqual(
				result,
				baseline,
				`${corpus.name} op ${op}: incremental equals a fresh full tokenize`,
			);
		}
		assert.ok(
			incrementalCalls < baselineCalls,
			`${corpus.name}: incremental re-tokenized ${incrementalCalls} lines vs ${baselineCalls} baseline lines`,
		);
		t.diagnostic(`${corpus.name}: ${incrementalCalls} incremental lines vs ${baselineCalls} baseline lines`);
		// IME-composition-like run: rapid single-char insertions at one spot,
		// every intermediate frame judged against a fresh full tokenize.
		const composing = '编辑器增量分词收敛测试';
		let insertAt = Math.floor(text.length / 2);
		for (let frame = 0; frame < composing.length; frame += 1) {
			text = text.slice(0, insertAt) + composing[frame] + text.slice(insertAt);
			insertAt += 1;
			const result = engine.update(session, text);
			const judge = engine.createSession(corpus.language);
			assert.deepEqual(
				result,
				engine.update(judge, text),
				`${corpus.name} IME frame ${frame}: the session stays consistent mid-composition`,
			);
		}
	}
});
