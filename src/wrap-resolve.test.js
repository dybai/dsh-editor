import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWordWrap, extensionOf, BUILTIN_WRAP_EXTENSIONS } from './wrap-resolve.js';

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
test('BUILTIN_WRAP_EXTENSIONS is a truly frozen data constant', () => {
	assert.deepEqual([...BUILTIN_WRAP_EXTENSIONS], ['md', 'markdown', 'mdx']);
	assert.equal(Object.isFrozen(BUILTIN_WRAP_EXTENSIONS), true);
	assert.throws(() => BUILTIN_WRAP_EXTENSIONS.push('txt'));
});

// Namespace import + destructure rather than a static named import: before
// implementation the `wrapGlobMatches` export does not exist yet, and a
// missing named export would fail this module's load — every existing case
// would error instead of passing the RED run.
import * as wrapResolve from './wrap-resolve.js';

const { wrapGlobMatches } = wrapResolve;

test('overrides hit beats global explicit and builtin', () => {
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', [{ glob: '*.md', enabled: true }]), true);
	assert.equal(resolveWordWrap({ wordWrap: true }, 'doc.txt', [{ glob: '*.txt', enabled: false }]), false);
});
test('multi-hit rules: any enabled wins over all-disabled', () => {
	const o = [{ glob: '*.md', enabled: false }, { glob: '*.markdown', enabled: true }];
	assert.equal(resolveWordWrap({}, 'readme.markdown', o), true);
	const dups = [{ glob: '*.md', enabled: false }, { glob: '*.md', enabled: true }];
	assert.equal(resolveWordWrap({}, 'readme.md', dups), true);
	assert.equal(resolveWordWrap({}, 'readme.md', [{ glob: '*.md', enabled: false }, { glob: '*.md', enabled: false }]), false);
});
test('no hit falls through to the lower layers (legacy semantics intact)', () => {
	assert.equal(resolveWordWrap({}, 'doc.md', [{ glob: '*.txt', enabled: true }]), true);
	assert.equal(resolveWordWrap(undefined, 'doc.md'), true);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md'), false);
});
test('wrapGlobMatches enforces the *.ext glob shape', () => {
	assert.equal(wrapGlobMatches('*.md', 'doc.md'), true);
	assert.equal(wrapGlobMatches('*.markdown', 'doc.markdown'), true);
	assert.equal(wrapGlobMatches('doc.md', 'doc.md'), false);
	assert.equal(wrapGlobMatches('**.md', 'doc.md'), false);
	assert.equal(wrapGlobMatches('a*.md', 'doc.md'), false);
	assert.equal(wrapGlobMatches('*.md extra', 'doc.md'), false);
	assert.equal(wrapGlobMatches('*.MD', 'doc.md'), false);
	assert.equal(wrapGlobMatches('*.md', 'doc.markdown'), false);
});
test('wrapGlobMatches bounds the extension length at 16', () => {
	assert.equal(wrapGlobMatches('*.abcdefghijklmnop', 'doc.abcdefghijklmnop'), true);
	assert.equal(wrapGlobMatches('*.abcdefghijklmnopq', 'doc.abcdefghijklmnopq'), false);
});
test('wrapGlobMatches lowercases the path (case-insensitive)', () => {
	assert.equal(wrapGlobMatches('*.md', 'README.MD'), true);
	assert.equal(wrapGlobMatches('*.md', 'A/B/Doc.Md'), true);
	assert.equal(wrapGlobMatches('*.md', 'a\\b\\Doc.MD'), true);
});
test('wrapGlobMatches accepts numeric extensions', () => {
	assert.equal(wrapGlobMatches('*.2024', 'build.2024'), true);
	assert.equal(wrapGlobMatches('*.123', 'a/b/log.123'), true);
	assert.equal(resolveWordWrap({}, 'build.2024', [{ glob: '*.2024', enabled: true }]), true);
	assert.equal(resolveWordWrap({}, 'build.2024'), false);
});
test('wrapGlobMatches is never-throw and rejects non-strings', () => {
	assert.equal(wrapGlobMatches(null, 'doc.md'), false);
	assert.equal(wrapGlobMatches(undefined, 'doc.md'), false);
	assert.equal(wrapGlobMatches(42, 'doc.md'), false);
	assert.equal(wrapGlobMatches('*.md', null), false);
	assert.equal(wrapGlobMatches('*.md', undefined), false);
	assert.equal(wrapGlobMatches('*.md', 42), false);
	assert.equal(wrapGlobMatches('*.md', ''), false);
	assert.equal(wrapGlobMatches(), false);
	assert.equal(wrapGlobMatches(null, null), false);
});
test('non-array overrides keep the two-param semantics byte-identical', () => {
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', undefined), false);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', null), false);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', '*.md'), false);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', 42), false);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', { glob: '*.md', enabled: true }), false);
	assert.equal(resolveWordWrap({ wordWrap: true }, 'doc.md', ['nope']), true);
	assert.equal(resolveWordWrap(undefined, 'doc.txt', 'not an array'), false);
});
test('malformed override entries are skipped, never thrown', () => {
	assert.equal(resolveWordWrap({}, 'doc.md', []), true);
	assert.equal(resolveWordWrap({}, 'doc.md', [null, 3, 'x', true]), true);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', [null, 3, 'x', true]), false);
	assert.equal(resolveWordWrap({ wordWrap: false }, 'doc.md', [{}, { glob: '*.md' }, { enabled: true }, { glob: '*.MD', enabled: true }, { glob: '*.md', enabled: 'yes' }, { glob: 5, enabled: true }, { glob: '*.md', enabled: null }]), false);
	assert.equal(resolveWordWrap({}, 'doc.md', [{}, { glob: '*.md', enabled: null }]), true);
});
