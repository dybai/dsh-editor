import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWordWrap, extensionOf } from './wrap-resolve.js';

test('explicit setting wins over the builtin default', () => {
	assert.equal(resolveWordWrap({ wordWrap: true }, 'notes.txt'), true);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md'), false);
});
test('unset falls back to the builtin extension default', () => {
	assert.equal(resolveWordWrap({}, 'doc.md'), true);
	assert.equal(resolveWordWrap({}, 'doc.markdown'), true);
	assert.equal(resolveWordWrap({}, 'doc.mdx'), true);
	assert.equal(resolveWordWrap({}, 'a/b/c.txt'), false);
	assert.equal(resolveWordWrap(null, 'doc.md'), true);
	assert.equal(resolveWordWrap(undefined, 'README'), false);
});
test('a non-boolean stored value is not an explicit setting', () => {
	assert.equal(resolveWordWrap({ wordWrap: 'yes' }, 'doc.md'), true);
});
test('extensionOf handles separators, case and dotfiles', () => {
	assert.equal(extensionOf('a\\b\\c.MD'), 'md');
	assert.equal(extensionOf('C:/x/y.md'), 'md');
	assert.equal(extensionOf('noext'), '');
	assert.equal(extensionOf('.editorconfig'), '');
	assert.equal(extensionOf(''), '');
});
