import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeLineRangeOf, activeLineBar, lineHeightPxOf, glyphBandOffsets } from './active-line.js';

/* -------------------------------------------------- activeLineRangeOf -- */

test('activeLineRangeOf: a null selection maps to the first line', () => {
  assert.deepEqual(activeLineRangeOf(null), { lineStart: 1, lineEnd: 1 });
});

test('activeLineRangeOf: a collapsed selection highlights the caret line only', () => {
  assert.deepEqual(activeLineRangeOf({ start: 5, end: 5, lineStart: 3, lineEnd: 3, text: null }), {
    lineStart: 3,
    lineEnd: 3,
  });
});

test('activeLineRangeOf: a multi-line selection highlights every touched line', () => {
  assert.deepEqual(activeLineRangeOf({ start: 2, end: 40, lineStart: 1, lineEnd: 4, text: '…' }), {
    lineStart: 1,
    lineEnd: 4,
  });
});

test('activeLineRangeOf: swapped bounds are normalized (smaller line first)', () => {
  assert.deepEqual(activeLineRangeOf({ lineStart: 5, lineEnd: 2 }), { lineStart: 2, lineEnd: 5 });
});

test('activeLineRangeOf: invalid or missing bounds fall back to the first line', () => {
  assert.deepEqual(activeLineRangeOf({}), { lineStart: 1, lineEnd: 1 });
  assert.deepEqual(activeLineRangeOf('x'), { lineStart: 1, lineEnd: 1 });
  assert.deepEqual(activeLineRangeOf({ lineStart: 0, lineEnd: -3 }), { lineStart: 1, lineEnd: 1 });
  assert.deepEqual(activeLineRangeOf({ lineStart: 2.7, lineEnd: 4.2 }), { lineStart: 2, lineEnd: 4 });
});

/* ------------------------------------------------------- activeLineBar -- */

test('activeLineBar: one line sits on paddingTop + (line-1)*lineHeight, one lineHeight tall', () => {
  assert.deepEqual(activeLineBar({ lineStart: 1, lineEnd: 1 }, { paddingTop: 10, lineHeight: 19.5 }), {
    top: 10,
    height: 19.5,
  });
  assert.deepEqual(activeLineBar({ lineStart: 3, lineEnd: 3 }, { paddingTop: 10, lineHeight: 19.5 }), {
    top: 49,
    height: 19.5,
  });
});

test('activeLineBar: a multi-line range spans from the first line top across every covered line', () => {
  assert.deepEqual(activeLineBar({ lineStart: 2, lineEnd: 4 }, { paddingTop: 12, lineHeight: 20 }), {
    top: 32,
    height: 60,
  });
});

test('activeLineBar: swapped bounds span the normalized range (bar never negative)', () => {
  assert.deepEqual(activeLineBar({ lineStart: 4, lineEnd: 2 }, { paddingTop: 10, lineHeight: 19.5 }), {
    top: 29.5,
    height: 58.5,
  });
});

test('activeLineBar: absent metrics degrade to the defensive 1px-per-line default', () => {
  assert.deepEqual(activeLineBar({ lineStart: 2, lineEnd: 2 }, undefined), { top: 1, height: 1 });
  assert.deepEqual(activeLineBar({ lineStart: 3, lineEnd: 3 }, { paddingTop: NaN, lineHeight: 0 }), {
    top: 2,
    height: 1,
  });
});

/* ------------------------------------------------------ lineHeightPxOf -- */

test('lineHeightPxOf: a px computed value passes through verbatim', () => {
  assert.equal(lineHeightPxOf('19.5px', 13), 19.5);
  assert.equal(lineHeightPxOf('20px', 13), 20);
});

test('lineHeightPxOf: a unitless computed value multiplies the computed font size', () => {
  assert.equal(lineHeightPxOf('1.5', 13), 19.5);
  assert.equal(lineHeightPxOf('2', 13.5), 27);
});

test('lineHeightPxOf: normal and unparseable values fail (caller keeps measuring)', () => {
  assert.equal(lineHeightPxOf('normal', 13), null);
  assert.equal(lineHeightPxOf('abc', 13), null);
  assert.equal(lineHeightPxOf('', 13), null);
});

