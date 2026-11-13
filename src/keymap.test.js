import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	KEYMAP_ACTIONS,
	defaultKeymap,
	normalizeKeymap,
	comboOf,
	matchAction,
	isReservedCombo,
	bindingsForDisplay,
	bindingsOfKeymap
} from './keymap.js';

/** keydown-like event factory (isComposing defaults to false). */
function keyEvent(code, { ctrl = false, shift = false, alt = false, meta = false, composing = false } = {}) {
	return { code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta, isComposing: composing };
}

// --- default shape ---

test('defaultKeymap has the exact natural-key shape (fresh objects)', () => {
	assert.deepEqual(KEYMAP_ACTIONS, ['save', 'saveAll', 'deleteLines']);
	const keymap = defaultKeymap();
	assert.deepEqual(keymap, {
		save: { code: 'KeyS', modifiers: ['primary'] },
		saveAll: { code: 'KeyS', modifiers: ['primary', 'shift'] },
		deleteLines: { code: 'KeyD', modifiers: ['primary'] }
	});
	// fresh copies: mutating one keymap never poisons later defaults
	keymap.save.modifiers.push('alt');
	assert.deepEqual(defaultKeymap().save, { code: 'KeyS', modifiers: ['primary'] });
});

// --- normalizeKeymap ---

test('normalizeKeymap accepts the object form and copies modifier arrays', () => {
	const normalized = normalizeKeymap({
		save: { code: 'KeyS', modifiers: ['primary'] },
		saveAll: { code: 'KeyS', modifiers: ['primary', 'shift'] },
		deleteLines: { code: 'KeyD', modifiers: ['primary'] }
	});
	assert.deepEqual(normalized, defaultKeymap());
	// modifier arrays are copied: mutating the normalized result never
	// touches the caller's input nor later defaults
	const before = defaultKeymap();
	normalized.save.modifiers.push('alt');
	assert.equal(before.save.modifiers.length, 1);
	assert.equal(normalizeKeymap(before).save.modifiers.length, 1);
	assert.equal(normalizeKeymap(normalized).save.modifiers.length, 2);
});

test('normalizeKeymap accepts the wire bindings array form (any order)', () => {
	const normalized = normalizeKeymap([
		{ action: 'deleteLines', code: 'Digit8', modifiers: ['primary', 'alt'] },
		{ action: 'save', code: 'KeyS', modifiers: ['primary'] },
		{ action: 'saveAll', code: 'KeyS', modifiers: ['primary', 'shift'] }
	]);
	assert.deepEqual(normalized.save, { code: 'KeyS', modifiers: ['primary'] });
	assert.deepEqual(normalized.saveAll, { code: 'KeyS', modifiers: ['primary', 'shift'] });
	assert.deepEqual(normalized.deleteLines, { code: 'Digit8', modifiers: ['primary', 'alt'] });
});

test('normalizeKeymap rejects missing actions, bad codes, bad modifiers, duplicate combos', () => {
	const good = defaultKeymap();
	const invalid = [
		undefined,
		null,
		'save',
		42,
		{},
		{ save: good.save, saveAll: good.saveAll }, // deleteLines missing
		{ save: good.save, saveAll: good.saveAll, deleteLines: { code: 'Comma', modifiers: ['primary'] } },
		{ save: good.save, saveAll: good.saveAll, deleteLines: { code: 'S', modifiers: ['primary'] } },
		{ save: good.save, saveAll: good.saveAll, deleteLines: { code: 'Digit99', modifiers: ['primary'] } },
		{ save: good.save, saveAll: good.saveAll, deleteLines: { code: 'KeyD', modifiers: ['hyper'] } },
		{ save: good.save, saveAll: good.saveAll, deleteLines: { code: 'KeyD', modifiers: 'primary' } },
		{ save: good.save, saveAll: good.saveAll, deleteLines: { code: 'KeyD' } },
		// duplicate combination: deleteLines collides with save's Ctrl+S
		{ save: good.save, saveAll: good.saveAll, deleteLines: { code: 'KeyS', modifiers: ['primary'] } },
		// duplicate combination modulo modifier order
		{
			save: good.save,
			saveAll: good.saveAll,
			deleteLines: { code: 'KeyS', modifiers: ['shift', 'primary'] }
		},
		// array form: duplicate action entries
		[
			{ action: 'save', code: 'KeyS', modifiers: ['primary'] },
			{ action: 'save', code: 'KeyD', modifiers: ['primary'] },
			{ action: 'saveAll', code: 'KeyS', modifiers: ['primary', 'shift'] },
			{ action: 'deleteLines', code: 'KeyD', modifiers: ['primary'] }
		],
		// array form: unknown action
		[
			{ action: 'save', code: 'KeyS', modifiers: ['primary'] },
			{ action: 'saveAll', code: 'KeyS', modifiers: ['primary', 'shift'] },
			{ action: 'deleteLines', code: 'KeyD', modifiers: ['primary'] },
			{ action: 'rename', code: 'KeyR', modifiers: ['primary'] }
		]
	];
	for (const candidate of invalid) {
		assert.equal(normalizeKeymap(candidate), undefined, `expected invalid: ${JSON.stringify(candidate)}`);
	}
	// an empty-modifier binding is within the vocabulary (subset check)
	assert.notEqual(
		normalizeKeymap({ ...good, deleteLines: { code: 'KeyD', modifiers: [] } }),
		undefined
	);
});

