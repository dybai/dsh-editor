/**
 * CM6 theme pure core — the token font-style class table and the base
 * theme rules the view assembly hands to `EditorView.theme` (Task 4).
 *
 * Two pure seams, zero imports:
 * - `fontStyleClasses(fontStyle)` maps a shiki token's vscode-textmate
 *   fontStyle bit mask (Italic=1, Bold=2, Underline=4) to the decoration
 *   classes the highlight adapter attaches to token marks. The returned
 *   array is freshly built per call, in i/b/u order.
 * - `cm6BaseTheme()` returns the base CM6 theme object: the CSS of the
 *   current `.dsh-editor-area` surface expressed with DSH alias variables,
 *   so the CM6 content surface inherits the editor's font metrics and
 *   palette instead of CM6's defaults. The view assembly feeds it to
 *   `EditorView.theme`; the DSH variables switch with the app theme, so
 *   no rule gates on CM6's `&light`/`&dark`.
 *
 * The token colours themselves are decoration inline styles (the shiki
 * token carries `color`); this module only styles the fontStyle classes.
 *
 * @module @dybai/dsh-editor/cm6/theme
 */

/** vscode-textmate fontStyle bits. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

/** Decoration classes for the token fontStyle bits, in i/b/u order. */
const TOK_ITALIC = 'dsh-editor-cm6-tok-i';
const TOK_BOLD = 'dsh-editor-cm6-tok-b';
const TOK_UNDERLINE = 'dsh-editor-cm6-tok-u';

/**
 * Map a shiki token's fontStyle bit mask to decoration classes.
 *
 * @param {number} fontStyle - vscode-textmate bits: Italic=1, Bold=2,
 * Underline=4; bits outside those three flags are ignored.
 * @returns {string[]} the matching classes in fixed i/b/u order — a new
 * array per call, so callers never share mutable state.
 */
export function fontStyleClasses(fontStyle) {
	const classes = [];
	if ((fontStyle & FONT_STYLE_ITALIC) !== 0) classes.push(TOK_ITALIC);
	if ((fontStyle & FONT_STYLE_BOLD) !== 0) classes.push(TOK_BOLD);
	if ((fontStyle & FONT_STYLE_UNDERLINE) !== 0) classes.push(TOK_UNDERLINE);
	return classes;
}

/**
 * The base CM6 theme object — selector → declaration list, ready for
 * `EditorView.theme(cm6BaseTheme())`.
 *
 * `&` mirrors `.dsh-editor-area`'s font metrics and palette. CM6's base
 * theme hard-codes `monospace`/1.4 on `.cm-scroller`, so the scroller
 * rule re-declares the metrics the code text actually inherits; the
 * native focus outline is suppressed, and `.cm-selectionBackground`
 * carries the 30% brand active tint (the focused variant repeats it with
 * the base theme's selector shape so it wins the cascade). The token
 * fontStyle classes get their matching declarations so the highlight
 * adapter's decoration classes have styles.
 *
 * @returns {Record<string, string>} the theme rules, a fresh object per
 * call.
 */
export function cm6BaseTheme() {
	return {
		'&': 'font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; tab-size: 4; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);',
		'&.cm-focused': 'outline: none;',
		'.cm-scroller': 'font-family: var(--dsw-font-mono, ui-monospace, monospace); line-height: 1.5;',
		'.cm-selectionBackground': 'background: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);',
		'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': 'background: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);',
		'.cm-gutters': 'background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-right: 1px solid var(--dsw-alias-border-l1);',
		'.cm-activeLine': 'background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);',
		'.cm-lineNumbers': 'color: var(--dsw-alias-label-secondary);',
		// Token fontStyle decoration classes (see fontStyleClasses above):
		// these are the classes the highlight adapter puts on token marks.
		'.dsh-editor-cm6-tok-i': 'font-style: italic;',
		'.dsh-editor-cm6-tok-b': 'font-weight: bold;',
		'.dsh-editor-cm6-tok-u': 'text-decoration: underline;',
	};
}
