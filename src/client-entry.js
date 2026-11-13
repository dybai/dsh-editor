/**
 * @dybai/dsh-editor — the editor framework's browser half (client entry).
 *
 * Bundled by scripts/build.mjs into `client.js` in the `__ModuleLoader__`
 * shape; exports `apply(ctx)` + `inject`. This entry owns the WIRING only —
 * all logic lives in the tested sibling modules (tab-machine, service,
 * ranking, lines, address, draft-store) and the React layer in
 * `src/components.js`.
 *
 * `apply(ctx)` composes, in order:
 *
 * 1. locale dictionaries + styles;
 * 2. the `dshEditorModes` registry (provide) with the built-in `plain-text`
 *    mode registered by this package;
 * 3. the `dshEditor` service (provide): version/active/open plus the tab
 *    registry; foreground resolution reads sidebar-right's on-screen session
 *    observable + active tab record against the registrations map;
 * 4. the editor tab type (kind `editor`, NO patterns — files enter only via
 *    the preview edit button's explicit `openResource(address, { kind })`);
 * 5. the `sidebar.right.pane.tab` body declaring the three child seats
 *    (`dsh-editor.actions` / `.status` / `.unavailable`), plus the
 *    `sidebar.right.pane.tab.title` occupant that paints externally
 *    deleted files' tab names red + strikethrough;
 * 6. the preview-toolbar edit button (`sidebar.right.tab.document.actions`);
 * 7. crash-safety plumbing: the shared draft store with flush-on-hide
 *    listeners (visibilitychange/beforeunload/pagehide while any tab
 *    controller exists), the mode-preference cache (fetched once at apply,
 *    refetched on every menu open), the self-managed keymap cache, the
 *    behavior settings cache (read by every tab machine at notice time and
 *    by the mode components at render time — the active-line highlight
 *    preference, 0.4.0, and the line-number gutter preference, 0.5.0), and
 *    per-tab disk watches (Host
 *    `workspaceFiles/changes` push; manual `stat` fallback swept on
 *    focus/visibility);
 * 8. the one remaining shortcuts command (`dshEditor.modeMenu`, unbound);
 *    save/saveAll/deleteLines are framework self-managed keymap bindings
 *    (spec §6) — the natural keys Ctrl+S / Ctrl+Shift+S / Ctrl+D return
 *    because a root-element keydown preventDefault works for ANY combo,
 *    which the DSH web whitelist cannot take away.
 *
 * Deliberately requires no `@deepseek-ai/*` package: the only bare require
 * is `react`, consumed by src/components.js.
 */

import { MAX_EDIT_CHARS, basenameOf, isEditablePath, parseFileAddress, sessionAddressFor } from './address.js';
import { deleteLines as deleteLinesOp, offsetOfLine } from './lines.js';
import { globMatches } from './ranking.js';
import { createDraftStore } from './draft-store.js';
import { createEditorService } from './service.js';
import { createEditorComponents } from './components.js';
import { defaultKeymap, normalizeKeymap, bindingsOfKeymap } from './keymap.js';
import { defaultSettings, normalizeSettings } from './settings.js';

/* --------------------------------------------------------- identity -- */

const PKG = '@dybai/dsh-editor';
const NS = 'dshEditor';
const EDITOR_KIND = 'editor';
const SERVICE_KEY = 'dshEditor';
const VERSION = '0.5.0';
const STYLE_ID = 'dsh-editor-styles';

/* ---------------------------------------------------------- locale -- */

const zh = {
	'meta.title': '文件编辑器',
	'meta.description':
		'让分栏里的文本文件可以直接编辑：打开文件就地修改并保存到磁盘（Ctrl+S），带版本冲突提示与重新加载。',
	'action.save': '保存',
	'action.saveTitle': '保存到磁盘（{combo}）',
	'action.edit': '编辑此文件',
	'action.editTitle': '在编辑器中打开此文件（保留只读预览）',
	'action.reload': '重新加载',
	'action.reloadTitle': '从磁盘重新加载该文件',
	'action.reloadDiscard': '重新加载并丢弃本地修改',
	'action.saveAnyway': '仍要保存（覆盖磁盘）',
	'action.recreateConfirm': '确认重建',
	'action.recreateConfirmTitle': '文件已被删除：再次点击将以当前内容重新创建该文件',
	'state.dirty': '未保存',
	'state.saved': '已保存',
	'state.saving': '正在保存…',
	'state.loading': '正在加载…',
	'error.unsupported': '此文件无法在这里编辑。',
	'error.loadFailed': '加载文件失败',
	'error.saveFailed': '保存失败',
	'error.notText': '此文件不是有效的 UTF-8 文本，无法编辑。',
	'error.tooLarge': '文件超过 4 MB，无法在此编辑。',
	'conflict.banner': '文件在加载后被修改过。重新加载会丢弃本地修改；仍要保存会覆盖磁盘上的文件。',
	'cmd.modeMenu': '选择编辑器模式',
	'mode.plain': '纯文本',
	'mode.none': '默认',
	'mode.indicatorTitle': '编辑器模式（点击切换）',
	'mode.transient': '本次',
	'mode.transientTitle': '本次用此模式打开（不持久化）',
	'mode.setDefault': '设为默认',
	'mode.setDefaultTitle': '把此模式匹配的文件设为默认用该模式打开',
	'mode.reset': '恢复默认',
	'mode.resetTitle': '清除命中此文件的关联，恢复按排序解析',
	'mode.loading': '正在读取模式偏好…',
	'mode.loadFailed': '读取模式偏好失败',
	'mode.writeFailed': '保存模式偏好失败',
	'mode.conflict': '模式偏好已被其他位置修改，已重新读取，请重试。',
	'keymap.buttonTitle': '编辑器快捷键',
	'keymap.save': '保存',
	'keymap.saveAll': '保存全部',
	'keymap.deleteLines': '删行',
	'keymap.record': '录制',
	'keymap.recording': '按下新组合…（Esc 取消）',
	'keymap.reset': '恢复默认',
	'keymap.resetTitle': '把三个动作的键位恢复为默认（Ctrl+S / Ctrl+Shift+S / Ctrl+D）',
	'keymap.duplicate': '该组合已被其他动作占用，请换一个组合。',
	'keymap.reserved': '该组合被浏览器保留（如关闭/新建标签页），无法录制',
	'keymap.reservedHint': '浏览器保留组合（Ctrl/⌘+W、T、N、Q 等）无法录制',
	'keymap.writeFailed': '保存快捷键失败',
	'keymap.conflict': '快捷键已被其他位置修改，已重新读取，请重试。',
	'external.modified': '文件已被外部修改。是否重新加载？',
	'external.deleted': '文件已被外部删除。是否关闭页签？',
	'external.reload': '重新加载',
	'external.reloadTitle': '丢弃本地修改，从磁盘重新加载',
	'external.dismiss': '放弃更新',
	'external.dismissTitle': '保留本地修改，忽略磁盘上的新内容（保存时将提示冲突）',
	'external.suppress': '不再询问',
	'external.suppressTitle': '本页签内不再询问外部修改（保存时仍会提示冲突）',
	'external.closeTab': '关闭页签',
	'external.closeTabTitle': '关闭这个文件已被删除的页签',
	'external.keep': '保留',
	'external.keepTitle': '保留页签继续编辑（保存将重新创建文件）',
	'settings.buttonTitle': '编辑器设置',
	'settings.autoReloadClean': '干净文件自动重载',
	'settings.autoReloadCleanTitle': '没有未保存修改的文件被外部修改时，直接重新载入而不询问',
	'settings.highlightActiveLine': '高亮光标所在行',
	'settings.highlightActiveLineTitle': '在光标（或选区触及）的行背后绘制高亮色带',
	'settings.highlightActiveLineNote': '内置纯文本模式始终支持；其他编辑模式可经描述符 activeLine 声明遵循同一开关。',
	'settings.showLineNumbers': '显示行号',
	'settings.showLineNumbersTitle': '在内容左侧显示行号列',
	'settings.on': '开',
	'settings.off': '关',
	'settings.writeFailed': '保存设置失败',
	'settings.conflict': '设置已被其他位置修改，已重新读取，请重试。',
	'status.lines': '行',
	'status.chars': '字符'
};

