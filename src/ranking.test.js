import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, globMatches, resolveModeId } from './ranking.js';

// --- glob matching primitives ---

test('globToRegExp anchors to the full path and flags case-insensitive', () => {
  const re = globToRegExp('main.js');
  assert.ok(re instanceof RegExp);
  assert.equal(re.flags.includes('i'), true);
  assert.equal(re.source.startsWith('^'), true);
  assert.equal(re.source.endsWith('$'), true);
  assert.equal(re.test('main.js'), true);
  assert.equal(re.test('src/main.js'), false);
});

test('globToRegExp: * matches any chars except / and does not cross segments', () => {
  assert.equal(globToRegExp('*.js').test('app.js'), true);
  assert.equal(globToRegExp('*.js').test('src/app.js'), false);
  assert.equal(globToRegExp('src/*.js').test('src/a b.js'), true);
  assert.equal(globToRegExp('src/*.js').test('src/x/app.js'), false);
});

test('globToRegExp: ** matches zero or more path segments', () => {
  // `a/**/*.ts` hits both a direct child and deep descendants
  assert.equal(globToRegExp('src/**/*.ts').test('src/x.ts'), true);
  assert.equal(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'), true);
  assert.equal(globToRegExp('src/**/*.ts').test('other/x.ts'), false);
  assert.equal(globToRegExp('**/*.md').test('docs/deep/nested/readme.md'), true);
});

test('globToRegExp: leading **/ matches zero or more leading segments', () => {
  assert.equal(globToRegExp('**/*.ts').test('x.ts'), true);
  assert.equal(globToRegExp('**/*.ts').test('a/b/x.ts'), true);
  assert.equal(globToRegExp('**/*.ts').test('a/b/x.js'), false);
});

test('globToRegExp: trailing /** matches zero or more trailing segments', () => {
  assert.equal(globToRegExp('a/**').test('a'), true);
  assert.equal(globToRegExp('a/**').test('a/b'), true);
  assert.equal(globToRegExp('a/**').test('a/b/c'), true);
  assert.equal(globToRegExp('a/**').test('ab'), false);
  assert.equal(globToRegExp('a/**').test('b/c'), false);
});

test('globToRegExp: mid /**/ matches zero or more middle segments', () => {
  assert.equal(globToRegExp('a/**/b').test('a/b'), true);
  assert.equal(globToRegExp('a/**/b').test('a/x/b'), true);
  assert.equal(globToRegExp('a/**/b').test('a/x/y/b'), true);
  assert.equal(globToRegExp('a/**/b').test('a/b/c'), false);
});

test('globToRegExp: bare ** matches any path', () => {
  assert.equal(globToRegExp('**').test('a'), true);
  assert.equal(globToRegExp('**').test('a/b/c.ts'), true);
});

test('globToRegExp: ? matches exactly one char except /', () => {
  assert.equal(globToRegExp('file?.js').test('file1.js'), true);
  assert.equal(globToRegExp('file?.js').test('file12.js'), false);
  assert.equal(globToRegExp('file?.js').test('file/.js'), false);
});

test('globToRegExp matches case-insensitively', () => {
  assert.equal(globToRegExp('*.js').test('APP.JS'), true);
  assert.equal(globToRegExp('*.JS').test('app.js'), true);
  // globstar `**` also matches zero segments, so both direct and nested files hit
  assert.equal(globToRegExp('SRC/**/*.TS').test('src/deep/Main.Ts'), true);
  assert.equal(globToRegExp('SRC/**/*.TS').test('src/Main.Ts'), true);
});

test('globToRegExp escapes regex metacharacters in the glob', () => {
  assert.equal(globToRegExp('file(1).js').test('file(1).js'), true);
  assert.equal(globToRegExp('file(1).js').test('fileX1.js'), false);
  assert.equal(globToRegExp('a+b.c').test('a+b.c'), true);
  assert.equal(globToRegExp('a+b.c').test('aab.c'), false);
});

test('globMatches reports whether the path satisfies the glob', () => {
  assert.equal(globMatches('*.js', 'index.js'), true);
  assert.equal(globMatches('*.js', 'index.mjs'), false);
  assert.equal(globMatches('docs/**/*.md', 'docs/guide/intro.md'), true);
});

test('globMatches pins the zero-segment ** convention', () => {
  assert.equal(globMatches('a/**/*.ts', 'a/x.ts'), true);
  assert.equal(globMatches('a/**/*.ts', 'a/b/c.ts'), true);
  assert.equal(globMatches('a/**/*.ts', 'a/x.js'), false);
  assert.equal(globMatches('**/*.ts', 'x.ts'), true);
  assert.equal(globMatches('a/**', 'a'), true);
  assert.equal(globMatches('a/**', 'a/b/c'), true);
});

test('globMatches pins the slash-unbounded ** fallback', () => {
  // `**` not bounded by slashes compiles to `.*`
  assert.equal(globMatches('src**', 'srcfoo'), true);
  assert.equal(globMatches('src**', 'src/a/b.js'), true);
  // anchoring: the pattern must still start with `src`
  assert.equal(globMatches('src**', 'asrc'), false);
});

// --- resolveModeId: the 5 brief scenarios ---

test('transientPin wins over everything and skips matches veto', () => {
  const entries = [
    { id: 'ext', priority: 'extension', globs: ['*.ts'], matches: () => false },
    { id: 'builtin', priority: 'builtin', globs: ['**/*.ts'], matches: () => true }
  ];
  assert.equal(
    resolveModeId(entries, 'src/app.ts', [{ glob: '*.ts', modeId: 'assoc' }], 'pinned-fallback'),
    'pinned-fallback'
  );
});

test('association beats ranking and is exempt from matches veto', () => {
  const entries = [
    { id: 'ext', priority: 'extension', globs: ['*.conf'], matches: () => false },
    { id: 'builtin', priority: 'builtin', globs: ['**/*.conf'] }
  ];
  assert.equal(
    resolveModeId(entries, 'app.conf', [{ glob: '*.conf', modeId: 'custom' }], undefined),
    'custom'
  );
});

test('extension outranks builtin, glob specificity outranks order', () => {
  // all three globs match `src/main.ts`; `*` never crosses `/` so every
  // glob here is written to genuinely hit that path
  const ext = { id: 'ext.ts', priority: 'extension', globs: ['**/*.ts'] };
  const builtinShort = { id: 'builtin.short', priority: 'builtin', globs: ['**/*.ts'] };
  const builtinLong = { id: 'builtin.long', priority: 'builtin', globs: ['**/main.ts'] };
  // extension wins over both builtins despite registering last with a shorter glob
  assert.equal(
    resolveModeId([builtinLong, builtinShort, ext], 'src/main.ts', [], undefined),
    'ext.ts'
  );
  // within a band, the longer matched pattern wins even when registered later
  assert.equal(resolveModeId([builtinShort, builtinLong], 'src/main.ts', [], undefined), 'builtin.long');
  assert.equal(resolveModeId([builtinLong, builtinShort], 'src/main.ts', [], undefined), 'builtin.long');
});

test('matches veto removes candidate', () => {
  const entries = [
    { id: 'ext.vetoed', priority: 'extension', globs: ['*.md'], matches: () => false },
    { id: 'builtin.kept', priority: 'builtin', globs: ['*.md'], matches: () => true }
  ];
  assert.equal(resolveModeId(entries, 'readme.md', [], undefined), 'builtin.kept');
});

test('no candidates returns undefined', () => {
  assert.equal(resolveModeId([], 'app.js', [], undefined), undefined);
  assert.equal(resolveModeId([{ id: 'ext', priority: 'extension', globs: ['*.ts'] }], 'app.js', [], undefined), undefined);
  // every candidate vetoed by matches
  assert.equal(
    resolveModeId([{ id: 'ext', priority: 'extension', globs: ['*.js'], matches: () => false }], 'app.js', [], undefined),
    undefined
  );
  // no pin, no associations, no entries
  assert.equal(resolveModeId([], 'app.js', [], undefined), undefined);
});

// --- resolveModeId: shape details ---

test('builtin outranks fallback and a globs-less entry is an always candidate', () => {
  const entries = [
    { id: 'fallback', priority: 'fallback' },
    { id: 'builtin', priority: 'builtin', globs: ['src/*.js'] }
  ];
  assert.equal(resolveModeId(entries, 'src/app.js', [], undefined), 'builtin');
  assert.equal(resolveModeId(entries, 'docs/readme.txt', [], undefined), 'fallback');
});

test('registration order breaks ties within a band and specificity', () => {
  const first = { id: 'first', priority: 'extension', globs: ['*.js'] };
  const second = { id: 'second', priority: 'extension', globs: ['?.js'] };
  assert.equal(resolveModeId([first, second], 'a.js', [], undefined), 'first');
  assert.equal(resolveModeId([second, first], 'a.js', [], undefined), 'second');
});

test('an entry with several globs takes its longest matching glob as specificity', () => {
  const shortFirst = { id: 'short', priority: 'builtin', globs: ['src/*.js'] };
  const multi = { id: 'multi', priority: 'builtin', globs: ['nomatch-*', 'src/**/*.js'] };
  assert.equal(resolveModeId([shortFirst, multi], 'src/a/b.js', [], undefined), 'multi');
});

test('associations resolve by first matching record in array order', () => {
  // `build/out.log` matches both records; array order alone decides
  const genericFirst = [
    { glob: '**/*.log', modeId: 'generic-log' },
    { glob: 'build/*.log', modeId: 'build-log' }
  ];
  const buildFirst = [...genericFirst].reverse();
  assert.equal(resolveModeId([], 'build/out.log', genericFirst, undefined), 'generic-log');
  assert.equal(resolveModeId([], 'build/out.log', buildFirst, undefined), 'build-log');
  // a malformed record without a usable glob is skipped, not fatal
  assert.equal(
    resolveModeId([], 'build/out.log', [{ modeId: 'broken' }, { glob: 'build/*.log', modeId: 'build-log' }], undefined),
    'build-log'
  );
  assert.equal(resolveModeId([], 'app.js', genericFirst, undefined), undefined);
});

test('entries without a matches function are never vetoed', () => {
  const entries = [{ id: 'plain', priority: 'fallback', matches: undefined }];
  assert.equal(resolveModeId(entries, 'anything.bin', [], undefined), 'plain');
});
