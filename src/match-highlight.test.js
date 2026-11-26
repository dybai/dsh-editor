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
	findMatches,
	subtractRanges,
	computeMatchHighlights,
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
test('findMatches respects case sensitivity (sensitive 2 hits, insensitive 3)', () => {
	assert.deepEqual(findMatches('foo FOO foo', { text: 'foo', caseSensitive: true, wholeWord: false }), [
		{ start: 0, end: 3 },
		{ start: 8, end: 11 },
	]); // 大小写敏感 → 2 处
	assert.deepEqual(findMatches('foo FOO foo', { text: 'foo', caseSensitive: false, wholeWord: false }), [
		{ start: 0, end: 3 },
		{ start: 4, end: 7 },
		{ start: 8, end: 11 },
	]); // 不区分大小写 → 3 处
});
test('findMatches wholeWord keeps only standalone words; document edge counts as boundary', () => {
	assert.deepEqual(findMatches('foo foobar foo', { text: 'foo', caseSensitive: true, wholeWord: true }), [
		{ start: 0, end: 3 },
		{ start: 11, end: 14 },
	]); // 仅独立两处；foobar 内的不算
	assert.deepEqual(findMatches('foo foobar foo', { text: 'foo', caseSensitive: true, wholeWord: false }), [
		{ start: 0, end: 3 },
		{ start: 4, end: 7 },
		{ start: 11, end: 14 },
	]); // 全词关 → 3 处
	assert.deepEqual(findMatches('foo', { text: 'foo', caseSensitive: true, wholeWord: true }), [{ start: 0, end: 3 }]); // 两端=文档边界 → 命中
});
test('findMatches falls back to per-char compare when case folding changes length', () => {
	// 'İ'（\u0130）小写折叠成 'i\u0307' 两个字符；needle 'i\u0307' 应命中单个 'İ'（[0,1)），不抛错
	assert.deepEqual(findMatches('\u0130x ix', { text: 'i\u0307', caseSensitive: false, wholeWord: false }), [
		{ start: 0, end: 1 },
	]);
	assert.deepEqual(findMatches('ix \u0130x', { text: 'i\u0307', caseSensitive: false, wholeWord: false }), [
		{ start: 3, end: 4 },
	]); // 变长折叠命中映射回原文偏移
});
test('findMatches skips the whole layer when the match count would exceed cap', () => {
	assert.deepEqual(findMatches('a'.repeat(501), { text: 'a', caseSensitive: true, wholeWord: false }), []); // 501 > 500 → 整层 []，不给部分列表
	const exact = findMatches('a'.repeat(500), { text: 'a', caseSensitive: true, wholeWord: false });
	assert.equal(exact.length, 500); // 恰好 500 → 全部保留
	assert.deepEqual(exact[0], { start: 0, end: 1 });
	assert.deepEqual(exact[499], { start: 499, end: 500 });
	assert.deepEqual(findMatches('aaa', { text: 'a', caseSensitive: true, wholeWord: false }, 2), []); // 显式 cap：3 > 2 → []
	assert.deepEqual(findMatches('aa', { text: 'a', caseSensitive: true, wholeWord: false }, 2), [
		{ start: 0, end: 1 },
		{ start: 1, end: 2 },
	]); // 恰好等于 cap → 保留
});
test('subtractRanges drops intersecting and identical ranges, keeps disjoint and adjacent', () => {
	assert.deepEqual(subtractRanges([{ start: 0, end: 5 }, { start: 10, end: 15 }], [{ start: 3, end: 7 }]), [
		{ start: 10, end: 15 },
	]); // 相交 → 丢弃
	assert.deepEqual(subtractRanges([{ start: 2, end: 4 }], [{ start: 2, end: 4 }]), []); // 相同 → 丢弃
	assert.deepEqual(subtractRanges([{ start: 0, end: 10 }], [{ start: 2, end: 4 }]), []); // 被包含 → 丢弃
	assert.deepEqual(subtractRanges([{ start: 0, end: 3 }, { start: 3, end: 6 }], [{ start: 3, end: 5 }]), [
		{ start: 0, end: 3 },
	]); // 相邻（前一 end === 后一 start）→ 保留
	assert.deepEqual(subtractRanges([{ start: 0, end: 3 }, { start: 5, end: 8 }], [{ start: 3, end: 5 }]), [
		{ start: 0, end: 3 },
		{ start: 5, end: 8 },
	]); // 不相交 → 全保留
});
test('computeMatchHighlights word layer keeps the selection span, selection layer subtracts it', () => {
	const both = computeMatchHighlights('foo foo', { start: 0, end: 3 }, { selectionEnabled: true, wordEnabled: true });
	assert.deepEqual(both.word, [{ start: 0, end: 3 }, { start: 4, end: 7 }]); // word 层不减选区，含选区自身位置
	assert.deepEqual(both.selection, [{ start: 4, end: 7 }]); // selection 层减去选区
	const collapsed = computeMatchHighlights('foo bar foo', { start: 1, end: 1 }, { selectionEnabled: true, wordEnabled: true });
	assert.deepEqual(collapsed.word, [{ start: 0, end: 3 }, { start: 8, end: 11 }]); // 折叠光标 → 整词层
	assert.deepEqual(collapsed.selection, []); // 折叠光标 → selection 层无 query
});
test('computeMatchHighlights honors per-layer switches and null selection', () => {
	assert.deepEqual(
		computeMatchHighlights('foo foo', { start: 0, end: 3 }, { selectionEnabled: false, wordEnabled: true }),
		{ word: [{ start: 0, end: 3 }, { start: 4, end: 7 }], selection: [] }
	); // selection 层关
	assert.deepEqual(
		computeMatchHighlights('foo foo', { start: 0, end: 3 }, { selectionEnabled: true, wordEnabled: false }),
		{ word: [], selection: [{ start: 4, end: 7 }] }
	); // word 层关
	assert.deepEqual(computeMatchHighlights('foo foo', null, { selectionEnabled: true, wordEnabled: true }), {
		word: [],
		selection: [],
	}); // selection null → 双层 []
});
test('scan layer never throws on unusable input', () => {
	assert.deepEqual(findMatches(null, { text: 'foo', caseSensitive: true, wholeWord: false }), []);
	assert.deepEqual(findMatches('foo', null), []);
	assert.deepEqual(findMatches('foo', { text: '', caseSensitive: true, wholeWord: false }), []); // 空 query → []
	assert.deepEqual(findMatches('foo', { text: 'foo' }), [{ start: 0, end: 3 }]); // 字段缺失不抛错，按折叠路径
	assert.deepEqual(subtractRanges(null, [{ start: 0, end: 1 }]), []);
	assert.deepEqual(subtractRanges([{ start: 0, end: 3 }], null), [{ start: 0, end: 3 }]);
	assert.deepEqual(computeMatchHighlights(null, { start: 0, end: 3 }, { selectionEnabled: true, wordEnabled: true }), {
		word: [],
		selection: [],
	});
	assert.deepEqual(computeMatchHighlights('foo', { start: 1, end: 1 }), { word: [], selection: [] }); // opts 缺失 → 双层关
});
