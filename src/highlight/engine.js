/**
 * Highlight engine — one tokenize session per tab over the vendored Shiki
 * core: session lifecycle, spec §8 guards and the tokenize passes (Task 3's
 * full-re pass plus Task 4's line-state incremental pass with the
 * convergence stop inside `update`'s tokenize block).
 *
 * The engine is the pure-logic heart of the code-highlight mode: it owns
 * the per-tab token and grammar-state caches and never touches React or
 * the chunk transport. Everything with a side effect is injected —
 * `core` (the Task 1 facade), `loadGroup` (the Task 4 chunk loader), `log`
 * (the persistent log channel) and `now` (the clock) — so `node --test`
 * drives the REAL vendored facade with a fake clock and the entry wires
 * the real transport.
 *
 * Degradation discipline (spec §8): every failure resolves to plain
 * rendering, never a throw. Guards idle the session ON the session object
 * (`idle`); a tokenize-budget blowout signals on the session too —
 * `degraded = true` and `degradedNotified = false` — and the engine stays
 * callback-free: the token layer reads the flags, schedules its one rAF
 * retry and marks `degradedNotified` itself; both flags clear again at the
 * top of every `update`. The engine only ever writes `degradedNotified`
 * back to false.
 *
 * Single import: `groupOfLanguage` from the language table — sessions take
 * language ids directly and never consult the path table.
 *
 * @module @dybai/dsh-editor/highlight/engine
 */

import { groupOfLanguage } from './languages.js';

/** Longest line the tokenizer scans; longer lines render plain (spec §8). */
export const MAX_TOKEN_LINE_LENGTH = 1000;

/** Hard big-file ceiling in bytes — over this the session idles (plain for its lifetime). */
export const MAX_FILE_BYTES = 8388608;

/**
 * The sync ceiling in bytes — files at or under it tokenize synchronously in
 * one update (instant color); files over it enter the progressive mode:
 * plain first, background frames grow the coverage until the file completes.
 */
export const MAX_SYNC_FILE_BYTES = 262144;

/** Big-file ceiling in lines. */
export const MAX_FILE_LINES = 200000;

/**
 * Wall-clock budget. Synchronous sessions: a blowout degrades the session
 * (spec §8's budget guard). Progressive frames: the same budget just ends
 * the frame — progress is resumable by design, never degraded.
 */
export const TOKENIZE_BUDGET_MS = 50;

/** The shared "render nothing" result — returned on every degraded path. */
export const EMPTY_LINES = Object.freeze([]);

/** UTF-8 measurement for the big-file guard: text.length under-counts CJK. */
const utf8 = new TextEncoder();

/**
 * Create the highlight engine.
 *
 * @param {object} deps - injected collaborators, all engine-external:
 * - `core`: the Task 1 facade (`createCoreFacade()`). The engine never
 *   imports the facade itself — the mode layer creates it and tests
 *   inject the real one.
 * - `loadGroup(group: string): Promise<{ languages: Record<string, object> }>`:
 *   fetches a lazy language group's chunk and resolves to the chunk's
 *   exports object — exactly the shape `createChunkLoader` (Task 4)
 *   returns from `require.async` and the vendored `src/vendor/lang-<group>.js`
 *   modules export. The engine registers every grammar of the `languages`
 *   record through `core.loadLanguageSync`.
 * - `log`: the leveled log channel (`log.warn(scope, text)` /
 *   `log.error(scope, text)`, scope `'highlight'`); a missing or
 *   method-less log degrades to silence rather than throwing.
 * - `now`: the clock (defaults to `Date.now`) — the tokenize budget seam.
 * - `scheduleFrame(fn: () => void)`: the background-frame scheduler for
 *   progressive sessions (the entry wires `requestAnimationFrame`; tests
 *   capture the callbacks). Defaults to a no-op — a progressive session
 *   without a scheduler still advances, one batch per update call.
 * - `onProgress(session)`: called after every progressive advance (entry
 *   batch and every background frame) so the token layer can repaint the
 *   grown coverage. Defaults to a no-op.
 * @returns {{ ready: (language: string) => Promise<boolean>,
 *   createSession: (language: string) => object,
 *   update: (session: object, text: string) => Array,
 *   dispose: (session: object) => void }} the engine.
 */
