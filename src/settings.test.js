import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings, SETTINGS_KEYS } from './settings.js';

test('defaultSettings: behavior opt-ins off, presentation defaults on', () => {
  assert.deepEqual(defaultSettings(), {
    autoReloadClean: false,
    highlightActiveLine: true,
    showLineNumbers: true,
  });
});

test('SETTINGS_KEYS carries exactly the known setting names', () => {
  assert.deepEqual([...SETTINGS_KEYS], ['autoReloadClean', 'highlightActiveLine', 'showLineNumbers']);
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
  });
  assert.deepEqual(normalizeSettings({ autoReloadClean: true }), {
    autoReloadClean: true,
    highlightActiveLine: true,
    showLineNumbers: true,
  });
  assert.deepEqual(normalizeSettings({ highlightActiveLine: false }), {
    autoReloadClean: false,
    highlightActiveLine: false,
    showLineNumbers: true,
  });
  assert.deepEqual(normalizeSettings({ showLineNumbers: false }), {
    autoReloadClean: false,
    highlightActiveLine: true,
    showLineNumbers: false,
  });
  assert.deepEqual(normalizeSettings({ autoReloadClean: true, highlightActiveLine: false, showLineNumbers: false }), {
    autoReloadClean: true,
    highlightActiveLine: false,
    showLineNumbers: false,
  });
});

test('normalizeSettings ignores unknown keys (forward-compat with newer hosts)', () => {
  assert.deepEqual(normalizeSettings({ autoReloadClean: true, futureSetting: 'x' }), {
    autoReloadClean: true,
    highlightActiveLine: true,
    showLineNumbers: true,
  });
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
  ]) {
    assert.equal(normalizeSettings(raw), undefined);
  }
});
