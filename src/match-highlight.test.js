import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
	findMatchesDetailed,
	findLineMatches,
	intersectRangeWithLine,
	subtractRanges,
	computeMatchHighlights,
	lineStartOffsets,
	buildMatchRowFragments,
	mergeLayerRanges,
} from './match-highlight.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
test('wordAt spans the word around the offset; a right-edge hug resolves the ending word', () => {
	// VS Code wordHelper `_findRegexMatchEnclosingPosition` 语义：光标落在
	// [start, end]（闭区间）即命中 — 词尾右贴（mid-text 或文档末）解析为以
	// offset 结尾的那个词；只有左右均非词字符（分隔符串内部、行首/行尾空白）
	// 才真正落空。
	assert.deepEqual(wordAt('foo bar', 0), { start: 0, end: 3, word: 'foo' });
	assert.deepEqual(wordAt('foo bar', 1), { start: 0, end: 3, word: 'foo' });
	assert.deepEqual(wordAt('foo bar', 2), { start: 0, end: 3, word: 'foo' });
	assert.deepEqual(wordAt('foo bar', 3), { start: 0, end: 3, word: 'foo' }); // 词尾右贴：解析 foo
	assert.deepEqual(wordAt('foo bar', 4), { start: 4, end: 7, word: 'bar' });
	assert.deepEqual(wordAt('foo bar', 7), { start: 4, end: 7, word: 'bar' }); // 文档末贴词尾（旧特例现为右贴子集）
	assert.deepEqual(wordAt('foo,bar', 3), { start: 0, end: 3, word: 'foo' }); // 分隔符上的右贴同样解析
	assert.equal(wordAt('foo  bar', 4), null); // 两空格之间：左右均非词字符
	assert.equal(wordAt(' foo', 0), null); // 行首空白
	assert.equal(wordAt('foo ', 4), null); // 行尾空白（前一字符是空格）
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
	assert.deepEqual(wordQueryOf('foo bar', { start: 3, end: 3 }), { text: 'foo', caseSensitive: true, wholeWord: true }); // 折叠在词尾右贴 → 右缘语义解析整词
	assert.equal(wordQueryOf('foo  bar', { start: 4, end: 4 }), null); // 折叠在无邻接词的空隙 → null
	// ⊆ 检查不被右缘语义破坏：非空选区始于词尾右贴时 hi > word.end → 仍然 null
	assert.equal(wordQueryOf('foo bar', { start: 3, end: 5 }), null); // 选区起点=词尾，非空 → ⊆ 失败
	assert.equal(wordQueryOf('foo bar', { start: 3, end: 4 }), null); // 选区跨入分隔符 → ⊆ 失败
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
	assert.deepEqual(findMatches('a'.repeat(502), { text: 'a', caseSensitive: true, wholeWord: false }), []); // cap+2 → 仍整层 []（早退在第 501 个命中即可判定）
	assert.deepEqual(findMatches('aaa', { text: 'a', caseSensitive: true, wholeWord: false }, 2), []); // 显式 cap：3 > 2 → []
	assert.deepEqual(findMatches('aa', { text: 'a', caseSensitive: true, wholeWord: false }, 2), [
		{ start: 0, end: 1 },
		{ start: 1, end: 2 },
	]); // 恰好等于 cap → 保留
	// 全词路径：只有边界命中计入 cap（内嵌命中不占额度）
	assert.deepEqual(findMatches('a a a a a a a', { text: 'a', caseSensitive: true, wholeWord: true }, 5), []); // 7 个边界命中 > 5 → []
	assert.deepEqual(findMatches('a a a a a', { text: 'a', caseSensitive: true, wholeWord: true }, 5), [
		{ start: 0, end: 1 },
		{ start: 2, end: 3 },
		{ start: 4, end: 5 },
		{ start: 6, end: 7 },
		{ start: 8, end: 9 },
	]); // 恰好 5 个边界命中 → 全部保留
	assert.deepEqual(findMatches('abx abx abx ab ab ab ab ab ab', { text: 'ab', caseSensitive: true, wholeWord: true }, 5), []); // 原始命中 9，边界命中 6 > 5 → []
	// 折叠路径同样封顶
	assert.deepEqual(findMatches('aA aA aA aA aA aA aA', { text: 'aa', caseSensitive: false, wholeWord: false }, 5), []); // 7 命中 > 5 → []
});
test('the scan layer threads the cap into the scanners and stops at limit+1 hits (source markers)', () => {
	// 行为语义与全量物化恒等（≤ cap → 全部；> cap → 整层 []），早退结构本身
	// 不可行为观测 — 其缺失只会静默退化回全量物化（4MB 文档下 10^4–10^5 次
	// 对象分配/次重算），按 spec §9 的防退化约定钉为源标记（与
	// components.test.js 的 wiring 钉法同一纪律）。
	const source = readFileSync(path.join(HERE, 'match-highlight.js'), 'utf8');
	const scanSpan = (name) => {
		const at = source.indexOf(`function ${name}`);
		assert.ok(at !== -1, `${name} was found in src/match-highlight.js`);
		return source.slice(at, source.indexOf('\n}', at));
	};
	assert.ok(source.includes('function scanLiteral(text, needle, limit, accept)'), 'scanLiteral takes the cap');
	assert.ok(source.includes('function scanCaseInsensitive(text, needle, limit, accept)'), 'scanCaseInsensitive takes the cap');
	assert.ok(source.includes('function scanLengthChangingFold(text, needleFolded, limit, accept)'), 'the fold fallback takes the cap');
	assert.ok(scanSpan('scanLiteral').includes('hits.length > limit'), 'scanLiteral stops pushing past the cap');
	assert.ok(scanSpan('scanLengthChangingFold').includes('hits.length > limit'), 'the fold fallback stops pushing past the cap');
	assert.ok(
		source.includes('scanLiteral(text, query.text, limit, accept)') && source.includes('scanCaseInsensitive(text, query.text, limit, accept)'),
		'findMatches threads the cap and the boundary acceptor into both scanners'
	);
	assert.ok(scanSpan('scanLiteral').includes('accept(at, end)'), 'the whole-word boundary check runs inline in the literal scan');
	assert.ok(scanSpan('scanLengthChangingFold').includes('accept(piece, end)'), 'the whole-word boundary check runs inline in the fold fallback');
});
test('findMatchesDetailed reports the over-cap flag the array return cannot express', () => {
	// 0.18.0 窗口扫描修订：超限信号必须可观测——数组 [] 分不清"无命中"
	// 与"超限早退"，overCap 旗标是绘制侧转窗口扫描的唯一触发依据。
	assert.deepEqual(findMatchesDetailed('a'.repeat(502), { text: 'a', caseSensitive: true, wholeWord: false }), {
		ranges: [],
		overCap: true,
	}); // cap+2 → 早退即判定：ranges [] + overCap true
	const exact = findMatchesDetailed('a'.repeat(500), { text: 'a', caseSensitive: true, wholeWord: false });
	assert.equal(exact.overCap, false); // 恰好 cap → 全部物化
	assert.equal(exact.ranges.length, 500);
	assert.deepEqual(exact.ranges[0], { start: 0, end: 1 });
	assert.deepEqual(exact.ranges[499], { start: 499, end: 500 });
	assert.deepEqual(findMatchesDetailed('aaa', { text: 'a', caseSensitive: true, wholeWord: false }, 2), {
		ranges: [],
		overCap: true,
	}); // 显式 cap：3 > 2 → 超限
	// 全词路径计数一致：只有边界命中计入 cap（内嵌命中不占额度）
	assert.deepEqual(findMatchesDetailed('a a a a a a a', { text: 'a', caseSensitive: true, wholeWord: true }, 5), {
		ranges: [],
		overCap: true,
	}); // 7 个边界命中 > 5
	const fiveWords = findMatchesDetailed('a a a a a', { text: 'a', caseSensitive: true, wholeWord: true }, 5);
	assert.equal(fiveWords.overCap, false);
	assert.equal(fiveWords.ranges.length, 5);
	// 折叠路径同样封顶
	assert.deepEqual(findMatchesDetailed('aA aA aA aA aA aA aA', { text: 'aa', caseSensitive: false, wholeWord: false }, 5), {
		ranges: [],
		overCap: true,
	});
});
test('findMatchesDetailed degrades unusable input to { ranges: [], overCap: false } — a degrade is not an over-cap', () => {
	assert.deepEqual(findMatchesDetailed(null, { text: 'foo', caseSensitive: true, wholeWord: false }), { ranges: [], overCap: false });
	assert.deepEqual(findMatchesDetailed('foo', null), { ranges: [], overCap: false });
	assert.deepEqual(findMatchesDetailed('foo', { text: '', caseSensitive: true, wholeWord: false }), { ranges: [], overCap: false });
	assert.deepEqual(findMatchesDetailed('foo', { text: 'foo' }), { ranges: [{ start: 0, end: 3 }], overCap: false }); // 字段缺失不抛错，按折叠路径
});
test('findMatches stays the thin wrapper over findMatchesDetailed ranges', () => {
	const query = { text: 'foo', caseSensitive: false, wholeWord: false };
	assert.deepEqual(findMatches('foo FOO foo', query), findMatchesDetailed('foo FOO foo', query).ranges); // under-cap 恒等
	const hot = { text: 'a', caseSensitive: true, wholeWord: false };
	assert.deepEqual(findMatches('a'.repeat(501), hot), findMatchesDetailed('a'.repeat(501), hot).ranges); // 超限同样恒等（[]）
});
test('findLineMatches scans one logical line and maps hits to document offsets', () => {
	assert.deepEqual(findLineMatches('e foo e', 10, { text: 'e', caseSensitive: false, wholeWord: false }), [
		{ start: 10, end: 11 },
		{ start: 16, end: 17 },
	]); // 行内偏移 0/6 → 文档偏移 +lineStart
	assert.deepEqual(findLineMatches('FOO foo', 3, { text: 'foo', caseSensitive: false, wholeWord: false }), [
		{ start: 3, end: 6 },
		{ start: 7, end: 10 },
	]); // 大小写折叠路径同样平移
	assert.deepEqual(findLineMatches('foo', 0, { text: 'foo', caseSensitive: true, wholeWord: true }), [{ start: 0, end: 3 }]); // 行边界即词边界（换行本就是分隔符）
	assert.deepEqual(findLineMatches('abx abx ab', 4, { text: 'ab', caseSensitive: true, wholeWord: true }), [
		{ start: 12, end: 14 },
	]); // 全词：abx 内嵌不算，仅独立 ab（行内 [8,10) → 文档 [12,14)）
	assert.deepEqual(findLineMatches('aaa', 0, { text: 'a', caseSensitive: true, wholeWord: false }, 2), []); // 行内 3 命中 > cap 2 → 该行 []
	assert.deepEqual(findLineMatches(undefined, 5, { text: 'a', caseSensitive: true, wholeWord: false }), []); // 非串行 → []
	assert.deepEqual(findLineMatches('foo', 5, null), []); // null query → []
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
		{
			word: [{ start: 0, end: 3 }, { start: 4, end: 7 }],
			selection: [],
			wordOverCap: false,
			selectionOverCap: false,
			queries: { word: { text: 'foo', caseSensitive: true, wholeWord: true }, selection: null },
		}
	); // selection 层关 → 查询 null，旗标 false
	assert.deepEqual(
		computeMatchHighlights('foo foo', { start: 0, end: 3 }, { selectionEnabled: true, wordEnabled: false }),
		{
			word: [],
			selection: [{ start: 4, end: 7 }],
			wordOverCap: false,
			selectionOverCap: false,
			queries: { word: null, selection: { text: 'foo', caseSensitive: false, wholeWord: false } },
		}
	); // word 层关 → 查询 null
	assert.deepEqual(computeMatchHighlights('foo foo', null, { selectionEnabled: true, wordEnabled: true }), {
		word: [],
		selection: [],
		wordOverCap: false,
		selectionOverCap: false,
		queries: { word: null, selection: null },
	}); // selection null → 双层 []，无查询
});
test('computeMatchHighlights flags an over-cap selection layer and returns the query it scanned with', () => {
	// 高频短串（用户验收场景：大文件里选 'e'）：选区层 501 命中 > 500 →
	// 数组 [] + selectionOverCap true + 查询原样返回——绘制侧据此转可视
	// 窗口扫描，层不再因频次失效。词层同一选区仍 under-cap。
	const over = computeMatchHighlights('e'.repeat(501), { start: 0, end: 1 }, { selectionEnabled: true, wordEnabled: true });
	assert.equal(over.selectionOverCap, true);
	assert.deepEqual(over.selection, []);
	assert.deepEqual(over.queries.selection, { text: 'e', caseSensitive: false, wholeWord: false }); // 查询与数组同源
	assert.equal(over.wordOverCap, false); // 501 个 'e' 连成一词 → 1 个全词命中
	assert.deepEqual(over.word, [{ start: 0, end: 501 }]);
	assert.deepEqual(over.queries.word, { text: 'e'.repeat(501), caseSensitive: true, wholeWord: true });
});
test('computeMatchHighlights flags an over-cap word layer the same way', () => {
	// both 组合的另一侧：词层超限、选区层无查询（折叠光标）。
	const over = computeMatchHighlights('a '.repeat(501), { start: 0, end: 0 }, { selectionEnabled: true, wordEnabled: true });
	assert.equal(over.wordOverCap, true); // 501 个独立 'a' > 500
	assert.deepEqual(over.word, []);
	assert.deepEqual(over.queries.word, { text: 'a', caseSensitive: true, wholeWord: true });
	assert.equal(over.selectionOverCap, false);
	assert.deepEqual(over.queries.selection, null);
});
test('computeMatchHighlights threads the cap option into both layers', () => {
	const over = computeMatchHighlights('foo foo foo', { start: 0, end: 3 }, { selectionEnabled: true, wordEnabled: false, cap: 2 });
	assert.equal(over.selectionOverCap, true); // 3 命中 > cap 2
	assert.deepEqual(over.selection, []);
	const under = computeMatchHighlights('foo foo foo', { start: 0, end: 3 }, { selectionEnabled: true, wordEnabled: false, cap: 3 });
	assert.equal(under.selectionOverCap, false);
	assert.deepEqual(under.selection, [{ start: 4, end: 7 }, { start: 8, end: 11 }]); // 选区自身位置仍被排除
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
		wordOverCap: false,
		selectionOverCap: false,
		queries: { word: null, selection: null },
	});
	assert.deepEqual(computeMatchHighlights('foo', { start: 1, end: 1 }), {
		word: [],
		selection: [],
		wordOverCap: false,
		selectionOverCap: false,
		queries: { word: null, selection: null },
	}); // opts 缺失 → 双层关
});
test('lineStartOffsets accumulates line lengths plus one newline per line', () => {
	assert.deepEqual(lineStartOffsets(['ab', 'c', '', 'd']), [0, 3, 5, 6]); // 第 i+1 行 = 前行内容 + 一个 '\n' 之后
	assert.deepEqual(lineStartOffsets([]), []); // 空数组 → []
	assert.deepEqual(lineStartOffsets('ab'), [0]); // 非数组 → [0]（首行从 0 开始）
	assert.deepEqual(lineStartOffsets(['ab', 5]), [0, 3]); // 非串元素按长度 0 计
});
test('buildMatchRowFragments with no matches yields a single plain run over the line or slice', () => {
	assert.deepEqual(buildMatchRowFragments('foo bar', 0, [], [], null), [{ text: 'foo bar', layer: 'plain' }]);
	assert.deepEqual(buildMatchRowFragments('foo bar', 0, [], [], { start: 1, end: 4 }), [
		{ text: 'oo ', layer: 'plain' },
	]); // 整切片：runs 精确覆盖 slice
});
test('buildMatchRowFragments splits a word match with a plain gap', () => {
	assert.deepEqual(buildMatchRowFragments('foo bar', 0, [{ start: 0, end: 3 }], [], null), [
		{ text: 'foo', layer: 'word' },
		{ text: ' bar', layer: 'plain' },
	]);
});
test('buildMatchRowFragments merges co-located layers into a single both run', () => {
	assert.deepEqual(buildMatchRowFragments('foo bar', 0, [{ start: 0, end: 3 }], [{ start: 0, end: 3 }], null), [
		{ text: 'foo', layer: 'both' },
		{ text: ' bar', layer: 'plain' },
	]); // 同一偏移同属两层 → 单 run 'both'
	assert.deepEqual(buildMatchRowFragments('foo bar', 0, [{ start: 0, end: 6 }], [{ start: 3, end: 6 }], null), [
		{ text: 'foo', layer: 'word' },
		{ text: ' ba', layer: 'both' },
		{ text: 'r', layer: 'plain' },
	]); // 部分重叠段才标 'both'（[3,6) = ' ba'）
});
test('buildMatchRowFragments keeps adjacent matches unmerged as separate runs', () => {
	assert.deepEqual(buildMatchRowFragments('abc', 0, [{ start: 0, end: 1 }, { start: 2, end: 3 }], [], null), [
		{ text: 'a', layer: 'word' },
		{ text: 'b', layer: 'plain' },
		{ text: 'c', layer: 'word' },
	]); // 三段
	assert.deepEqual(buildMatchRowFragments('ab', 0, [{ start: 0, end: 1 }, { start: 1, end: 2 }], [], null), [
		{ text: 'a', layer: 'word' },
		{ text: 'b', layer: 'word' },
	]); // 相邻同层 run 也不合并
});
test('buildMatchRowFragments splits a boundary-crossing match exactly at the slice seam', () => {
	const line = 'foobarbaz';
	const front = buildMatchRowFragments(line, 0, [{ start: 3, end: 6 }], [], { start: 0, end: 4 });
	const back = buildMatchRowFragments(line, 0, [{ start: 3, end: 6 }], [], { start: 4, end: 9 });
	assert.deepEqual(front, [
		{ text: 'foo', layer: 'plain' },
		{ text: 'b', layer: 'word' },
	]); // [3,6) ∩ [0,4) = [3,4)：前片只含 'b'
	assert.deepEqual(back, [
		{ text: 'ar', layer: 'word' },
		{ text: 'baz', layer: 'plain' },
	]); // [3,6) ∩ [4,9) = [4,6)：后片只含 'ar'
	const joined = [...front, ...back].map((run) => run.text).join('');
	assert.equal(joined, line); // 两片 runs 拼接回原行，不重不漏
	assert.equal(front[front.length - 1].text + back[0].text, 'bar'); // 'bar' 恰在边界 4 精确切分
});
test('buildMatchRowFragments emits only the intersecting part of partially clipped matches', () => {
	assert.deepEqual(buildMatchRowFragments('abcdef', 0, [{ start: 0, end: 3 }], [], { start: 1, end: 4 }), [
		{ text: 'bc', layer: 'word' },
		{ text: 'd', layer: 'plain' },
	]); // 行首截断：匹配只与切片相交于 [1,3)
	assert.deepEqual(buildMatchRowFragments('abcdef', 0, [{ start: 3, end: 6 }], [], { start: 0, end: 4 }), [
		{ text: 'abc', layer: 'plain' },
		{ text: 'd', layer: 'word' },
	]); // 行尾截断：匹配只与切片相交于 [3,4)
});
test('buildMatchRowFragments translates document offsets by lineStart', () => {
	const lineRelative = buildMatchRowFragments('foobarbaz', 0, [{ start: 3, end: 6 }], [], null);
	const byDocOffsets = buildMatchRowFragments('foobarbaz', 10, [{ start: 13, end: 16 }], [], null);
	assert.deepEqual(byDocOffsets, lineRelative); // lineStart=10 时 [{13,16}] 与行内 [{3,6}] 等效
	assert.deepEqual(byDocOffsets, [
		{ text: 'foo', layer: 'plain' },
		{ text: 'bar', layer: 'word' },
		{ text: 'baz', layer: 'plain' },
	]);
});
test('buildMatchRowFragments degrades unusable input to empty runs, never throws', () => {
	assert.deepEqual(buildMatchRowFragments(123, 0, [], [], null), []); // 非串 lineText → 空 runs
	assert.deepEqual(buildMatchRowFragments(null, 0, [], [], null), []);
	assert.deepEqual(buildMatchRowFragments('foo', 0, null, [], null), []); // 非数组 matches → 空 runs
	assert.deepEqual(buildMatchRowFragments('foo', 0, [], 'x', null), []);
	assert.deepEqual(buildMatchRowFragments('foobarbaz', 0, [{ start: 3, end: 6 }], [], { start: 5, end: 2 }), []); // 倒置 slice → 空
	assert.deepEqual(buildMatchRowFragments('foo', 0, [{ start: 'a', end: 3 }], [], null), [
		{ text: 'foo', layer: 'plain' },
	]); // 残缺匹配条目跳过，不抛错
});

