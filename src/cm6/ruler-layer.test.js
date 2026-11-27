import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulerGeometry } from './ruler-layer.js';

// Enabled ruler, gutter 40px, 8px cell, column default 80 → 40 + 640.
const BASE = { enabled: true, column: 80, charWidth: 8, gutterWidth: 40, viewportWidth: 800 };

/* ------------------------------------------------------ 开关 -- */

test('rulerGeometry: disabled（及其它非 true 开关）→ null', () => {
	assert.equal(rulerGeometry({ ...BASE, enabled: false }), null);
	assert.equal(rulerGeometry({ ...BASE, enabled: 0 }), null);
	assert.equal(rulerGeometry({ ...BASE, enabled: '' }), null);
	// 与 DOM 层同宽：只有字面 true 才开启。
	assert.equal(rulerGeometry({ ...BASE, enabled: 'true' }), null);
	assert.equal(rulerGeometry({ ...BASE, enabled: 1 }), null);
});

test('rulerGeometry: 输入缺失/非对象 → null，绝不抛错', () => {
	assert.equal(rulerGeometry(), null);
	assert.equal(rulerGeometry(null), null);
	assert.equal(rulerGeometry(undefined), null);
	assert.equal(rulerGeometry('x'), null);
});

/* ------------------------------------------- column 收敛矩阵 -- */
// 收敛镜像 components.js:563 的 clampRulerColumnInput(column) ?? 80：
// 非数字/非有限 → 默认 80；有限值先四舍五入再夹到 1–999。

test('rulerGeometry: column 0 / -1 / 1000 / NaN → 1 / 1 / 999 / 80', () => {
	assert.deepEqual(rulerGeometry({ ...BASE, column: 0 }), { x: 40 + 1 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: -1 }), { x: 40 + 1 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: 1000 }), { x: 40 + 999 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: Number.NaN }), { x: 40 + 80 * 8 });
});

test('rulerGeometry: 合法列原样保留，非数字/非有限值落到默认 80', () => {
	assert.deepEqual(rulerGeometry({ ...BASE, column: 1 }), { x: 40 + 1 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: 120 }), { x: 40 + 120 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: 999 }), { x: 40 + 999 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: undefined }), { x: 40 + 80 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: '80' }), { x: 40 + 80 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: Number.POSITIVE_INFINITY }), { x: 40 + 80 * 8 });
});

test('rulerGeometry: 小数列先四舍五入（与 clampRulerColumnInput 同规，非 floor）', () => {
	assert.deepEqual(rulerGeometry({ ...BASE, column: 80.4 }), { x: 40 + 80 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: 80.5 }), { x: 40 + 81 * 8 });
	assert.deepEqual(rulerGeometry({ ...BASE, column: 0.4 }), { x: 40 + 1 * 8 }); // 四舍五入 0 → 夹到 1
});

/* ------------------------------------------------------ 几何 -- */

test('rulerGeometry: x = gutterWidth + column × charWidth', () => {
	assert.deepEqual(
		rulerGeometry({ enabled: true, column: 120, charWidth: 7.5, gutterWidth: 33, viewportWidth: 0 }),
		{ x: 33 + 120 * 7.5 }
	);
	// 无行号（gutter 0）时就是 column × charWidth。
	assert.deepEqual(rulerGeometry({ enabled: true, column: 80, charWidth: 10, gutterWidth: 0, viewportWidth: 640 }), { x: 800 });
});

test('rulerGeometry: viewportWidth 被接受但不影响 x（几何列、与滚动/折叠无关）', () => {
	const narrow = rulerGeometry({ ...BASE, viewportWidth: 100 });
	const wide = rulerGeometry({ ...BASE, viewportWidth: 100000 });
	assert.deepEqual(narrow, wide);
	assert.deepEqual(narrow, { x: 40 + 80 * 8 });
	// 缺 viewportWidth 也一样。
	assert.deepEqual(rulerGeometry({ enabled: true, column: 80, charWidth: 8, gutterWidth: 40 }), { x: 680 });
});

test('rulerGeometry: 不可用的测量值退化，x 永不为 NaN', () => {
	assert.deepEqual(rulerGeometry({ ...BASE, charWidth: Number.NaN }), { x: 40 });
	assert.deepEqual(rulerGeometry({ ...BASE, charWidth: '8' }), { x: 40 });
	assert.deepEqual(rulerGeometry({ ...BASE, gutterWidth: Number.NaN }), { x: 640 });
	assert.deepEqual(rulerGeometry({ ...BASE, charWidth: undefined, gutterWidth: undefined }), { x: 0 });
	// 负/零测量不抛错：照几何公式。
	assert.deepEqual(rulerGeometry({ ...BASE, charWidth: 0 }), { x: 40 });
});