// --- matchAction: primary = ctrlKey on the windows platform string ---

test('matchAction resolves primary to ctrlKey on windows and matches exactly', () => {
	const keymap = defaultKeymap();
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true }), keymap), 'save');
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true, shift: true }), keymap), 'saveAll');
	assert.equal(matchAction(keyEvent('KeyD', { ctrl: true }), keymap), 'deleteLines');
	// meta on windows is NOT primary
	assert.equal(matchAction(keyEvent('KeyS', { meta: true }), keymap), undefined);
	// plain S (no modifiers) and wrong code never match
	assert.equal(matchAction(keyEvent('KeyS'), keymap), undefined);
	assert.equal(matchAction(keyEvent('KeyA', { ctrl: true }), keymap), undefined);
	// an extra held modifier breaks the exact-set match
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true, alt: true }), keymap), undefined);
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true, shift: true, alt: true }), keymap), undefined);
});

test('Shift+S matches only saveAll (shift alone is not a match)', () => {
	const keymap = defaultKeymap();
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true, shift: true }), keymap), 'saveAll');
	assert.equal(matchAction(keyEvent('KeyS', { shift: true }), keymap), undefined);
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true }), keymap), 'save');
});

test('matchAction returns undefined while composing', () => {
	const keymap = defaultKeymap();
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true, composing: true }), keymap), undefined);
	assert.equal(
		matchAction(keyEvent('KeyS', { ctrl: true, shift: true, composing: true }), keymap),
		undefined
	);
});

test('matchAction on macos resolves primary to metaKey', () => {
	const keymap = defaultKeymap();
	assert.equal(matchAction(keyEvent('KeyS', { meta: true }), keymap, 'macos'), 'save');
	assert.equal(matchAction(keyEvent('KeyS', { meta: true, shift: true }), keymap, 'macos'), 'saveAll');
	assert.equal(matchAction(keyEvent('KeyD', { meta: true }), keymap, 'macos'), 'deleteLines');
	// ctrl on macos is the literal 'control' modifier, not primary
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true }), keymap, 'macos'), undefined);
	assert.equal(
		matchAction(keyEvent('KeyS', { ctrl: true }), { ...keymap, save: { code: 'KeyS', modifiers: ['control'] } }, 'macos'),
		'save'
	);
});

test('matchAction tolerates garbage input and non-matching keymaps', () => {
	assert.equal(matchAction(null, defaultKeymap()), undefined);
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true }), null), undefined);
	assert.equal(matchAction(keyEvent('KeyS', { ctrl: true }), {}), undefined);
	assert.equal(matchAction({ ctrlKey: true }, defaultKeymap()), undefined); // no code
});

// --- isReservedCombo: browser-lifecycle combos the recorder must reject ---

