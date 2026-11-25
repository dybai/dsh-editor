import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreFacade } from './shiki-core.js';
import { languages as langWeb } from './lang-web.js';

test('the vendored facade tokenizes with the css-variables theme and tracks grammar state', async () => {
	const facade = createCoreFacade();
	const p = facade.ensureReady();
	assert.ok(p instanceof Promise, 'ensureReady returns a promise and createCoreFacade starts no work');
	await p;
	const { tokens, grammarState } = facade.tokenizeLine('const x = 1;', { lang: 'javascript', maxLineLength: 1000 });
	assert.ok(tokens.length > 0);
	assert.ok(tokens.some((t) => typeof t.color === 'string' && t.color.startsWith('var(--shiki-')), 'css-variables theme emits var(--shiki-*) colors');
	const again = facade.tokenizeLine('const y = 2;', { lang: 'javascript', grammarState, maxLineLength: 1000 });
	assert.ok(again.tokens.length > 0);
	assert.equal(facade.statesEqual(grammarState, again.grammarState), true, 'equal-prefix javascript lines converge to equal states');
});

test('a lazy language group loads into the highlighter and tokenizes', async () => {
	const facade = createCoreFacade();
	await facade.ensureReady();
	assert.equal(facade.isLanguageLoaded('python'), false);
	facade.loadLanguageSync((await import('./lang-script.js')).languages.python);
	assert.equal(facade.isLanguageLoaded('python'), true);
	const { tokens } = facade.tokenizeLine('def f():', { lang: 'python', maxLineLength: 1000 });
	assert.ok(tokens.length > 0);
	assert.ok(Object.keys(langWeb).includes('html'));
});
