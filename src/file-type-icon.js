/**
 * File-type icon plumbing for the editor tab title (0.15.0) and the tab edit
 * badge's derived glyph (0.16.0).
 *
 * The tab-title seat occupant (`EditorTabTitle` in `src/components.js`)
 * renders the same file-type icon the DSH document preview tab shows: the
 * host's shared `FileTypeIcon` component, classified by the host's shared
 * `classifyFileType` — both exported by the runtime module
 * `@deepseek-ai/dsh-client-ui-primitives`. Referencing that module at runtime
 * (rather than vendoring icon artwork) keeps the type icon byte-identical
 * with the preview tab, tracks the host's icon set as it evolves, and
 * carries no license obligations for the type icon itself: nothing is
 * copied. (Exception, 0.16.0: the edit badge's glyph —
 * `TAB_TITLE_DISC_GLYPH_HTML` below — IS shipped with the plugin as a
 * derived artwork; see its provenance note.)
 *
 * Pure functions only, ZERO imports and ZERO bare requires — the same
 * discipline as `ruler.js` / `goto-line.js`. This module must stay importable
 * under `node --test`; the bare require of the primitives module lives in
 * `src/components.js` (react-requiring modules are outside the pure test
 * graph by convention), guarded there so an older host without the module
 * degrades to the plain-filename title.
 */

/** The icon size the document preview tab title uses (px). */
export const TAB_TITLE_ICON_SIZE = 16;

/** Debug-marker class for the title icon. Never a contract (contracts §1). */
export const TAB_TITLE_ICON_CLASS = 'dsh-editor-tabtitle-icon';

/**
 * The editor badge's edit glyph — the tab edit badge's inner artwork (0.16.0).
 *
 * PROVENANCE: derived from the host MIT-licensed `edit-outline` artwork
 * (`@deepseek-ai/dsh-client-ui-primitives`), boldened for 10px legibility:
 * stroke-width raised 1 -> 2 (pen diagonal), the filled square path carries an
 * additional `stroke="currentColor" stroke-width="1"` with round joins so its
 * frame keeps ~1.4px of ink at 1x, and the pen diagonal gets round caps.
 * Rendered inside the 12px white disc (`-tabtitle-editdisc`, which owns the
 * glyph's `currentColor` via its `color`). Distributed with this plugin under
 * the host's MIT license — the README 0.16.0 section records the derivation.
 */
export const TAB_TITLE_DISC_GLYPH_HTML =
	'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke-width="2">' +
	'<path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"></path>' +
	'<path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor" stroke-linecap="round"></path>' +
	'</svg>';

/**
 * Validate a module-ish object as the host primitives' narrow slice the tab
 * title needs. Returns the destructured pair when both exports are present
 * and callable, `null` otherwise (missing module, missing export, wrong
 * shape — every degradation is silent by design, spec §5.1/§8). Never throws.
 * @param {any} mod - whatever the runtime require returned (may be null).
 * @returns {{ FileTypeIcon: Function, classifyFileType: Function } | null}
 *   the narrow pair (never the whole module reference), or null.
 */
export function resolveFileTypeIconApi(mod) {
	if (mod === null || mod === undefined) return null;
	const { FileTypeIcon, classifyFileType } = mod;
	if (typeof FileTypeIcon !== 'function' || typeof classifyFileType !== 'function') {
		return null;
	}
	return { FileTypeIcon, classifyFileType };
}

/**
 * Build the props for the tab-title icon element, or `null` when no icon
 * should render: api missing (degraded host) or the name empty / not a
 * string (no ghost icon next to an empty title). `kind` comes from the
 * host's own `classifyFileType`, so the basename and final-dot parsing —
 * and therefore the icon itself — match the preview tab byte for byte.
 * Never throws.
 * @param {any} name - the tab's file basename (see `basenameOf`).
 * @param {{ FileTypeIcon: Function, classifyFileType: Function } | null} api
 *   the resolved primitives slice (see `resolveFileTypeIconApi`).
 * @returns {{ kind: any, size: number, className: string } | null}
 */
export function tabTitleIconProps(name, api) {
	if (api === null || api === undefined) return null;
	if (typeof name !== 'string' || name.length === 0) return null;
	return {
		kind: api.classifyFileType(name),
		size: TAB_TITLE_ICON_SIZE,
		className: TAB_TITLE_ICON_CLASS
	};
}
