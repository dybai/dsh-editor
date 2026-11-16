import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewStateKey,
  isPosition,
  isSelectionRecord,
  selectionRecordFromSnapshot,
  selectionFromViewState,
  canApplyScroll,
  scrollDiffers,
  shouldRestoreViewState,
  shouldFocusEditorAfterSelection
} from './view-state.js';

const TEXT = 'one\ntwo\nthree';

test('viewStateKey builds a case-folded workspace key for Windows paths', () => {
  assert.equal(viewStateKey('D:\\Work\\Proj', 's1', 'src/Main.js'), 'd:/work/proj/src/main.js');
  assert.equal(viewStateKey('D:/Work/Proj/', 's1', 'src/main.js'), 'd:/work/proj/src/main.js');
});

test('viewStateKey preserves POSIX case and handles the POSIX root', () => {
  assert.equal(viewStateKey('/home/me/proj', 's1', 'src/Main.js'), '/home/me/proj/src/Main.js');
  assert.equal(viewStateKey('/', 's1', 'a.js'), '/a.js');
});

test('viewStateKey uses absolute and UNC paths directly', () => {
  assert.equal(viewStateKey('C:/ws', 's1', 'E:/Other/Notes.txt'), 'e:/other/notes.txt');
  assert.equal(viewStateKey('C:/ws', 's1', '//Server/Share/A.txt'), '//server/share/a.txt');
});

test('viewStateKey falls back to session identity when cwd is unknown', () => {
  assert.equal(viewStateKey(undefined, 's1', 'src/a.js'), 'session:s1/src/a.js');
  assert.equal(viewStateKey('', 's1', 'src/a.js'), 'session:s1/src/a.js');
  assert.equal(viewStateKey(undefined, '', 'src/a.js'), undefined);
  assert.equal(viewStateKey('D:/ws', 's1', ''), undefined);
});

test('position and selection validators reject malformed records', () => {
  assert.equal(isPosition({ line: 1, column: 1 }), true);
  assert.equal(isPosition({ line: 1.5, column: 1 }), false);
  assert.equal(isPosition({ line: 1, column: 0 }), false);
  assert.equal(isPosition(null), false);
  assert.equal(isSelectionRecord(null), true);
  assert.equal(isSelectionRecord({ start: { line: 2, column: 1 }, end: { line: 1, column: 1 } }), false);
});

test('selectionRecordFromSnapshot converts machine offsets to line/column', () => {
  assert.deepEqual(
    selectionRecordFromSnapshot(TEXT, { start: 1, end: 8, lineStart: 1, lineEnd: 3, text: 'ne\ntwo\n' }),
    { start: { line: 1, column: 2 }, end: { line: 3, column: 1 } }
  );
  assert.equal(selectionRecordFromSnapshot(TEXT, null), null);
});

test('selectionFromViewState restores a collapsed caret', () => {
  assert.deepEqual(
    selectionFromViewState(TEXT, { start: { line: 2, column: 2 }, end: { line: 2, column: 2 } }),
    { start: 5, end: 5, lineStart: 2, lineEnd: 2, text: null }
  );
});

test('selectionFromViewState restores a multi-line range', () => {
  assert.deepEqual(
    selectionFromViewState(TEXT, { start: { line: 1, column: 2 }, end: { line: 3, column: 1 } }),
    { start: 1, end: 8, lineStart: 1, lineEnd: 3, text: 'ne\ntwo\n' }
  );
});

test('selectionFromViewState clamps out-of-range lines and columns', () => {
  assert.deepEqual(
    selectionFromViewState(TEXT, { start: { line: 99, column: 99 }, end: { line: 99, column: 99 } }),
    { start: 13, end: 13, lineStart: 3, lineEnd: 3, text: null }
  );
  assert.deepEqual(
    selectionFromViewState('', { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }),
    { start: 0, end: 0, lineStart: 1, lineEnd: 1, text: null }
  );
});

test('selectionFromViewState normalizes reversed endpoints and rejects invalid input', () => {
  assert.deepEqual(
    selectionFromViewState(TEXT, { start: { line: 3, column: 1 }, end: { line: 1, column: 2 } }),
    { start: 1, end: 8, lineStart: 1, lineEnd: 3, text: 'ne\ntwo\n' }
  );
  assert.equal(selectionFromViewState(TEXT, null), null);
  assert.equal(selectionFromViewState(TEXT, { start: { line: 0, column: 1 }, end: { line: 1, column: 1 } }), null);
});

test('canApplyScroll gates on attachment and the target axes', () => {
  const pending = { top: 40, left: 2 };
  assert.equal(canApplyScroll(pending, { attached: true, clientHeight: 100, clientWidth: 50 }), true);
  assert.equal(canApplyScroll(pending, { attached: false, clientHeight: 100, clientWidth: 50 }), false);
  assert.equal(canApplyScroll(pending, { attached: true, clientHeight: 0, clientWidth: 50 }), false);
  assert.equal(canApplyScroll({ top: 0, left: 2 }, { attached: true, clientHeight: 0, clientWidth: 50 }), true);
  assert.equal(canApplyScroll(null, { attached: true, clientHeight: 100, clientWidth: 50 }), false);
});

test('scrollDiffers uses a one-pixel tolerance', () => {
  assert.equal(scrollDiffers({ top: 10, left: 2 }, { top: 10, left: 2 }), false);
  assert.equal(scrollDiffers({ top: 10, left: 2 }, { top: 11, left: 2 }), false);
  assert.equal(scrollDiffers({ top: 10, left: 2 }, { top: 12, left: 2 }), true);
  assert.equal(scrollDiffers({ top: 10, left: 2 }, null), false);
});

test('shouldRestoreViewState suppresses navigation until a mode switch', () => {
  assert.equal(shouldRestoreViewState({ loaded: true, navigationLine: null, modeSwitched: false }), true);
  assert.equal(shouldRestoreViewState({ loaded: true, navigationLine: 12, modeSwitched: false }), false);
  assert.equal(shouldRestoreViewState({ loaded: true, navigationLine: 12, modeSwitched: true }), true);
  assert.equal(shouldRestoreViewState({ loaded: false, navigationLine: null, modeSwitched: false }), false);
});

test('shouldFocusEditorAfterSelection focuses a visible editor outside text entry', () => {
  assert.equal(shouldFocusEditorAfterSelection({ attached: true, activeIsSelf: false, activeIsTextEntry: false }), true);
  assert.equal(shouldFocusEditorAfterSelection({ attached: false, activeIsSelf: false, activeIsTextEntry: false }), false);
  assert.equal(shouldFocusEditorAfterSelection({ attached: true, activeIsSelf: true, activeIsTextEntry: false }), false);
  assert.equal(shouldFocusEditorAfterSelection({ attached: true, activeIsSelf: false, activeIsTextEntry: true }), false);
  assert.equal(shouldFocusEditorAfterSelection(null), false);
});