export function createEngine({ core, loadGroup, log, now = Date.now, scheduleFrame, onProgress }) {
	const advanceFrame = typeof scheduleFrame === 'function' ? scheduleFrame : () => {};
	const notifyProgress = typeof onProgress === 'function' ? onProgress : () => {};
	const logSource = log === null || log === undefined ? {} : log;
	const logWarn = typeof logSource.warn === 'function' ? logSource.warn.bind(logSource) : () => {};
	const logError = typeof logSource.error === 'function' ? logSource.error.bind(logSource) : () => {};

	/** In-flight group registrations: one loadGroup call serves the whole group. */
	const groupLoads = new Map();
	/** In-flight ready() promises: concurrent callers get the identical promise. */
	const readyInFlight = new Map();
	/** Sessions dropped by dispose(). */
	const disposedSessions = new WeakSet();

	/**
	 * Make a language tokenizable. Never rejects: unknown languages,
	 * a failed core init and a failed group load all resolve `false`
	 * (logged, spec §8's degradation chain) — warmup languages only
	 * ensure the core; lazy groups fetch their chunk and register every
	 * grammar it exports. Concurrent callers for one language share the
	 * same in-flight promise; concurrent languages of one group share
	 * one group fetch.
	 * @param {string} language - the session language id (table row key).
	 * @returns {Promise<boolean>} true when the language is loaded.
	 */
	function ready(language) {
		const inFlight = readyInFlight.get(language);
		if (inFlight !== undefined) return inFlight;
		const promise = resolveReady(language);
		readyInFlight.set(language, promise);
		const forget = () => readyInFlight.delete(language);
		promise.then(forget, forget);
		return promise;
	}

	/** The ready() body — see ready(). Resolves false on every failure. */
	async function resolveReady(language) {
		if (core.isLanguageLoaded(language)) return true;
		const group = groupOfLanguage(language);
		if (group === undefined) {
			logWarn('highlight', `unknown language "${language}" — plain rendering`);
			return false;
		}
		try {
			await core.ensureReady();
		} catch (error) {
			logError('highlight', `core init failed — plain rendering (${messageOf(error)})`);
			return false;
		}
		if (group !== 'warmup') {
			try {
				await loadGroupIntoCore(group);
			} catch (error) {
				logWarn('highlight', `language group "${group}" failed to load — plain rendering (${messageOf(error)})`);
				return false;
			}
		}
		return core.isLanguageLoaded(language);
	}

	/**
	 * Register one lazy group's grammars into the core, deduping the
	 * transport: concurrent callers (any language of the group) share a
	 * single in-flight loadGroup promise. The entry is forgotten once it
	 * settles — success is cached by the core's loaded-language set, and
	 * failures retry on the next ready() (negative caching belongs to the
	 * chunk loader, not the engine).
	 */
	function loadGroupIntoCore(group) {
		let pending = groupLoads.get(group);
		if (pending !== undefined) return pending;
		pending = registerGroup(group);
		groupLoads.set(group, pending);
		const forget = () => groupLoads.delete(group);
		pending.then(forget, forget);
		return pending;
	}

	/** Fetch the group chunk and load every grammar its languages record carries. */
	async function registerGroup(group) {
		const chunkExports = await loadGroup(group);
		const languages = chunkExports === null || chunkExports === undefined ? undefined : chunkExports.languages;
		if (languages === null || typeof languages !== 'object') {
			throw new Error(`chunk for group "${group}" exports no languages record`);
		}
		for (const grammar of Object.values(languages)) core.loadLanguageSync(grammar);
	}

	/**
	 * Create one tab's tokenize session. `lines`/`states` are the
	 * line-indexed caches (per-line token rows and per-line end-of-line
	 * grammar states); `degraded`/`degradedNotified` are the budget
	 * signal the token layer reads; `idle` marks a session parked by the
	 * big-file guards.
	 * @param {string} language - the language id the tab tokenizes as.
	 * @returns {object} the fresh session.
	 */
	function createSession(language) {
		return {
			language,
			text: '',
			lines: EMPTY_LINES,
			states: [],
			degraded: false,
			degradedNotified: false,
			idle: false,
			progressive: false,
			progressLine: 0,
			progressDone: true,
			framePending: false,
		};
	}

	/**
	 * Tokenize `text` into the session's line-indexed token rows and
	 * return them (`session.lines`). Synchronous and idempotent for
	 * unchanged text (cache hit returns the identical array); changed text
	 * re-tokenizes incrementally from the first differing line and stops
	 * early where the grammar state converges with the cache.
	 *
	 * Order: degradation flags clear first (every update is a fresh
	 * attempt); a disposed or idle session is a plain no-op; the big-file
	 * guards run BEFORE any tokenization — char count, then UTF-8 byte
	 * count (a CJK file can sit under the char ceiling yet over the byte
	 * one), then line count — and a trip parks the session idle for its
	 * lifetime; a session whose language is not loaded yet renders empty
	 * WITHOUT touching the caches (a later update after the group
	 * registers tokenizes the same text); then the incremental tokenize
	 * pass, falling back to the full-re pass whenever no usable cached
	 * state exists.
	 *
	 * @param {object} session - a session from createSession.
	 * @param {string} text - the tab's whole current text.
	 * @returns {Array} the line-indexed token rows, or EMPTY_LINES on any
	 *   degraded path.
	 */
	function update(session, text) {
		// Degradation flags clear at the top of every update: each call
		// starts a fresh tokenize attempt, and the token layer's one-shot
		// retry repaint re-arms on the next blowout.
		session.degraded = false;
		session.degradedNotified = false;
		if (disposedSessions.has(session)) return EMPTY_LINES;
		if (session.idle) return EMPTY_LINES;
		if (session.text === text) return session.lines;

		// Big-file guards (spec §8): over the hard ceiling the tab renders
		// plain for good. Char count first — the cheap test that also spares
		// the byte measurement on oversized ASCII — then the UTF-8 byte count
		// (a CJK file can sit under the char ceiling yet over the byte one),
		// then the line count.
		if (text.length > MAX_FILE_BYTES) {
			markIdle(session, text);
			return EMPTY_LINES;
		}
		const bytes = utf8.encode(text).length;
		if (bytes > MAX_FILE_BYTES) {
			markIdle(session, text);
			return EMPTY_LINES;
		}
		const lines = text.split('\n'); // '\r' stays as line content
		if (lines.length > MAX_FILE_LINES) {
			markIdle(session, text);
			return EMPTY_LINES;
		}
		if (!core.isLanguageLoaded(session.language)) return EMPTY_LINES;
		// An in-flight progressive session continues over this text (an edit
		// truncates to the first differing line, coverage keeps growing).
		if (session.progressive && !session.progressDone) return tokenizeProgressive(session, text, lines);
		// Files over the sync ceiling enter the progressive mode: plain ink
		// first, background frames grow the coverage to the whole file.
		if (bytes > MAX_SYNC_FILE_BYTES) return enterProgressive(session, text, lines);
		return tokenizeUpdate(session, text, lines);
	}

	/**
	 * Route a guarded update to the incremental pass or the full-re pass.
	 * The incremental pass needs a usable cache: the line-indexed caches
	 * must match the cached text (true after every committed tokenize; the
	 * pristine session fails the check), and the first differing line L
	 * must have a cached grammar state to carry — L > 0, since an edit that
	 * reaches the first line restarts from the root state and the full-re
	 * pass already covers that. Everything else re-tokenizes from L with
	 * the running state.
	 */
	function tokenizeUpdate(session, text, lines) {
		const oldLines = session.text.split('\n');
		if (session.lines.length !== oldLines.length || session.states.length !== oldLines.length) {
			return tokenizeAll(session, text, lines);
		}
		const shared = Math.min(oldLines.length, lines.length);
		let firstDiff = 0;
		while (firstDiff < shared && oldLines[firstDiff] === lines[firstDiff]) firstDiff += 1;
		const stateBefore = firstDiff > 0 ? session.states[firstDiff - 1] : undefined;
		if (stateBefore === undefined) return tokenizeAll(session, text, lines);
		return tokenizeChanged(session, text, lines, oldLines, firstDiff);
	}

	/**
	 * The incremental pass — re-tokenize lines firstDiff.. carrying the
	 * cached grammar state of line firstDiff-1, with the convergence stop.
	 *
	 * Convergence: after tokenizing line i, the running state may equal the
	 * cached state at the SAME index (the grammar re-converged, e.g. a
	 * rename inside one statement). Every later line then tokenizes exactly
	 * as it did before, so the cached rows beyond i are still the correct
	 * rows — they are copied verbatim (line-indexed caches, no offset
	 * remapping) and the pass stops. The stop is only SOUND when the new
	 * tail equals the cached tail at the same indices: same line count and
	 * a common line suffix covering everything after i. Line-count-changing
	 * edits (a line split or join) shift the tail, so they skip the
	 * convergence stop and re-tokenize to the end.
	 *
	 * The copied tail is shared read-only — the fresh outer arrays are the
	 * only structures the pass ever writes, so the caches it copies from
	 * are never mutated. The budget is checked every line like the full-re
	 * pass; a blowout discards the partial result, signals on the session
	 * and returns EMPTY_LINES.
	 */
	function tokenizeChanged(session, text, lines, oldLines, firstDiff) {
		const startedAt = now();
		const tokenLines = [];
		const states = [];
		let grammarState = session.states[firstDiff - 1];
		const sameLineCount = oldLines.length === lines.length;
		let suffix = 0;
		if (sameLineCount) {
			while (
				suffix < lines.length - firstDiff &&
				oldLines[lines.length - 1 - suffix] === lines[lines.length - 1 - suffix]
			) {
				suffix += 1;
			}
		}
		// The earliest index whose convergence permits the verbatim tail
		// copy: every line after it must sit inside the common suffix.
		const stopFloor = sameLineCount ? lines.length - suffix : Infinity;
		let convergedAt = -1;
		for (let index = firstDiff; index < lines.length; index += 1) {
			if (now() - startedAt > TOKENIZE_BUDGET_MS) {
				session.degraded = true;
				session.degradedNotified = false;
				return EMPTY_LINES;
			}
			const { tokens, grammarState: nextState } = core.tokenizeLine(lines[index], {
				lang: session.language,
				grammarState,
				maxLineLength: MAX_TOKEN_LINE_LENGTH,
			});
			grammarState = nextState;
			states.push(grammarState);
			tokenLines.push(tokens.map(toToken));
			if (index + 1 >= stopFloor && core.statesEqual(grammarState, session.states[index])) {
				convergedAt = index;
				break;
			}
		}
		// With no convergence the pass owns every line from firstDiff on, so
		// the tail copy is empty (oldLines.length sits past the old cache);
		// with convergence the cached rows past convergedAt are the tail.
		const tailFrom = convergedAt === -1 ? oldLines.length : convergedAt + 1;
		session.text = text;
		session.lines = session.lines.slice(0, firstDiff).concat(tokenLines, session.lines.slice(tailFrom));
		session.states = session.states.slice(0, firstDiff).concat(states, session.states.slice(tailFrom));
		return session.lines;
	}

	/**
	 * The full-re tokenize pass — one cohesive per-line loop, the fallback
	 * whenever no usable cached state exists (a cold session, an edit that
	 * reaches the first line, a cache that does not match the cached text).
	 *
	 * The budget is checked every line; a blowout discards the partial
	 * result, signals on the session and returns EMPTY_LINES.
	 */
	function tokenizeAll(session, text, lines) {
		const startedAt = now();
		const tokenLines = [];
		const states = [];
		let grammarState;
		for (const line of lines) {
			if (now() - startedAt > TOKENIZE_BUDGET_MS) {
				session.degraded = true;
				session.degradedNotified = false;
				return EMPTY_LINES;
			}
			const { tokens, grammarState: nextState } = core.tokenizeLine(line, {
				lang: session.language,
				grammarState,
				maxLineLength: MAX_TOKEN_LINE_LENGTH,
			});
			grammarState = nextState;
			states.push(grammarState);
			tokenLines.push(tokens.map(toToken));
		}
		session.text = text;
		session.lines = tokenLines;
		session.states = states;
		return tokenLines;
	}

	/** Park a session idle: the tab renders plain for its lifetime. */
	function markIdle(session, text) {
		session.idle = true;
		session.text = text;
		session.lines = EMPTY_LINES;
		session.states = [];
		session.progressive = false;
		session.progressDone = true;
		session.progressLine = 0;
		session.framePending = false;
	}

	/**
	 * Enter the progressive mode: caches reset, coverage grows from line 0
	 * over background frames. The first batch advances immediately (so a
	 * paint-driven update still makes progress), the rest is scheduled.
	 */
	function enterProgressive(session, text, lines) {
		session.progressive = true;
		session.progressDone = false;
		session.progressLine = 0;
		session.text = text;
		session.lines = [];
		session.states = [];
		return tokenizeProgressive(session, text, lines);
	}

	/**
	 * One progressive batch: re-split/truncate on a changed text (an edit
	 * mid-progress truncates the cache to the first differing line — bounded
	 * by the covered prefix — and resumes from the carried grammar state),
	 * then tokenize lines under the per-frame budget, ALWAYS advancing at
	 * least one line so the pass terminates. Frames never degrade: a budget
	 * blowout is a resumable pause. Completion flips the session back to the
	 * plain incremental path (full cache → convergence applies again).
	 */
	function tokenizeProgressive(session, text, lines) {
		if (session.text !== text) {
			const oldLines = session.text.split('\n');
			const shared = Math.min(oldLines.length, lines.length);
			let firstDiff = 0;
			while (firstDiff < shared && oldLines[firstDiff] === lines[firstDiff]) firstDiff += 1;
			const keep = Math.min(firstDiff, session.lines.length);
			session.lines = session.lines.slice(0, keep);
			session.states = session.states.slice(0, keep);
			session.progressLine = keep;
			session.text = text;
		}
		if (session.progressLine >= lines.length) {
			session.progressive = false;
			session.progressDone = true;
			session.framePending = false;
			notifyProgress(session);
			return session.lines;
		}
		const startedAt = now();
		while (session.progressLine < lines.length) {
			const index = session.progressLine;
			const { tokens, grammarState: nextState } = core.tokenizeLine(lines[index], {
				lang: session.language,
				grammarState: index > 0 ? session.states[index - 1] : undefined,
				maxLineLength: MAX_TOKEN_LINE_LENGTH,
			});
			session.states.push(nextState);
			session.lines.push(tokens.map(toToken));
			session.progressLine = index + 1;
			if (now() - startedAt > TOKENIZE_BUDGET_MS) break;
		}
		if (session.progressLine >= lines.length) {
			session.progressive = false;
			session.progressDone = true;
			session.framePending = false;
		} else {
			scheduleProgressFrame(session);
		}
		notifyProgress(session);
		return session.lines;
	}

	/**
	 * Schedule one background advance for a progressing session. The
	 * pending-frame gate keeps a single in-flight callback per session; the
	 * callback re-reads the session state at fire time — a disposed or
	 * completed session simply returns.
	 */
	function scheduleProgressFrame(session) {
		if (session.framePending) return;
		session.framePending = true;
		advanceFrame(() => {
			session.framePending = false;
			if (disposedSessions.has(session)) return;
			if (session.progressDone || session.idle) return;
			tokenizeProgressive(session, session.text, session.text.split('\n'));
		});
	}

	/**
	 * Drop a session's caches. update() on a disposed session is a no-op
	 * returning EMPTY_LINES; dispose is idempotent.
	 * @param {object} session - a session from createSession.
	 */
	function dispose(session) {
		if (session === null || typeof session !== 'object') return;
		disposedSessions.add(session);
		session.text = '';
		session.lines = EMPTY_LINES;
		session.states = [];
		session.degraded = false;
		session.degradedNotified = false;
		session.idle = false;
		session.progressive = false;
		session.progressDone = true;
		session.progressLine = 0;
		session.framePending = false;
	}

	return { ready, createSession, update, dispose };
}

/** Project a facade token onto the engine's Token shape (content dropped — offsets, color and fontStyle only). */
function toToken(token) {
	return { start: token.start, end: token.end, color: token.color, fontStyle: token.fontStyle };
}

/** Error text for log lines — never throws on a non-Error rejection value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
