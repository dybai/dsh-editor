/**
 * CM6 extension-plan pure core — the mode props collapsed into the toggle
 * record the view assembly consumes (Task 8).
 *
 * `resolveExtensionPlan(props)` is the §4 mapping table's props face as one
 * ignore-safe normalization: the component (Task 9) resolves the framework's
 * default-on preferences and hands the raw mode props here, and this module
 * answers the plan `createCm6View` flips its named compartments by. It owns
 * no defaults beyond the all-off/absent floor — booleans coerce with a
 * literal `true` only, numbers and strings pass through RAW (ruler column
 * convergence lives in ruler-layer.js, indent enum validation in the
 * settings validator), so the pure cores downstream keep owning every
 * normalization decision.
 *
 * Prop names mirror contracts §5.1: `showLineNumbers` → `lineNumbers`,
 * `highlightActiveLine` → `activeLine`, `wordWrap` → `wrap`,
 * `scrollBeyondLastLine` → `scrollBeyondLastLine`, the `showWhitespace`
 * triple, the `ruler` pair, the `indentSettings` pair
 * (`indentMode`/`indentWidth` → `mode`/`width`), and the `matchHighlight`
 * pair. Zero imports: directly testable under node:test.
 *
 * @module @dybai/dsh-editor/cm6/view-plan
 */

/** The framework's default indent mode (settings.js defaultSettings). */
const DEFAULT_INDENT_MODE = 'auto';

/** The framework's default indent width (settings.js defaultSettings). */
const DEFAULT_INDENT_WIDTH = 4;

/**
 * Literal-`true` boolean gate — the convention every preference prop uses.
 * @param {any} value
 * @returns {boolean}
 */
function flag(value) {
	return value === true;
}

/**
 * A usable prop object or `{}` — null/primitives read as absent.
 * @param {any} value
 * @returns {object}
 */
function objectOf(value) {
	return value !== null && typeof value === 'object' ? value : {};
}

/**
 * Normalize the mode props into the extension plan.
 *
 * @param {any} props - the mode props (see the module doc for the names);
 * absent, null and non-object input degrades to the all-off plan.
 * @returns {{
 *   lineNumbers: boolean, activeLine: boolean, wrap: boolean,
 *   scrollBeyondLastLine: boolean,
 *   whitespace: { spaces: boolean, tabs: boolean, newlines: boolean },
 *   ruler: { enabled: boolean, column: any },
 *   indent: { mode: string, width: number },
 *   matchHighlight: { selection: boolean, word: boolean }
 * }} a fresh plan object per call (nested objects included).
 */
export function resolveExtensionPlan(props) {
	const source = objectOf(props);
	const whitespace = objectOf(source.showWhitespace);
	const ruler = objectOf(source.ruler);
	const indent = objectOf(source.indentSettings);
	const matchHighlight = objectOf(source.matchHighlight);
	const mode = indent.indentMode;
	const width = indent.indentWidth;
	return {
		lineNumbers: flag(source.showLineNumbers),
		activeLine: flag(source.highlightActiveLine),
		wrap: flag(source.wordWrap),
		scrollBeyondLastLine: flag(source.scrollBeyondLastLine),
		whitespace: {
			spaces: flag(whitespace.spaces),
			tabs: flag(whitespace.tabs),
			newlines: flag(whitespace.newlines),
		},
		// The column passes through raw — rulerGeometry converges it (1–999, default 80).
		ruler: { enabled: flag(ruler.enabled), column: ruler.column },
		indent: {
			mode: typeof mode === 'string' ? mode : DEFAULT_INDENT_MODE,
			width: typeof width === 'number' && Number.isFinite(width) ? width : DEFAULT_INDENT_WIDTH,
		},
		matchHighlight: {
			selection: flag(matchHighlight.selection),
			word: flag(matchHighlight.word),
		},
	};
}
