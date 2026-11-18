import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePointColumns } from './wrap-geometry.js';
import {
  WHITESPACE_GLYPHS,
  WHITESPACE_TAB_SIZE,
  glyphSvgShape,
  tabAdvance,
  showsNewlineGlyph,
  visibleWindow,
  buildWhitespaceRow,
} from './whitespace.js';

/* --------------------------------------------------- codePointColumns -- */

test('codePointColumns is exported from wrap-geometry for the whitespace layer', () => {
  assert.equal(typeof codePointColumns, 'function');
  assert.equal(codePointColumns(0x4e00), 2); // CJK wide → 2 columns
  assert.equal(codePointColumns(0x61), 1); // latin → 1 column
});

/* ------------------------------------------------------------ constants -- */

test('WHITESPACE_GLYPHS is frozen and byte-exact', () => {
  assert.deepEqual(WHITESPACE_GLYPHS, { space: '\u00B7', tab: '\u2192', newline: '\u21B5' });
  assert.equal(Object.isFrozen(WHITESPACE_GLYPHS), true);
});

test('WHITESPACE_TAB_SIZE is the 4-column default', () => {
  assert.equal(WHITESPACE_TAB_SIZE, 4);
});

/* ------------------------------------------------------------ tabAdvance -- */

test('tabAdvance: every distance to the next stop, wrapping at each boundary', () => {
  assert.equal(tabAdvance(0, 4), 4);
  assert.equal(tabAdvance(1, 4), 3);
  assert.equal(tabAdvance(2, 4), 2);
  assert.equal(tabAdvance(3, 4), 1);
  assert.equal(tabAdvance(4, 4), 4);
  assert.equal(tabAdvance(5, 4), 3);
});

test('tabAdvance: other stop widths, including the 1-column stop', () => {
  assert.equal(tabAdvance(7, 8), 1);
  assert.equal(tabAdvance(0, 1), 1);
});

test('tabAdvance: unusable tabSize or column degrades to the 4-column default', () => {
  assert.equal(tabAdvance(0, NaN), 4);
  assert.equal(tabAdvance(0, 0), 4);
  assert.equal(tabAdvance(NaN, 4), 4);
});

/* ----------------------------------------------------- showsNewlineGlyph -- */

test('showsNewlineGlyph: a break glyph shows on every non-last line', () => {
  assert.equal(showsNewlineGlyph(['a'], 1), false); // last line of a file without trailing newline
  assert.equal(showsNewlineGlyph(['a', 'b'], 1), true); // a\nb: a has ↵
  assert.equal(showsNewlineGlyph(['a', 'b'], 2), false);
  assert.equal(showsNewlineGlyph(['a', 'b', ''], 1), true); // a\nb\n: only a has ↵
  assert.equal(showsNewlineGlyph(['a', '', 'b'], 2), true); // an inner blank line's break draws at its start
});

test('showsNewlineGlyph: a trailing empty last line swallows the final break glyph', () => {
  assert.equal(showsNewlineGlyph(['a', ''], 1), false); // a\n: trailing newline, no glyph anywhere
  assert.equal(showsNewlineGlyph(['a', 'b', ''], 2), false); // b's break IS the trailing newline
});

test('showsNewlineGlyph: invalid or out-of-range line numbers degrade to false', () => {
  assert.equal(showsNewlineGlyph(['a', 'b'], 3), false); // out of range
  assert.equal(showsNewlineGlyph(['a', 'b'], 0), false);
  assert.equal(showsNewlineGlyph(['a', 'b'], NaN), false);
  assert.equal(showsNewlineGlyph(['a', 'b'], 1.5), false);
  assert.equal(showsNewlineGlyph(['a', 'b'], '1'), false);
  assert.equal(showsNewlineGlyph(null, 1), false);
});

/* --------------------------------------------------- buildWhitespaceRow -- */

test('buildWhitespaceRow: every switch off passes the text through verbatim', () => {
  assert.deepEqual(buildWhitespaceRow({ text: 'a \tb', spaces: false, tabs: false, newlines: false }), [
    { kind: 'text', text: 'a \tb' },
  ]);
});

test('buildWhitespaceRow: spaces render as middle-dot glyphs', () => {
  assert.deepEqual(buildWhitespaceRow({ text: 'a b', spaces: true, tabs: false, newlines: false }), [
    { kind: 'text', text: 'a' },
    { kind: 'glyph', glyph: '·' },
    { kind: 'text', text: 'b' },
  ]);
});

test('buildWhitespaceRow: tabs render as an arrow glyph plus pad to the next stop', () => {
  assert.deepEqual(buildWhitespaceRow({ text: 'a\tb', spaces: false, tabs: true, newlines: false }), [
    { kind: 'text', text: 'a' },
    { kind: 'glyph', glyph: '→' },
    { kind: 'pad', count: 2 },
    { kind: 'text', text: 'b' },
  ]);
  assert.deepEqual(buildWhitespaceRow({ text: '\tabc', spaces: false, tabs: true, newlines: false }), [
    { kind: 'glyph', glyph: '→' },
    { kind: 'pad', count: 3 },
    { kind: 'text', text: 'abc' },
  ]);
  // 汉 is 2 columns wide, so its tab advances 2 → pad 1.
  assert.deepEqual(buildWhitespaceRow({ text: '汉\t', spaces: false, tabs: true, newlines: false }), [
    { kind: 'text', text: '汉' },
    { kind: 'glyph', glyph: '→' },
    { kind: 'pad', count: 1 },
  ]);
  // An explicit tabSize feeds the stop arithmetic (column 1 → next stop 8 → pad 6).
  assert.deepEqual(buildWhitespaceRow({ text: 'a\tb', spaces: false, tabs: true, newlines: false, tabSize: 8 }), [
    { kind: 'text', text: 'a' },
    { kind: 'glyph', glyph: '→' },
    { kind: 'pad', count: 6 },
    { kind: 'text', text: 'b' },
  ]);
});