const en = {
	'meta.title': 'File editor',
	'meta.description':
		'Makes text files in the side pane editable: open a file, edit it in place, and save back to disk with Ctrl+S, with stale-version conflict prompts and reload.',
	'action.save': 'Save',
	'action.saveTitle': 'Save to disk ({combo})',
	'action.edit': 'Edit this file',
	'action.editTitle': 'Open this file in the editor (keeps the read-only preview)',
	'action.reload': 'Reload',
	'action.reloadTitle': 'Reload the file from disk',
	'action.reloadDiscard': 'Reload and discard local changes',
	'action.saveAnyway': 'Save anyway (overwrite on disk)',
	'action.recreateConfirm': 'Confirm recreate',
	'action.recreateConfirmTitle': 'The file is deleted: click again to recreate it with the current content',
	'state.dirty': 'Unsaved changes',
	'state.saved': 'Saved',
	'state.saving': 'Saving…',
	'state.loading': 'Loading…',
	'error.unsupported': 'This file cannot be edited here.',
	'error.loadFailed': 'Failed to load the file',
	'error.saveFailed': 'Save failed',
	'error.notText': 'This file is not valid UTF-8 text and cannot be edited.',
	'error.tooLarge': 'This file is larger than 4 MB and cannot be edited here.',
	'conflict.banner':
		'The file changed on disk since it was loaded. Reloading discards local changes; saving anyway overwrites the file on disk.',
	'cmd.modeMenu': 'Choose editor mode',
	'mode.plain': 'Plain text',
	'mode.none': 'Default',
	'mode.indicatorTitle': 'Editor mode (click to change)',
	'mode.transient': 'Once',
	'mode.transientTitle': 'Open with this mode this time (not persisted)',
	'mode.setDefault': 'Set as default',
	'mode.setDefaultTitle': 'Open files matching this mode with it by default',
	'mode.reset': 'Restore defaults',
	'mode.resetTitle': 'Clear the associations matching this file and fall back to ranking',
	'mode.loading': 'Loading mode preferences…',
	'mode.loadFailed': 'Failed to load mode preferences',
	'mode.writeFailed': 'Failed to save mode preferences',
	'mode.conflict': 'Mode preferences changed elsewhere; reloaded, please retry.',
	'keymap.buttonTitle': 'Editor shortcuts',
	'keymap.save': 'Save',
	'keymap.saveAll': 'Save all',
	'keymap.deleteLines': 'Delete lines',
	'keymap.record': 'Record',
	'keymap.recording': 'Press the new combo… (Esc to cancel)',
	'keymap.reset': 'Restore defaults',
	'keymap.resetTitle': 'Restore the default keys (Ctrl+S / Ctrl+Shift+S / Ctrl+D)',
	'keymap.duplicate': 'That combo is already used by another action; pick another one.',
	'keymap.reserved': 'This combination is reserved by the browser (e.g. close/new tab) and cannot be recorded',
	'keymap.reservedHint': 'Browser-reserved combos (Ctrl/⌘+W, T, N, Q, …) cannot be recorded',
	'keymap.writeFailed': 'Failed to save shortcuts',
	'keymap.conflict': 'Shortcuts changed elsewhere; reloaded, please retry.',
	'external.modified': 'The file was modified externally. Reload it?',
	'external.deleted': 'The file was deleted externally. Close this tab?',
	'external.reload': 'Reload',
	'external.reloadTitle': 'Discard local changes and reload the file from disk',
	'external.dismiss': 'Keep mine',
	'external.dismissTitle': 'Keep the local changes and ignore the new disk content (saving will surface the conflict)',
	'external.suppress': 'Stop asking',
	'external.suppressTitle': 'Stop asking about external changes in this tab (saving still surfaces the conflict)',
	'external.closeTab': 'Close tab',
	'external.closeTabTitle': 'Close this tab whose file was deleted',
	'external.keep': 'Keep',
	'external.keepTitle': 'Keep the tab and keep editing (saving recreates the file)',
	'settings.buttonTitle': 'Editor settings',
	'settings.autoReloadClean': 'Auto-reload clean files',
	'settings.autoReloadCleanTitle': 'When a file without unsaved changes is modified externally, reload it silently instead of asking',
	'settings.highlightActiveLine': 'Highlight active line',
	'settings.highlightActiveLineTitle': 'Draw a highlight band behind the caret line (or every line the selection touches)',
	'settings.highlightActiveLineNote': 'The built-in plain-text mode always honors this; other editor modes may declare support via their descriptor.',
	'settings.showLineNumbers': 'Show line numbers',
	'settings.showLineNumbersTitle': 'Draw the line-number column beside the content',
	'settings.on': 'On',
	'settings.off': 'Off',
	'settings.writeFailed': 'Failed to save settings',
	'settings.conflict': 'Settings changed elsewhere; reloaded, please retry.',
	'status.lines': 'lines',
	'status.chars': 'chars'
};

/** Client services this module needs at activation, in order. The shortcuts
 * service is intentionally absent: its commands register through a nested
 * `ctx.inject`, so the editor degrades gracefully without it. */
export const inject = ['slots', 'locale', 'remote', 'connection', 'sessions', 'sidebarRight', 'sidebarRightTabs'];

/* ---------------------------------------------------------- styles -- */