/* --------------------------------------------------- mergeLayerRanges -- */

test('mergeLayerRanges merges co-located spans into a both range, overlaps split per segment', () => {
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 3 }], [{ start: 0, end: 3 }]), [
		{ start: 0, end: 3, layer: 'both' },
	]); // 同位同 span → 单条 'both'
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 6 }], [{ start: 3, end: 6 }]), [
		{ start: 0, end: 3, layer: 'word' },
		{ start: 3, end: 6, layer: 'both' },
	]); // 仅真正重叠的段标 'both'
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 2 }], [{ start: 1, end: 4 }]), [
		{ start: 0, end: 1, layer: 'word' },
		{ start: 1, end: 2, layer: 'both' },
		{ start: 2, end: 4, layer: 'selection' },
	]); // 交叠并集按文档序切为三段
});
test('mergeLayerRanges keeps adjacent ranges unmerged as separate entries', () => {
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 1 }, { start: 1, end: 2 }], []), [
		{ start: 0, end: 1, layer: 'word' },
		{ start: 1, end: 2, layer: 'word' },
	]); // 相邻同层条目也不合并（逐段输出，与 buildMatchRowFragments 同纪律）
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 2 }], [{ start: 2, end: 4 }]), [
		{ start: 0, end: 2, layer: 'word' },
		{ start: 2, end: 4, layer: 'selection' },
	]); // 跨层相邻同样不合并
});
test('mergeLayerRanges emits only covered spans; inter-layer gaps are absent', () => {
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 2 }], [{ start: 5, end: 7 }]), [
		{ start: 0, end: 2, layer: 'word' },
		{ start: 5, end: 7, layer: 'selection' },
	]); // 间隙 [2,5) 不输出（无 'plain' 层）
	assert.deepEqual(mergeLayerRanges([], [{ start: 3, end: 4 }]), [{ start: 3, end: 4, layer: 'selection' }]);
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 4 }], []), [{ start: 0, end: 4, layer: 'word' }]);
	assert.deepEqual(mergeLayerRanges([], []), []); // 双层皆空 → []
});
test('mergeLayerRanges degrades unusable input to empty output, never throws', () => {
	assert.deepEqual(mergeLayerRanges(null, null), []);
	assert.deepEqual(mergeLayerRanges('x', 42), []); // 非数组层 → []
	assert.deepEqual(mergeLayerRanges([{ start: 'a', end: 3 }], [{ start: 0, end: 2 }]), [
		{ start: 0, end: 2, layer: 'selection' },
	]); // 残缺条目跳过，不绕它切分
	assert.deepEqual(mergeLayerRanges([{ start: 5, end: 2 }], []), [{ start: 2, end: 5, layer: 'word' }]); // 倒置条目交换
	assert.deepEqual(mergeLayerRanges([{ start: 3, end: 3 }], [{ start: 0, end: 1 }]), [
		{ start: 0, end: 1, layer: 'selection' },
	]); // 零长条目跳过
	assert.deepEqual(mergeLayerRanges([{ start: 0.9, end: 2.5 }], []), [{ start: 0, end: 2, layer: 'word' }]); // 小数下取整到字符索引
});

