/**
 * Framework self-managed keymap — pure key-combo model (spec §6).
 *
 * The framework actions save / saveAll / deleteLines / gotoLine are NOT
 * registered through `ctx.shortcuts` (whose web runtime whitelists
 * browser-owned combos
 * away from page-level defaults). Instead the editor tab's ROOT element
 * intercepts keydown and calls `preventDefault()` itself — a page-level
 * preventDefault works for ANY combination, so the natural keys
 * (Ctrl+S / Ctrl+Shift+S / Ctrl+D) return. Bindings are a global user
 * preference persisted through the Host storage RPC bridge
 * (`dshEditor/getKeymap` / `dshEditor/setKeymap`, KV table `keymap`).
 *
 * Model:
 * - a keymap maps each action id to a binding `{ code, modifiers }`;
 * - `code` is a `KeyboardEvent.code` from the storable alphabet
 *   `Key<A-Z>` / `Digit<0-9>`;
 * - `modifiers` is a subset of the abstract set
 *   `primary | control | alt | shift | meta`, where `primary` resolves to
 *   Cmd (metaKey) on macos and Ctrl (ctrlKey) everywhere else. The web
 *   runtime is Ctrl-based, so callers default `platform` to `'windows'`.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/keymap
 */

/** The framework actions owned by the self-managed keymap channel. */
export const KEYMAP_ACTIONS = ['save', 'saveAll', 'deleteLines', 'gotoLine'];

/** Storable `KeyboardEvent.code` alphabet: letters and digits only. */
const CODE_RE = /^(Key[A-Z]|Digit[0-9])$/;

/** Abstract modifier vocabulary shared with the Host `setKeymap` validator. */
const ALLOWED_MODIFIERS = ['primary', 'control', 'alt', 'shift', 'meta'];

/**
 * The built-in keymap: Ctrl+S / Ctrl+Shift+S / Ctrl+D / Ctrl+G (v0.6.0).
 * @returns a fresh keymap object (callers may mutate their copy).
 */
export function defaultKeymap() {
	return {
		save: { code: 'KeyS', modifiers: ['primary'] },
		saveAll: { code: 'KeyS', modifiers: ['primary', 'shift'] },
		deleteLines: { code: 'KeyD', modifiers: ['primary'] },
		gotoLine: { code: 'KeyG', modifiers: ['primary'] }
	};
}

/**
 * The shared entry-validation walk behind `normalizeKeymap` and
 * `completeKeymap`: accept either shape (object or wire form), validate
 * every entry — known action, `code` from the storable alphabet,
 * `modifiers` within the allowed vocabulary, no duplicate action, no two
 * entries sharing one (code, modifier-set) combination — and collect the
 * ADOPTED partial map with its taken-combo set.
 * @param {any} raw
 * @returns {{ adopted: object, taken: Set<string> }} or `undefined` when
 * anything is structurally invalid.
 */
function adoptEntries(raw) {
	if (raw === null || typeof raw !== 'object') return undefined;
	let entries;
	if (Array.isArray(raw)) {
		entries = raw;
	} else {
		entries = KEYMAP_ACTIONS.map((action) =>
			raw[action] === null || typeof raw[action] !== 'object' ? null : { action, ...raw[action] }
		);
	}
	const adopted = {};
	const taken = new Set();
	for (const entry of entries) {
		if (entry === null || typeof entry !== 'object') return undefined;
		const { action, code, modifiers } = entry;
		if (typeof action !== 'string' || !KEYMAP_ACTIONS.includes(action)) return undefined;
		if (Object.prototype.hasOwnProperty.call(adopted, action)) return undefined; // duplicate action
		if (typeof code !== 'string' || !CODE_RE.test(code)) return undefined;
		if (!Array.isArray(modifiers)) return undefined;
		const set = [];
		for (const modifier of modifiers) {
			if (typeof modifier !== 'string' || !ALLOWED_MODIFIERS.includes(modifier)) return undefined;
			if (!set.includes(modifier)) set.push(modifier);
		}
		const combo = `${code}|${[...set].sort().join('+')}`;
		if (taken.has(combo)) return undefined; // duplicate combination
		taken.add(combo);
		adopted[action] = { code, modifiers: set };
	}
	return { adopted, taken };
}

/**
 * Validate and normalize a COMPLETE keymap.
 *
 * Accepts either shape:
 * - the object form `{ save: {code, modifiers}, … }` (one entry per action);
 * - the wire form `[{ action, code, modifiers }]` (`dshEditor/getKeymap`
 *   records, any subset order).
 *
 * Rules: every framework action present, `code` from the storable alphabet,
 * `modifiers` an array within the allowed vocabulary, and no two actions
 * sharing one (code, modifier-set) combination.
 * @param {any} raw
 * @returns the complete keymap with copied modifier arrays, or
 * `undefined` when anything is invalid (including a missing action —
 * use `completeKeymap` when partial stores must be migrated).
 */