const STYLES = `
.dsh-editor-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-editor-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); min-height: 36px; flex: none; position: relative; }
.dsh-editor-name { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.dsh-editor-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-editor-mode-btn { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; flex: none; }
.dsh-editor-mode-btn:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsh-editor-mode-caret { font-size: 9px; line-height: 1; }
.dsh-editor-menu { position: absolute; top: calc(100% + 4px); right: 10px; z-index: 40; min-width: 280px; max-width: 380px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; gap: 2px; }
.dsh-editor-menu-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12px; }
.dsh-editor-menu-item:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-editor-menu-check { width: 14px; flex: none; color: var(--dsw-alias-brand-primary); }
.dsh-editor-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsh-editor-menu-action { flex: none; height: 22px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-menu-action:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-editor-menu-action:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-menu-footer { display: flex; justify-content: flex-end; padding: 4px 6px 2px; border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 4px; }
.dsh-editor-menu-reset { height: 22px; padding: 0 8px; border: none; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.dsh-editor-menu-reset:hover:not(:disabled) { color: var(--dsh-alias-label-primary); }
.dsh-editor-menu-reset:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-menu-note { padding: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-editor-menu-error { padding: 6px; font-size: 11px; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; }
.dsh-editor-dirty { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
.dsh-editor-dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); }
.dsh-editor-btn { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; white-space: nowrap; flex: none; }
.dsh-editor-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dsh-editor-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.dsh-editor-btn.warn { background: var(--dsw-alias-state-warn-primary); border-color: transparent; color: #fff; }
.dsh-editor-banner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); font-size: 12px; color: var(--dsw-alias-label-primary); flex: none; }
.dsh-editor-banner-text { flex: 1 1 auto; min-width: 0; }
.dsh-editor-area { flex: 1 1 auto; min-height: 0; width: 100%; resize: none; border: none; outline: none; padding: 10px 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; white-space: pre; overflow: auto; tab-size: 4; }
.dsh-editor-inputwrap { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
.dsh-editor-highlight { position: absolute; inset: 0; overflow: hidden; pointer-events: none; background: var(--dsw-alias-bg-base); }
.dsh-editor-highlight-bar { position: absolute; left: 0; min-width: 100%; box-sizing: border-box; border-top: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, var(--dsw-alias-bg-base)); border-bottom: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, var(--dsw-alias-bg-base)); opacity: 0.3; }
.dsh-editor-area.dsh-editor-area-overlay { position: relative; z-index: 1; background: transparent; }
.dsh-editor-center { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px; color: var(--dsw-alias-label-secondary); font-size: 13px; text-align: center; }
.dsh-editor-center-stack { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 90%; }
.dsh-editor-spinner { width: 18px; height: 18px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: transparent; border-radius: 50%; animation: dsh-editor-spin 0.8s linear infinite; flex: none; }
@keyframes dsh-editor-spin { to { transform: rotate(360deg); } }
.dsh-editor-status { display: flex; align-items: center; gap: 12px; padding: 4px 10px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 11px; color: var(--dsw-alias-label-secondary); min-height: 24px; flex: none; position: relative; }
.dsh-editor-status-meta { flex: none; white-space: nowrap; }
.dsh-editor-status-notice { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.dsh-editor-notice-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-editor-notice-error { color: var(--dsw-alias-state-error-primary); }
.dsh-editor-keymap-btn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; flex: none; }
.dsh-editor-keymap-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-editor-keymap-btn[aria-expanded="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-editor-keymap { position: absolute; bottom: calc(100% + 4px); right: 10px; z-index: 40; min-width: 300px; max-width: 400px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; gap: 2px; }
.dsh-editor-keymap-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12px; }
.dsh-editor-keymap-row:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-editor-keymap-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsh-editor-keymap-combo { flex: none; min-width: 70px; text-align: center; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: var(--dsw-alias-bg-layer-1); font-family: var(--dsh-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-editor-keymap-record { flex: none; height: 22px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-keymap-record:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-editor-keymap-record:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-keymap-record.recording { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-editor-keymap-hint { padding: 2px 6px; font-size: 11px; color: var(--dsw-alias-brand-primary); }
.dsh-editor-keymap-error { padding: 6px; font-size: 11px; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; }
.dsh-editor-keymap-footer { display: flex; align-items: center; justify-content: flex-end; padding: 4px 6px 2px; border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 4px; }
.dsh-editor-keymap-note { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: 0.8; }
.dsh-editor-keymap-reset { height: 22px; padding: 0 8px; border: none; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.dsh-editor-keymap-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-editor-keymap-reset:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-tool-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-editor-tool-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-editor-seat { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dsh-editor-seat-status { flex: 1 1 auto; justify-content: flex-end; gap: 8px; overflow: hidden; }
.dsh-editor-seat-column { flex-direction: column; align-items: center; gap: 8px; }
.dsh-editor-banner-external { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, var(--dsw-alias-bg-layer-1)); }
.dsh-editor-tabtitle { display: contents; }
.dsh-editor-tabtitle-deleted { display: contents; color: var(--dsw-alias-state-error-primary); text-decoration: line-through; }
.dsh-editor-settings { position: absolute; bottom: calc(100% + 4px); right: 10px; z-index: 40; min-width: 300px; max-width: 400px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; gap: 2px; }
.dsh-editor-settings-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12px; }
.dsh-editor-settings-row:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-editor-settings-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsh-editor-settings-toggle { flex: none; height: 22px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-settings-toggle:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-editor-settings-toggle.on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-editor-settings-toggle:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-settings-note { padding: 4px 6px 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: 0.8; }
.dsh-editor-settings-error { padding: 6px; font-size: 11px; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; }
/* Line-number gutter (0.5.0): the MONO 13px font lives on the container so
 * its inline 'ch' widths (src/line-numbers.js) resolve in the SAME font as
 * the textarea's matching 'padding-left' — a sans-inherited ch clips the
 * numbers' leading digits. font-size / line-height / padding-top stay
 * identical to .dsh-editor-area's (13px / 1.5 / 10px) so number k sits
 * exactly k lines down, same precondition as the highlight backdrop.
 * z-index 2 paints ABOVE the overlay textarea (z-index 1): with wrap:'off'
 * a horizontal scroll sweeps glyphs across the padding band and the opaque
 * gutter must cover them; pointer-events:none keeps clicks falling through
 * to the textarea (tradeoff: it also covers the scrollbar's left strip).
 * Geometry: the band spans digits + 1.5 + 2 (ch); the rule
 * (.dsh-editor-gutter-rule) sits INSIDE the band at digits + 1.5 — the 2ch
 * right of the rule is covered background keeping the content away from it.
 * -gutter-text's inline width equals that same rule offset (the digits'
 * sub-band): right-aligned inside it with the 1.5ch padding-right below
 * (= GUTTER_GAP_CH, src/line-numbers.js), the widest number ends exactly
 * 1.5ch left of the rule. CONTENT_GAP_CH (2ch) has no CSS twin — it exists
 * only as band width minus rule offset.
 * The RESERVATION is constant: the textarea keeps its padding-left whether
 * or not the gutter renders, so toggling the preference never shifts
 * content. The text block translates against scrollTop at the DOM layer. */
.dsh-editor-gutter { position: absolute; left: 0; top: 0; bottom: 0; z-index: 2; overflow: hidden; background: var(--dsw-alias-bg-base); pointer-events: none; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; }
.dsh-editor-gutter-rule { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-border-l1); }
.dsh-editor-gutter-text { padding: 10px 1.5ch 0 0; text-align: right; white-space: pre; color: var(--dsw-alias-label-secondary); opacity: 0.8; }
`;

/**
 * Insert the plugin stylesheet once into the document head for the plugin's
 * whole lifetime (components render in foreign hosts, so component-local
 * style tags cannot cover them). Theme tokens only.
 * @returns the style-tag remover.
 */
function ensureStyles() {
	if (typeof document === 'undefined' || document === null) return () => {};
	if (document.getElementById(STYLE_ID) !== null) return () => {};
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLES;
	document.head.appendChild(tag);
	return () => tag.remove();
}

