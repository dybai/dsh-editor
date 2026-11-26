import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_MATCHES_PER_LAYER,
	MAX_SELECTION_QUERY_LENGTH,
	WORD_SEPARATORS,
	isSeparatorChar,
	isWordChar,
	wordAt,
	wordQueryOf,
	selectionQueryOf,
} from './match-highlight.js';

test('isWordChar accepts letters (CJK included), digits and underscore only', () => {
	assert.equal(isWordChar('f'), true);
	assert.equal(isWordChar('Z'), true);
	assert.equal(isWordChar('中'), true);
	assert.equal(isWordChar('5'), true);
	assert.equal(isWordChar('_'), true);
	assert.equal(isWordChar('!'), false); // 分隔符
	assert.equal(isWordChar('"'), false);
	assert.equal(isWordChar(' '), false); // 空白
	assert.equal(isWordChar('\n'), false);
	assert.equal(isWordChar(''), false);
	assert.equal(isWordChar('ab'), false); // 多字符
	assert.equal(isWordChar(undefined), false);
	assert.equal(isWordChar(5), false);
});
test('isSeparatorChar flags the separator set plus whitespace only', () => {
	assert.equal(isSeparatorChar('!'), true);
	assert.equal(isSeparatorChar('-'), true);
	assert.equal(isSeparatorChar('{'), true);
	assert.equal(isSeparatorChar('"'), true);
	assert.equal(isSeparatorChar(' '), true); // 空白符另计为分隔
	assert.equal(isSeparatorChar('\t'), true);
	assert.equal(isSeparatorChar('\n'), true);
	assert.equal(isSeparatorChar('f'), false);
	assert.equal(isSeparatorChar('中'), false);
	assert.equal(isSeparatorChar('_'), false);
	assert.equal(isSeparatorChar(''), false);
	assert.equal(isSeparatorChar('ab'), false);
	assert.equal(isSeparatorChar(null), false);
});
test('guard constants and WORD_SEPARATORS carry the verbatim values', () => {
	assert.equal(MAX_MATCHES_PER_LAYER, 500);
	assert.equal(MAX_SELECTION_QUERY_LENGTH, 200);
	assert.equal(WORD_SEPARATORS, '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?');
});
test('wordAt spans the word around the offset; a separator offset misses', () => {
	assert.deepEqual(wordAt('foo bar', 0), { start: 0, end: 3, word: 'foo' });
	assert.deepEqual(wordAt('foo bar', 1), { start: 0, end: 3, word: 'foo' });
	assert.deepEqual(wordAt('foo bar', 2), { start: 0, end: 3, word: 'foo' });
	assert.equal(wordAt('foo bar', 3), null); // 光标落在分隔符（空格）上
	assert.deepEqual(wordAt('foo bar', 4), { start: 4, end: 7, word: 'bar' });
	assert.deepEqual(wordAt('foobar', 3), { start: 0, end: 6, word: 'foobar' }); // 词尾紧贴：词内偏移
	assert.deepEqual(wordAt('foobar', 6), { start: 0, end: 6, word: 'foobar' }); // offset === end（文档末光标贴词尾）
	assert.deepEqual(wordAt('你好世界', 2), { start: 0, end: 4, word: '你好世界' }); // CJK 连续串一词
	assert.deepEqual(wordAt('a_1', 1), { start: 0, end: 3, word: 'a_1' }); // 数字+下划线一词
	assert.equal(wordAt('foo', -1), null); // 越界
	assert.equal(wordAt('foo', 4), null);
	assert.equal(wordAt('foo', 1.5), null); // 非整数
	assert.equal(wordAt('foo', Number.NaN), null);
	assert.equal(wordAt(null, 0), null); // text 非串
	assert.equal(wordAt('', 0), null);
});
test('wordQueryOf resolves the whole word for collapsed and in-word selections', () => {
	assert.deepEqual(wordQueryOf('foo', { start: 1, end: 1 }), { text: 'foo', caseSensitive: true, wholeWord: true });
	assert.equal(wordQueryOf('foo bar', { start: 3, end: 3 }), null); // 折叠在空格
	assert.deepEqual(wordQueryOf('foo', { start: 1, end: 2 }), { text: 'foo', caseSensitive: true, wholeWord: true }); // 部分选区 → 整词
	assert.deepEqual(wordQueryOf('foo', { start: 0, end: 3 }), { text: 'foo', caseSensitive: true, wholeWord: true }); // 选区=整词
	assert.deepEqual(wordQueryOf('foo', { start: 2, end: 1 }), { text: 'foo', caseSensitive: true, wholeWord: true }); // start > end 交换
	assert.equal(wordQueryOf('foo bar', { start: 0, end: 7 }), null); // 跨词
	assert.equal(wordQueryOf('foo\nbar', { start: 0, end: 7 }), null); // 跨行选区
	assert.equal(wordQueryOf('foo!', { start: 0, end: 4 }), null); // 选区尾部越出词界
	assert.equal(wordQueryOf('foo', null), null); // selection 非对象
	assert.equal(wordQueryOf('foo', 'x'), null);
	assert.equal(wordQueryOf('foo', { start: '1', end: 1 }), null); // 字段非数
});
test('selectionQueryOf returns the literal slice for usable selections', () => {
	assert.deepEqual(selectionQueryOf('foo', { start: 1, end: 3 }), { text: 'oo', caseSensitive: false, wholeWord: false });
	assert.deepEqual(selectionQueryOf('foo', { start: 3, end: 1 }), { text: 'oo', caseSensitive: false, wholeWord: false }); // 交换
	assert.equal(selectionQueryOf('foo', { start: 2, end: 2 }), null); // 空选区
	assert.equal(selectionQueryOf('foo\nbar', { start: 1, end: 7 }), null); // 含换行
	const twoHundred = 'a'.repeat(200);
	assert.deepEqual(selectionQueryOf(twoHundred, { start: 0, end: 200 }), {
		text: twoHundred,
		caseSensitive: false,
		wholeWord: false,
	}); // 长度 200 通过
	assert.equal(selectionQueryOf(`${twoHundred}b`, { start: 0, end: 201 }), null); // 201 → null
	assert.equal(selectionQueryOf('a  b', { start: 1, end: 3 }), null); // 纯空格
	assert.equal(selectionQueryOf('a\t\tb', { start: 1, end: 3 }), null); // 纯 Tab
	assert.deepEqual(selectionQueryOf('foo bar', { start: 2, end: 5 }), { text: 'o b', caseSensitive: false, wholeWord: false }); // 空格+字母混合
	assert.equal(selectionQueryOf('foo', null), null);
	assert.equal(selectionQueryOf('foo', { start: NaN, end: 3 }), null); // 字段非数
});
test('query builders never throw on non-string text', () => {
	assert.equal(wordQueryOf(null, { start: 0, end: 0 }), null);
	assert.equal(wordQueryOf(undefined, { start: 0, end: 0 }), null);
	assert.equal(selectionQueryOf(null, { start: 0, end: 3 }), null);
	assert.equal(selectionQueryOf(undefined, { start: 0, end: 3 }), null);
});