test('lineHeightPxOf: zero or non-finite outcomes fail (never a usable bar metric)', () => {
  assert.equal(lineHeightPxOf('0px', 13), null);
  assert.equal(lineHeightPxOf('1.5', NaN), null);
  assert.equal(lineHeightPxOf(undefined, 13), null);
});

/* ---------------------------------------------------- glyphBandOffsets -- */

const GLYPH_METRICS = {
  lineHeight: 19.5,
  fontAscent: 12.4,
  fontDescent: 3.05, // 半行距 2.025，基线在 14.425
  inkAscent: 11.4, // '中g' 探针串的墨迹上沿（CJK ≈ 0.88em）
  inkDescent: 2.6, // 'g' 的下伸墨迹（≈ 0.2em）
  paddingTop: 2,
  paddingBottom: 2,
  bandHeight: 2,
};

test('glyphBandOffsets: frames the glyph ink with equal padding on both sides', () => {
  const { top, bottom } = glyphBandOffsets(GLYPH_METRICS);
  // 墨迹上沿 3.025 - padding 2 → 上带 top = 1.025
  assert.ok(Math.abs(top - 1.025) < 1e-9, `top=${top}`);
  // 墨迹下沿 17.025 + padding 2 + 带高 2 → bottom 内缩 = 19.5 - 21.025 = -1.525
  // （负值 = 色带沉入行盒下方的行间空白带，窗口 ±8 内合法）
  assert.ok(Math.abs(bottom - -1.525) < 1e-9, `bottom=${bottom}`);
});

test('glyphBandOffsets: asymmetric paddings move each band independently', () => {
  // 上带贴字顶（padding 0）、下带远离字底（padding 6）
  const { top, bottom } = glyphBandOffsets({ ...GLYPH_METRICS, paddingTop: 0, paddingBottom: 6 });
  assert.ok(Math.abs(top - 3.025) < 1e-9, `top=${top}`);
  // 19.5 - 17.025 - 6 - 2 = -5.525 → 沉入行间空白带（窗口内）
  assert.ok(Math.abs(bottom - -5.525) < 1e-9, `bottom=${bottom}`);
});

test('glyphBandOffsets: roomy line heights get real symmetric whitespace', () => {
  const { top, bottom } = glyphBandOffsets({ ...GLYPH_METRICS, lineHeight: 23.4 });
  // 半行距 3.975，基线 16.375；墨迹 [4.975, 18.975] → top = 2.975, bottom = 0.425
  assert.ok(Math.abs(top - 2.975) < 1e-9, `top=${top}`);
  assert.ok(Math.abs(bottom - 0.425) < 1e-9, `bottom=${bottom}`);
});

test('glyphBandOffsets: paddings past the box edge extend into the inter-line window', () => {
  // 墨迹撑满行盒时 padding 4 越过盒边 → 色带进入相邻行之间的空白带（−8 窗口内）
  const { top, bottom } = glyphBandOffsets({ ...GLYPH_METRICS, inkAscent: 12.3, inkDescent: 3.0, paddingTop: 4, paddingBottom: 4 });
  assert.ok(Math.abs(top - -1.875) < 1e-9, `top=${top}`);
  assert.ok(Math.abs(bottom - -3.925) < 1e-9, `bottom=${bottom}`);
});
test('glyphBandOffsets: oversized padding clamps into the inter-line window (±8px beyond the box)', () => {
  // padding 100 → 墨迹外 97px，远超行盒；夹到行间窗口边界 ±8，
  // 让"调大 padding"始终有可见效果（色带进入相邻行之间的空白带）。
  const { top, bottom } = glyphBandOffsets({ ...GLYPH_METRICS, paddingTop: 100, paddingBottom: 100 });
  assert.equal(top, -8);
  assert.equal(bottom, -8);
});
test('glyphBandOffsets: small paddings stay attached to the ink (inside the box)', () => {
  const { top } = glyphBandOffsets({ ...GLYPH_METRICS, paddingTop: 1 });
  assert.ok(Math.abs(top - 2.025) < 1e-9, `top=${top}`); // 3.025 - 1
});

test('glyphBandOffsets: missing or non-finite metrics → null (caller keeps the CSS fallback)', () => {
  assert.equal(glyphBandOffsets(undefined), null);
  assert.equal(glyphBandOffsets({ lineHeight: NaN }), null);
  assert.equal(glyphBandOffsets({ ...GLYPH_METRICS, fontAscent: undefined }), null);
});