/* ----------------------------------------------------- live facade -- */

/** The plugin apply context and captured service handles, set by apply(). */
let facade = null;

/** The Session's workspace root from the sessions facade snapshot. */
function sessionCwdOf(sessionId) {
	try {
		return facade?.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd;
	} catch {
		return undefined;
	}
}

/**
 * Call one Host Remote endpoint through the generic gateway carrier
 * (`connection.rpc.call`, the exact channel every generated namespace method
 * uses); no client-side namespace has to be mounted.
 * @param endpoint - `<namespace>/<method>`.
 * @param args - named wire arguments.
 * @param signal - caller cancellation.
 * @returns the `{ ok, value | error }` envelope.
 */
async function rpcCall(endpoint, args, signal) {
	const ctx = facade === null ? undefined : facade.ctx;
	if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') {
		throw new Error('dsh-editor: the plugin context is unavailable');
	}
	const connection = ctx.get('connection');
	const rpc = connection !== undefined && connection !== null ? connection.rpc : undefined;
	if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
		throw new Error('dsh-editor: the Client connection service with rpc.call is unavailable');
	}
	return await rpc.call('/api', endpoint, { args }, signal);
}

/**
 * Read one complete file as UTF-8 text plus its version — the machine's
 * `deps.load`. Size above MAX_EDIT_CHARS rejects with kind `too-large`;
 * undecodable bytes reject with kind `not-text` (CRLF/CR normalized to LF).
 */
async function loadFile(sessionId, targetPath, signal) {
	const ctx = facade === null ? undefined : facade.ctx;
	const namespace = ctx !== undefined && ctx !== null ? ctx.get('remote.workspaceFiles') : undefined;
	if (namespace === undefined || namespace === null || typeof namespace.readBytes !== 'function') {
		throw new Error('dsh-editor: remote.workspaceFiles with readBytes is unavailable');
	}
	const result = await namespace.readBytes(sessionId, targetPath, {}, signal);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		throw new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: the file read failed'
		);
	}
	const value = result.value;
	const data = value !== null && typeof value === 'object' ? value.data : undefined;
	const bytes = value !== null && typeof value.bytes === 'number' ? value.bytes : data instanceof Uint8Array ? data.length : undefined;
	if (bytes !== undefined && bytes > MAX_EDIT_CHARS) {
		const error = new Error('too-large');
		error.kind = 'too-large';
		throw error;
	}
	if (!(data instanceof Uint8Array)) {
		const error = new Error('dsh-editor: the file read returned no bytes');
		error.kind = 'load-failed';
		throw error;
	}
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(data);
	} catch {
		const error = new Error('not utf-8');
		error.kind = 'not-text';
		throw error;
	}
	return {
		text: text.replace(/\r\n?/g, '\n'),
		version: value !== null && typeof value.version === 'string' ? value.version : ''
	};
}

/**
 * Write one file through the Host `dshEditor/writeFile` RPC — the machine's
 * `deps.write`. Rejects on envelope failure carrying `error.code` (stale
 * detection in the machine reads code/message for /stale/i).
 */
async function writeFile(sessionId, targetPath, content, baseVersion, signal) {
	const result = await rpcCall(
		`${SERVICE_KEY}/writeFile`,
		{ workspaceFileScopeId: sessionId, path: targetPath, content, baseVersion },
		signal
	);
	if (result !== null && typeof result === 'object' && result.ok === true) {
		const value = result.value;
		return {
			operation: value !== null && typeof value === 'object' ? value.operation : undefined,
			version: value !== null && typeof value === 'object' ? value.version : undefined
		};
	}
	const failure = result !== null && typeof result === 'object' ? result.error : null;
	const error = new Error(
		failure !== null && typeof failure.message === 'string' && failure.message.length > 0
			? failure.message
			: 'dsh-editor: the file write failed'
	);
	if (failure !== null && failure !== undefined && typeof failure.code === 'string') error.code = failure.code;
	throw error;
}

/* --------------------------------------------------- disk watch io -- */

/**
 * Open the Host push stream for one file — the disk-watch module's
 * `openChanges`. Returns the supervised `remote.$stream` disposable iterable
 * (`workspaceFiles/changes` frames), or `undefined` when the remote face
 * cannot stream (the watch then starts in manual mode and the focus sweep
 * drives `stat` checks instead).
 */
function openChanges(sessionId, targetPath) {
	const ctx = facade === null ? undefined : facade.ctx;
	const remote = ctx !== undefined && ctx !== null ? ctx.get('remote') : undefined;
	const namespace = ctx !== undefined && ctx !== null ? ctx.get('remote.workspaceFiles') : undefined;
	if (remote === undefined || remote === null || typeof remote.$stream !== 'function') return undefined;
	if (namespace === undefined || namespace === null || typeof namespace.changes !== 'function') return undefined;
	return remote.$stream({
		name: `dsh-editor disk watch of ${sessionId}`,
		open: (signal) => namespace.changes(sessionId, targetPath, signal),
		ended: () => new Error(`dsh-editor disk watch of ${sessionId} ended`)
	});
}

/**
 * Stat one file's disk version — the disk-watch module's `stat`. Resolves
 * `{ version }`; rejects otherwise. Both wire failure shapes are normalized
 * onto a thrown Error carrying the host `code`, so the watch's not-found
 * classification (/FS_NOT_FOUND|ENOENT/) works on either path.
 */
async function statFile(sessionId, targetPath) {
	const ctx = facade === null ? undefined : facade.ctx;
	const namespace = ctx !== undefined && ctx !== null ? ctx.get('remote.workspaceFiles') : undefined;
	if (namespace === undefined || namespace === null || typeof namespace.stat !== 'function') {
		throw new Error('dsh-editor: remote.workspaceFiles with stat is unavailable');
	}
	let result;
	try {
		result = await namespace.stat(sessionId, targetPath, undefined);
	} catch (error) {
		throw error; // a thrown RemoteError already carries `code`
	}
	if (result !== null && typeof result === 'object' && result.ok === true) {
		const value = result.value;
		const version = value !== null && typeof value === 'object' ? value.version : undefined;
		if (typeof version === 'string' && version.length > 0) return { version };
		throw new Error('dsh-editor: the file stat returned no version');
	}
	const failure = result !== null && typeof result === 'object' ? result.error : null;
	const error = new Error(
		failure !== null && typeof failure.message === 'string' && failure.message.length > 0
			? failure.message
			: 'dsh-editor: the file stat failed'
	);
	if (failure !== null && failure !== undefined && typeof failure.code === 'string') error.code = failure.code;
	throw error;
}

/* --------------------------------------------------- mode registry -- */

/**
 * The `dshEditorModes` registry (spec §4.3): plain { register, entries,
 * subscribe }; provided as a cordis service so third parties reach it via
 * `ctx.get('dshEditorModes')`.
 */
function createModeRegistry() {
	const descriptors = [];
	const listeners = new Set();
	function notify() {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// subscriber isolation
			}
		}
	}
	return {
		register(descriptor) {
			if (descriptor === null || typeof descriptor !== 'object' || typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
				throw new Error('dsh-editor: a mode descriptor requires a non-empty string id');
			}
			descriptors.push(descriptor);
			notify();
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				const index = descriptors.indexOf(descriptor);
				if (index !== -1) descriptors.splice(index, 1);
				notify();
			};
		},
		entries() {
			return descriptors.slice();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}

