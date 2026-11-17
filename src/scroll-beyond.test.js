import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endScrollTarget, scrollBeyondPadding } from './scroll-beyond.js';

test('scrollBeyondPadding: viewport above one line keeps the difference', () => {
  assert.equal(scrollBeyondPadding(400, 19.5), 380.5);
  assert.equal(scrollBeyondPadding(600, 20), 580);
});

test('scrollBeyondPadding: viewport exactly one line tall adds nothing', () => {
  assert.equal(scrollBeyondPadding(19.5, 19.5), 0);
});

test('scrollBeyondPadding: viewport below one line clamps to 0', () => {
  assert.equal(scrollBeyondPadding(10, 19.5), 0);
  assert.equal(scrollBeyondPadding(0, 19.5), 0);
});

test('scrollBeyondPadding: unusable line heights yield 0', () => {
  assert.equal(scrollBeyondPadding(400, 0), 0);
  assert.equal(scrollBeyondPadding(400, -1), 0);
  assert.equal(scrollBeyondPadding(400, NaN), 0);
  assert.equal(scrollBeyondPadding(400, Infinity), 0);
  assert.equal(scrollBeyondPadding(400, '19.5'), 0);
  assert.equal(scrollBeyondPadding(400, undefined), 0);
});

test('scrollBeyondPadding: unusable client heights yield 0', () => {
  assert.equal(scrollBeyondPadding(NaN, 19.5), 0);
  assert.equal(scrollBeyondPadding(Infinity, 19.5), 0);
  assert.equal(scrollBeyondPadding(-5, 19.5), 0);
  assert.equal(scrollBeyondPadding('400', 19.5), 0);
  assert.equal(scrollBeyondPadding(undefined, 19.5), 0);
});

test('scrollBeyondPadding: fractional inputs pass through unrounded', () => {
  assert.equal(scrollBeyondPadding(400.25, 19.5), 380.75);
});

/* ------------------------------------------------------ endScrollTarget -- */

// Realistic geometry: paddingTop 10, lineHeight 19.5, viewport 400. With the
// scroll-beyond padding applied, max scrollTop is 10 + 100*19.5 + 380.5 - 400
// = 1940.5 for a 100-line file.
const BASE = { clientHeight: 400, lineHeight: 19.5, paddingTop: 10, lineCount: 100, maxScrollTop: 1940.5 };

test('endScrollTarget: lands the last line blankBelowLines above the bottom', () => {
  assert.equal(endScrollTarget(BASE), 1657.5);
  // Verify the contract, not just the number: blank below the last line's
  // bottom edge equals 5 lineHeights at the returned offset.
  const lastLineBottom = BASE.paddingTop + BASE.lineCount * BASE.lineHeight;
  const blankBelow = BASE.clientHeight - (lastLineBottom - 1657.5);
  assert.equal(blankBelow, 5 * 19.5);
});

test('endScrollTarget: defaults blankBelowLines to 5', () => {
  assert.equal(endScrollTarget({ ...BASE, blankBelowLines: 5 }), endScrollTarget(BASE));
});

test('endScrollTarget: clamps to the scroll extent bottom', () => {
  // A huge blank wish can never exceed the extent.
  assert.equal(endScrollTarget({ ...BASE, blankBelowLines: 50 }), 1940.5);
  // A small extent (setting off / tiny pane) pins the landing to its bottom.
  assert.equal(endScrollTarget({ ...BASE, lineCount: 30, maxScrollTop: 25 }), 25);
  assert.equal(endScrollTarget({ ...BASE, maxScrollTop: 0 }), 0);
});

test('endScrollTarget: clamps to 0 when the content cannot scroll', () => {
  assert.equal(endScrollTarget({ ...BASE, lineCount: 1 }), 0);
  assert.equal(endScrollTarget({ ...BASE, lineCount: 1, maxScrollTop: 50 }), 0);
});

test('endScrollTarget: fractional geometry passes through unrounded', () => {
  assert.equal(endScrollTarget({ ...BASE, clientHeight: 400.25 }), 1657.25);
});

test('endScrollTarget: unusable inputs return null (never throw)', () => {
  assert.equal(endScrollTarget(null), null);
  assert.equal(endScrollTarget(undefined), null);
  assert.equal(endScrollTarget('x'), null);
  for (const field of ['clientHeight', 'lineHeight', 'paddingTop', 'lineCount', 'maxScrollTop']) {
    assert.equal(endScrollTarget({ ...BASE, [field]: NaN }), null, field);
    assert.equal(endScrollTarget({ ...BASE, [field]: undefined }), null, field);
    assert.equal(endScrollTarget({ ...BASE, [field]: '19.5' }), null, field);
  }
  assert.equal(endScrollTarget({ ...BASE, lineHeight: 0 }), null);
  assert.equal(endScrollTarget({ ...BASE, paddingTop: -1 }), null);
  assert.equal(endScrollTarget({ ...BASE, maxScrollTop: -5 }), null);
  assert.equal(endScrollTarget({ ...BASE, lineCount: 0 }), null);
  assert.equal(endScrollTarget({ ...BASE, lineCount: 1.5 }), null);
  assert.equal(endScrollTarget({ ...BASE, blankBelowLines: -1 }), null);
  assert.equal(endScrollTarget({ ...BASE, blankBelowLines: NaN }), null);
});
