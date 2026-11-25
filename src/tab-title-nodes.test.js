/**
 * Tests for `src/tab-title-nodes.js` — the pure builder for the editor tab
 * title's child nodes (0.16.0 follow-up).
 *
 * WHY THIS EXISTS: 0.16.0's final review mutation-tested the source-text
 * guards in `client-entry.test.js` and found the blind spot — replacing the
 * disc glyph injection with an empty attribute kept every guard green. The
 * fix is to build the title's children in a pure function with an INJECTABLE
 * `h`, so `node --test` can assert the actual element tree (gate, node
 * structure, class names, disc content, aria-hidden) without React or a DOM.
 * The fake `h` below records its arguments verbatim; assertions compare that
 * record against the spec'd tree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	TAB_TITLE_TEXT_CLASS,
	TAB_TITLE_TEXT_DELETED_CLASS,
	buildTabTitleChildren
} from './tab-title-nodes.js';

function fakeH(type, props, ...children) {
	return { type, props, children };
}

function fakeIconNode() {
	return { kind: 'icon-node' };
}

const GLYPH = '<svg width="10" height="10"></svg>';

test('fake h records the caller arguments (harness self-check)', () => {
	const node = fakeH('span', { className: 'x' }, 'child');
	assert.equal(node.type, 'span');
	assert.deepEqual(node.props, { className: 'x' });
	assert.deepEqual(node.children, ['child']);
});

test('buildTabTitleChildren builds iconwrap + text span when the icon is present', () => {
	const iconNode = fakeIconNode();
	const children = buildTabTitleChildren({ h: fakeH, iconNode, glyphHtml: GLYPH, deleted: false, name: 'app.py' });
	assert.equal(children.length, 2);
	const [iconwrap, textSpan] = children;
	assert.equal(iconwrap.type, 'span');
	assert.equal(iconwrap.props.className, 'dsh-editor-tabtitle-iconwrap');
	assert.equal(iconwrap.props.key, 'iwrap');
	assert.equal(iconwrap.children.length, 2);
	assert.equal(iconwrap.children[0], iconNode);
	const disc = iconwrap.children[1];
	assert.equal(disc.type, 'span');
	assert.equal(disc.props.className, 'dsh-editor-tabtitle-editdisc');
	assert.equal(disc.props['aria-hidden'], true);
	assert.equal(disc.props.dangerouslySetInnerHTML.__html, GLYPH);
	assert.equal(textSpan.type, 'span');
	assert.equal(textSpan.props.className, TAB_TITLE_TEXT_CLASS);
	assert.deepEqual(textSpan.children, ['app.py']);
});

test('buildTabTitleChildren marks the text span deleted', () => {
	const children = buildTabTitleChildren({ h: fakeH, iconNode: fakeIconNode(), glyphHtml: GLYPH, deleted: true, name: 'app.py' });
	assert.equal(children[1].props.className, 'dsh-editor-tabtitle-text-deleted');
	assert.equal(children[1].props.className, TAB_TITLE_TEXT_DELETED_CLASS);
});

test('buildTabTitleChildren returns only the text span without an icon node', () => {
	const children = buildTabTitleChildren({ h: fakeH, iconNode: null, glyphHtml: GLYPH, deleted: false, name: 'app.py' });
	assert.equal(children.length, 1);
	assert.equal(children[0].type, 'span');
	assert.equal(children[0].props.className, TAB_TITLE_TEXT_CLASS);
	assert.deepEqual(children[0].children, ['app.py']);
});
