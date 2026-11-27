import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MATCHES_PER_LAYER, computeMatchHighlights, lineStartOffsets } from '../match-highlight.js';
import { visibleTokenLineCeiling, matchDecorationDescriptors } from './match-decorations.js';

/* --------------------------------------------- visibleTokenLineCeiling -- */

test('visibleTokenLineCeiling: 非 progressive 会话放行到 toLine', () => {
	// 普通同步会话（全量已 token 化）→ 装饰区间原样放行。
	assert.equal(visibleTokenLineCeiling({ idle: false, degraded: false, progressive: false, progressLine: 0 }, 5, 100), 100);
	// 旗标缺失的裸对象按普通会话读（idle/degraded/progressive 均 ≠ true）。
	assert.equal(visibleTokenLineCeiling({}, 5, 100), 100);
});

test('visibleTokenLineCeiling: progressive 收口到 progressLine，永不越过（Review Focus 4 的钉子）', () => {
	// 给未 token 化的行上装饰 = 错误高亮：渐进会话的装饰区间收口到
	// min(toLine, max(fromLine, progressLine))。
	const session = { idle: false, degraded: false, progressive: true, progressLine: 40 };
	assert.equal(visibleTokenLineCeiling(session, 0, 100), 40); // progressLine < toLine → progressLine
	assert.equal(visibleTokenLineCeiling(session, 0, 40), 40); // progressLine === toLine → toLine
	assert.equal(visibleTokenLineCeiling(session, 0, 10), 10); // progressLine > toLine → toLine
	assert.equal(visibleTokenLineCeiling(session, 30, 60), 40); // 区间中段 → progressLine
	assert.equal(visibleTokenLineCeiling(session, 40, 100), 40); // progressLine === fromLine → fromLine
	assert.equal(visibleTokenLineCeiling(session, 50, 100), 50); // progressLine < fromLine → fromLine
});

test('visibleTokenLineCeiling: idle / degraded → fromLine（无 decoration）', () => {
	// 大文件 park 或预算爆掉 → 没有 token 可读 → 整段不放行。
	assert.equal(visibleTokenLineCeiling({ idle: true, degraded: false, progressive: false, progressLine: 0 }, 7, 100), 7);
	assert.equal(visibleTokenLineCeiling({ idle: false, degraded: true, progressive: false, progressLine: 0 }, 7, 100), 7);
	// idle / degraded 优先于 progressive：parked 的渐进会话照样不放行。
	assert.equal(visibleTokenLineCeiling({ idle: true, degraded: false, progressive: true, progressLine: 90 }, 7, 100), 7);
	assert.equal(visibleTokenLineCeiling({ idle: false, degraded: true, progressive: true, progressLine: 90 }, 7, 100), 7);
});

test('visibleTokenLineCeiling: 行号与会话的防御归一，绝不抛错', () => {
	const normal = { idle: false, degraded: false, progressive: false, progressLine: 0 };
	assert.equal(visibleTokenLineCeiling(normal, -5, 100), 100); // fromLine 负数 → 0，普通放行
	assert.equal(visibleTokenLineCeiling(normal, 10, 4), 10); // toLine < fromLine → fromLine
	assert.equal(visibleTokenLineCeiling(normal, Number.NaN, 100), 100); // fromLine 非有限 → 0
	assert.equal(visibleTokenLineCeiling(normal, 5, Number.NaN), 5); // toLine 非有限 → fromLine
	assert.equal(visibleTokenLineCeiling(normal, Number.NEGATIVE_INFINITY, 3), 3);
	assert.equal(visibleTokenLineCeiling(normal, 2.9, 8.9), 8); // 小数行号下取整到行索引
	assert.equal(visibleTokenLineCeiling(null, 3, 100), 3); // 无会话 → 无 token → 不放行
	assert.equal(visibleTokenLineCeiling(undefined, 3, 100), 3);
	assert.equal(visibleTokenLineCeiling('x', 3, 100), 3);
	// progressLine 非有限按 0 读 → 收口到 fromLine。
	const progressiveNaN = { idle: false, degraded: false, progressive: true, progressLine: Number.NaN };
	assert.equal(visibleTokenLineCeiling(progressiveNaN, 2, 100), 2);
	// progressLine 负数按 clamp 收口到 fromLine。
	const progressiveNegative = { idle: false, degraded: false, progressive: true, progressLine: -3 };
	assert.equal(visibleTokenLineCeiling(progressiveNegative, 2, 100), 2);
});

