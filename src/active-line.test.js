import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeLineRangeOf, activeLineBar, lineHeightPxOf } from './active-line.js';

/* -------------------------------------------------- activeLineRangeOf -- */

test('activeLineRangeOf: a null selection maps to the first line', () => {
  assert.deepEqual(activeLineRangeOf(null), { lineStart: 1, lineEnd: 1 });
});

test('activeLineRangeOf: a collapsed selection highlights the caret line only', () => {
  assert.deepEqual(activeLineRangeOf({ start: 5, end: 5, lineStart: 3, lineEnd: 3, text: null }), {
    lineStart: 3,
    lineEnd: 3,
  });
});

test('activeLineRangeOf: a multi-line selection highlights every touched line', () => {
  assert.deepEqual(activeLineRangeOf({ start: 2, end: 40, lineStart: 1, lineEnd: 4, text: '…' }), {
    lineStart: 1,
    lineEnd: 4,
  });
});

test('activeLineRangeOf: swapped bounds are normalized (smaller line first)', () => {
  assert.deepEqual(activeLineRangeOf({ lineStart: 5, lineEnd: 2 }), { lineStart: 2, lineEnd: 5 });
});

test('activeLineRangeOf: invalid or missing bounds fall back to the first line', () => {
  assert.deepEqual(activeLineRangeOf({}), { lineStart: 1, lineEnd: 1 });
  assert.deepEqual(activeLineRangeOf('x'), { lineStart: 1, lineEnd: 1 });
  assert.deepEqual(activeLineRangeOf({ lineStart: 0, lineEnd: -3 }), { lineStart: 1, lineEnd: 1 });
  assert.deepEqual(activeLineRangeOf({ lineStart: 2.7, lineEnd: 4.2 }), { lineStart: 2, lineEnd: 4 });
});

/* ------------------------------------------------------- activeLineBar -- */

test('activeLineBar: one line sits on paddingTop + (line-1)*lineHeight, one lineHeight tall', () => {
  assert.deepEqual(activeLineBar({ lineStart: 1, lineEnd: 1 }, { paddingTop: 10, lineHeight: 19.5 }), {
    top: 10,
    height: 19.5,
  });
  assert.deepEqual(activeLineBar({ lineStart: 3, lineEnd: 3 }, { paddingTop: 10, lineHeight: 19.5 }), {
    top: 49,
    height: 19.5,
  });
});

test('activeLineBar: a multi-line range spans from the first line top across every covered line', () => {
  assert.deepEqual(activeLineBar({ lineStart: 2, lineEnd: 4 }, { paddingTop: 12, lineHeight: 20 }), {
    top: 32,
    height: 60,
  });
});

test('activeLineBar: swapped bounds span the normalized range (bar never negative)', () => {
  assert.deepEqual(activeLineBar({ lineStart: 4, lineEnd: 2 }, { paddingTop: 10, lineHeight: 19.5 }), {
    top: 29.5,
    height: 58.5,
  });
});

test('activeLineBar: absent metrics degrade to the defensive 1px-per-line default', () => {
  assert.deepEqual(activeLineBar({ lineStart: 2, lineEnd: 2 }, undefined), { top: 1, height: 1 });
  assert.deepEqual(activeLineBar({ lineStart: 3, lineEnd: 3 }, { paddingTop: NaN, lineHeight: 0 }), {
    top: 2,
    height: 1,
  });
});

/* ------------------------------------------------------ lineHeightPxOf -- */

test('lineHeightPxOf: a px computed value passes through verbatim', () => {
  assert.equal(lineHeightPxOf('19.5px', 13), 19.5);
  assert.equal(lineHeightPxOf('20px', 13), 20);
});

test('lineHeightPxOf: a unitless computed value multiplies the computed font size', () => {
  assert.equal(lineHeightPxOf('1.5', 13), 19.5);
  assert.equal(lineHeightPxOf('2', 13.5), 27);
});

test('lineHeightPxOf: normal and unparseable values fail (caller keeps measuring)', () => {
  assert.equal(lineHeightPxOf('normal', 13), null);
  assert.equal(lineHeightPxOf('abc', 13), null);
  assert.equal(lineHeightPxOf('', 13), null);
});

test('lineHeightPxOf: zero or non-finite outcomes fail (never a usable bar metric)', () => {
  assert.equal(lineHeightPxOf('0px', 13), null);
  assert.equal(lineHeightPxOf('1.5', NaN), null);
  assert.equal(lineHeightPxOf(undefined, 13), null);
});
