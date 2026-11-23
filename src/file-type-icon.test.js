/**
 * Tests for `src/file-type-icon.js` — the editor tab title's file-type icon
 * plumbing (0.15.0): validating the host's `@deepseek-ai/dsh-client-ui-primitives`
 * runtime module shape and building the icon props for the tab-title seat.
 *
 * Pure-module discipline: this module (and its test) carry zero imports and
 * zero bare requires, so `node --test` can load them directly — the same rule
 * `ruler.js` / `goto-line.js` follow. The bare require of the primitives
 * module lives in `src/components.js`, OUTSIDE this test graph (react-requiring
 * modules are never imported here).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	TAB_TITLE_ICON_CLASS,
	TAB_TITLE_ICON_SIZE,
	resolveFileTypeIconApi,
	tabTitleIconProps
} from './file-type-icon.js';

function fakeApi() {
	return {
		FileTypeIcon: () => null,
		classifyFileType: (name) => `kind-of:${name}`
	};
}

test('resolveFileTypeIconApi passes a well-shaped module through as a narrow object', () => {
	const api = fakeApi();
	const resolved = resolveFileTypeIconApi(api);
	assert.notEqual(resolved, null);
	assert.equal(resolved.FileTypeIcon, api.FileTypeIcon);
	assert.equal(resolved.classifyFileType, api.classifyFileType);
});

test('resolveFileTypeIconApi rejects missing or malformed exports', () => {
	assert.equal(resolveFileTypeIconApi(null), null);
	assert.equal(resolveFileTypeIconApi(undefined), null);
	assert.equal(resolveFileTypeIconApi({}), null);
	assert.equal(resolveFileTypeIconApi({ FileTypeIcon: () => null }), null);
	assert.equal(resolveFileTypeIconApi({ classifyFileType: (n) => n }), null);
	assert.equal(resolveFileTypeIconApi({ FileTypeIcon: 'svg', classifyFileType: (n) => n }), null);
	assert.equal(resolveFileTypeIconApi({ FileTypeIcon: () => null, classifyFileType: 42 }), null);
});

test('tabTitleIconProps builds the 16px tab-title icon props', () => {
	const api = fakeApi();
	assert.deepEqual(tabTitleIconProps('README.md', api), {
		kind: 'kind-of:README.md',
		size: TAB_TITLE_ICON_SIZE,
		className: TAB_TITLE_ICON_CLASS
	});
	assert.equal(TAB_TITLE_ICON_SIZE, 16);
	assert.equal(TAB_TITLE_ICON_CLASS, 'dsh-editor-tabtitle-icon');
});

test('tabTitleIconProps returns null without an api or without a name', () => {
	const api = fakeApi();
	assert.equal(tabTitleIconProps('README.md', null), null);
	assert.equal(tabTitleIconProps('README.md', undefined), null);
	assert.equal(tabTitleIconProps('', api), null);
	assert.equal(tabTitleIconProps(undefined, api), null);
	assert.equal(tabTitleIconProps(null, api), null);
	assert.equal(tabTitleIconProps(42, api), null);
});