test('isReservedCombo rejects primary/primary+shift lifecycle combos', () => {
	// primary 单修饰 + KeyW|KeyT|KeyN|KeyQ|Tab|PageUp|PageDown
	assert.equal(isReservedCombo(keyEvent('KeyW', { ctrl: true })), true);
	assert.equal(isReservedCombo(keyEvent('KeyT', { ctrl: true })), true);
	assert.equal(isReservedCombo(keyEvent('KeyN', { ctrl: true })), true);
	assert.equal(isReservedCombo(keyEvent('KeyQ', { ctrl: true })), true);
	assert.equal(isReservedCombo(keyEvent('Tab', { ctrl: true })), true);
	assert.equal(isReservedCombo(keyEvent('PageUp', { ctrl: true })), true);
	assert.equal(isReservedCombo(keyEvent('PageDown', { ctrl: true })), true);
	// primary+shift + KeyW|KeyN|KeyQ|KeyT
	assert.equal(isReservedCombo(keyEvent('KeyW', { ctrl: true, shift: true })), true);
	assert.equal(isReservedCombo(keyEvent('KeyN', { ctrl: true, shift: true })), true);
	assert.equal(isReservedCombo(keyEvent('KeyQ', { ctrl: true, shift: true })), true);
	assert.equal(isReservedCombo(keyEvent('KeyT', { ctrl: true, shift: true })), true);
});

test('isReservedCombo admits recordable combos: alt extras, save keys, bare keys', () => {
	assert.equal(isReservedCombo(keyEvent('KeyW', { ctrl: true, alt: true })), false); // Ctrl+Alt+W 可录制
	assert.equal(isReservedCombo(keyEvent('KeyS', { ctrl: true })), false); // Ctrl+S 本尊可录制
	assert.equal(isReservedCombo(keyEvent('KeyS', { ctrl: true, shift: true })), false); // saveAll 默认键
	assert.equal(isReservedCombo(keyEvent('KeyD', { ctrl: true })), false);
	assert.equal(isReservedCombo(keyEvent('KeyW')), false); // 裸键无修饰不算组合
	assert.equal(isReservedCombo(keyEvent('KeyT', { shift: true })), false); // 无 primary 的 shift
	assert.equal(isReservedCombo(keyEvent('Tab')), false);
	assert.equal(isReservedCombo(null), false);
	assert.equal(isReservedCombo({ ctrlKey: true }), false); // no code
});

test('isReservedCombo on macos reserves the Cmd variants, not literal ctrl', () => {
	assert.equal(isReservedCombo(keyEvent('KeyW', { meta: true }), 'macos'), true); // ⌘W
	assert.equal(isReservedCombo(keyEvent('KeyT', { meta: true, shift: true }), 'macos'), true); // ⌘⇧T
	assert.equal(isReservedCombo(keyEvent('KeyW', { ctrl: true }), 'macos'), false); // literal ctrl 不是 primary
	assert.equal(isReservedCombo(keyEvent('KeyW', { meta: true, alt: true }), 'macos'), false);
});

// --- comboOf / bindingsForDisplay ---

test('comboOf renders Ctrl+S / Ctrl+Shift+S in [primary, shift, alt] order', () => {
	assert.equal(comboOf({ code: 'KeyS', modifiers: ['primary'] }), 'Ctrl+S');
	assert.equal(comboOf({ code: 'KeyS', modifiers: ['shift', 'primary'] }), 'Ctrl+Shift+S');
	assert.equal(comboOf({ code: 'KeyD', modifiers: ['primary'] }), 'Ctrl+D');
	assert.equal(comboOf({ code: 'Digit5', modifiers: ['primary', 'alt', 'shift'] }), 'Ctrl+Shift+Alt+5');
	assert.equal(comboOf({ code: 'KeyK', modifiers: [] }), 'K');
	assert.equal(comboOf({ code: 'KeyS', modifiers: ['primary'] }, 'macos'), '⌘+S');
	assert.equal(comboOf(null), '');
});

test('bindingsForDisplay renders the whole default keymap', () => {
	assert.deepEqual(bindingsForDisplay(defaultKeymap()), {
		save: 'Ctrl+S',
		saveAll: 'Ctrl+Shift+S',
		deleteLines: 'Ctrl+D'
	});
});

// --- wire conversion ---

test('bindingsOfKeymap emits the setKeymap wire array', () => {
	assert.deepEqual(bindingsOfKeymap(defaultKeymap()), [
		{ action: 'save', code: 'KeyS', modifiers: ['primary'] },
		{ action: 'saveAll', code: 'KeyS', modifiers: ['primary', 'shift'] },
		{ action: 'deleteLines', code: 'KeyD', modifiers: ['primary'] }
	]);
	// round trip through normalizeKeymap is lossless
	assert.deepEqual(normalizeKeymap(bindingsOfKeymap(defaultKeymap())), defaultKeymap());
});
