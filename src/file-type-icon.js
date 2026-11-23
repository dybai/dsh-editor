/**
 * File-type icon plumbing for the editor tab title (0.15.0).
 *
 * The tab-title seat occupant (`EditorTabTitle` in `src/components.js`)
 * renders the same file-type icon the DSH document preview tab shows: the
 * host's shared `FileTypeIcon` component, classified by the host's shared
 * `classifyFileType` — both exported by the runtime module
 * `@deepseek-ai/dsh-client-ui-primitives`. Sharing that module at runtime
 * (rather than vendoring icon artwork) keeps the icons byte-identical with
 * the preview tab, tracks the host's icon set as it evolves, and carries no
 * license obligations: nothing is copied.
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
