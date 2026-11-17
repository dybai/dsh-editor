import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWrapGeometry, changedLineRange, columnsOf, estimateRows, estimateAllRows } from './wrap-geometry.js';

test('buildWrapGeometry maps lines to visual rows', () => {
	const g = buildWrapGeometry([2, 1, 3], 10);
	assert.equal(g.rowsOf(2), 1);
	assert.equal(g.rowsBefore(2), 2);
	assert.equal(g.visualTop(2), 20);
	assert.equal(g.rowsBefore(4), 6);
	assert.equal(g.totalRows(), 6);
	assert.equal(g.lineAtVisualOffset(-5), 1);
	assert.equal(g.lineAtVisualOffset(0), 1);
	assert.equal(g.lineAtVisualOffset(19.9), 1);
	assert.equal(g.lineAtVisualOffset(20), 2);
	assert.equal(g.lineAtVisualOffset(60), 3);
});
test('buildWrapGeometry rejects unusable input with null', () => {
	assert.equal(buildWrapGeometry([], 10), null);
	assert.equal(buildWrapGeometry([0, 1], 10), null);
	assert.equal(buildWrapGeometry([1.5], 10), null);
	assert.equal(buildWrapGeometry('2,1,3', 10), null);
	assert.equal(buildWrapGeometry(null, 10), null);
	assert.equal(buildWrapGeometry([2, '1'], 10), null);
	assert.equal(buildWrapGeometry([2, Infinity], 10), null);
	assert.equal(buildWrapGeometry([2, , 3], 10), null);
	assert.equal(buildWrapGeometry([2, 1, 3], 0), null);
	assert.equal(buildWrapGeometry([2, 1, 3], -10), null);
	assert.equal(buildWrapGeometry([2, 1, 3], NaN), null);
	assert.equal(buildWrapGeometry([2, 1, 3], Infinity), null);
});
test('rowsOf and rowsBefore clamp out-of-range lines', () => {
	const g = buildWrapGeometry([2, 1, 3], 10);
	assert.equal(g.rowsOf(0), 2);
	assert.equal(g.rowsOf(99), 3);
	assert.equal(g.rowsOf(1), 2);
	assert.equal(g.rowsOf(NaN), 2);
	assert.equal(g.rowsBefore(0), 0);
	assert.equal(g.rowsBefore(-5), 0);
	assert.equal(g.rowsBefore(1), 0);
	assert.equal(g.rowsBefore(NaN), 0);
	assert.equal(g.rowsBefore(3), 3);
	assert.equal(g.visualTop(4), 60);
});
test('lineAtVisualOffset lands a row boundary on the next line and clamps past the end', () => {
	const g = buildWrapGeometry([2, 1, 3], 10);
	assert.equal(g.lineAtVisualOffset(g.visualTop(2)), 2);
	assert.equal(g.lineAtVisualOffset(g.visualTop(3)), 3);
	assert.equal(g.lineAtVisualOffset(1000), 3);
	assert.equal(g.lineAtVisualOffset(NaN), 1);
});
test('changedLineRange computes the changed union', () => {
	assert.equal(changedLineRange('a\nb\nc', 'a\nb\nc'), null);
	assert.deepEqual(changedLineRange('a\nb', 'a\nX'), { start: 2, end: 2 });
	assert.deepEqual(changedLineRange('a', 'a\nb\nc'), { start: 2, end: 3 });
	assert.deepEqual(changedLineRange('a\nb\nc', 'a'), { start: 2, end: 3 });
	assert.deepEqual(changedLineRange('a\nb', 'b'), { start: 1, end: 1 });
	assert.deepEqual(changedLineRange('', 'a\nb'), { start: 1, end: 2 });
	assert.deepEqual(changedLineRange('a\nb', ''), { start: 1, end: 2 });
});
test('changedLineRange never throws on non-string input', () => {
	assert.deepEqual(changedLineRange(null, 'a\nb'), { start: 1, end: 1 });
	assert.deepEqual(changedLineRange('a\nb', undefined), { start: 1, end: 1 });
	assert.deepEqual(changedLineRange(42, ['a']), { start: 1, end: 1 });
	assert.deepEqual(changedLineRange(null, null), { start: 1, end: 1 });
});
test('columnsOf advances tabs to the next stop and widths CJK as 2', () => {
	assert.equal(columnsOf('ab', 8), 2);
	assert.equal(columnsOf('\t', 8), 8);
	assert.equal(columnsOf('a\tb', 8), 9);
	assert.equal(columnsOf('中文', 8), 4);
	assert.equal(columnsOf('', 8), 0);
});
test('columnsOf walks code points and degrades bad tabColumns to 8', () => {
	assert.equal(columnsOf('\u{20000}', 8), 2);
	assert.equal(columnsOf('\t\t', 8), 16);
	assert.equal(columnsOf('a\tb', 0), 9);
	assert.equal(columnsOf('a\tb', 2.5), 9);
	assert.equal(columnsOf('a\tb', NaN), 9);
	assert.equal(columnsOf(null, 8), 0);
});
test('estimateRows degrades bad charsPerRow to 1', () => {
	assert.equal(estimateRows('abcd', 2, 8), 2);
	assert.equal(estimateRows('', 2, 8), 1);
	assert.equal(estimateRows('abc', 0, 8), 1);
	assert.equal(estimateRows('abc', NaN, 8), 1);
	assert.deepEqual(estimateAllRows(['a', 'bb', '中文'], 2, 8), [1, 1, 2]);
});
test('estimateRows and estimateAllRows degrade unusable input to 1', () => {
	assert.equal(estimateRows('abc', -1, 8), 1);
	assert.equal(estimateRows('abc', Infinity, 8), 1);
	assert.equal(estimateRows(null, 2, 8), 1);
	assert.deepEqual(estimateAllRows(null, 2, 8), [1]);
	assert.deepEqual(estimateAllRows('abc', 2, 8), [1]);
	assert.deepEqual(estimateAllRows([], 2, 8), [1]);
	assert.deepEqual(estimateAllRows([null, 'a'], 2, 8), [1, 1]);
});
