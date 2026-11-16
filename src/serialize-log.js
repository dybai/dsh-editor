/**
 * Safe single-line serialization of log arguments — the stringifier the
 * persistent log channel (log-manager) builds its lines with. Arguments are
 * stringified one by one, joined with single spaces, then capped at
 * `maxChars` (default 2000); a capped line ends with `…(truncated)`.
 *
 * Iron rule: `serializeLogArgs` NEVER throws, whatever it is handed. Every
 * failure mode degrades to a placeholder instead: circular references render
 * as `[circular]`, unserializable members (throwing getters, hostile proxies,
 * stack-depth overflows) as `[unserializable]`, and bigint / function /
 * symbol values as their dedicated placeholders (`123n` form, `[function]`,
 * `[symbol]`). Line breaks inside string arguments become the literal two
 * characters `\n`, so the output is always a single line.
 *
 * Primitive values render exactly like `JSON.stringify` (including `undefined`
 * members being skipped and `NaN`/`Infinity` degrading to `null`); only the
 * placeholders and cycle handling differ, since plain `JSON.stringify` cannot
 * express either.
 *
 * Zero imports: pure functions only, unit-testable without DOM.
 *
 * @module @dybai/dsh-editor/serialize-log
 */

/** Line cap before truncation; the brief's default for the log channel. */
const DEFAULT_MAX_CHARS = 2000;

/** Appended to a cut line; the truncated result stays within `maxChars`. */
const TRUNCATION_MARKER = '…(truncated)';

/** Line breaks (CRLF, LF, CR) collapse to the literal two characters `\n`. */
const LINE_BREAKS = /\r\n|\r|\n/g;

/**
 * Serialize log arguments into one safe single-line string.
 * @param {unknown[]} args - the arguments as passed to the logger.
 * @param {{ maxChars?: number }} [opts] - `maxChars` caps the returned line
 *   (default 2000); a non-finite or negative value falls back to the default.
 * @returns {string} a single line of at most `maxChars` characters; cut lines
 *   end with `…(truncated)`. Never throws on any input.
 */
export function serializeLogArgs(args, opts) {
	const maxChars =
		typeof opts?.maxChars === 'number' && Number.isFinite(opts.maxChars) && opts.maxChars >= 0
			? opts.maxChars
			: DEFAULT_MAX_CHARS;
	let line;
	try {
		line = args.map(stringifyArg).join(' ');
	} catch {
		line = '[unserializable]'; // 铁律兜底：任何输入都不得抛出
	}
	if (line.length > maxChars) {
		line = line.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
	}
	return line;
}

/**
 * Stringify one argument; string arguments keep their text with line breaks
 * replaced by literal `\n`, everything else goes through the placeholder-safe
 * value serializer. Any failure degrades to `[unserializable]`.
 * @param {unknown} arg
 * @returns {string}
 */
function stringifyArg(arg) {
	if (typeof arg === 'string') return arg.replace(LINE_BREAKS, '\\n');
	try {
		return stringifyValue(arg, new Set());
	} catch {
		return '[unserializable]';
	}
}

/**
 * JSON.stringify-shaped value serializer: same primitive rendering as
 * `JSON.stringify`, plus type-dispatch placeholders for bigint / function /
 * symbol, on-stack cycle detection and per-member getter guards.
 * @param {unknown} value
 * @param {Set<object>} seen - objects on the current serialization stack.
 * @returns {string}
 * @throws nothing on plain values; hostile `toJSON`/proxies propagate to the
 *   per-argument guard in `stringifyArg`.
 */
function stringifyValue(value, seen) {
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'function') return '[function]';
	if (typeof value === 'symbol') return '[symbol]';
	if (typeof value === 'bigint') return `${value}n`;
	if (typeof value === 'object') return value === null ? 'null' : stringifyObject(value, seen);
	if (typeof value === 'undefined') return 'undefined';
	// number / boolean: finite numbers render like `JSON.stringify`, which
	// also renders NaN and the infinities as `null`.
	return typeof value === 'number' && !Number.isFinite(value) ? 'null' : String(value);
}

/**
 * Serialize an object, array or exotic container (Map/Set/Date/…). Cycles are
 * detected against the on-stack `seen` set only, so the same object visited
 * twice across sibling branches still serializes in full. A `toJSON` method
 * is honoured first, exactly like `JSON.stringify` does (this also gives
 * `Date` its ISO-string rendering).
 * @param {object} value
 * @param {Set<object>} seen
 * @returns {string}
 */
function stringifyObject(value, seen) {
	if (seen.has(value)) return '[circular]';
	seen.add(value);
	try {
		if (typeof value.toJSON === 'function') return stringifyValue(value.toJSON(), seen);
		if (Array.isArray(value)) return `[${arrayMembers(value, seen).join(',')}]`;
		return `{${objectMembers(value, seen).join(',')}}`;
	} finally {
		seen.delete(value);
	}
}

/** Array members; JSON.stringify renders in-array `undefined` as `null`. */
function arrayMembers(value, seen) {
	const parts = [];
	for (let i = 0; i < value.length; i++) {
		let member;
		try {
			member = value[i];
		} catch {
			parts.push('[unserializable]'); // 元素读取抛错（如 Proxy 陷阱）
			continue;
		}
		parts.push(member === undefined ? 'null' : stringifyValue(member, seen));
	}
	return parts;
}

/** Own enumerable members; undefined-valued keys are skipped like JSON.stringify. */
function objectMembers(value, seen) {
	const parts = [];
	for (const key of Object.keys(value)) {
		let member;
		try {
			member = value[key];
		} catch {
			parts.push(`${JSON.stringify(key)}:[unserializable]`); // getter 抛错
			continue;
		}
		if (member === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${stringifyValue(member, seen)}`);
	}
	return parts;
}