/* ---------------------------------------------- mode associations -- */

/**
 * The mode-association cache (spec §8: Host storage via the RPC bridge).
 * Fetched once at apply, refetched on every menu open, updated after every
 * menu write; tab components re-resolve their mode when it changes.
 */
const associationState = { list: [], updatedAt: undefined, listeners: new Set() };

function getAssociations() {
	return associationState.list;
}

function subscribeAssociations(listener) {
	associationState.listeners.add(listener);
	return () => {
		associationState.listeners.delete(listener);
	};
}

function notifyAssociationListeners() {
	for (const listener of [...associationState.listeners]) {
		try {
			listener();
		} catch {
			// subscriber isolation
		}
	}
}

/** Read the complete association set through `dshEditor/getModePreferences`. */
async function refreshAssociations() {
	const result = await rpcCall(`${SERVICE_KEY}/getModePreferences`, {}, undefined);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		throw new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: reading mode preferences failed'
		);
	}
	const value = result.value;
	const list = value !== null && Array.isArray(value.associations) ? value.associations : [];
	associationState.list = list.filter(
		(entry) => entry !== null && typeof entry === 'object' && typeof entry.glob === 'string' && typeof entry.modeId === 'string'
	);
	associationState.updatedAt = value !== null && typeof value.updatedAt === 'number' ? value.updatedAt : undefined;
	notifyAssociationListeners();
}

/**
 * Replace the complete association set through `dshEditor/setModePreferences`
 * (compare-and-set against the cached `updatedAt`). A conflicting write
 * refetches the cache and rejects with `error.conflict === true`.
 */
async function writeAssociations(list) {
	const args = { associations: list };
	if (typeof associationState.updatedAt === 'number') args.expectedUpdatedAt = associationState.updatedAt;
	const result = await rpcCall(`${SERVICE_KEY}/setModePreferences`, args, undefined);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		const conflict = /conflict/i.test(`${failure !== null && typeof failure.code === 'string' ? failure.code : ''} ${failure !== null && typeof failure.message === 'string' ? failure.message : ''}`);
		const error = new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: saving mode preferences failed'
		);
		if (conflict) {
			error.conflict = true;
			try {
				await refreshAssociations();
			} catch {
				// the conflict path still surfaces; the next open refetches
			}
		}
		throw error;
	}
	associationState.list = list;
	associationState.updatedAt = result.value !== null && typeof result.value === 'object' && typeof result.value.updatedAt === 'number' ? result.value.updatedAt : associationState.updatedAt;
	notifyAssociationListeners();
	try {
		await refreshAssociations();
	} catch {
		// best-effort resync; the local copy already reflects the write
	}
	// The associations write restamped the SHARED token; resync the keymap
	// cache's copy so the next recorder write does not ride a stale CAS token.
	try {
		await refreshKeymap();
	} catch {
		// best-effort; defaults stay authoritative until a later read
	}
	try {
		await refreshSettings();
	} catch {
		// best-effort; defaults stay authoritative until a later read
	}
}

/** "设为默认": upsert one association record per glob of the mode. */
function associationsForDefault(current, descriptor) {
	const globs = Array.isArray(descriptor.globs)
		? descriptor.globs.filter((glob) => typeof glob === 'string' && glob.length > 0)
		: [];
	const kept = current.filter((entry) => !globs.includes(entry.glob));
	return [...kept, ...globs.map((glob) => ({ glob, modeId: descriptor.id }))];
}

/** "恢复默认": drop every association record whose glob hits the path. */
function associationsForReset(current, targetPath) {
	return current.filter((entry) => {
		try {
			return !(typeof entry.glob === 'string' && globMatches(entry.glob, targetPath));
		} catch {
			return true;
		}
	});
}

/* ---------------------------------------------------------- keymap -- */

/**
 * The framework self-managed keymap cache (spec §6): a GLOBAL user preference
 * (one binding set across tabs and modes). Seeded with the built-in defaults,
 * read once at apply through `dshEditor/getKeymap` (a failed/short read keeps
 * the defaults), rewritten after every recorder write. Every mounted editor
 * tab matches keydown against this cache — the shortcuts service never sees
 * the three actions.
 */
const keymapState = { keymap: defaultKeymap(), updatedAt: undefined, listeners: new Set() };

function getKeymap() {
	return keymapState.keymap;
}

function subscribeKeymap(listener) {
	keymapState.listeners.add(listener);
	return () => {
		keymapState.listeners.delete(listener);
	};
}

function notifyKeymapListeners() {
	for (const listener of [...keymapState.listeners]) {
		try {
			listener();
		} catch {
			// subscriber isolation
		}
	}
}

/**
 * Read the persisted keymap through `dshEditor/getKeymap` and adopt it when
 * the records form a valid complete keymap; anything else keeps the current
 * (default) bindings — a Host that never wrote the table reports an empty
 * binding set and the defaults stay authoritative.
 */
async function refreshKeymap(signal) {
	const result = await rpcCall(`${SERVICE_KEY}/getKeymap`, {}, signal);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		throw new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: reading the keymap failed'
		);
	}
	const value = result.value;
	if (value !== null && Array.isArray(value.bindings)) {
		const normalized = normalizeKeymap(value.bindings);
		if (normalized !== undefined) keymapState.keymap = normalized;
	}
	keymapState.updatedAt =
		value !== null && typeof value === 'object' && typeof value.updatedAt === 'number' ? value.updatedAt : undefined;
	notifyKeymapListeners();
}

/**
 * Persist a new keymap through `dshEditor/setKeymap` (compare-and-set against
 * the cached token, which the mode-association store SHARES — see the Host
 * module doc). Accepts the object form `{ save, saveAll, deleteLines }` or
 * the wire bindings array; invalid input rejects before any RPC. On success
 * the local cache updates and every mounted editor tab immediately matches
 * the new keys. A conflicting write refetches and rejects with
 * `error.conflict === true`.
 */
async function writeKeymap(input) {
	const normalized = normalizeKeymap(input);
	if (normalized === undefined) {
		const error = new Error('dsh-editor: the keymap is invalid');
		error.code = 'keymap/invalid';
		throw error;
	}
	const args = { bindings: bindingsOfKeymap(normalized) };
	if (typeof keymapState.updatedAt === 'number') args.expectedUpdatedAt = keymapState.updatedAt;
	const result = await rpcCall(`${SERVICE_KEY}/setKeymap`, args, undefined);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		const conflict = /conflict/i.test(`${failure !== null && typeof failure.code === 'string' ? failure.code : ''} ${failure !== null && typeof failure.message === 'string' ? failure.message : ''}`);
		const error = new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: saving the keymap failed'
		);
		if (conflict) {
			error.conflict = true;
			try {
				await refreshKeymap();
			} catch {
				// the conflict path still surfaces; the next open refetches
			}
		}
		throw error;
	}
	keymapState.keymap = normalized;
	keymapState.updatedAt =
		result.value !== null && typeof result.value === 'object' && typeof result.value.updatedAt === 'number'
			? result.value.updatedAt
			: keymapState.updatedAt;
	notifyKeymapListeners();
	try {
		await refreshKeymap();
	} catch {
		// best-effort resync; the local copy already reflects the write
	}
	// The keymap write restamped the SHARED token; resync the associations
	// cache so the next menu write does not ride a stale CAS token.
	try {
		await refreshAssociations();
	} catch {
		// surfaced by the menu's next open
	}
	try {
		await refreshSettings();
	} catch {
		// best-effort; defaults stay authoritative until a later read
	}
}

