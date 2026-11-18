import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIndentUnit, resolveIndentUnit } from './indent.js';

test('detectIndentUnit: a single leading tab decides tabs', () => {
	assert.deepEqual(detectIndentUnit('a\n\tb\n      c'), { mode: 'tabs' });
});
test('detectIndentUnit: most frequent leading-space count wins; ties pick the smaller', () => {
	assert.deepEqual(detectIndentUnit('a\n  b\n  c\n    d'), { mode: 'spaces', width: 2 });
	assert.deepEqual(detectIndentUnit('a\n  b\n    c'), { mode: 'spaces', width: 2 });
});
test('detectIndentUnit: >16 leading spaces are alignment noise', () => {
	assert.deepEqual(detectIndentUnit('                    a\n    b'), { mode: 'spaces', width: 4 });
});
test('detectIndentUnit: only the first 200 non-empty lines are samples', () => {
	const head = Array.from({ length: 200 }, () => '  x').join('\n');
	assert.deepEqual(detectIndentUnit(`${head}\n    late`), { mode: 'spaces', width: 2 });
});
test('detectIndentUnit: blank and whitespace-only lines are not samples; no signal → null', () => {
	assert.equal(detectIndentUnit(''), null);
	assert.equal(detectIndentUnit('abc\ndef'), null);
	assert.deepEqual(detectIndentUnit('\n   \n\tab'), { mode: 'tabs' }); // '   ' trim 后为空，不占样本
});
test('detectIndentUnit: CRLF-safe', () => {
	assert.deepEqual(detectIndentUnit('a\r\n\tb'), { mode: 'tabs' });
});
test('resolveIndentUnit: explicit modes win, auto detects, fallback width', () => {
	assert.equal(resolveIndentUnit({ indentMode: 'tabs', indentWidth: 2 }, ''), '\t');
	assert.equal(resolveIndentUnit({ indentMode: 'spaces', indentWidth: 2 }, ''), '  ');
	assert.equal(resolveIndentUnit({ indentMode: 'spaces', indentWidth: 3 }, ''), '    '); // 非法宽度回 4
	assert.equal(resolveIndentUnit({ indentMode: 'auto', indentWidth: 2 }, 'a\n\tb'), '\t');
	assert.equal(resolveIndentUnit({ indentMode: 'auto', indentWidth: 2 }, 'a\n    b'), '    ');
	assert.equal(resolveIndentUnit({ indentMode: 'auto', indentWidth: 2 }, ''), '  '); // 探测 null → 设置宽度
	assert.equal(resolveIndentUnit(null, ''), '    '); // 防御：非法 settings → 4 空格
	assert.equal(resolveIndentUnit(undefined, undefined), '    ');
});
