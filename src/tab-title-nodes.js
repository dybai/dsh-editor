/**
 * Pure builder for the editor tab title's child nodes (0.16.0 follow-up).
 *
 * `EditorTabTitle` (in `src/components.js`) delegates its children to this
 * module so `node --test` can assert the actual element tree with a fake
 * `h` — the 0.16.0 final review mutation-tested the source-text guards and
 * found they stay green even when the disc glyph injection is replaced with
 * an empty attribute (an "empty disc" regression). Tree assertions close
 * that class of blind spots: gate, node structure, class names, disc
 * content and aria-hidden are all asserted against this function's output.
 *
 * The tree (icon present):
 *   span.dsh-editor-tabtitle-iconwrap (relative 16x16 plate wrapper)
 *   ├─ iconNode                       ← the 16px file-type icon element
 *   └─ span.dsh-editor-tabtitle-editdisc  ← 12px white disc badge carrying
 *                                           the derived edit glyph
 * plus the filename text span (deleted state swaps its class). Without an
 * icon node (older host / empty name — same gate as the icon itself) only
 * the text span is produced: no empty disc, no orphaned badge.
 *
 * Pure builder: ZERO imports and ZERO bare requires — the same discipline
 * as `ruler.js` / `goto-line.js`. `h` is injected by the caller (React's
 * createElement in production, a recording fake in tests), so this module
 * stays importable under `node --test`.
 */

export const TAB_TITLE_ICONWRAP_CLASS = 'dsh-editor-tabtitle-iconwrap';

/** Debug-marker class for the badge disc. Never a contract (contracts §1). */
export const TAB_TITLE_EDITDISC_CLASS = 'dsh-editor-tabtitle-editdisc';

export const TAB_TITLE_TEXT_CLASS = 'dsh-editor-tabtitle-text';

export const TAB_TITLE_TEXT_DELETED_CLASS = 'dsh-editor-tabtitle-text-deleted';

/**
 * Build the tab title's child nodes.
 *
 * `iconNode === null` (same gate as the icon: primitives missing or empty
 * filename) → only the text span: the plain 0.14.0/0.15.0 fallback without
 * an empty disc or an orphaned badge. `deleted` swaps the text span's class
 * for the red strikethrough variant — the disc and icon are deliberately
 * unaffected (the red lives on the TEXT-ONLY span; see `EditorTabTitle`).
 * Never throws.
 * @param {object} options
 * @param {Function} options.h - element factory (React createElement).
 * @param {{ type: string, props: object } | null} options.iconNode - the
 *   already-built 16px file-type icon element, or null when degraded.
 * @param {string} options.glyphHtml - the derived edit glyph svg string
 *   (`TAB_TITLE_DISC_GLYPH_HTML` from `src/file-type-icon.js`).
 * @param {boolean} options.deleted - the tab's externally-deleted state.
 * @param {string} options.name - the file basename for the text span.
 * @returns {Array} child nodes for the outer `-tabtitle` span.
 */
export function buildTabTitleChildren({ h, iconNode, glyphHtml, deleted, name }) {
	const textSpan = h(
		'span',
		{
			className: deleted ? TAB_TITLE_TEXT_DELETED_CLASS : TAB_TITLE_TEXT_CLASS
		},
		name
	);
	if (iconNode === null || iconNode === undefined) {
		return [textSpan];
	}
	const disc = h(
		'span',
		{
			className: TAB_TITLE_EDITDISC_CLASS,
			'aria-hidden': true,
			dangerouslySetInnerHTML: { __html: glyphHtml }
		}
	);
	const iconwrap = h(
		'span',
		{
			className: TAB_TITLE_ICONWRAP_CLASS,
			key: 'iwrap'
		},
		iconNode,
		disc
	);
	return [iconwrap, textSpan];
}