/* -------------------------------------------------------- settings -- */

/**
 * The editor behavior settings cache (the settings panel's global user
 * preference). Same shape as the keymap cache: seeded with the built-in
 * defaults, read once at apply through `dshEditor/getSettings` (a failed or
 * malformed read keeps the defaults), rewritten after every toggle write.
 * The tab machines read `autoReloadClean` from this cache at notice time.
 */
const settingsState = { settings: defaultSettings(), updatedAt: undefined, listeners: new Set() };

function getSettings() {
	return settingsState.settings;
}

function subscribeSettings(listener) {
	settingsState.listeners.add(listener);
	return () => {
		settingsState.listeners.delete(listener);
	};
}

function notifySettingsListeners() {
	for (const listener of [...settingsState.listeners]) {
		try {
			listener();
		} catch {
			// subscriber isolation
		}
	}
}

/**
 * Read the persisted settings through `dshEditor/getSettings` and adopt them
 * when the payload normalizes; anything else keeps the current (default)
 * values — a Host that never wrote the table reports an empty settings set
 * and the defaults stay authoritative.
 */
async function refreshSettings(signal) {
	const result = await rpcCall(`${SERVICE_KEY}/getSettings`, {}, signal);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		throw new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: reading the settings failed'
		);
	}
	const value = result.value;
	const normalized = normalizeSettings(value !== null && typeof value === 'object' ? value.settings : undefined);
	if (normalized !== undefined) settingsState.settings = normalized;
	settingsState.updatedAt =
		value !== null && typeof value === 'object' && typeof value.updatedAt === 'number' ? value.updatedAt : undefined;
	notifySettingsListeners();
}

/**
 * Persist the settings through `dshEditor/setSettings` (compare-and-set
 * against the cached SHARED token — see the Host module doc). On success the
 * local cache updates and every mounted editor tab reads the new values at
 * its next disk notice. A conflicting write refetches and rejects with
 * `error.conflict === true`. The write restamps the SHARED token, so the
 * keymap and association caches are resynced afterwards.
 */
async function writeSettings(input) {
	const candidate = normalizeSettings({ ...getSettings(), ...input });
	if (candidate === undefined) {
		const error = new Error('dsh-editor: the settings payload is invalid');
		error.code = 'settings/invalid';
		throw error;
	}
	const args = { settings: candidate };
	if (typeof settingsState.updatedAt === 'number') args.expectedUpdatedAt = settingsState.updatedAt;
	const result = await rpcCall(`${SERVICE_KEY}/setSettings`, args, undefined);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		const conflict = /conflict/i.test(`${failure !== null && typeof failure.code === 'string' ? failure.code : ''} ${failure !== null && typeof failure.message === 'string' ? failure.message : ''}`);
		const error = new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: saving the settings failed'
		);
		if (conflict) {
			error.conflict = true;
			try {
				await refreshSettings();
			} catch {
				// the conflict path still surfaces; the next toggle retries
			}
		}
		throw error;
	}
	settingsState.settings = candidate;
	settingsState.updatedAt =
		result.value !== null && typeof result.value === 'object' && typeof result.value.updatedAt === 'number'
			? result.value.updatedAt
			: settingsState.updatedAt;
	notifySettingsListeners();
	try {
		await refreshSettings();
	} catch {
		// best-effort resync; the local copy already reflects the write
	}
	// The settings write restamped the SHARED token; resync the other two
	// caches so their next writes do not ride a stale CAS token.
	try {
		await refreshKeymap();
	} catch {
		// best-effort; defaults stay authoritative until a later read
	}
	try {
		await refreshAssociations();
	} catch {
		// surfaced by the menu's next open
	}
}

/* ------------------------------------------- foreground resolution -- */

/**
 * The entry-side mirror of service registrations (tabKey → registration),
 * used by foreground resolution, saveAll gating and the commands.
 */
const tabRegistrations = new Map();

/** tabKey → mode-menu opener, populated by the visible EditorTab. */
const menuOpeners = new Map();

/** Live tab controllers; guards the flush-on-hide listeners. */
const liveControllers = new Set();

/** Coerce a sidebar-right mounted-snapshot value into a SessionId. */
function normalizeSessionIdOf(value) {
	if (typeof value === 'string' && value.length > 0) return value;
	if (value !== null && typeof value === 'object') {
		if (typeof value.sessionId === 'string' && value.sessionId.length > 0) return value.sessionId;
		if (typeof value.id === 'string' && value.id.length > 0) return value.id;
	}
	return undefined;
}

/** The on-screen SessionId from `ctx.sidebarRight.mounted`. */
function mountedSession() {
	try {
		return normalizeSessionIdOf(facade?.sidebarRight?.mounted?.getSnapshot?.());
	} catch {
		return undefined;
	}
}

/** The active pane's TabRecord from `ctx.sidebarRight.active()`. */
function activeTabRecord() {
	try {
		const sidebarRight = facade === null ? undefined : facade.sidebarRight;
		if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.active !== 'function') return undefined;
		return sidebarRight.active();
	} catch {
		return undefined;
	}
}

/**
 * deps.resolveForegroundTab for the service (spec §4.2): the on-screen
 * session's active tab is one of THIS framework's editor tabs (kind match on
 * the active record) and a registered, visible tab with the same address.
 * Re-run triggers: registration changes + controller publishes (hooked by the
 * service), visibility flips and `sidebarRight.mounted` changes (through each
 * registration's notifyChange).
 */
function resolveForegroundTab() {
	const sessionId = mountedSession();
	if (sessionId === undefined) return undefined;
	const record = activeTabRecord();
	if (record === undefined || record === null || typeof record !== 'object') return undefined;
	if (record.kind !== EDITOR_KIND || typeof record.contentId !== 'string') return undefined;
	for (const [tabKey, registration] of tabRegistrations) {
		if (registration.address !== record.contentId) continue;
		if (registration.sessionId !== sessionId) continue;
		if (typeof registration.isVisible === 'function' && registration.isVisible() !== true) continue;
		return {
			tabKey,
			sessionId: registration.sessionId,
			address: registration.address,
			controller: registration.controller,
			isVisible: true
		};
	}
	return undefined;
}

/**
 * The keymap actions' dispatch helpers (spec §6): the editor tab's root
 * element intercepts keydown and routes the matched action here. `save` and
 * `deleteLines` operate on ONE registration's controller; `saveAll` sweeps
 * the session through the editor service (ready/saving + dirty gating).
 */

/** Queue one save for a registration's controller (force = overwrite intent). */
function requestSaveTab(registration, force) {
	const controller = registration !== null && typeof registration === 'object' ? registration.controller : undefined;
	if (controller === undefined || controller === null || typeof controller.requestSave !== 'function') return;
	controller.requestSave(force === true);
}