/* ---------------------------------------- matchDecorationDescriptors -- */
// 全量路径：小文档直接复用 computeMatchHighlights，输出从 {start,end}
// 平移成 CM6 的 {from,to} 描述子。

test('matchDecorationDescriptors: 小文档全量 = computeMatchHighlights 结果换成 {from,to}', () => {
	const cases = [
		['foo foo', { start: 0, end: 3 }],
		['foo bar foo', { start: 1, end: 1 }],
		['foo FOO foo', { start: 0, end: 3 }],
		['foo foobar foo', { start: 4, end: 7 }],
	];
	for (const [text, selection] of cases) {
		const reference = computeMatchHighlights(text, selection, { selectionEnabled: true, wordEnabled: true });
		assert.deepEqual(matchDecorationDescriptors({ text, selection, selectionEnabled: true, wordEnabled: true }), {
			word: reference.word.map((range) => ({ from: range.start, to: range.end })),
			selection: reference.selection.map((range) => ({ from: range.start, to: range.end })),
		});
	}
	// 具体形状（移植 computeMatchHighlights 用例）：折叠光标 → 整词层两处、
	// 选区层无 query。
	assert.deepEqual(matchDecorationDescriptors({ text: 'foo bar foo', selection: { start: 1, end: 1 }, selectionEnabled: true, wordEnabled: true }), {
		word: [{ from: 0, to: 3 }, { from: 8, to: 11 }],
		selection: [],
	});
});

test('matchDecorationDescriptors: under-cap 时忽略 viewport，恰好 500 命中仍全量物化', () => {
	// 500 个独立 'a' 行 = 恰好 cap：全量物化保留全部命中，viewport 不生效。
	const text = Array.from({ length: MAX_MATCHES_PER_LAYER }, () => 'a').join('\n');
	const descriptors = matchDecorationDescriptors({
		text,
		selection: { start: 0, end: 0 },
		viewport: { fromLine: 3, toLine: 5 }, // 若被误用会只剩 3 处
		selectionEnabled: false,
		wordEnabled: true,
	});
	assert.equal(descriptors.word.length, MAX_MATCHES_PER_LAYER);
	assert.deepEqual(descriptors.word[0], { from: 0, to: 1 });
	assert.deepEqual(descriptors.word[MAX_MATCHES_PER_LAYER - 1], { from: 998, to: 999 });
	assert.deepEqual(descriptors.selection, []);
});

test('matchDecorationDescriptors: 超限词层回退 viewport 行区间（层永不跳过）', () => {
	// 501 个独立 'a' 行 → 词层全量超限 → 物化 [] → 该层只在 viewport 行
	// 区间 [3,5] 内重算，命中平移回 doc 坐标。
	const text = Array.from({ length: MAX_MATCHES_PER_LAYER + 1 }, () => 'a').join('\n');
	const descriptors = matchDecorationDescriptors({
		text,
		selection: { start: 0, end: 0 },
		viewport: { fromLine: 3, toLine: 5 },
		selectionEnabled: false,
		wordEnabled: true,
	});
	// 行 i 的 'a' 在 doc 偏移 [2i, 2i+1)：行 3/4/5 → [6,7)/[8,9)/[10,11)。
	assert.deepEqual(descriptors.word, [{ from: 6, to: 7 }, { from: 8, to: 9 }, { from: 10, to: 11 }]);
	assert.deepEqual(descriptors.selection, []);
});

test('matchDecorationDescriptors: 超限选区层回退 viewport 行区间并保留选区排除', () => {
	// 501 个独立 'e' 行 + 选中行 0 的 'e' → 选区层全量超限 → viewport
	// [0,2] 内重算，选区自身位置仍被 subtractRanges 排除。
	const text = Array.from({ length: MAX_MATCHES_PER_LAYER + 1 }, () => 'e').join('\n');
	const descriptors = matchDecorationDescriptors({
		text,
		selection: { start: 0, end: 1 },
		viewport: { fromLine: 0, toLine: 2 },
		selectionEnabled: true,
		wordEnabled: false,
	});
	assert.deepEqual(descriptors.selection, [{ from: 2, to: 3 }, { from: 4, to: 5 }]); // 选区自身 [0,1) 不在
	assert.deepEqual(descriptors.word, []);
});

