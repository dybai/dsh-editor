import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGotoLine } from './goto-line.js';

// --- 合法输入 ---

test('parseGotoLine accepts whole-number input within range', () => {
	assert.deepEqual(parseGotoLine('1', 100), { ok: true, line: 1 });
	assert.deepEqual(parseGotoLine('42', 100), { ok: true, line: 42 });
	assert.deepEqual(parseGotoLine('100', 100), { ok: true, line: 100 });
	// 前后空白容忍（粘贴场景）
	assert.deepEqual(parseGotoLine(' 7 ', 100), { ok: true, line: 7 });
	// 数字本身也接受（调用方方便）
	assert.deepEqual(parseGotoLine(7, 100), { ok: true, line: 7 });
});

test('parseGotoLine clamps out-of-range input to [1, lineCount]', () => {
	assert.deepEqual(parseGotoLine('0', 100), { ok: true, line: 1 });
	assert.deepEqual(parseGotoLine('-3', 100), { ok: true, line: 1 });
	assert.deepEqual(parseGotoLine('999999', 100), { ok: true, line: 100 });
	// 小数向下取整（与 requestNavigate→onNavigate 的 floor 语义一致）
	assert.deepEqual(parseGotoLine('5.9', 100), { ok: true, line: 5 });
});

// --- 非法输入 ---

test('parseGotoLine rejects empty, non-numeric and non-finite input', () => {
	const bad = ['', '   ', 'abc', '12abc', 'NaN', 'Infinity', '.', '-', '+', null, undefined];
	for (const candidate of bad) {
		assert.deepEqual(parseGotoLine(candidate, 100), { ok: false }, `expected invalid: ${String(candidate)}`);
	}
});

test('parseGotoLine rejects a garbage lineCount', () => {
	for (const lineCount of [0, -1, NaN, Infinity, undefined, null, '10']) {
		assert.deepEqual(parseGotoLine('1', lineCount), { ok: false }, `lineCount: ${String(lineCount)}`);
	}
});