test('buildWhitespaceRow: the newline switch appends the break glyph', () => {
  assert.deepEqual(buildWhitespaceRow({ text: 'a', spaces: false, tabs: false, newlines: true }), [
    { kind: 'text', text: 'a' },
    { kind: 'glyph', glyph: '↵' },
  ]);
  // An empty row with everything on is the break glyph alone.
  assert.deepEqual(buildWhitespaceRow({ text: '', spaces: true, tabs: true, newlines: true }), [
    { kind: 'glyph', glyph: '↵' },
  ]);
});

test('buildWhitespaceRow: a tab landing one column before its stop emits pad count 0 (pad-count-0 契约锁定)', () => {
  // Column 3 + tab → tabAdvance 1 → pad 0: the builder DOES emit a
  // zero-count pad fragment, and the renderer's `count > 0` skip
  // (components.js appendRow) relies on exactly that shape. Pinned so
  // the emission contract cannot silently change to a missing fragment.
  assert.deepEqual(buildWhitespaceRow({ text: 'abc\t', spaces: false, tabs: true, newlines: false }), [
    { kind: 'text', text: 'abc' },
    { kind: 'glyph', glyph: '→' },
    { kind: 'pad', count: 0 },
  ]);
});

test('buildWhitespaceRow: surrogate pairs survive as whole code points', () => {
  assert.deepEqual(buildWhitespaceRow({ text: '\u{1F600}x', spaces: false, tabs: false, newlines: false }), [
    { kind: 'text', text: '\u{1F600}x' },
  ]);
});

test('buildWhitespaceRow: unusable input degrades safely, never throws', () => {
  assert.deepEqual(buildWhitespaceRow({}), []);
  assert.deepEqual(buildWhitespaceRow(null), []);
  // A degraded empty line behaves like the pinned empty line: just ↵.
  assert.deepEqual(buildWhitespaceRow({ text: null, spaces: true, tabs: true, newlines: true }), [
    { kind: 'glyph', glyph: '↵' },
  ]);
});

/* -------------------------------------------------------- visibleWindow -- */

test('visibleWindow: the pinned window arithmetic with margins', () => {
  assert.deepEqual(
    visibleWindow({ scrollTop: 0, paddingTop: 10, lineHeight: 20, clientHeight: 100, lineCount: 1000, marginRows: 2 }),
    { first0: 0, count: 9 } // ceil(100/20)=5 + 2×2
  );
  assert.deepEqual(
    visibleWindow({ scrollTop: 120, paddingTop: 10, lineHeight: 20, clientHeight: 100, lineCount: 1000, marginRows: 2 }),
    { first0: 3, count: 9 } // floor(110/20)=5 − 2
  );
  assert.deepEqual(
    visibleWindow({ scrollTop: 0, paddingTop: 10, lineHeight: 20, clientHeight: 100, lineCount: 3, marginRows: 2 }),
    { first0: 0, count: 3 } // clamped to the line count
  );
});

test('visibleWindow: a broken lineHeight degrades to an empty window', () => {
  assert.deepEqual(
    visibleWindow({ scrollTop: 0, paddingTop: 10, lineHeight: 0, clientHeight: 100, lineCount: 3, marginRows: 2 }),
    { first0: 0, count: 0 }
  );
  assert.deepEqual(
    visibleWindow({ scrollTop: 0, paddingTop: 10, lineHeight: NaN, clientHeight: 100, lineCount: 3, marginRows: 2 }),
    { first0: 0, count: 0 }
  );
});

/* --------------------------------------------- glyphSvgShape (0.12.0 fix) -- */

test('glyphSvgShape: 每个字形字符返回矢量形状规格(viewBox + 元素 + 垂直定位)', () => {
  for (const glyph of [WHITESPACE_GLYPHS.space, WHITESPACE_GLYPHS.tab, WHITESPACE_GLYPHS.newline]) {
    const shape = glyphSvgShape(glyph);
    assert.ok(shape !== null && typeof shape === 'object', `${glyph} 应有形状规格`);
    assert.match(shape.viewBox, /^0 0 12 12$/);
    assert.ok(Array.isArray(shape.elements) && shape.elements.length > 0, `${glyph} 应有至少一个绘制元素`);
    assert.ok(typeof shape.yCenterEm === 'number' && shape.yCenterEm >= 0 && shape.yCenterEm <= 0.5, `${glyph} 应有 0–0.5em 的垂直中心`);
    for (const el of shape.elements) {
      assert.ok(el.tag === 'circle' || el.tag === 'path' || el.tag === 'line', `${glyph} 元素 tag 合法`);
    }
  }
});

test('glyphSvgShape: circle 用 fill,线类用 stroke=currentColor,规格自描述', () => {
  const dot = glyphSvgShape(WHITESPACE_GLYPHS.space);
  assert.equal(dot.elements[0].tag, 'circle');
  assert.equal(dot.elements[0].fill, 'currentColor');
  const arrow = glyphSvgShape(WHITESPACE_GLYPHS.tab);
  assert.equal(arrow.elements[0].stroke, 'currentColor');
  const enter = glyphSvgShape(WHITESPACE_GLYPHS.newline);
  assert.equal(enter.elements[0].stroke, 'currentColor');
});

test('glyphSvgShape: 未知/劣化字形返回 null(never-throw)', () => {
  assert.equal(glyphSvgShape('x'), null);
  assert.equal(glyphSvgShape(null), null);
  assert.equal(glyphSvgShape(undefined), null);
  assert.equal(glyphSvgShape(42), null);
});