export function normalizeKeymap(raw) {
	const walk = adoptEntries(raw);
	if (walk === undefined) return undefined;
	for (const action of KEYMAP_ACTIONS) {
		if (walk.adopted[action] === undefined) return undefined; // action missing
	}
	return walk.adopted;
}

/**
 * The candidate bindings a MISSING action is filled with, in order: the
 * action's default binding, then default+shift, then default+alt (for
 * `gotoLine`: Ctrl+G → Ctrl+Shift+G → Ctrl+Alt+G). For defaults that
 * already carry shift/alt a later candidate can repeat an earlier combo —
 * harmless, the walk always prefers the first free candidate.
 * @param {{ code: string, modifiers: string[] }} defaultBinding
 * @returns {{ code: string, modifiers: string[] }[]}
 */
function fillCandidates(defaultBinding) {
	const { code, modifiers } = defaultBinding;
	const candidates = [defaultBinding];
	if (!modifiers.includes('shift')) candidates.push({ code, modifiers: [...modifiers, 'shift'] });
	if (!modifiers.includes('alt')) candidates.push({ code, modifiers: [...modifiers, 'alt'] });
	return candidates;
}

/**
 * Migrate a PARTIAL persisted keymap (v0.6.0): the same entry validation as
 * `normalizeKeymap`, but completeness is REPAIRED instead of required —
 * missing actions (a pre-0.6 store predates `gotoLine`) are filled from
 * default-first candidates that stay collision-free with the adopted
 * records. When every candidate of some action collides, the WHOLE
 * migration is rejected (`undefined`) so the caller keeps its complete
 * fallback cache instead of ever holding an incomplete map.
 * @param {any} raw - a possibly-incomplete keymap (object or wire form).
 * @returns a complete normalized keymap, or `undefined` when the records
 * are structurally invalid or the fill is impossible.
 */
export function completeKeymap(raw) {
	const walk = adoptEntries(raw);
	if (walk === undefined) return undefined;
	const completed = walk.adopted;
	for (const action of KEYMAP_ACTIONS) {
		if (completed[action] !== undefined) continue;
		const binding = fillCandidates(defaultKeymap()[action]).find(
			(candidate) => !walk.taken.has(`${candidate.code}|${[...candidate.modifiers].sort().join('+')}`)
		);
		if (binding === undefined) return undefined;
		completed[action] = { code: binding.code, modifiers: binding.modifiers.slice() };
		walk.taken.add(`${completed[action].code}|${[...completed[action].modifiers].sort().join('+')}`);
	}
	return completed;
}

/**
 * Resolve the abstract `primary` modifier to the physical one for a platform.
 * @param {string} platform - `'windows'` (default; web is Ctrl-based) or
 * `'macos'`.
 */
function primaryPhysicalKey(platform) {
	return platform === 'macos' ? 'meta' : 'control';
}

/**
 * The display string of one binding, e.g. `Ctrl+Shift+S`.
 *
 * Order `[primary, shift, alt]` (then `control`/`meta` for completeness);
 * `primary` renders as `Ctrl` (`⌘` on macos), the code drops its
 * `Key`/`Digit` prefix.
 * @param {{ code: string, modifiers: string[] }} binding
 * @param {string} [platform]
 * @returns {string}
 */
export function comboOf(binding, platform = 'windows') {
	if (binding === null || typeof binding !== 'object') return '';
	const macos = platform === 'macos';
	const labels = new Map([
		['primary', macos ? '⌘' : 'Ctrl'],
		['shift', 'Shift'],
		['alt', 'Alt'],
		['control', 'Ctrl'],
		['meta', macos ? '⌘' : 'Meta']
	]);
	const order = ['primary', 'control', 'meta', 'shift', 'alt'];
	const present = Array.isArray(binding.modifiers)
		? order.filter((modifier) => binding.modifiers.includes(modifier))
		: [];
	const key = typeof binding.code === 'string' ? binding.code.replace(/^(Key|Digit)/, '') : '';
	return [...present.map((modifier) => labels.get(modifier)), key].join('+');
}

/**
 * Match one keydown against a keymap.
 *
 * `primary` checks `metaKey` on macos and `ctrlKey` everywhere else (the web
 * runtime is Ctrl-based); a composing event never matches (IME must keep
 * working). The event's physical modifier set must EQUAL the binding's
 * resolved set and the codes must match — an extra held modifier is not a
 * match.
 *
 * Every OWN KEY of the passed keymap is a candidate action — the framework's
 * four-action keymap and editor-internal combo tables (e.g. the plain-text
 * End-key pairs) dispatch through the same matcher, so exact-modifier,
 * composing, and platform semantics stay defined in exactly one place.
 * Arrays are rejected (a keymap is an action → binding record, not a list).
 *
 * @param {{ code, ctrlKey, shiftKey, altKey, metaKey, isComposing }} eventLike
 * @param {{ [action: string]: { code: string, modifiers: string[] } } | null} [keymap]
 * @param {string} [platform]
 * @returns {string | undefined} the matched action id (the keymap's own key).
 */