/**
 * The shared delete-lines computation (previously the deleteLines command's
 * run body): delete the lines touched by the current selection and land the
 * caret on the original start line via the framework content write command.
 */
function deleteLinesFor(registration) {
	const controller = registration !== null && typeof registration === 'object' ? registration.controller : undefined;
	if (controller === undefined || controller === null) return;
	const current = controller.getState();
	if (current.phase !== 'ready' && current.phase !== 'saving') return;
	const selection = current.selection;
	const start = selection !== null && typeof selection.start === 'number' ? selection.start : 0;
	const end = selection !== null && typeof selection.end === 'number' ? selection.end : start;
	const outcome = deleteLinesOp(current.draft, start, end);
	const caretOffset = offsetOfLine(outcome.text, outcome.caretLine);
	controller.setContent(outcome.text, {
		start: caretOffset,
		end: caretOffset,
		lineStart: outcome.caretLine,
		lineEnd: outcome.caretLine,
		text: null
	});
}

/**
 * deps.closeTab: best-effort framework close of one docked tab. The
 * sidebar-right surface is verified live in Task 9; the candidates cover the
 * plausible method names and degrade to a console warning.
 */
function closeTab(tabKey) {
	const sidebarRight = facade === null ? undefined : facade.sidebarRight;
	if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight !== 'object') return;
	for (const methodName of ['close', 'closeTab', 'closeResource']) {
		const method = sidebarRight[methodName];
		if (typeof method !== 'function') continue;
		try {
			const arg = methodName === 'closeResource' ? tabRegistrations.get(tabKey)?.address : tabKey;
			const outcome = method.call(sidebarRight, arg);
			if (outcome !== null && typeof outcome === 'object' && typeof outcome.catch === 'function') {
				outcome.catch(() => {});
			}
			return;
		} catch {
			// try the next candidate
		}
	}
	console.warn('[dsh-editor] closing a tab is not supported by this sidebar-right build');
}

/** Subscribe to `ctx.sidebarRight.mounted` changes (session switches). */
function subscribeMounted(listener) {
	const mounted = facade === null ? undefined : facade.sidebarRight?.mounted;
	if (mounted === undefined || mounted === null || typeof mounted.subscribe !== 'function') return () => {};
	return mounted.subscribe(() => listener());
}

/** Preview edit button click: open the file in the editor tab type. */
function openFromPreview(sessionId, absolutePath) {
	const sidebarRight = facade === null ? undefined : facade.sidebarRight;
	if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.openResource !== 'function') {
		console.warn('[dsh-editor] the right-Sidebar service is unavailable');
		return;
	}
	try {
		sidebarRight.openResource(sessionAddressFor(sessionCwdOf(sessionId), sessionId, absolutePath), { kind: EDITOR_KIND });
	} catch (error) {
		console.warn('[dsh-editor] opening the editor failed:', error);
	}
}

/* ------------------------------------------------------- commands -- */

/** Register one command with the documented defaults-fallback degradation. */
function registerCommandWithFallback(shortcuts, command) {
	try {
		const dispose = shortcuts.register(command);
		return typeof dispose === 'function' ? dispose : undefined;
	} catch (error) {
		if (command.defaults !== undefined && Object.keys(command.defaults).length > 0) {
			try {
				const dispose = shortcuts.register({ ...command, defaults: {} });
				return typeof dispose === 'function' ? dispose : undefined;
			} catch (fallbackError) {
				console.warn('[dsh-editor] registering command', command.id, 'failed:', fallbackError);
				return undefined;
			}
		}
		console.warn('[dsh-editor] registering command', command.id, 'failed:', error);
		return undefined;
	}
}

/**
 * The ONE remaining shortcuts command (spec §6): `dshEditor.modeMenu`, no
 * default key (user-bindable). save / saveAll / deleteLines LEFT this
 * surface on purpose — the web runtime's whitelist refuses browser-owned
 * combos as page-level defaults, so the three actions moved to the
 * framework's SELF-MANAGED keymap: the editor root element intercepts
 * keydown and calls preventDefault itself (valid for ANY combo, whitelist
 * not applicable), with bindings persisted via `dshEditor/get|setKeymap`.
 */
function editorCommands(t) {
	return [
		{
			id: 'dshEditor.modeMenu',
			label: () => t('cmd.modeMenu'),
			aliases: ['change editor mode'],
			defaults: {},
			regions: ['page', 'editable'],
			modals: [],
			resolve: () => {
				const foreground = resolveForegroundTab();
				if (foreground === undefined) return { status: 'pass' };
				return {
					status: 'handled',
					run: () => {
						const opener = menuOpeners.get(foreground.tabKey);
						if (typeof opener === 'function') opener();
					}
				};
			}
		}
	];
}

/* ----------------------------------------------------- draft store -- */