/* ------------------------------------------ intersectRangeWithLine -- */
// 2026-11-26 active-tint 修订：当前选区按可视逻辑行裁剪的纯函数——
// syncExtraLayers 用它把 live 选区变成 per-line tint 的第三源
// （mergeLayerRanges 的 active 参数）。

test('intersectRangeWithLine returns the covered part of the line in document offsets', () => {
	// 行 [4,10)（lineStart 4，6 字符文本）：选区完全在行内 → 原样交回。
	assert.deepEqual(intersectRangeWithLine(6, 9, 4, 'abcdef'), { start: 6, end: 9 });
	// 选区跨行覆盖整行（起点在行前、终点在行后）→ 裁剪到行界。
	assert.deepEqual(intersectRangeWithLine(0, 20, 4, 'abcdef'), { start: 4, end: 10 });
	// 单侧越界：起点在行前裁到行首；终点在行后裁到行尾。
	assert.deepEqual(intersectRangeWithLine(2, 8, 4, 'abcdef'), { start: 4, end: 8 });
	assert.deepEqual(intersectRangeWithLine(6, 30, 4, 'abcdef'), { start: 6, end: 10 });
});
test('intersectRangeWithLine clips a multi-line selection per line: each line keeps its own covered span', () => {
	// 文档 'ab\ncdef\nghi'（行起点 0/3/8），选区 [1,9)：三行各取所覆盖
	// 部分——'b'、'cdef'、'g'。换行符不属于任何行的 tint（token 行不绘
	// 制换行符），行文本边界即裁剪边界。
	assert.deepEqual(intersectRangeWithLine(1, 9, 0, 'ab'), { start: 1, end: 2 });
	assert.deepEqual(intersectRangeWithLine(1, 9, 3, 'cdef'), { start: 3, end: 7 });
	assert.deepEqual(intersectRangeWithLine(1, 9, 8, 'ghi'), { start: 8, end: 9 });
});
test('intersectRangeWithLine answers null for disjoint, edge-touching and collapsed selections', () => {
	assert.equal(intersectRangeWithLine(0, 2, 4, 'abcdef'), null); // 选区止于行前（贴行首不算：半开区间）
	assert.equal(intersectRangeWithLine(10, 12, 4, 'abcdef'), null); // 选区始于行尾（贴行尾同样不算）
	assert.equal(intersectRangeWithLine(2, 5, 0, 'ab'), null); // 选区含换行符位（行文本止于 2）
	assert.equal(intersectRangeWithLine(6, 6, 4, 'abcdef'), null); // 折叠光标 → 无活动 tint
	assert.equal(intersectRangeWithLine(2, 2, 0, 'abcdef'), null);
});
test('intersectRangeWithLine swaps reversed bounds and floors fractional offsets', () => {
	assert.deepEqual(intersectRangeWithLine(9, 6, 4, 'abcdef'), { start: 6, end: 9 }); // 倒置选区交换
	assert.deepEqual(intersectRangeWithLine(2.9, 5.1, 0, 'abcdef'), { start: 2, end: 5 }); // 小数下取整到字符索引
});
test('intersectRangeWithLine degrades unusable input to null, never throws', () => {
	assert.equal(intersectRangeWithLine(undefined, 5, 0, 'abc'), null); // 非数字选区界
	assert.equal(intersectRangeWithLine(1, 'x', 0, 'abc'), null);
	assert.equal(intersectRangeWithLine(Number.NaN, 5, 0, 'abc'), null); // 非有限数
	assert.equal(intersectRangeWithLine(1, Number.POSITIVE_INFINITY, 0, 'abc'), null);
	assert.equal(intersectRangeWithLine(0, 3, Number.NaN, 'abc'), null); // 非有限 lineStart → 行不可定位
	assert.equal(intersectRangeWithLine(0, 3, 'x', 'abc'), null);
	assert.equal(intersectRangeWithLine(0, 3, 0, null), null); // 非串 lineText → 空行
	assert.equal(intersectRangeWithLine(0, 3, 0, 42), null);
	assert.equal(intersectRangeWithLine(0, 0, 0, ''), null); // 空行 + 折叠选区
	assert.equal(intersectRangeWithLine(0, 2, 5, ''), null); // 空行（只剩换行符位，无 tint）
});