export function matchAction(eventLike, keymap, platform = 'windows') {
	if (eventLike === null || typeof eventLike !== 'object') return undefined;
	if (eventLike.isComposing === true) return undefined;
	if (keymap === null || typeof keymap !== 'object' || Array.isArray(keymap)) return undefined;
	const code = eventLike.code;
	if (typeof code !== 'string') return undefined;
	const physical = new Set();
	if (eventLike.ctrlKey === true) physical.add('control');
	if (eventLike.altKey === true) physical.add('alt');
	if (eventLike.shiftKey === true) physical.add('shift');
	if (eventLike.metaKey === true) physical.add('meta');
	const primaryPhysical = primaryPhysicalKey(platform);
	for (const action of Object.keys(keymap)) {
		const binding = keymap[action];
		if (binding === null || typeof binding !== 'object') continue;
		if (binding.code !== code) continue;
		const modifiers = Array.isArray(binding.modifiers) ? binding.modifiers : [];
		let matched = modifiers.length === physical.size;
		if (matched) {
			for (const modifier of modifiers) {
				const resolved = modifier === 'primary' ? primaryPhysical : modifier;
				if (!physical.has(resolved)) {
					matched = false;
					break;
				}
			}
		}
		if (matched) return action;
	}
	return undefined;
}

/**
 * The display table for a whole keymap: `{ save: 'Ctrl+S', … }`.
 * @param {object} [keymap]
 * @param {string} [platform]
 */
export function bindingsForDisplay(keymap, platform = 'windows') {
	const display = {};
	for (const action of KEYMAP_ACTIONS) {
		display[action] = keymap !== null && typeof keymap === 'object'
			? comboOf(keymap[action], platform)
			: '';
	}
	return display;
}

/**
 * Whether a keydown is a BROWSER-RESERVED lifecycle combination the page can
 * never reliably intercept (a root-element preventDefault does suppress most
 * combos, but the browser may act on these before the page — Ctrl+W closing
 * the tab was observed live — so the recorder must REJECT them instead of
 * swallowing and hoping).
 *
 * Reserved (web, all platforms): the abstract modifier set is exactly
 * `{primary}` with `code ∈ {KeyW, KeyT, KeyN, KeyQ, Tab, PageUp, PageDown}`
 * (close/new tab, new window, quit, tab-cycle, tab-shift), or exactly
 * `{primary, shift}` with `code ∈ {KeyW, KeyN, KeyQ, KeyT}` (reopen-closed-
 * tab and friends). Everything else — including bare keys without modifiers
 * and combos carrying `alt`/`control`/`meta` extras — is recordable.
 * @param {{ code, ctrlKey, shiftKey, altKey, metaKey, isComposing }} eventLike
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isReservedCombo(eventLike, platform = 'windows') {
	if (eventLike === null || typeof eventLike !== 'object') return false;
	const code = eventLike.code;
	if (typeof code !== 'string') return false;
	// Abstract modifier set of the event: the platform's physical primary key
	// (ctrl on windows, meta on macos) counts as 'primary' ONLY; the other
	// physical key stays its literal 'control'/'meta' self.
	const primary = platform === 'macos' ? eventLike.metaKey === true : eventLike.ctrlKey === true;
	const shift = eventLike.shiftKey === true;
	const extras =
		eventLike.altKey === true ||
		(platform === 'macos' ? eventLike.ctrlKey : eventLike.metaKey) === true;
	const SINGLE = new Set(['KeyW', 'KeyT', 'KeyN', 'KeyQ', 'Tab', 'PageUp', 'PageDown']);
	const SHIFTED = new Set(['KeyW', 'KeyN', 'KeyQ', 'KeyT']);
	if (primary && !shift && !extras) return SINGLE.has(code);
	if (primary && shift && !extras) return SHIFTED.has(code);
	return false;
}

/**
 * Convert a normalized keymap into the wire `bindings` array for
 * `dshEditor/setKeymap` (one `{ action, code, modifiers }` per action).
 * @param {object} keymap - a normalized keymap object.
 * @returns {{ action: string, code: string, modifiers: string[] }[]}
 */
export function bindingsOfKeymap(keymap) {
	return KEYMAP_ACTIONS.map((action) => ({
		action,
		code: keymap[action].code,
		modifiers: keymap[action].modifiers.slice()
	}));
}