test('matchDecorationDescriptors: 两层独立回退——词层全量、选区层 viewport', () => {
	// 400 个独立 'e' 行（词层 'e' 全词命中 400 ≤ cap）+ 一行 200 个 'ee'
	// （选区层字面 'e' 命中 400 + 400 = 800 > cap）：同一选区下词层不回退
	// （viewport 被忽略，仍 400 处），选区层回退到 viewport 行区间。
	const eeLine = 'ee '.repeat(200).trimEnd();
	const text = [...Array.from({ length: 400 }, () => 'e'), eeLine].join('\n');
	const descriptors = matchDecorationDescriptors({
		text,
		selection: { start: 0, end: 1 },
		viewport: { fromLine: 3, toLine: 5 },
		selectionEnabled: true,
		wordEnabled: true,
	});
	assert.equal(descriptors.word.length, 400); // under-cap：全量，viewport 不生效
	assert.deepEqual(descriptors.word[0], { from: 0, to: 1 });
	assert.deepEqual(descriptors.word[399], { from: 798, to: 799 });
	// 选区层回退：viewport 行 3/4/5 的 'e'（选区 [0,1) 在区间外，不参与排除）。
	assert.deepEqual(descriptors.selection, [{ from: 6, to: 7 }, { from: 8, to: 9 }, { from: 10, to: 11 }]);
});

test('matchDecorationDescriptors: 超限层遇不可用 viewport → 该层空（无区间可重算）', () => {
	const text = Array.from({ length: MAX_MATCHES_PER_LAYER + 1 }, () => 'a').join('\n');
	const caret = { start: 0, end: 0 };
	assert.deepEqual(
		matchDecorationDescriptors({ text, selection: caret, viewport: null, selectionEnabled: false, wordEnabled: true }),
		{ word: [], selection: [] }
	); // viewport null → []
	assert.deepEqual(
		matchDecorationDescriptors({ text, selection: caret, viewport: {}, selectionEnabled: false, wordEnabled: true }),
		{ word: [], selection: [] }
	); // 行字段缺失 → []
	assert.deepEqual(
		matchDecorationDescriptors({ text, selection: caret, viewport: { fromLine: Number.NaN, toLine: 5 }, selectionEnabled: false, wordEnabled: true }),
		{ word: [], selection: [] }
	); // 行字段非有限 → []
});

/* -------------------------------------------- 开关独立 + 语义保留 -- */
// 断言形状移植自 match-highlight.test.js 的 computeMatchHighlights /
// wordQueryOf / selectionQueryOf 既有用例。

test('matchDecorationDescriptors: 两开关独立关层', () => {
	// selectionEnabled=false → 选区层空，词层照常。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'foo foo', selection: { start: 0, end: 3 }, selectionEnabled: false, wordEnabled: true }),
		{ word: [{ from: 0, to: 3 }, { from: 4, to: 7 }], selection: [] }
	);
	// wordEnabled=false → 词层空，选区层照常。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'foo foo', selection: { start: 0, end: 3 }, selectionEnabled: true, wordEnabled: false }),
		{ word: [], selection: [{ from: 4, to: 7 }] }
	);
	// 双关 → 双层空。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'foo foo', selection: { start: 0, end: 3 }, selectionEnabled: false, wordEnabled: false }),
		{ word: [], selection: [] }
	);
});

test('matchDecorationDescriptors: 词层保留选区跨度，选区层排除自身', () => {
	// 移植自「word layer keeps the selection span」用例：word 层不减选区，
	// selection 层减去选区自身位置。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'foo foo', selection: { start: 0, end: 3 }, selectionEnabled: true, wordEnabled: true }),
		{ word: [{ from: 0, to: 3 }, { from: 4, to: 7 }], selection: [{ from: 4, to: 7 }] }
	);
	// 选区 = 整词 → 词层保留该唯一命中，选区层排除后为空。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'xxx', selection: { start: 0, end: 3 }, selectionEnabled: true, wordEnabled: true }),
		{ word: [{ from: 0, to: 3 }], selection: [] }
	);
});

