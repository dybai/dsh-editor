import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings, SETTINGS_KEYS } from './settings.js';

test('defaultSettings turns every known setting off (默认一律询问)', () => {
  assert.deepEqual(defaultSettings(), { autoReloadClean: false });
});

test('SETTINGS_KEYS carries exactly the known setting names', () => {
  assert.deepEqual([...SETTINGS_KEYS], ['autoReloadClean']);
});

test('normalizeSettings rejects non-object payloads (defaults stay authoritative)', () => {
  for (const raw of [undefined, null, 'x', 42, [true]]) {
    assert.equal(normalizeSettings(raw), undefined);
  }
});

test('normalizeSettings merges the payload over the defaults', () => {
  assert.deepEqual(normalizeSettings({}), { autoReloadClean: false });
  assert.deepEqual(normalizeSettings({ autoReloadClean: true }), { autoReloadClean: true });
  assert.deepEqual(normalizeSettings({ autoReloadClean: false }), { autoReloadClean: false });
});

test('normalizeSettings ignores unknown keys (forward-compat with newer hosts)', () => {
  assert.deepEqual(normalizeSettings({ autoReloadClean: true, futureSetting: 'x' }), {
    autoReloadClean: true,
  });
});

test('normalizeSettings rejects a known key with a non-boolean value', () => {
  for (const raw of [{ autoReloadClean: 'yes' }, { autoReloadClean: 1 }, { autoReloadClean: null }]) {
    assert.equal(normalizeSettings(raw), undefined);
  }
});