/* ------------------------------ mergeLayerRanges: the active source -- */
// 2026-11-26 active-tint 修订：第三源 active（live 选区），标签优先级
// active > both > selection > word；二参调用与不可用 active 退化保持
// 修订前行为（既有二参测试是回归锚点，必须全绿）。

test('mergeLayerRanges ranks the active label above both, selection and word', () => {
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 6 }], [{ start: 3, end: 9 }], [{ start: 2, end: 5 }]), [
		{ start: 0, end: 2, layer: 'word' },
		{ start: 2, end: 5, layer: 'active' },
		{ start: 5, end: 6, layer: 'both' },
		{ start: 6, end: 9, layer: 'selection' },
	]); // 三源并集：active 覆盖段无论是否有匹配层同覆，一律 'active'
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 4 }], [], [{ start: 1, end: 3 }]), [
		{ start: 0, end: 1, layer: 'word' },
		{ start: 1, end: 3, layer: 'active' },
		{ start: 3, end: 4, layer: 'word' },
	]); // active 压 word
	assert.deepEqual(mergeLayerRanges([], [{ start: 0, end: 4 }], [{ start: 1, end: 3 }]), [
		{ start: 0, end: 1, layer: 'selection' },
		{ start: 1, end: 3, layer: 'active' },
		{ start: 3, end: 4, layer: 'selection' },
	]); // active 压 selection
});
test('mergeLayerRanges labels an active span co-located with a selection span active', () => {
	assert.deepEqual(mergeLayerRanges([], [{ start: 0, end: 3 }], [{ start: 0, end: 3 }]), [
		{ start: 0, end: 3, layer: 'active' },
	]); // active 与 selection 同位 → active（当前选区读强于其它匹配）
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 3 }], [{ start: 0, end: 3 }], [{ start: 0, end: 3 }]), [
		{ start: 0, end: 3, layer: 'active' },
	]); // word+selection+active 三层同位仍是 active
});
test('mergeLayerRanges emits active-only coverage when no match layer has content', () => {
	// 匹配层皆空的形态（如跨行选区：词查询跨词、选区查询含换行，双双
	// 丢弃）：active 单独成段——原生选区被抑制后它是选区的唯一视觉。
	assert.deepEqual(mergeLayerRanges([], [], [{ start: 1, end: 4 }]), [{ start: 1, end: 4, layer: 'active' }]);
});
test('mergeLayerRanges two-argument calls stay unchanged; a malformed active degrades to them', () => {
	// 二参契约回归锚点：显式 undefined 第三参与省略第三参输出一致。
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 3 }], [{ start: 3, end: 6 }], undefined), [
		{ start: 0, end: 3, layer: 'word' },
		{ start: 3, end: 6, layer: 'selection' },
	]);
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 3 }], [{ start: 3, end: 6 }]), [
		{ start: 0, end: 3, layer: 'word' },
		{ start: 3, end: 6, layer: 'selection' },
	]);
	// 非数组 / 残缺条目 / 零长条目：active 源按与其它层同一防御纪律归
	// 一，不可用输入退化为二参行为，绝不抛错。
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 3 }], [], null), [{ start: 0, end: 3, layer: 'word' }]);
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 3 }], [], 'x'), [{ start: 0, end: 3, layer: 'word' }]);
	assert.deepEqual(mergeLayerRanges([{ start: 0, end: 3 }], [], 42), [{ start: 0, end: 3, layer: 'word' }]);
	assert.deepEqual(
		mergeLayerRanges([{ start: 0, end: 3 }], [], [null, { start: 'a', end: 2 }, { start: 5, end: 5 }]),
		[{ start: 0, end: 3, layer: 'word' }]
	); // 残缺/零长条目跳过
	assert.deepEqual(mergeLayerRanges([], [], [{ start: 9, end: 2 }]), [{ start: 2, end: 9, layer: 'active' }]); // 倒置条目交换
	assert.deepEqual(mergeLayerRanges([], [], [{ start: 1.9, end: 4.5 }]), [{ start: 1, end: 4, layer: 'active' }]); // 小数下取整
});