test('matchDecorationDescriptors: 词层大小写敏感、选区层大小写不敏感', () => {
	// 移植自 findMatches 大小写用例：词层只命中小写两处；选区层折叠命中
	// 全部三处再排除自身。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'foo FOO foo', selection: { start: 0, end: 3 }, selectionEnabled: true, wordEnabled: true }),
		{
			word: [{ from: 0, to: 3 }, { from: 8, to: 11 }],
			selection: [{ from: 4, to: 7 }, { from: 8, to: 11 }],
		}
	);
});

test('matchDecorationDescriptors: 词层全词门——foobar 内嵌的 foo 不命中', () => {
	// 移植自 findMatches wholeWord 用例：折叠光标在 foo 内 → 只有独立两处。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'foo foobar foo', selection: { start: 1, end: 1 }, selectionEnabled: true, wordEnabled: true }).word,
		[{ from: 0, to: 3 }, { from: 11, to: 14 }]
	);
});

test('matchDecorationDescriptors: 选区层的跳过规则原样保留（跨行/纯空白/超长）', () => {
	// 跨行选区：词查询跨词丢弃、选区查询含换行丢弃 → 双层空。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'foo\nbar', selection: { start: 0, end: 7 }, selectionEnabled: true, wordEnabled: true }),
		{ word: [], selection: [] }
	);
	// 纯空格选区：选区查询丢弃；选区跨出词界 → 词查询同样丢弃。
	assert.deepEqual(
		matchDecorationDescriptors({ text: 'a  b', selection: { start: 1, end: 3 }, selectionEnabled: true, wordEnabled: true }),
		{ word: [], selection: [] }
	);
	// 200 字符边界通过：选区查询成立，命中另一处 200 连 x。
	const twoHundred = 'x'.repeat(200);
	const atLimit = matchDecorationDescriptors({
		text: `${twoHundred} ${twoHundred}`,
		selection: { start: 0, end: 200 },
		selectionEnabled: true,
		wordEnabled: true,
	});
	assert.deepEqual(atLimit.selection, [{ from: 201, to: 401 }]); // 自身 [0,200) 被排除
	// 201 字符 → 选区查询丢弃 → 选区层空（词层不受影响：201 连 x 是一个词）。
	const overLimit = matchDecorationDescriptors({
		text: `${'x'.repeat(201)} ${'x'.repeat(201)}`,
		selection: { start: 0, end: 201 },
		selectionEnabled: true,
		wordEnabled: true,
	});
	assert.deepEqual(overLimit.selection, []);
	assert.equal(overLimit.word.length, 2);
});

test('matchDecorationDescriptors: 不可用输入退化为双层空，绝不抛错', () => {
	assert.deepEqual(matchDecorationDescriptors(), { word: [], selection: [] }); // 实参缺失
	assert.deepEqual(matchDecorationDescriptors({ text: null, selection: { start: 0, end: 3 }, selectionEnabled: true, wordEnabled: true }), {
		word: [],
		selection: [],
	});
	assert.deepEqual(matchDecorationDescriptors({ text: 'foo foo', selection: null, selectionEnabled: true, wordEnabled: true }), {
		word: [],
		selection: [],
	}); // selection null → 双层空（同 computeMatchHighlights）
	assert.deepEqual(matchDecorationDescriptors({ text: 'foo foo', selection: { start: 9, end: 99 }, selectionEnabled: true, wordEnabled: true }), {
		word: [],
		selection: [],
	}); // 选区越界 → 查询丢弃
});

/* ------------------------------------------------------- 辅助一致性 -- */

test('matchDecorationDescriptors: 多行文档命中偏移与 lineStartOffsets 一致', () => {
	// 0 基行索引对齐 session.lines：行 i 的起点 = lineStartOffsets(lines)[i]。
	const lines = ['ab', 'cd', 'ef'];
	const offsets = lineStartOffsets(lines);
	assert.deepEqual(offsets, [0, 3, 6]);
	const text = lines.join('\n');
	const descriptors = matchDecorationDescriptors({
		text,
		selection: { start: 3, end: 5 }, // 选中行 1 的 'cd'
		viewport: { fromLine: 1, toLine: 2 },
		selectionEnabled: true,
		wordEnabled: true,
	});
	// under-cap：全量路径，viewport 不生效——词层唯一命中 = 行 1 的 'cd'
	// （偏移 [3,5) = offsets[1] .. offsets[1]+2），选区层排除自身后为空。
	assert.deepEqual(descriptors.word, [{ from: 3, to: 5 }]);
	assert.deepEqual(descriptors.selection, []);
});
