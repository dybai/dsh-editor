/**
 * Task 9 guard tests — the CM6 mode component's source-level contract.
 *
 * component.js requires React (the bundler resolves `require('react')` in
 * factory scope, exactly like components.js / mode-code-highlight.js), so
 * it is NOT importable under node:test — the established discipline for
 * React-requiring modules: every assertion reads the component's source
 * text and pins the markers whose absence would silently degrade (not
 * crash): the async chunk gate, the pending loading shape, the engine
 * session lifecycle, the mode obligations, the machine-mirror echo
 * suppression, the plain-text degradation chain, and the StrictMode
 * re-arm.
 *
 * Guarded groups (task-9 brief Step 1):
 * - the degradation path's FULL mode-prop forwarding (named, one by one,
 *   matchHighlight/initialScroll/onScrollChange included)
 * - the async gate: loadCm6() on mount, the isBlocked short-circuit, the
 *   pending render's loading shape, the module-level factory cache
 * - the session lifecycle: languageOf(path) → engine.ready → createSession
 *   → update; a path change disposes the old session and re-readies
 * - the obligations: the SINGLE applyEdit call site (Review Focus 3), the
 *   reportSelection convention, the onNavigate claim, initialScroll once,
 *   scroll → onScrollChange, focus on first ready
 * - the machine mirrors under the mirroring flag (echo suppression — the
 *   genuine behavior change CM6 brings over the DOM seam)
 * - unmount: view destroy + engine dispose, no reports on the teardown path
 * - degradation: isBlocked / load rejection / assembly throw → log.warn
 *   once + PlainTextMode, never retried for this component
 * - StrictMode double-mount: cleanup → re-arm (create/destroy/create)
 * - the ten-member deps seam (R9), the activeLineRanges derivation, the
 *   indent 'auto' pre-resolution, the progressive repaint dispatch, the
 *   thin-component import discipline and the §5.5 red lines
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offsetOfLine } from '../lines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENT_PATH = path.join(HERE, 'component.js');

/** The component's source — read lazily so each guard reports its own RED until component.js exists. */
function componentText() {
	return readFileSync(COMPONENT_PATH, 'utf8');
}

/* -------------------------------------------- factory + degrade forwarding -- */

test('createCodeMirrorMode({ cm6Loader, engine, PlainTextMode, subscribeProgress, log }) returns the CodeMirrorMode component', () => {
	const text = componentText();
	assert.ok(
		text.includes('export function createCodeMirrorMode({ cm6Loader, engine, PlainTextMode, subscribeProgress, log })'),
		'the factory signature matches the Task 10 assembly seam'
	);
	assert.ok(
		text.includes('return function CodeMirrorMode(props) {'),
		'the factory returns the CodeMirrorMode component'
	);
	assert.ok(
		text.includes("const React = require('react')"),
		'React arrives through the bundler-resolved require (the components.js pattern)'
	);
	assert.ok(text.includes('const h = React.createElement'), 'createElement is aliased to h — no JSX');
});

test('the degradation path forwards the FULL mode-prop set to PlainTextMode (named, one by one)', () => {
	const text = componentText();
	// The degrade render must hand PlainTextMode every mode prop the
	// framework supplied — a plain-text editor with every preference
	// honored (the same shape the absent-engine degradation of the DOM seam
	// renders). Each prop is named — a dropped prop fails here first.
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
		assert.ok(text.includes(marker), `the degrade render forwards ${marker.split(':')[0]} to PlainTextMode`);
	}
	assert.ok(text.includes('h(PlainTextMode, {'), 'the degraded render mounts PlainTextMode');
});

/* ----------------------------------------------------------- async gate -- */

test('the async gate: mount drives cm6Loader.loadCm6(); a blocked loader degrades before any transport call; pending keeps the loading shape', () => {
	const text = componentText();
	assert.ok(
		text.includes('cm6Loader.loadCm6()'),
		'the mount effect drives the loader (concurrent mounts share its in-flight dedupe)'
	);
	assert.ok(
		text.includes('cm6Loader.isBlocked()'),
		'a blocked loader short-circuits to degradation before the transport is touched'
	);
	// The pending render reuses the loading visual family (components.js's
	// loading body) so the async gate reads as an ordinary load.
	assert.ok(text.includes('className: `${CLASS}-center`'), 'the pending render reuses the -center body shape');
	assert.ok(text.includes('className: `${CLASS}-center-stack`'), 'the loading stack shape is reused');
	assert.ok(text.includes('className: `${CLASS}-spinner`'), 'the pending spinner is reused');
	assert.ok(text.includes("t('state.loading')"), 'the pending label rides the translation channel');
});

