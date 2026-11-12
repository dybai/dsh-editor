import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileAddress, basenameOf, isEditablePath, sessionAddressFor, MAX_EDIT_CHARS } from './address.js';

test('parseFileAddress round-trips sessionAddressFor inside the workspace', () => {
  const address = sessionAddressFor('D:/ws/proj', 'session-1', 'd:/ws/PROJ/src/main.js');
  assert.deepEqual(parseFileAddress(address), { scope: 'session', sessionId: 'session-1', path: 'src/main.js' });
});
test('parseFileAddress round-trips paths outside the workspace', () => {
  const address = sessionAddressFor('D:/ws/proj', 'session-1', 'E:/other/notes.txt');
  assert.deepEqual(parseFileAddress(address), { scope: 'session', sessionId: 'session-1', path: 'E:/other/notes.txt' });
});
test('parseFileAddress rejects non-session and malformed addresses', () => {
  assert.equal(parseFileAddress('dsh-resource://file/absolute/C:/x.txt'), undefined);
  assert.equal(parseFileAddress('https://example.com/a.js'), undefined);
  assert.equal(parseFileAddress('dsh-resource://file/session/'), undefined);
});
test('basenameOf returns the decoded last address segment', () => {
  assert.equal(basenameOf('dsh-resource://file/session/sid/src/a b.js'), 'a b.js');
});
test('isEditablePath accepts known text extensions, case-insensitively', () => {
  assert.equal(isEditablePath('src/main.js'), true);
  assert.equal(isEditablePath('SRC/MAIN.JS'), true);
  assert.equal(isEditablePath('img/logo.png'), false);
  assert.equal(isEditablePath('IMG/LOGO.PNG'), false);
});
test('isEditablePath accepts dotfiles and known extensionless basenames', () => {
  assert.equal(isEditablePath('.gitignore'), true);
  assert.equal(isEditablePath('Makefile'), true);
});
test('MAX_EDIT_CHARS is 4 MiB', () => {
  assert.equal(MAX_EDIT_CHARS, 4 * 1024 * 1024);
});
