import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsWritePayload, defaultSettings, normalizeSettings, SETTINGS_KEYS } from './settings.js';

test('defaultSettings: behavior opt-ins off, presentation defaults on', () => {
  assert.deepEqual(defaultSettings(), {
    autoReloadClean: false,
    highlightActiveLine: true,
    showLineNumbers: true,
    scrollBeyondLastLine: true,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
});

test('SETTINGS_KEYS carries exactly the known setting names', () => {
  assert.deepEqual([...SETTINGS_KEYS], ['autoReloadClean', 'highlightActiveLine', 'showLineNumbers', 'scrollBeyondLastLine', 'wordWrap', 'showWhitespaceSpaces', 'showWhitespaceTabs', 'showWhitespaceNewlines']);
});

test('normalizeSettings rejects non-object payloads (defaults stay authoritative)', () => {
  for (const raw of [undefined, null, 'x', 42, [true]]) {
    assert.equal(normalizeSettings(raw), undefined);
  }
});

test('normalizeSettings merges the payload over the defaults', () => {
  assert.deepEqual(normalizeSettings({}), {
    autoReloadClean: false,
    highlightActiveLine: true,
    showLineNumbers: true,
    scrollBeyondLastLine: true,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
  assert.deepEqual(normalizeSettings({ autoReloadClean: true }), {
    autoReloadClean: true,
    highlightActiveLine: true,
    showLineNumbers: true,
    scrollBeyondLastLine: true,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
  assert.deepEqual(normalizeSettings({ highlightActiveLine: false }), {
    autoReloadClean: false,
    highlightActiveLine: false,
    showLineNumbers: true,
    scrollBeyondLastLine: true,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
  assert.deepEqual(normalizeSettings({ showLineNumbers: false }), {
    autoReloadClean: false,
    highlightActiveLine: true,
    showLineNumbers: false,
    scrollBeyondLastLine: true,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
  assert.deepEqual(normalizeSettings({ scrollBeyondLastLine: false }), {
    autoReloadClean: false,
    highlightActiveLine: true,
    showLineNumbers: true,
    scrollBeyondLastLine: false,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
  assert.deepEqual(normalizeSettings({ autoReloadClean: true, highlightActiveLine: false, showLineNumbers: false }), {
    autoReloadClean: true,
    highlightActiveLine: false,
    showLineNumbers: false,
    scrollBeyondLastLine: true,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
});

test('normalizeSettings ignores unknown keys (forward-compat with newer hosts)', () => {
  assert.deepEqual(normalizeSettings({ autoReloadClean: true, futureSetting: 'x' }), {
    autoReloadClean: true,
    highlightActiveLine: true,
    showLineNumbers: true,
    scrollBeyondLastLine: true,
    wordWrap: false,
    showWhitespaceSpaces: false,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
});

test('wordWrap is a known boolean setting defaulting to false', () => {
  assert.ok(SETTINGS_KEYS.includes('wordWrap'));
  assert.equal(defaultSettings().wordWrap, false);
  assert.deepEqual(normalizeSettings({ wordWrap: true }), { ...defaultSettings(), wordWrap: true });
  assert.equal(normalizeSettings({ wordWrap: 'yes' }), undefined);
});

test('the showWhitespace keys are known boolean settings defaulting to false', () => {
  assert.ok(SETTINGS_KEYS.includes('showWhitespaceSpaces'));
  assert.ok(SETTINGS_KEYS.includes('showWhitespaceTabs'));
  assert.ok(SETTINGS_KEYS.includes('showWhitespaceNewlines'));
  assert.equal(defaultSettings().showWhitespaceSpaces, false);
  assert.equal(defaultSettings().showWhitespaceTabs, false);
  assert.equal(defaultSettings().showWhitespaceNewlines, false);
  assert.deepEqual(normalizeSettings({ showWhitespaceSpaces: true, showWhitespaceTabs: false }), {
    ...defaultSettings(),
    showWhitespaceSpaces: true,
    showWhitespaceTabs: false,
    showWhitespaceNewlines: false,
  });
  assert.equal(normalizeSettings({ showWhitespaceSpaces: 'yes' }), undefined);
});

test('normalizeSettings rejects a known key with a non-boolean value', () => {
  for (const raw of [
    { autoReloadClean: 'yes' },
    { autoReloadClean: 1 },
    { autoReloadClean: null },
    { highlightActiveLine: 'yes' },
    { highlightActiveLine: 0 },
    { highlightActiveLine: null },
    { showLineNumbers: 'yes' },
    { showLineNumbers: 0 },
    { showLineNumbers: null },
    { scrollBeyondLastLine: 'yes' },
    { scrollBeyondLastLine: 1 },
    { scrollBeyondLastLine: null },
    { wordWrap: 'yes' },
    { wordWrap: 0 },
    { wordWrap: null },
  ]) {
    assert.equal(normalizeSettings(raw), undefined);
  }
});

test('buildSettingsWritePayload writes only the toggled key on a fresh install', () => {
  // raw === null: nothing stored yet, so wordWrap stays ABSENT (the builtin
  // md/markdown/mdx default must survive an unrelated toggle).
  assert.deepEqual(buildSettingsWritePayload(null, { scrollBeyondLastLine: true }), {
    scrollBeyondLastLine: true,
  });
});

test('buildSettingsWritePayload preserves an explicitly stored wordWrap across unrelated toggles', () => {
  assert.deepEqual(buildSettingsWritePayload({ wordWrap: false }, { highlightActiveLine: false }), {
    wordWrap: false,
    highlightActiveLine: false,
  });
});

test('buildSettingsWritePayload merges the change over the raw stored set', () => {
  assert.deepEqual(buildSettingsWritePayload({ autoReloadClean: true }, { wordWrap: true }), {
    autoReloadClean: true,
    wordWrap: true,
  });
});

test('buildSettingsWritePayload treats a non-object raw set as empty', () => {
  for (const raw of [undefined, null, 'x', 42, [true]]) {
    assert.deepEqual(buildSettingsWritePayload(raw, { wordWrap: true }), { wordWrap: true });
  }
});

test('buildSettingsWritePayload rejects an invalid change', () => {
  for (const input of [undefined, null, 'x', 42, [true], { nope: true }, { wordWrap: 'yes' }, { wordWrap: null }]) {
    assert.equal(buildSettingsWritePayload(null, input), undefined);
  }
});

test('buildSettingsWritePayload rejects a corrupted raw set (unknown key or non-boolean)', () => {
  assert.equal(buildSettingsWritePayload({ nope: true }, { wordWrap: true }), undefined);
  assert.equal(buildSettingsWritePayload({ wordWrap: 'yes' }, { highlightActiveLine: false }), undefined);
});

test('buildSettingsWritePayload writes only the explicit showWhitespace change', () => {
  // raw === {}: nothing stored yet, so only the toggled key appears — the
  // other two stay ABSENT (absence = never-set; defaults are never
  // materialized into writes).
  assert.deepEqual(buildSettingsWritePayload({}, { showWhitespaceTabs: true }), {
    showWhitespaceTabs: true,
  });
  // An explicitly stored value flips false without falling back to a default.
  assert.deepEqual(buildSettingsWritePayload({ showWhitespaceSpaces: true }, { showWhitespaceSpaces: false }), {
    showWhitespaceSpaces: false,
  });
});