test('the resolved view factory is minted ONCE per activation at MODULE level', () => {
	const text = componentText();
	assert.ok(text.includes('let cm6Factory = null'), 'the activation-level cache is a module-scope binding');
	const mints = (text.match(/createCm6ViewFactory\(/g) || []).length;
	assert.equal(mints, 1, `createCm6ViewFactory is called exactly once — the mint site (found ${mints})`);
	assert.ok(
		text.includes('createCm6ViewFactory(chunkExports.cm6)'),
		'the mint consumes the cm6 record the loader resolved from the chunk'
	);
	assert.ok(
		text.includes('cm6Factory({ plan, deps, docText, host })'),
		'every view is created through the Task 8 seam signature'
	);
});

/* ---------------------------------------------------- session lifecycle -- */

test('the session lifecycle: languageOf(path) → engine.ready → createSession → update; a path change disposes and re-readies', () => {
	const text = componentText();
	assert.ok(
		text.includes('languageOf(pathRef.current)'),
		'the path resolves through the language table (the live pathRef read, the mode-code-highlight pattern)'
	);
	assert.ok(text.includes('engine.ready(lang)'), 'the language is readied before the session exists');
	assert.ok(text.includes('engine.createSession(lang)'), 'the tab session is created per language');
	assert.ok(text.includes('engine.update(session, text)'), 'every doc change feeds the session through the engine');
	assert.ok(text.includes('engine.dispose(session)'), 'the session effect hands the session back to the engine');
	assert.ok(
		text.includes('props.path, engine'),
		'the session lifecycle re-runs on a path change (the effect keys on props.path)'
	);
	// The dispose sits in the effect CLEANUP: the old session drops before
	// the next effect run readies the new language, never after it.
	const disposeAt = text.indexOf('engine.dispose(session)');
	const effectStart = text.lastIndexOf('React.useEffect(', disposeAt);
	const effectBody = text.slice(effectStart, disposeAt);
	assert.ok(
		!effectBody.includes('engine.dispose('),
		'dispose lives in the cleanup — the old session drops before the new language is readied'
	);
});

/* --------------------------------------------------------- obligations -- */

test('obligations: the SINGLE applyEdit call site is the updateListener forwarding (Review Focus 3)', () => {
	const text = componentText();
	const applyEditCalls = (text.match(/\.applyEdit\(/g) || []).length;
	assert.equal(
		applyEditCalls,
		1,
		`applyEdit is called exactly ONCE — the view updateListener\'s forwarding (found ${applyEditCalls})`
	);
	// No composition/keydown reporting path: the component owns no textarea,
	// edits are reported by the view's updateListener alone (IME included).
	for (const banned of ['onKeyDown', 'onKeyUp', 'onSelect:', 'onChange:', 'execCommand', 'stopPropagation']) {
		assert.ok(!text.includes(banned), `no ${banned} reporting path — the view\'s listener is the only edit channel`);
	}
});

test('the selection report mirrors PlainTextMode\'s reportSelection convention', () => {
	const text = componentText();
	const payloadAt = text.indexOf('applySelection({');
	assert.ok(payloadAt !== -1, 'the selection report calls controller.applySelection');
	const payload = text.slice(payloadAt, text.indexOf('});', payloadAt));
	assert.ok(payload.includes('start: selection.start'), 'the normalized start offset');
	assert.ok(payload.includes('end: selection.end'), 'the normalized end offset');
	assert.ok(
		payload.includes('lineStart: selection.lineStart'),
		'the start\'s 1-based line number (the lineOfOffset semantics, view.js derives it)'
	);
	assert.ok(payload.includes('lineEnd: selection.lineEnd'), 'the end\'s 1-based line number');
	assert.ok(
		payload.includes('text: selection.start === selection.end ? null : selection.text'),
		'text is null when collapsed — the reportSelection convention (components.js ~1817)'
	);
});

test('onNavigate: the component claims line jumps through handle.navigateToLine and returns true', () => {
	const text = componentText();
	const claimAt = text.indexOf('controller.onNavigate((line) => {');
	assert.ok(claimAt !== -1, 'the component subscribes to the controller navigation channel');
	const claim = text.slice(claimAt, text.indexOf('});', claimAt));
	const navigateAt = claim.indexOf('handle.navigateToLine(line)');
	assert.ok(navigateAt !== -1, 'the handler routes the jump to the handle');
	const trueAt = claim.indexOf('return true');
	assert.ok(trueAt !== -1 && trueAt > navigateAt, 'the handler claims the jump (returns true after navigating)');
});

test('initialScroll lands once through handle.applyInitialScroll; the view focuses on first ready', () => {
	const text = componentText();
	assert.ok(
		text.includes('applyInitialScroll(props.initialScroll)'),
		'the framework restore target is applied through the handle'
	);
	assert.ok(text.includes('initialScrollAppliedRef'), 'the restore is one-shot per mount');
	assert.ok(text.includes('view.focus()'), 'the view takes focus on first ready (the PlainTextMode discipline)');
	assert.ok(
		text.includes('shouldFocusEditorOnOpen('),
		'the focus verdict reuses the shared pure helper — never steals a text entry\'s focus'
	);
});

test('scroll offsets forward to props.onScrollChange when it is a function', () => {
	const text = componentText();
	assert.ok(
		text.includes('onScrollChangeRef.current = props.onScrollChange'),
		'the live reporter rides a ref (the ref-during-render pattern — a late prop needs no re-wiring)'
	);
	const onScrollAt = text.indexOf('onScroll: (offset) => {');
	assert.ok(onScrollAt !== -1, 'the deps onScroll handler was found');
	const onScrollSpan = text.slice(onScrollAt, text.indexOf('},', onScrollAt));
	assert.ok(
		onScrollSpan.includes("typeof report !== 'function'"),
		'the reporter is shape-guarded before the call'
	);
	assert.ok(
		onScrollSpan.includes('report({ top: offset.top, left: offset.left })'),
		'the offsets forward verbatim as { top, left }'
	);
});

/* ------------------------------------------------------ machine mirrors -- */

test('machine mirrors: setContent and mirrorMachineSelection run under the mirroring flag', () => {
	const text = componentText();
	const setContentAt = text.indexOf('surface.handle.setContent(text, selection)');
	assert.ok(setContentAt !== -1, 'a machine content write mirrors through handle.setContent');
	assert.ok(
		text.includes('surface.handle.mirrorMachineSelection(selection)'),
		'a machine selection mirrors through handle.mirrorMachineSelection'
	);
	// The flag arms BEFORE the handle calls and disarms in a finally — a
	// throwing mirror never leaves the suppression stuck on.
	const mirrorEffectStart = text.lastIndexOf('React.useEffect(', setContentAt);
	const mirrorEffectEnd = text.indexOf('}, [state.draft, state.selection, phase]);', mirrorEffectStart);
	const mirrorEffect = text.slice(mirrorEffectStart, mirrorEffectEnd);
	const armAt = mirrorEffect.indexOf('mirroringRef.current = true');
	assert.ok(armAt !== -1 && armAt < mirrorEffect.indexOf('surface.handle.setContent'), 'the flag arms before the content mirror');
	assert.ok(
		mirrorEffect.lastIndexOf('mirroringRef.current = false') > mirrorEffect.indexOf('surface.handle.mirrorMachineSelection'),
		'the flag disarms after the selection mirror'
	);
	const finallyCount = (mirrorEffect.match(/} finally \{/g) || []).length;
	assert.equal(finallyCount, 2, 'both mirrors disarm in a finally (a throwing mirror never leaves the flag armed)');
});

test('the mirror effect ALWAYS ends with the catch-up repaint (the active-line duty)', () => {
	const text = componentText();
	const setContentAt = text.indexOf('surface.handle.setContent(text, selection)');
	const mirrorEffectStart = text.lastIndexOf('React.useEffect(', setContentAt);
	const mirrorEffect = text.slice(mirrorEffectStart, text.indexOf('}, [state.draft, state.selection, phase]);', mirrorEffectStart));
	// PlainTextMode's mirror effect paints the caret line UNCONDITIONALLY
	// at the end of its ready path (components.js ~2295): its DOM paint
	// reads the live caret. The CM6 twin is a catch-up repaint — the
	// selection snapshot the active-line source reads is current only at
	// effect time (React rendered first), while the caret's own
	// transaction already rebuilt the decorations against the PRE-render
	// snapshot. Without this dispatch the highlight lags one selection
	// change behind (and the first selection after mount paints nothing).
	const lastDisarmAt = mirrorEffect.lastIndexOf('mirroringRef.current = false');
	assert.ok(lastDisarmAt !== -1, 'the mirroring flag disarms inside the effect');
	const tail = mirrorEffect.slice(lastDisarmAt).replace(/\/\/[^\n]*/g, '').trim();
	assert.ok(
		tail.endsWith('repaint();'),
		'the effect ends with the unconditional catch-up repaint — outside both mirror conditionals (the highlight follows the caret in the same frame)'
	);
	assert.ok(
		!mirrorEffect.includes("typeof selection !== 'object') return;"),
		'a null machine selection no longer early-returns past the repaint — every ready-path run repaints'
	);
});

test('echo suppression: machine-driven transactions never re-enter controller.applyEdit/applySelection', () => {
	const text = componentText();
	const onEditAt = text.indexOf('onEdit: (text) => {');
	assert.ok(onEditAt !== -1, 'the deps onEdit handler was found');
	const onEditSpan = text.slice(onEditAt, text.indexOf('onSelection:', onEditAt));
	const echoGuardAt = onEditSpan.indexOf('if (mirroringRef.current === true) return;');
	const applyEditAt = onEditSpan.indexOf('.applyEdit(text)');
	assert.ok(echoGuardAt !== -1, 'onEdit guards on the mirroring flag');
	assert.ok(
		applyEditAt !== -1 && echoGuardAt < applyEditAt,
		'the guard precedes the controller call — a machine write is never re-reported as a user edit'
	);
	assert.ok(
		onEditSpan.indexOf('feedSession(text);') < echoGuardAt,
		'the session feed runs BEFORE the echo guard — a machine-written document still tokenizes'
	);
	const onSelectionAt = text.indexOf('onSelection: (selection) => {');
	assert.ok(onSelectionAt !== -1, 'the deps onSelection handler was found');
	const onSelectionSpan = text.slice(onSelectionAt, text.indexOf('onScroll:', onSelectionAt));
	const selectionGuardAt = onSelectionSpan.indexOf('if (mirroringRef.current === true) return;');
	const applySelectionAt = onSelectionSpan.indexOf('.applySelection({');
	assert.ok(selectionGuardAt !== -1, 'onSelection guards on the mirroring flag');
	assert.ok(
		applySelectionAt !== -1 && selectionGuardAt < applySelectionAt,
		'the guard precedes the controller call — a machine selection echo never re-enters applySelection'
	);
});

/* -------------------------------------------------------------- unmount -- */

test('unmount: view destroy + engine dispose, and the teardown paths report nothing', () => {
	const text = componentText();
	const destroyAt = text.indexOf('surface.handle.destroy()');
	assert.ok(destroyAt !== -1, 'the view is destroyed through the handle');
	const cleanup = text.slice(text.lastIndexOf('return () => {', destroyAt), text.indexOf('}, [', destroyAt));
	assert.ok(
		cleanup.includes('surfaceRef.current = null'),
		'the surface ref drops first (every later path no-ops on null)'
	);
	for (const banned of ['applyEdit', 'applySelection', 'setContent', 'mirrorMachineSelection']) {
		assert.ok(!cleanup.includes(banned), `the view teardown never calls ${banned}`);
	}
	const disposeAt = text.indexOf('engine.dispose(session)');
	const sessionCleanup = text.slice(text.lastIndexOf('return () => {', disposeAt), text.indexOf('}, [', disposeAt));
	for (const banned of ['applyEdit', 'applySelection', 'setContent', 'mirrorMachineSelection']) {
		assert.ok(!sessionCleanup.includes(banned), `the session teardown never calls ${banned}`);
	}
});

/* ---------------------------------------------------------- degradation -- */

test('degradation: isBlocked, a load rejection and an assembly throw all reach the same plain-text path, logged once', () => {
	const text = componentText();
	assert.ok(
		text.includes("typeof logSource.warn === 'function'"),
		'the log channel is shape-guarded (a malformed channel stays silent)'
	);
	assert.ok(text.includes("logWarn('cm6'"), 'the degradation logs through the cm6 scope');
	assert.ok(text.includes('degradedRef.current = true'), 'the degradation is a one-way per-component flag');
	// 1. A blocked loader degrades BEFORE the transport call.
	const gateAt = text.indexOf('cm6Loader.isBlocked()');
	const loadAt = text.indexOf('cm6Loader.loadCm6()');
	assert.ok(gateAt !== -1 && loadAt !== -1, 'the gate markers were found');
	assert.ok(gateAt < loadAt, 'the blocked check precedes the load call');
	assert.ok(
		text.slice(gateAt, loadAt).includes('degrade('),
		'a blocked loader degrades without touching the transport'
	);
	// 2. A rejected load degrades.
	const gateEffect = text.slice(loadAt, text.indexOf('}, [cm6Loader', loadAt));
	assert.ok(gateEffect.includes('degrade('), 'the rejection handler degrades');
	// 3. An assembly throw degrades.
	const assemblyAt = text.indexOf('cm6Factory({ plan, deps, docText, host })');
	const assemblySpan = text.slice(assemblyAt, assemblyAt + 500);
	const catchAt = assemblySpan.indexOf('} catch (error) {');
	assert.ok(catchAt !== -1, 'the assembly call is wrapped in a catch');
	assert.ok(assemblySpan.indexOf('degrade(') > catchAt, 'an assembly throw degrades');
});

/* ----------------------------------------------------- StrictMode re-arm -- */

test('StrictMode double-mount: the cleanup re-arms cleanly (create/destroy/create idempotent)', () => {
	const text = componentText();
	const destroyAt = text.indexOf('surface.handle.destroy()');
	const cleanup = text.slice(text.lastIndexOf('return () => {', destroyAt), text.indexOf('}, [', destroyAt));
	assert.ok(
		cleanup.includes('surfaceRef.current = null'),
		'the teardown nulls the surface ref — the re-run rebuilds from scratch (the descriptor.reset() precedent, mode-code-highlight.js:96-114)'
	);
	// The chunk gate re-run never re-tries once degraded.
	const gateAt = text.indexOf('cm6Loader.isBlocked()');
	const gateEffectStart = text.lastIndexOf('React.useEffect(', gateAt);
	const gateEffect = text.slice(gateEffectStart, text.indexOf('}, [cm6Loader', gateEffectStart));
	assert.ok(
		gateEffect.indexOf('degradedRef.current') < gateEffect.indexOf('cm6Loader.loadCm6()'),
		'the gate checks the degraded flag BEFORE re-loading (a degraded mount never retries)'
	);
	assert.ok(
		text.includes('sessionRef.current = null'),
		'the session teardown nulls the session ref — the re-run re-arms a fresh session'
	);
});

/* ---------------------------------------------------------- the deps seam -- */

test('the deps seam carries the pinned ten members (R9) into the view', () => {
	const text = componentText();
	const depsAt = text.indexOf('const deps = {');
	assert.ok(depsAt !== -1, 'the deps object literal was found');
	const deps = text.slice(depsAt, text.indexOf('};', depsAt));
	for (const member of [
		'onEdit: (text) => {',
		'onSelection: (selection) => {',
		'onScroll: (offset) => {',
		'get session()',
		'lineTokenDecorations,',
		'matchDecorationDescriptors,',
		'whitespaceDecorationDescriptors,',
		'rulerGeometry,',
		'cm6BaseTheme,',
		'activeLineRanges: () => {',
	]) {
		assert.ok(deps.includes(member), `deps carries ${member.split(':')[0].replace('get ', '')}`);
	}
	assert.ok(
		text.includes('get session()'),
		'the session is a LIVE accessor (a snapshot value would freeze the creation-moment null forever)'
	);
});

test('activeLineRanges derives doc ranges through ONE single-pass walk memoized on the selection signature (C1)', () => {
	const text = componentText();
	const hookAt = text.indexOf('activeLineRanges: () => {');
	assert.ok(hookAt !== -1, 'the active-line source hook was found');
	const hook = text.slice(hookAt, text.indexOf('},', text.indexOf('return ranges;', hookAt)));
	assert.ok(
		hook.includes('selectionSnapshotRef.current'),
		"the source is the controller selection snapshot (the framework's own lineStart/lineEnd)"
	);
	assert.ok(
		hook.includes('activeLineRangeOf(selection)'),
		'the 1-based inclusive range comes from the active-line pure core'
	);
	// ONE pass (C1): the module-scope walk below collects every touched
	// line's start offset in a single scan. offsetOfLine per line is
	// O(offset) each — quadratic over a select-all on a large document
	// (the freeze this fix removes).
	assert.ok(
		text.includes('function activeLineStartOffsets('),
		'the single-pass line-start walk lives at module scope'
	);
	assert.ok(
		hook.includes('activeLineStartOffsets(text, lineStart, lineEnd)'),
		'the hook derives every touched line offset through the ONE walk'
	);
	assert.ok(
		!text.includes('offsetOfLine('),
		'no offsetOfLine call remains — the per-line O(offset) walks are gone'
	);
	// The selection-signature memo: the view's active-line plugin calls
	// this hook on EVERY view update; an unchanged selection over
	// unchanged text must return the cached ranges without re-walking.
	assert.ok(
		hook.includes('`${selection.start}:${selection.end}:${text.length}`'),
		'the signature keys on the selection offsets and the text length'
	);
	assert.ok(
		hook.includes('activeLineMemo.text === text'),
		'the memo hits only when the draft reference is content-equal (a same-length content morph invalidates)'
	);
	assert.ok(
		hook.includes('return activeLineMemo.ranges;'),
		'a signature hit returns the cached ranges'
	);
});

test('the single-pass walk is offsetOfLine-faithful on real lines and bounds the past-end clamp (extracted source, C1)', () => {
	const source = componentText();
	const start = source.indexOf('function activeLineStartOffsets(');
	assert.ok(start !== -1, 'the module-scope single-pass helper exists');
	const end = source.indexOf('\n}\n', start);
	assert.ok(end !== -1, 'the helper closes at column 0 (a module-scope function)');
	// component.js is React-requiring and not importable under node:test,
	// but the helper is pure over its arguments — extract its source and
	// evaluate it directly, then check it against the shared lines
	// helper it replaces (offsetOfLine is the normative reference).
	const activeLineStartOffsets = new Function(
		`${source.slice(start, end + 3)}\nreturn activeLineStartOffsets;`
	)();
	for (const doc of ['a\nb\nc', 'a\nb\n', '', 'a', 'a\nb\nc\nd\ne\nf', 'x\r\ny']) {
		const realLast = doc.split('\n').length;
		for (let first = 1; first <= realLast + 2; first += 1) {
			for (let last = first; last <= realLast + 2; last += 1) {
				const got = activeLineStartOffsets(doc, first, last);
				const prefix = [];
				for (let line = first; line <= Math.min(last, realLast); line += 1) {
					prefix.push(offsetOfLine(doc, line));
				}
				assert.deepEqual(
					got.slice(0, prefix.length),
					prefix,
					`doc ${JSON.stringify(doc)} lines [${first}, ${last}]: the real-line prefix is offsetOfLine-faithful`
				);
				if (last > realLast) {
					assert.deepEqual(
						got.slice(prefix.length),
						[doc.length],
						`doc ${JSON.stringify(doc)} lines [${first}, ${last}]: the past-end tail collapses to ONE text.length clamp`
					);
				} else {
					assert.equal(
						got.length,
						prefix.length,
						`doc ${JSON.stringify(doc)} lines [${first}, ${last}]: no past-end tail`
					);
				}
			}
		}
	}
	// Defensive gates, the house style.
	assert.deepEqual(activeLineStartOffsets(null, 1, 3), [], 'a non-string text degrades to []');
	assert.deepEqual(activeLineStartOffsets('a\nb', Number.NaN, 2), [], 'a non-finite lineStart degrades to []');
	assert.deepEqual(activeLineStartOffsets('a\nb', 1, Number.NaN), [], 'a non-finite lineEnd degrades to []');
	assert.deepEqual(activeLineStartOffsets('a\nb', 3, 2), [], 'an empty (swapped) range degrades to []');
});

/* --------------------------------------------------- plan + indent auto -- */

test('the plan is resolved through resolveExtensionPlan and re-dispatched live on preference flips', () => {
	const text = componentText();
	assert.ok(text.includes('resolveExtensionPlan({'), 'the plan comes from the Task 8 pure normalizer');
	assert.ok(
		text.includes('surface.reconfigure(plan)'),
		'preference flips re-dispatch the compartments live (never a view rebuild)'
	);
	assert.ok(
		text.includes('planKey'),
		'the re-dispatch keys on the plan\'s serialized shape — a draft edit that moves nothing costs no transaction'
	);
});

test("indent 'auto' parity: the detected mode is resolved before the plan is built", () => {
	const text = componentText();
	assert.ok(
		text.includes("settings.indentMode === 'auto'"),
		"the pre-resolution keys on the literal 'auto' mode"
	);
	assert.ok(
		text.includes('detectIndentUnit('),
		'the unit detection reuses src/indent.js (never re-implemented here)'
	);
	assert.ok(
		text.includes('indentSettings: resolvedIndentSettings(props, detectedIndent)'),
		'the plan consumes the pre-resolved settings — the view\'s indentUnit takes the detected mode, not a literal auto'
	);
});

/* -------------------------------------------------- progressive repaint -- */

test('progressive repaint: subscribeProgress ticks dispatch a view transaction (spec §5.6)', () => {
	const text = componentText();
	assert.ok(
		text.includes('return subscribeProgress(repaint);'),
		'the component subscribes to the engine progress channel'
	);
	assert.ok(
		text.includes('view.dispatch({ effects: [] })'),
		'each tick dispatches a no-op transaction — the decoration plugin rebuilds against the grown token cache'
	);
});

/* ------------------------------------------------ the controller subscription -- */

test('the component subscribes to the controller state (useSyncExternalStore with the fallback)', () => {
	const text = componentText();
	assert.ok(
		text.includes('typeof React.useSyncExternalStore === \'function\''),
		'the store hook is resolved once at module scope (the components.js precedent)'
	);
	assert.ok(text.includes('useExternalStore('), 'the subscription rides the store hook when the host provides it');
	assert.ok(text.includes('controller.subscribe'), 'the subscription binds the controller\'s own store');
});

/* ------------------------------------------------ thin-component pins -- */

test('the pure cores are imported statically; CM6 arrives only through the loader\'s chunk', () => {
	const text = componentText();
	for (const marker of [
		"import { createCm6ViewFactory } from './view.js'",
		"import { resolveExtensionPlan } from './view-plan.js'",
		"import { lineTokenDecorations } from './highlight-adapter.js'",
		"import { matchDecorationDescriptors } from './match-decorations.js'",
		"import { whitespaceDecorationDescriptors } from './whitespace-decorations.js'",
		"import { rulerGeometry } from './ruler-layer.js'",
		"import { cm6BaseTheme } from './theme.js'",
	]) {
		assert.ok(text.includes(marker), `${marker} is a static import`);
	}
	assert.ok(
		text.includes("import { languageOf } from '../highlight/languages.js'"),
		'languageOf comes from the highlight language table'
	);
	assert.ok(
		text.includes("import { detectIndentUnit } from '../indent.js'"),
		'the indent detection comes from src/indent.js'
	);
	assert.ok(
		text.includes("import { activeLineRangeOf } from '../active-line.js'"),
		'the active-line range normalization comes from the pure core'
	);
	assert.ok(
		text.includes("import { shouldFocusEditorOnOpen } from '../view-state.js'"),
		'the focus verdict comes from the shared view-state helper'
	);
	assert.ok(!text.includes('@codemirror/'), 'no static @codemirror import');
	assert.ok(
		!text.includes('vendor/cm6-core'),
		'the vendored facade is never statically imported — the loader resolves it'
	);
});

test('§5.5 red lines: no I/O, no save, no stopPropagation in the mode component', () => {
	const text = componentText();
	for (const banned of [
		'stopPropagation',
		'preventDefault',
		'localStorage',
		'execCommand',
		'writeFile',
		'requestSave',
		'saveAll',
		'fetch(',
	]) {
		assert.ok(!text.includes(banned), `${banned} is out of the mode component's scope (contracts §5.5)`);
	}
});
