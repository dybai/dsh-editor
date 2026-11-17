import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrollBeyondPadding } from './scroll-beyond.js';

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
