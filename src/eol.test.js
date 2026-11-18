import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEol, applyEol } from './eol.js';

/* ---------------------------------------------------- detectEol -- */

test('detectEol: 无行断/空串 → lf(默认)', () => {
  assert.equal(detectEol(''), 'lf');
  assert.equal(detectEol('abc'), 'lf');
  assert.equal(detectEol(null), 'lf');
  assert.equal(detectEol(undefined), 'lf');
  assert.equal(detectEol(42), 'lf');
});

test('detectEol: 单一类型各归其类', () => {
  assert.equal(detectEol('a\nb'), 'lf');
  assert.equal(detectEol('a\r\nb'), 'crlf');
  assert.equal(detectEol('a\rb'), 'cr');
  assert.equal(detectEol('a\r\nb\r\nc'), 'crlf');
  assert.equal(detectEol('a\r'), 'cr');
  assert.equal(detectEol('\r\n'), 'crlf');
});

test('detectEol: 混合行尾按主导类型归一,平票回 lf', () => {
  // crlf×2 vs lf×1 → crlf
  assert.equal(detectEol('a\r\nb\nc\r\nd'), 'crlf');
  // 平票 1:1 → lf
  assert.equal(detectEol('a\r\nb\nc'), 'lf');
  // cr×1 vs crlf×1 平票 → lf
  assert.equal(detectEol('a\rb\r\nc'), 'lf');
  // lf×2 vs cr×1 → lf
  assert.equal(detectEol('a\nb\nc\rd'), 'lf');
  // crlf×1 vs cr×2 → cr
  assert.equal(detectEol('a\r\nb\rc\rd'), 'cr');
});

test('detectEol: \\r 后紧跟 \\n 只算一个 crlf,不重复计数', () => {
  // 'a\r\n' 里的 \r 不应再被计为独立 cr
  assert.equal(detectEol('a\r\n'), 'crlf');
});

/* ---------------------------------------------------- applyEol -- */

test('applyEol: lf 原样返回', () => {
  assert.equal(applyEol('a\nb\n', 'lf'), 'a\nb\n');
  assert.equal(applyEol('a\nb\n', undefined), 'a\nb\n');
  assert.equal(applyEol('a\nb\n', 'bogus'), 'a\nb\n');
});

test('applyEol: crlf 把每个 \\n 转成 \\r\\n', () => {
  assert.equal(applyEol('a\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.equal(applyEol('a\nb', 'crlf'), 'a\r\nb');
  assert.equal(applyEol('\n', 'crlf'), '\r\n');
});

test('applyEol: cr 把每个 \\n 转成 \\r', () => {
  assert.equal(applyEol('a\nb\n', 'cr'), 'a\rb\r');
});

test('applyEol: 空串/劣化输入安全', () => {
  assert.equal(applyEol('', 'crlf'), '');
  assert.equal(applyEol(null, 'crlf'), '');
  assert.equal(applyEol(undefined, 'crlf'), '');
});