/** The localStorage adapter (in-memory no-op fallback outside a browser). */
function resolveStorageAdapter() {
	try {
		const store = typeof window !== 'undefined' && window !== null ? window.localStorage : undefined;
		if (store !== undefined && store !== null) {
			return {
				getItem: (key) => store.getItem(key),
				setItem: (key, value) => store.setItem(key, value),
				removeItem: (key) => store.removeItem(key)
			};
		}
	} catch {
		// privacy mode / storage denied
	}
	return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

/** One shared draft store for every tab machine (single storage key). */
const editorDraftStore = createDraftStore(resolveStorageAdapter());

/* ----------------------------------------------------------- apply -- */

/**
 * Plugin activation: the full framework wiring (see the module doc for the
 * composition order). Idempotent per activation; every registration returns
 * its disposer through `ctx.effect`.
 * @param ctx - the plugin's Client context.
 */
export function apply(ctx) {
	facade = { ctx, sidebarRight: ctx.get('sidebarRight'), sessions: ctx.get('sessions') };
	const boundT =
		ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.bind === 'function'
			? ctx.locale.bind(NS)
			: (key) => key;

	// 1. locale + styles
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-editor: dictionaries');
	ctx.effect(() => ensureStyles(), 'dsh-editor: styles');

	// 2. mode registry (provide) — plain-text registers after the components
	const modeRegistryObj = createModeRegistry();
	ctx.effect(() => ctx.provide('dshEditorModes', modeRegistryObj), 'dsh-editor: mode registry');

	// 3. dshEditor service (provide)
	const editorService = createEditorService({
		version: VERSION,
		resolveForegroundTab,
		openInSidebar: (target, opts) => {
			const sidebarRight = facade === null ? undefined : facade.sidebarRight;
			if (sidebarRight !== undefined && sidebarRight !== null && typeof sidebarRight.openResource === 'function') {
				sidebarRight.openResource(target, opts);
			}
		},
		modeRegistry: modeRegistryObj,
		closeTab
	});
	ctx.effect(() => ctx.provide('dshEditor', editorService), 'dsh-editor: service');

	const componentRuntime = {
		draftStore: editorDraftStore,
		loadFile,
		writeFile,
		modeRegistry: modeRegistryObj,
		subscribeModes: (listener) => modeRegistryObj.subscribe(listener),
		getAssociations,
		subscribeAssociations,
		refreshAssociations,
		setDefaultMode: async (descriptor) => {
			await writeAssociations(associationsForDefault(getAssociations(), descriptor));
		},
		resetAssociationsFor: async (targetPath) => {
			await writeAssociations(associationsForReset(getAssociations(), targetPath));
		},
		registerTab: (tabKey, registration) => {
			tabRegistrations.set(tabKey, registration);
			const dispose = editorService.registerTab(tabKey, registration);
			return () => {
				if (tabRegistrations.get(tabKey) === registration) tabRegistrations.delete(tabKey);
				dispose();
			};
		},
		subscribeMounted,
		registerModeMenuOpener: (tabKey, opener) => {
			menuOpeners.set(tabKey, opener);
			return () => {
				if (menuOpeners.get(tabKey) === opener) menuOpeners.delete(tabKey);
			};
		},
		addLiveController: (controller) => {
			liveControllers.add(controller);
		},
		removeLiveController: (controller) => {
			liveControllers.delete(controller);
		},
		openFromPreview,
		// self-managed keymap channel (spec §6): global user preference,
		// persisted through the Host RPC bridge, shared by every mounted tab
		getKeymap,
		subscribeKeymap,
		setKeymap: writeKeymap,
		// settings channel (v0.3): global user preference read by every tab
		// machine at notice time (`autoReloadClean`), written by the gear panel
		getSettings,
		subscribeSettings,
		setSettings: writeSettings,
		// disk watch IO: the Host push stream (or undefined → manual mode)
		// and the cheap stat used by both the stream fallback and the focus sweep
		openChanges,
		statFile,
		getRegistration: (tabKey) => tabRegistrations.get(tabKey),
		saveAllOfSession: (sessionId) => editorService.saveAll(sessionId),
		requestSaveTab,
		deleteLinesFor
	};

	const editorComponents = createEditorComponents(componentRuntime);

	ctx.effect(
		() =>
			modeRegistryObj.register({
				id: 'plain-text',
				priority: 'fallback',
				globs: ['*'],
				label: () => boundT('mode.plain'),
				contentKind: 'text',
				// 契约自描述（§5.1）：内置模式实现了活动行高亮并遵循偏好。
				activeLine: true,
				component: editorComponents.PlainTextMode
			}),
		'dsh-editor: plain-text mode'
	);

	// 4. tab type: claims nothing by itself (no patterns) — files enter only
	// through the preview edit button's explicit kind (canOpen still applies).
	ctx.effect(
		() =>
			ctx.sidebarRightTabs.register({
				id: PKG,
				kind: EDITOR_KIND,
				keepMounted: true,
				canOpen: (candidate) => {
					const parsed = parseFileAddress(candidate);
					return parsed !== undefined && parsed.scope === 'session' && isEditablePath(parsed.path);
				},
				title: basenameOf
			}),
		'dsh-editor: tab type'
	);

	// 5. pane.tab body with the three child seats (declaring children makes
	// the framework inject renderSlot into the body component's props).
	ctx.slots.inject('sidebar.right.pane.tab', function* () {
		yield ctx.slots.register(
			{
				name: 'sidebar.right.pane.tab',
				key: PKG,
				locale: NS,
				children: {
					'dsh-editor.actions': { kind: 'list', scope: 'session' },
					'dsh-editor.status': { kind: 'list', scope: 'session' },
					'dsh-editor.unavailable': { kind: 'list', scope: 'session' }
				}
			},
			editorComponents.EditorTabGuarded
		);
	});

	// 5b. the tab-title occupant (same key dispatch as the body): paints the
	// file name red + strikethrough while its file is externally deleted.
	ctx.slots.inject('sidebar.right.pane.tab.title', function* () {
		yield ctx.slots.register(
			{ name: 'sidebar.right.pane.tab.title', key: PKG, locale: NS },
			editorComponents.EditorTabTitleGuarded
		);
	});

	// 6. preview edit button — the only entry into the editor
	ctx.slots.inject('sidebar.right.tab.document.actions', function* () {
		yield ctx.slots.register(
			{ name: 'sidebar.right.tab.document.actions', id: 'dsh-editor-edit', order: 5, locale: NS },
			editorComponents.EditButtonGuarded
		);
	});

	// 7. crash-safety plumbing: prime the association cache (menu opens
	// refetch) and the keymap cache (defaults stay authoritative when the
	// read fails or the Host never wrote the table), and flush drafts on
	// hide while any tab controller exists.
	refreshAssociations().catch(() => {
		// surfaced by the menu's next open
	});
	refreshKeymap().catch(() => {
		// defaults stay authoritative; the popover works on the local cache
	});
	refreshSettings().catch(() => {
		// defaults stay authoritative; the toggle works on the local cache
	});
	ctx.effect(() => {
		const flushNow = () => {
			if (liveControllers.size > 0) editorDraftStore.flush();
		};
		const onVisibility = () => {
			try {
				if (document.visibilityState === 'hidden') flushNow();
			} catch {
				// document going away
			}
		};
		const hasDocument = typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function';
		const hasWindow = typeof window !== 'undefined' && window !== null && typeof window.addEventListener === 'function';
		if (hasDocument) document.addEventListener('visibilitychange', onVisibility);
		if (hasWindow) {
			window.addEventListener('beforeunload', flushNow);
			window.addEventListener('pagehide', flushNow);
		}
		return () => {
			if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
			if (hasWindow) {
				window.removeEventListener('beforeunload', flushNow);
				window.removeEventListener('pagehide', flushNow);
			}
		};
	}, 'dsh-editor: draft flush on hide');

	// 8. the one remaining shortcuts command (modeMenu, unbound); the three
	// editor actions are self-managed keymap bindings (see editorCommands).
	ctx.inject(['shortcuts'], (scope) =>
		scope.effect(() => {
			const disposers = editorCommands(boundT).map((command) =>
				registerCommandWithFallback(scope.shortcuts, command)
			);
			return () => {
				for (const dispose of disposers) {
					if (typeof dispose === 'function') dispose();
				}
			};
		}, 'dsh-editor: shortcut commands')
	);

	// 9. the manual-mode disk-check sweep: when the page becomes visible or
	// the window regains focus, every editor tab's watch runs one cheap stat
	// (streaming watches included — the machine deduplicates, so this only
	// catches events a dead or degraded stream missed). Watches whose stream
	// died degrade to manual mode and live entirely on this sweep.
	ctx.effect(() => {
		const checkAll = () => {
			for (const registration of tabRegistrations.values()) {
				try {
					if (typeof registration.checkDisk === 'function') registration.checkDisk();
				} catch {
					// one broken tab must not block the sweep
				}
			}
		};
		const hasDocument = typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function';
		const hasWindow = typeof window !== 'undefined' && window !== null && typeof window.addEventListener === 'function';
		const onVisibility = () => {
			try {
				if (document.visibilityState === 'visible') checkAll();
			} catch {
				// document going away
			}
		};
		if (hasDocument) document.addEventListener('visibilitychange', onVisibility);
		if (hasWindow) window.addEventListener('focus', checkAll);
		return () => {
			if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
			if (hasWindow) window.removeEventListener('focus', checkAll);
		};
	}, 'dsh-editor: disk stat check on focus');
}
