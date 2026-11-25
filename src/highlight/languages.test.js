/**
 * Tests for `src/highlight/languages.js` — the pure extension → language →
 * chunk-group table and its three consumers.
 *
 * The table is the single source of truth for registration globs and for
 * lazy language-group loading, so the integrity tests below pin its shape
 * (non-empty language, one of the five groups, non-empty lowercase
 * extensions) and its global uniqueness invariant (deriveGlobs() emits one
 * `*.<ext>` per extension, so a duplicate would silently collapse order).
 * The `languageOf` cases pin the spec'd edge semantics: basename after the
 * last `/` or `\`, suffix after the last dot, leading dot still separates,
 * and undefined for no-dot basenames, unknown suffixes and trailing dots.
 * Unknown-suffix lookups include `constructor` to prove the lookup table is
 * a Map, not a plain object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_TABLE, languageOf, deriveGlobs, groupOfLanguage } from './languages.js';

const GROUPS = ['warmup', 'web', 'script', 'system', 'data'];

/* ------------------------------------------------ LANGUAGE_TABLE -- */

test('LANGUAGE_TABLE: every row has a non-empty language, a legal group and non-empty lowercase extensions', () => {
	assert.ok(Array.isArray(LANGUAGE_TABLE));
	for (const row of LANGUAGE_TABLE) {
		assert.equal(typeof row.language, 'string');
		assert.ok(row.language.length > 0, 'language must be non-empty');
		assert.ok(GROUPS.includes(row.group), `${row.language}: group ${row.group} is one of the five`);
		assert.ok(Array.isArray(row.extensions), `${row.language}: extensions is an array`);
		assert.ok(row.extensions.length > 0, `${row.language}: extensions must be non-empty`);
		for (const extension of row.extensions) {
			assert.equal(typeof extension, 'string');
			assert.match(extension, /^[a-z0-9]+$/, `${row.language}: extension ${extension} is non-empty lowercase`);
		}
	}
});

test('LANGUAGE_TABLE: every extension is unique across the whole table', () => {
	const all = LANGUAGE_TABLE.flatMap((row) => row.extensions);
	assert.equal(new Set(all).size, all.length, 'no duplicate extension in the flat table');
});

/* --------------------------------------------------- languageOf -- */

test('languageOf: basename suffix, both separators, case-insensitive', () => {
	assert.equal(languageOf('src/app/Editor.JS'), 'javascript');
	assert.equal(languageOf('src\\app\\Editor.JS'), 'javascript');
	assert.equal(languageOf('/x/App.TSX'), 'typescript');
});

test('languageOf: no dot, unknown suffix, trailing dot and empty suffix are undefined', () => {
	assert.equal(languageOf('/x/Makefile'), undefined);
	assert.equal(languageOf('/x/noext'), undefined);
	assert.equal(languageOf('a.tar.gz'), undefined);
	assert.equal(languageOf('foo.constructor'), undefined);
	assert.equal(languageOf('name.'), undefined);
	assert.equal(languageOf(''), undefined);
});

test('languageOf: leading dot still separates (.env)', () => {
	assert.equal(languageOf('configs/.env'), 'dotenv');
});

/* ---------------------------------------------- deriveGlobs -- */

test('deriveGlobs: contains the spec globs js, tsx and env', () => {
	const globs = deriveGlobs();
	assert.ok(globs.includes('*.js'));
	assert.ok(globs.includes('*.tsx'));
	assert.ok(globs.includes('*.env'));
});

test('deriveGlobs: no duplicates, table order, and every extension round-trips', () => {
	const globs = deriveGlobs();
	assert.equal(new Set(globs).size, globs.length, 'no duplicate glob');
	const set = new Set(globs);
	for (const row of LANGUAGE_TABLE) {
		for (const extension of row.extensions) {
			assert.ok(set.has(`*.${extension}`), `round-trip *.${extension}`);
		}
	}
	// one glob per unique extension (no brace expansion in the glob translator)
	assert.equal(globs.length, new Set(LANGUAGE_TABLE.flatMap((row) => row.extensions)).size);
	// stable table order: the first table row's first extension leads
	assert.equal(globs[0], '*.js');
});

/* ------------------------------------------- groupOfLanguage -- */

test('groupOfLanguage: table languages map to their group, unknown is undefined', () => {
	assert.equal(groupOfLanguage('javascript'), 'warmup');
	assert.equal(groupOfLanguage('html'), 'web');
	assert.equal(groupOfLanguage('python'), 'script');
	assert.equal(groupOfLanguage('rust'), 'system');
	assert.equal(groupOfLanguage('dotenv'), 'data');
	assert.equal(groupOfLanguage('nosuch'), undefined);
	assert.equal(groupOfLanguage('constructor'), undefined);
});
