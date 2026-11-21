import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRulerColumnInput, isValidRulerColumn, rulerLeftCh } from './ruler.js';

test('clampRulerColumnInput converges to the 1-999 integer range', () => {
	assert.equal(clampRulerColumnInput(0), 1);
	assert.equal(clampRulerColumnInput(-5), 1);
	assert.equal(clampRulerColumnInput(1), 1);
	assert.equal(clampRulerColumnInput(80), 80);
	assert.equal(clampRulerColumnInput(999), 999);
	assert.equal(clampRulerColumnInput(1000), 999);
	assert.equal(clampRulerColumnInput(80.4), 80);
	assert.equal(clampRulerColumnInput(80.5), 81);
});
test('clampRulerColumnInput returns null for unparseable input', () => {
	for (const raw of ['80', '', ' ', null, undefined, NaN, Infinity, -Infinity, {}, true]) {
		assert.equal(clampRulerColumnInput(raw), null);
	}
});
test('isValidRulerColumn accepts exactly the valid integers', () => {
	assert.equal(isValidRulerColumn(1), true);
	assert.equal(isValidRulerColumn(80), true);
	assert.equal(isValidRulerColumn(999), true);
	assert.equal(isValidRulerColumn(0), false);
	assert.equal(isValidRulerColumn(1000), false);
	assert.equal(isValidRulerColumn(80.5), false);
	assert.equal(isValidRulerColumn('80'), false);
	assert.equal(isValidRulerColumn(null), false);
});
test('rulerLeftCh adds bandWidth and column with defensive fallbacks', () => {
	assert.equal(rulerLeftCh(80, 0), 80);
	assert.equal(rulerLeftCh(80, 7), 87);
	assert.equal(rulerLeftCh(1, 4), 5);
	assert.equal(rulerLeftCh(999, 3), 1002);
	assert.equal(rulerLeftCh(0, 7), 87); // 非法 column → 防御回退 80
	assert.equal(rulerLeftCh(80, Number.NaN), 80); // 非法 bandWidth → 0
});
