/**
 * @dybai/dsh-editor — the editor framework's browser half (client entry).
 *
 * Bundled by scripts/build.mjs into `client.js` in the `__ModuleLoader__`
 * shape; exports `apply(ctx)` + `inject`. This entry owns the WIRING only —
 * all logic lives in the tested sibling modules (tab-machine, service,
 * ranking, lines, address, draft-store, view-state, view-state-store) and the
 * React layer in `src/components.js`.
 *
 * `apply(ctx)` composes, in order:
 *
 * 0. the persistent log channel (0.7.0): a bounded 500-entry buffer, the
 *    leveled channel (console mirror + enqueue) and the debounced flusher
 *    draining into the Host `dshEditor/appendLogs` endpoint; hide events
 *    (the draft flush-on-hide block) also flush it early;
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
 *    controller exists), the shared view-state store (0.8.0 — the cursor and
 *    scroll remembered per workspace path, pruned by every new tab controller
 *    and flushed alongside the drafts on hide; `runtime.viewStateStore` plus
 *    `runtime.sessionCwdOf` are what the tab layer keys it by), the
 *    mode-preference cache (fetched once at apply,
 *    refetched on every menu open), the self-managed keymap cache, the
 *    behavior settings cache (read by every tab machine at notice time and
 *    by the mode components at render time — the active-line highlight
 *    preference, 0.4.0, and the line-number gutter preference, 0.5.0), the
 *    per-file-type word-wrap override cache (0.11.0 — the top layer of
 *    `resolveWordWrap`), the cross-window preference bus (0.11.0 — each
 *    successful preference write announces its store name; every other
 *    window refetches all four caches on receipt and on focus/visibility,
 *    because the four tables share one CAS token), and
 *    per-tab disk watches (Host
 *    `workspaceFiles/changes` push; manual `stat` fallback swept on
 *    focus/visibility);
 * 8. the one remaining shortcuts command (`dshEditor.modeMenu`, unbound);
 *    save/saveAll/deleteLines are framework self-managed keymap bindings
 *    (spec §6) — the natural keys Ctrl+S / Ctrl+Shift+S / Ctrl+D return
 *    because a root-element keydown preventDefault works for ANY combo,
 *    which the DSH web whitelist cannot take away;
 * 9. the application-level settings center (0.11.0): a `document.body` host +
 *    a react-dom root created once per activation, rendering the singleton
 *    `SettingsDialog` while `runtime.openSettings(path)` is open and
 *    unmounting it (render(null)) on close — mount-on-open keeps the dialog's
 *    focus-on-open effect honest. The status-bar gear is its only entry; the
 *    0.10.0 per-tab settings popover is retired. The dialog's render tail
 *    carries the non-interactive About group (0.19.0: the build fingerprint,
 *    `runtime.buildInfo` — version + bundle stamp).
 *
 * Deliberately requires no `@deepseek-ai/*` package: the bare requires are
 * `react` (consumed by src/components.js and the settings-center host) and
 * `react-dom` (the host's createRoot, verified against the DSH web runtime —
 * see the settings-dialog section below).
 */

import { MAX_EDIT_CHARS, basenameOf, isEditablePath, parseFileAddress, sessionAddressFor } from './address.js';
import { deleteLines as deleteLinesOp, offsetOfLine } from './lines.js';
import { globMatches } from './ranking.js';
import { createDraftStore } from './draft-store.js';
import { createViewStateStore } from './view-state-store.js';
import { createEditorService } from './service.js';
import { createEditorComponents } from './components.js';
// Settings center shell (0.11.0): the dialog module and its frozen section
// registry land in the bundle here; section 9 of `apply` installs the
// application-level host that renders it (the status-bar gear opens it).
import { SettingsDialog, SETTINGS_SECTION_REGISTRY } from './settings-dialog.js';
import { KEYMAP_ACTIONS, comboOf, defaultKeymap, normalizeKeymap, completeKeymap, bindingsOfKeymap } from './keymap.js';
import { buildSettingsWritePayload, defaultSettings, normalizeSettings } from './settings.js';
import { createPrefsBus } from './prefs-bus.js';
import { createLogChannel } from './debug-log.js';
import { createLogBuffer } from './log-buffer.js';
import { createLogFlusher } from './log-flush.js';
import { detectEol } from './eol.js';
// Code-highlight mode (0.17.0): the engine + its language-group chunk
// transport + the language table; CM6 content surface (Task 10): the cm6
// chunk loader. The ENTRY scope owns the only `require.async` call sites
// (the bundler's chunk transports) and the one engine singleton; sessions
// are per tab, owned by each mounted mode's surface (the CM6 component's
// session lifecycle).
import { createEngine } from './highlight/engine.js';
import { createChunkLoader } from './highlight/chunks.js';
import { createCm6Loader } from './cm6/chunks.js';
import { deriveGlobs } from './highlight/languages.js';
import { createCoreFacade } from './vendor/shiki-core.js';

// The settings center host renders React trees itself (one root per window),
// so the entry needs the same bundler-resolved React its components use.
// `react-dom` is required lazily inside apply, where the availability check
// lives (spec §12 open point ①); the DSH web frontend's static module registry
// ships both packages to plugin factories (react 18.3.1, react-dom 18.3.1 with
// `createRoot` on the main export).
const React = require('react');
const h = React.createElement;

/* --------------------------------------------------------- identity -- */

const PKG = '@dybai/dsh-editor';
const NS = 'dshEditor';
const EDITOR_KIND = 'editor';
const SERVICE_KEY = 'dshEditor';
const VERSION = '0.20.0';
// The build fingerprint (Task 2 of the 2026-11-26 active-tint plan): the
// same version number ships in many different builds, so the bundler
// (scripts/build.mjs) swaps this literal placeholder for
// `<git short SHA>.<UTC HHmm>` — or the fallback `yyyyMMdd.HHmm` when the
// git subprocess fails — and the settings center shows the pair. Under
// node --test the placeholder stays an inert literal.
const BUILD_STAMP = '@@BUILD_STAMP@@';
const STYLE_ID = 'dsh-editor-styles';

/* ---------------------------------------------------------- locale -- */

const zh = {
	'meta.title': '文件编辑器',
	'meta.description':
		'让分栏里的文本文件可以直接编辑：打开文件就地修改并保存到磁盘（Ctrl+S，可在状态栏齿轮打开的设置中心里改键），Ctrl+G 跳转到指定行，带版本冲突提示与重新加载；文件被外部修改或删除时主动提示。',
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
	'mode.code': '代码高亮',
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
	'keymap.save': '保存',
	'keymap.saveAll': '保存全部',
	'keymap.deleteLines': '删行',
	'keymap.record': '录制',
	'keymap.recording': '按下新组合…（Esc 取消）',
	'keymap.reset': '恢复默认',
	'keymap.gotoLine': '跳转到行',
	'keymap.resetTitle': '把四个动作的键位恢复为默认（Ctrl+S / Ctrl+Shift+S / Ctrl+D / Ctrl+G）',
	'keymap.duplicate': '该组合已被其他动作占用，请换一个组合。',
	'keymap.reserved': '该组合被浏览器保留（如关闭/新建标签页），无法录制',
	'keymap.reservedHint': '浏览器保留组合（Ctrl/⌘+W、T、N、Q 等）与 Tab 缩进无法录制',
	'keymap.writeFailed': '保存快捷键失败',
	'keymap.conflict': '快捷键已被其他位置修改，已重新读取，请重试。',
	'goto.title': '跳转到行',
	'goto.context': '当前 {line} 行 · 共 {max} 行',
	'goto.placeholder': '行号（1–{max}）',
	'goto.jump': '跳转',
	'goto.jumpTitle': '跳转到输入的行（Enter）',
	'goto.invalid': '请输入 1–{max} 之间的行号',
	'goto.loading': '正在加载文件…',
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
	'settings.scrollBeyondLastLine': '滚动越过最后一行',
	'settings.scrollBeyondLastLineTitle': '在内容末尾之后保留可滚动空白，最后一行可滚动到视口顶部',
	'settings.showWhitespaceGroup': '显示空白字符',
	'settings.showWhitespaceSpaces': '显示空格',
	'settings.showWhitespaceSpacesTitle': '把空格字符显示为浅色间隔号 ·',
	'settings.showWhitespaceSpacesNote': '全局设置，对所有已挂载编辑器立即生效；默认关闭。',
	'settings.showWhitespaceTabs': '显示制表符',
	'settings.showWhitespaceTabsTitle': '把制表符显示为浅色箭头 → 并补位到停位',
	'settings.showWhitespaceTabsNote': '全局设置，对所有已挂载编辑器立即生效；默认关闭。',
	'settings.showWhitespaceNewlines': '显示换行符',
	'settings.showWhitespaceNewlinesTitle': '在每个行断的行尾显示浅色回车符 ↵（文件末尾的尾随换行不显示）',
	'settings.showWhitespaceNewlinesNote': '全局设置，对所有已挂载编辑器立即生效；默认关闭。',
	'settings.wordWrap': '自动换行',
	'settings.wordWrapTitle': '过长的行在编辑区宽度内自动折行显示',
	'settings.indentMode': '缩进模式',
	'settings.indentModeTitle': 'Tab 键插入的缩进单位：自动探测当前文件 / 固定制表符 / 固定空格',
	'settings.indentModeAuto': '自动探测',
	'settings.indentModeTabs': '制表符',
	'settings.indentModeSpaces': '空格',
	'settings.indentWidth': '缩进宽度',
	'settings.indentWidthTitle': '空格模式下每级缩进的空格数',
	'settings.indentWidthNote': '仅「空格」模式生效；自动探测无信号时也用它作回退宽度。',
	'settings.showRulerGroup': '标尺',
	'settings.showRuler': '显示竖线标尺',
	'settings.showRulerTitle': '在编辑区指定列的位置显示一条竖线参考线（VS Code 风格）',
	'settings.showRulerNote': '全局设置，对所有已挂载编辑器立即生效；默认关闭。',
	'settings.rulerColumn': '标尺位置（列）',
	'settings.rulerColumnTitle': '竖线所在的列号（画在第 N 个字符格的右缘）',
	'settings.rulerColumnNote': '1–999 的整数，默认 80；修改在失焦或回车后生效。',
	'settings.buildInfoGroup': '关于',
	'settings.buildInfo': '构建版本',
	'settings.matchHighlightGroup': '匹配高亮',
	'settings.wordHighlight': '高亮光标所在词',
	'settings.wordHighlightTitle': '光标停在一个词上（或选区落在一个词内）时，高亮该词的所有完整出现',
	'settings.wordHighlightNote': '全词匹配，区分大小写；多行选区不高亮。默认开启。',
	'settings.selectionHighlight': '高亮选区匹配项',
	'settings.selectionHighlightTitle': '选中文本后，高亮文档中其它相同内容（与当前选区重叠的位置除外）',
	'settings.selectionHighlightNote': '字面匹配，不区分大小写；纯空白或超 200 字符的选区、多行选区不高亮。默认开启。',
	'settings.on': '开',
	'settings.off': '关',
	'settings.writeFailed': '保存设置失败',
	'settings.conflict': '设置已被其他位置修改，已重新读取，请重试。',
	'settingsCenter.title': '编辑器设置',
	'settingsCenter.close': '关闭',
	'settingsCenter.section.appearance': '外观',
	'settingsCenter.section.behavior': '行为',
	'settingsCenter.section.indent': '缩进',
	'settingsCenter.section.wrap': '换行',
	'settingsCenter.section.keymap': '快捷键',
	'settingsCenter.wordWrapGlobalNote': '未设置时按扩展名默认（md 系开）',
	'settingsCenter.wrapOverrideLabel': '本类型换行',
	'settingsCenter.wrapOverrideFollow': '跟随全局',
	'settingsCenter.wrapOverrideOn': '强制开',
	'settingsCenter.wrapOverrideOff': '强制关',
	'settingsCenter.wrapOverrideNoExtension': '（无扩展名）',
	'status.lines': '行',
	'status.chars': '字符'
};

const en = {
	'meta.title': 'File editor',
	'meta.description':
		'Makes text files in the side pane editable: open a file, edit it in place, and save back to disk with Ctrl+S (rebindable in the settings center opened from the status-bar gear), jump to a line with Ctrl+G, with stale-version conflict prompts and reload; external modifications and deletions are detected and surfaced.',
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
	'mode.code': 'Code highlight',
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
	'keymap.save': 'Save',
	'keymap.saveAll': 'Save all',
	'keymap.deleteLines': 'Delete lines',
	'keymap.record': 'Record',
	'keymap.recording': 'Press the new combo… (Esc to cancel)',
	'keymap.reset': 'Restore defaults',
	'keymap.gotoLine': 'Go to line',
	'keymap.resetTitle': 'Restore the default keys (Ctrl+S / Ctrl+Shift+S / Ctrl+D / Ctrl+G)',
	'keymap.duplicate': 'That combo is already used by another action; pick another one.',
	'keymap.reserved': 'This combination is reserved by the browser (e.g. close/new tab) and cannot be recorded',
	'keymap.reservedHint': 'Browser-reserved combos (Ctrl/⌘+W, T, N, Q, etc.) and Tab indentation cannot be recorded',
	'keymap.writeFailed': 'Failed to save shortcuts',
	'keymap.conflict': 'Shortcuts changed elsewhere; reloaded, please retry.',
	'goto.title': 'Go to line',
	'goto.context': 'Ln {line} of {max}',
	'goto.placeholder': 'Line (1–{max})',
	'goto.jump': 'Go',
	'goto.jumpTitle': 'Jump to the entered line (Enter)',
	'goto.invalid': 'Enter a line between 1 and {max}',
	'goto.loading': 'Loading the file…',
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
	'settings.scrollBeyondLastLine': 'Scroll past last line',
	'settings.scrollBeyondLastLineTitle': 'Keep scrollable blank space past the end of content so the last line can scroll to the top of the viewport',
	'settings.showWhitespaceGroup': 'Show whitespace',
	'settings.showWhitespaceSpaces': 'Show spaces',
	'settings.showWhitespaceSpacesTitle': 'Render space characters as a light middle dot (·)',
	'settings.showWhitespaceSpacesNote': 'Global setting; applies to every mounted editor immediately. Off by default.',
	'settings.showWhitespaceTabs': 'Show tabs',
	'settings.showWhitespaceTabsTitle': 'Render tab characters as a light arrow (→), padded to the next stop',
	'settings.showWhitespaceTabsNote': 'Global setting; applies to every mounted editor immediately. Off by default.',
	'settings.showWhitespaceNewlines': 'Show newlines',
	'settings.showWhitespaceNewlinesTitle': 'Render each line break as a light return glyph (↵) at the end of its line; the trailing newline at end of file is not drawn',
	'settings.showWhitespaceNewlinesNote': 'Global setting; applies to every mounted editor immediately. Off by default.',
	'settings.wordWrap': 'Word wrap',
	'settings.wordWrapTitle': 'Wrap overly long lines within the editor width',
	'settings.indentMode': 'Indent style',
	'settings.indentModeTitle': 'The indent unit the Tab key inserts: auto-detect the current file / fixed tabs / fixed spaces',
	'settings.indentModeAuto': 'Auto detect',
	'settings.indentModeTabs': 'Tabs',
	'settings.indentModeSpaces': 'Spaces',
	'settings.indentWidth': 'Indent width',
	'settings.indentWidthTitle': 'Spaces per indent level in spaces mode',
	'settings.indentWidthNote': 'Only applies in Spaces mode; also used as the fallback width when auto detect has no signal.',
	'settings.showRulerGroup': 'Ruler',
	'settings.showRuler': 'Show vertical ruler',
	'settings.showRulerTitle': 'Draw a vertical guide line at the configured column in the editor area (VS Code style)',
	'settings.showRulerNote': 'Global setting; applies to every mounted editor immediately. Off by default.',
	'settings.rulerColumn': 'Ruler column',
	'settings.rulerColumnTitle': 'The column the line marks (drawn at the right edge of the Nth character cell)',
	'settings.rulerColumnNote': 'An integer from 1 to 999, default 80; changes apply on blur or Enter.',
	'settings.buildInfoGroup': 'About',
	'settings.buildInfo': 'Build version',
	'settings.matchHighlightGroup': 'Match highlight',
	'settings.wordHighlight': 'Highlight word under cursor',
	'settings.wordHighlightTitle': 'Highlight every whole-word occurrence when the caret rests on a word (or the selection sits inside one)',
	'settings.wordHighlightNote': 'Whole-word matching, case-sensitive; multiline selections never highlight. On by default.',
	'settings.selectionHighlight': 'Highlight selection matches',
	'settings.selectionHighlightTitle': 'After selecting text, highlight other occurrences of the same content (positions overlapping the selection excluded)',
	'settings.selectionHighlightNote': 'Literal matching, case-insensitive; whitespace-only or over-200-character selections and multiline selections never highlight. On by default.',
	'settings.on': 'On',
	'settings.off': 'Off',
	'settings.writeFailed': 'Failed to save settings',
	'settings.conflict': 'Settings changed elsewhere; reloaded, please retry.',
	'settingsCenter.title': 'Editor settings',
	'settingsCenter.close': 'Close',
	'settingsCenter.section.appearance': 'Appearance',
	'settingsCenter.section.behavior': 'Behavior',
	'settingsCenter.section.indent': 'Indent',
	'settingsCenter.section.wrap': 'Word wrap',
	'settingsCenter.section.keymap': 'Shortcuts',
	'settingsCenter.wordWrapGlobalNote': 'When unset, the per-extension default applies (md-like files wrap)',
	'settingsCenter.wrapOverrideLabel': 'Word wrap for this type',
	'settingsCenter.wrapOverrideFollow': 'Follow global',
	'settingsCenter.wrapOverrideOn': 'Force on',
	'settingsCenter.wrapOverrideOff': 'Force off',
	'settingsCenter.wrapOverrideNoExtension': '(no extension)',
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
.dsh-editor-menu { position: absolute; bottom: calc(100% + 4px); right: 10px; z-index: 40; min-width: 280px; max-width: 380px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; gap: 2px; }
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
.dsh-editor-highlight-bar { position: absolute; left: 0; min-width: 100%; box-sizing: border-box; --dsh-editor-active-line-inset: -2px; opacity: 0.3; }
.dsh-editor-highlight-bar::before, .dsh-editor-highlight-bar::after { content: ""; position: absolute; left: 0; right: 0; height: 2px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, var(--dsw-alias-bg-base)); }
/* The band offsets are canvas-measured (font-aware: the bands frame the real
 * glyph ink, set per paint as --dsh-editor-band-top/-bottom custom props);
 * the static --dsh-editor-active-line-inset fallback applies only on engines
 * without TextMetrics bounding boxes. */
.dsh-editor-highlight-bar::before { top: var(--dsh-editor-band-top, var(--dsh-editor-active-line-inset, -2px)); }
.dsh-editor-highlight-bar::after { bottom: var(--dsh-editor-band-bottom, var(--dsh-editor-active-line-inset, -2px)); }
/* Match-highlight layer (the matchHighlight prop): the windowed underlay
 * PlainTextMode mounts directly above the active-line highlight backdrop
 * while either layer switch is on, below the overlay textarea. The
 * container mirrors the whitespace layer's font rules declaration for
 * declaration (family, 13px, line-height 1.5, tab-size 4) so the underlay
 * rows keep the textarea's exact advance widths — a tint drifting off its
 * characters would be worse than no tint. Rows carry transparent ink (the
 * textarea renders the same text on top; only the runs' backgrounds
 * show): word matches under a faint label-primary wash, selection matches
 * under a brand-primary wash, a both-layers run under the two mixed. Each
 * run carries exactly ONE class — stacked classes would cascade into
 * whichever background rule won. The mix ratios are tuned against VS
 * Code's look; the class names and theme-alias references are the
 * contract.
 */
.dsh-editor-match { position: absolute; inset: 0; overflow: hidden; pointer-events: none; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; tab-size: 4; }
.dsh-editor-match-row { position: absolute; white-space: pre; color: transparent; }
.dsh-editor-match-word { background: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent); }
.dsh-editor-match-selection { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.dsh-editor-match-both { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)); }
/* Whitespace glyph layer (0.12.0): the viewport-sized underlay PlainTextMode
 * mounts between the highlight backdrop and the gutter band while any of the
 * three switches (spaces/tabs/newlines) is on, below the overlay textarea.
 * Its font metrics mirror .dsh-editor-area declaration for declaration
 * (family, 13px, line-height 1.5, tab-size 4) so the underlay rows keep the
 * textarea's exact advance widths — a glyph drifting off its column would be
 * worse than no glyph at all. pointer-events: none keeps every pointer path
 * on the textarea; overflow: hidden bounds the windowed rows to the viewport
 * (rows position against scrollTop, never against the scroll extent). */
.dsh-editor-whitespace { position: absolute; inset: 0; overflow: hidden; pointer-events: none; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; tab-size: 4; color: var(--dsw-alias-label-primary); }
/* The row's text nodes exist ONLY for advance: they carry the real line
 * text so the glyph boxes land on their exact columns, but their INK must
 * never paint — the textarea renders the same text on top, and two
 * text-rendering paths rasterize with subpixel differences, so visible
 * under-ink reads as a double-struck (bolder/blurry) font. Transparent
 * color keeps the layout and kills the ink; the glyph spans restore the
 * label color explicitly because their SVG strokes/fills use currentColor. */
.dsh-editor-whitespace-row { position: absolute; white-space: pre; color: transparent; }
/* The glyph box is a zero-height inline-block: its bottom edge sits on the
 * text baseline and its width carries the 1ch advance. The ink itself is an
 * SVG (font-independent geometry — see glyphSvgShape in src/whitespace.js:
 * font fallbacks drew ·/→ with full-width advances whose ink landed at
 * font-specific offsets), centered at (50%, yCenterEm above the baseline)
 * via the per-instance transform the builder sets. */
.dsh-editor-whitespace-glyph { display: inline-block; width: 1ch; height: 0; position: relative; opacity: 0.25; color: var(--dsw-alias-label-primary); }
.dsh-editor-whitespace-glyph svg { position: absolute; width: 1ch; height: 1ch; overflow: visible; }
/* Ruler (0.14.0): the overlay layer Task 5 mounts inside the editor area;
 * -ruler-line is the 1px guide at the configured column. CSS lands first. */
.dsh-editor-ruler { position: absolute; inset: 0; overflow: hidden; pointer-events: none; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; }
.dsh-editor-ruler-line { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-border-l1); }
.dsh-editor-area.dsh-editor-area-overlay { position: relative; z-index: 1; background: transparent; }
/* Word wrap (0.10.0): PlainTextMode appends this class when the wordWrap
 * prop is literally true and switches the textarea's wrap attribute to
 * 'soft'. The three declaration values are the hand-maintained CSS twin of
 * WRAP_LINE_STYLES (src/wrap-measure.js): the textarea and the measurement
 * mirror must agree on the wrapping rules byte for byte, so Task 11's gate
 * greps both. Deliberately placed after .dsh-editor-area: same
 * specificity, later rule wins over its white-space: pre. */
.dsh-editor-area-wrap { white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; }
.dsh-editor-center { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px; color: var(--dsw-alias-label-secondary); font-size: 13px; text-align: center; }
.dsh-editor-center-stack { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 90%; }
.dsh-editor-spinner { width: 18px; height: 18px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: transparent; border-radius: 50%; animation: dsh-editor-spin 0.8s linear infinite; flex: none; }
@keyframes dsh-editor-spin { to { transform: rotate(360deg); } }
.dsh-editor-status { display: flex; align-items: center; gap: 12px; padding: 4px 10px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 11px; color: var(--dsw-alias-label-secondary); min-height: 24px; flex: none; position: relative; }
.dsh-editor-status-meta { flex: none; white-space: nowrap; }
.dsh-editor-status-notice { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.dsh-editor-notice-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-editor-notice-error { color: var(--dsw-alias-state-error-primary); }
/* The status-bar icon button (0.11.0: only the settings gear remains — the
 * 0.10.0 keymap button that shared this class is retired, so the class lost
 * its stale name). */
.dsh-editor-status-btn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; flex: none; }
.dsh-editor-status-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-editor-tool-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-editor-tool-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-editor-seat { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dsh-editor-seat-status { flex: 1 1 auto; justify-content: flex-end; gap: 8px; overflow: hidden; }
.dsh-editor-seat-column { flex-direction: column; align-items: center; gap: 8px; }
.dsh-editor-banner-external { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, var(--dsw-alias-bg-layer-1)); }
.dsh-editor-tabtitle { display: contents; }
.dsh-editor-tabtitle-text-deleted { color: var(--dsw-alias-state-error-primary); text-decoration: line-through; }
.dsh-editor-tabtitle-icon { flex: none; }
.dsh-editor-tabtitle-iconwrap { position: relative; width: 16px; height: 16px; flex: none; display: inline-block; }
.dsh-editor-tabtitle-editdisc { position: absolute; left: 0; bottom: 0; transform: translate(-20%, 20%); width: 12px; height: 12px; border-radius: 50%; display: grid; place-items: center; box-sizing: border-box; background: #FFFFFF; color: #9AA0A8; }
/* Settings center (0.11.0): the application-level singleton modal. The
 * backdrop is a fixed full-viewport layer (z-index above the status-bar
 * popovers' 40, below the DSH platform dialogs — tuned in Task 9's manual
 * matrix); clicking the backdrop itself closes. The panel centers a two-pane
 * layout: a fixed-width section menu on the left (the active item uses the
 * brand tint) and the active section's scrolling content on the right.
 * The -host div is the react-dom root container appended to document.body
 * (outside every tab, so the dialog outlives its opener): display: contents
 * keeps it out of layout while its fixed-position child paints the backdrop.
 * House tokens only; no element ids, no inline styles. */
.dsh-editor-settings-dialog-host { display: contents; }
.dsh-editor-settings-dialog-backdrop { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.42); }
.dsh-editor-settings-dialog-panel { display: flex; flex-direction: column; width: 100%; height: 100%; max-width: 880px; max-height: 620px; min-height: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.32); outline: none; overflow: hidden; }
.dsh-editor-settings-dialog-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex: none; }
.dsh-editor-settings-dialog-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.dsh-editor-settings-dialog-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 16px; line-height: 1; cursor: pointer; }
.dsh-editor-settings-dialog-close:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-editor-settings-dialog-body { display: flex; flex: 1 1 auto; min-height: 0; }
.dsh-editor-settings-dialog-menu { flex: none; width: 168px; padding: 8px; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.dsh-editor-settings-dialog-menu-item { display: flex; align-items: center; width: 100%; padding: 6px 8px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: left; cursor: pointer; }
.dsh-editor-settings-dialog-menu-item:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-editor-settings-dialog-menu-item.active { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 500; }
.dsh-editor-settings-dialog-content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; padding: 14px; }
.dsh-editor-settings-dialog-section { display: flex; flex-direction: column; gap: 2px; }
.dsh-editor-settings-dialog-group-title { margin-top: 8px; padding: 0 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-editor-settings-dialog-row { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 6px; font-size: 12px; }
.dsh-editor-settings-dialog-row:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-editor-settings-dialog-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsh-editor-settings-dialog-toggle { flex: none; height: 24px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-settings-dialog-toggle:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-editor-settings-dialog-toggle.on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-editor-settings-dialog-toggle:disabled { opacity: 0.45; cursor: default; }
/* Indentation section (0.13.0): the segmented controls (-seg / -seg-btn).
 * One bordered pill per row; the selected option is tinted with the brand
 * color, like the active section menu item. The width control is disabled
 * outside spaces mode and falls back to this opacity. */
.dsh-editor-settings-dialog-seg { flex: none; display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; overflow: hidden; }
.dsh-editor-settings-dialog-seg-btn { height: 22px; padding: 0 10px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-settings-dialog-seg-btn + .dsh-editor-settings-dialog-seg-btn { border-left: 1px solid var(--dsw-alias-border-l1); }
.dsh-editor-settings-dialog-seg-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-editor-settings-dialog-seg-btn.on { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); }
.dsh-editor-settings-dialog-seg-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-settings-dialog-note { padding: 2px 10px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: 0.8; }
/* Ruler position (0.14.0): the numeric rulerColumn field in the appearance
 * section's RulerPositionSection row. */
.dsh-editor-settings-dialog-number { height: 24px; width: 84px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: var(--dsw-font-mono, ui-monospace, monospace); }
.dsh-editor-settings-dialog-number:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-editor-settings-dialog-number:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-settings-dialog-error { margin-bottom: 8px; padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); font-size: 11px; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; }
/* Keymap section (0.11.0): the recorder rows that used to live in the
 * status-bar keymap popover. The section container reuses -section; the rows
 * keep the popover's label · combo · record anatomy, rescoped under the dialog
 * prefix and sized like the other section rows (no absolute positioning — the
 * dialog's content pane owns the layout now). */
.dsh-editor-settings-dialog-keymap-row { display: flex; align-items: center; gap: 12px; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
.dsh-editor-settings-dialog-keymap-row:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-editor-settings-dialog-keymap-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsh-editor-settings-dialog-keymap-combo { flex: none; min-width: 88px; text-align: center; padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: var(--dsw-alias-bg-layer-1); font-family: var(--dsh-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-editor-settings-dialog-keymap-record { flex: none; height: 24px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-settings-dialog-keymap-record:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-editor-settings-dialog-keymap-record:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-settings-dialog-keymap-record.recording { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-editor-settings-dialog-keymap-hint { padding: 2px 10px 6px; font-size: 11px; color: var(--dsw-alias-brand-primary); }
.dsh-editor-settings-dialog-keymap-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 8px 10px 2px; border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 8px; }
.dsh-editor-settings-dialog-keymap-note { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: 0.8; }
.dsh-editor-settings-dialog-keymap-reset { flex: none; height: 24px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-settings-dialog-keymap-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-editor-settings-dialog-keymap-reset:disabled { opacity: 0.45; cursor: default; }
/* Go-to-line popover (0.6.0): anchored to the status bar's LEFT edge (above
 * the Ln/Col indicator — the status-bar buttons on the right keep that edge).
 * Absolute against .dsh-editor-status's position:relative, same bottom
 * overhang and elevation tokens as the other popovers. */
.dsh-editor-goto { position: absolute; bottom: calc(100% + 4px); left: 10px; z-index: 40; width: 250px; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; gap: 6px; }
.dsh-editor-goto-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsh-editor-goto-title { flex: none; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-editor-goto-context { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-editor-goto-row { display: flex; gap: 6px; }
.dsh-editor-goto-input { flex: 1 1 auto; min-width: 0; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-editor-goto-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-editor-goto-jump { flex: none; height: 24px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-editor-goto-jump:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-editor-goto-jump:disabled { opacity: 0.45; cursor: default; }
.dsh-editor-goto-note { font-size: 11px; }
.dsh-editor-goto-note.dsh-editor-goto-error { color: var(--dsw-alias-state-error-primary); }
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
 * The RESERVATION is constant: the textarea keeps its padding-left and the
 * rule and band ALWAYS paint — toggling the preference shows/hides only the
 * numbers, never moving content or the boundary.
 * The text block translates against scrollTop at the DOM layer. */
.dsh-editor-gutter { position: absolute; left: 0; top: 0; bottom: 0; z-index: 2; overflow: hidden; background: var(--dsw-alias-bg-base); pointer-events: none; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.5; }
.dsh-editor-gutter-rule { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-border-l1); }
.dsh-editor-gutter-text { padding: 10px 1.5ch 0 0; text-align: right; white-space: pre; color: var(--dsw-alias-label-secondary); opacity: 0.8; }
/* Wrapped-mode gutter layer (0.10.0, the wordWrap preference): the wrap
 * controller paints ONE span per VISIBLE line into this box, at the
 * viewport-relative px it computed, so a wrapped document never materializes
 * a document-sized number block (the -gutter-text block above is the sole
 * renderer only while wrapping is off).
 * The box is pinned to the band top and carries NO transform: the controller
 * already folded the scroll offset into every span top (its group translate
 * is a deliberate no-op for that reason), so the box has nothing of its own
 * to move. Its inline border-box width = the digits sub-band (ruleOffset ch),
 * exactly like -gutter-text, so a number ends at the same x whether wrapping
 * is on or off. Each span inherits the band's mono 13px / 1.5 from
 * .dsh-editor-gutter and repeats -gutter-text's padding (10px top =
 * .dsh-editor-area's padding-top, so the first number sits on the textarea's
 * first row), 1.5ch right alignment and colour/opacity. */
.dsh-editor-gutter-wrap { position: absolute; inset: 0; overflow: hidden; }
.dsh-editor-gutter-wrap span { position: absolute; left: 0; right: 0; padding: 10px 1.5ch 0 0; box-sizing: border-box; text-align: right; white-space: pre; color: var(--dsw-alias-label-secondary); opacity: 0.8; }
/* CM6 content surface (Task 10, R11): the code-highlight mode's root and
 * view host. The CM6 component renders the .dsh-editor-cm6 root (mounted
 * in the same slot PlainTextMode's -inputwrap fills inside the tab root's
 * flex column) and the .dsh-editor-cm6-host div (the CodeMirror view
 * mounts into it with parent: host); neither carries layout rules of its
 * own, so this block makes the root fill the mode slot, the host fill the
 * root, and the mounted .cm-editor fill the host — without it the pane
 * collapses to the editor's intrinsic height. House tokens only: the root
 * paints the same base background the -area and the -highlight backdrop
 * use, so the pending/host phases never flash a foreign color. */
.dsh-editor-cm6 { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; background: var(--dsw-alias-bg-base); }
.dsh-editor-cm6-host { flex: 1 1 auto; min-height: 0; position: relative; }
.dsh-editor-cm6-host .cm-editor { height: 100%; }
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

/**
 * The persistent log channel for the current activation, set by apply() and
 * read by the module-level helpers (keymap migration, tab close/open,
 * command registration); `null` before the first activation.
 */
let log = null;

/**
 * The cross-window preference notification bus (0.11.0): a successful
 * preference write in ANY window announces only the changed store's name, and
 * every other same-origin window hears it and refetches ALL FOUR preference
 * caches from the Host (the source of truth) — the four tables share one
 * `updatedAt` CAS token, so refreshing only the named store would leave the
 * other three caches (and their tokens) stale. Module-scope like the draft
 * store; `apply` owns only the subscription's lifetime. Never throws — a
 * window without either delivery channel simply goes without cross-window
 * notifications.
 *
 * Named `preferenceBus`, NOT `prefsBus`, on purpose: the bundler derives the
 * dependency closure identifier from the file name (`src/prefs-bus.js` →
 * camelCase `prefsBus`) and emits it into the same factory scope, so an
 * entry-scope `prefsBus` binding collides at build time
 * (`Identifier 'prefsBus' has already been declared`) — do not "tidy" it back.
 */
const preferenceBus = createPrefsBus({});

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
		version: value !== null && typeof value.version === 'string' ? value.version : '',
		// 行尾保留(0.12.x):在归一化之前探测原始行尾,写线时由机器还原
		// (applyEol)——机内与显示层恒为 LF,磁盘文件保持自己的行尾。
		eol: detectEol(text)
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
	// Tell the other windows; their handlers refresh ALL FOUR preference
	// caches (the tables share one CAS token), never just this store.
	preferenceBus.notify('associations');
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
	// The same restamp invalidates the wrap-overrides cache's CAS token.
	try {
		await refreshWrapOverrides();
	} catch {
		// best-effort; the wrap panel's next open refetches
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
 * the framework actions.
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
		// 完整集直接采纳；缺动作的旧版存储（v0.5 及更早没有 gotoLine）经
		// completeKeymap 迁移补缺——自定义键位保留，缺失动作按候选链填充
		// （Ctrl+G → Ctrl+Shift+G → Ctrl+Alt+G），迁移不回写 Host。
		const complete = normalizeKeymap(value.bindings);
		if (complete !== undefined) {
			keymapState.keymap = complete;
		} else {
			const migrated = completeKeymap(value.bindings);
			if (migrated !== undefined) {
				const stored = new Set(value.bindings.map((binding) => (binding !== null && typeof binding === 'object' ? binding.action : null)));
				const filled = KEYMAP_ACTIONS.filter((action) => !stored.has(action))
					.map((action) => `${action}=${comboOf(migrated[action]) || '（无空闲候选）'}`)
					.join(', ');
				log?.debug('keymap', 'migrated partial store; filled', filled);
				keymapState.keymap = migrated;
			}
		}
	}
	keymapState.updatedAt =
		value !== null && typeof value === 'object' && typeof value.updatedAt === 'number' ? value.updatedAt : undefined;
	notifyKeymapListeners();
}

/**
 * Persist a new keymap through `dshEditor/setKeymap` (compare-and-set against
 * the cached token, which the mode-association store SHARES — see the Host
 * module doc). Accepts the object form `{ save, saveAll, deleteLines, gotoLine }`
 * or the wire bindings array; invalid input rejects before any RPC. On success
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
	// Tell the other windows; their handlers refresh ALL FOUR preference
	// caches (the tables share one CAS token), never just this store.
	preferenceBus.notify('keymap');
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
	// The same restamp invalidates the wrap-overrides cache's CAS token.
	try {
		await refreshWrapOverrides();
	} catch {
		// best-effort; the wrap panel's next open refetches
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
const settingsState = { settings: defaultSettings(), raw: null, updatedAt: undefined, listeners: new Set() };

function getSettings() {
	return settingsState.settings;
}

/**
 * The Host's raw settings payload as last read or written: ONLY the keys the
 * Host actually stored (absent keys stay absent, so per-file resolution can
 * fall back to its builtin defaults), or `null` before the first successful
 * read. Never normalized — do not apply `defaultSettings()` to it.
 * @returns the raw `{ [name]: boolean }` payload, or `null` when unknown.
 */
function getRawSettings() {
	return settingsState.raw;
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
	settingsState.raw =
		value !== null && typeof value === 'object' && value.settings !== null && typeof value.settings === 'object'
			? value.settings
			: null;
	const normalized = normalizeSettings(value !== null && typeof value === 'object' ? value.settings : undefined);
	if (normalized !== undefined) settingsState.settings = normalized;
	settingsState.updatedAt =
		value !== null && typeof value === 'object' && typeof value.updatedAt === 'number' ? value.updatedAt : undefined;
	notifySettingsListeners();
}

/**
 * Persist the settings through `dshEditor/setSettings` (compare-and-set
 * against the cached SHARED token — see the Host module doc). The payload is
 * DELTA-PRESERVING: the raw stored set (explicit settings only) plus the
 * caller's change, never the builtin defaults — the Host's full-set replace
 * then rewrites exactly the explicit set, so unset keys stay unset (and their
 * per-file builtin defaults stay reachable). On success the local caches
 * update and every mounted editor tab reads the new values at its next disk
 * notice. A conflicting write refetches and rejects with
 * `error.conflict === true`. The write restamps the SHARED token, so the
 * keymap, association and wrap-override caches are resynced afterwards (and
 * the other windows are told through the preference bus).
 */
async function writeSettings(input) {
	const payload = buildSettingsWritePayload(settingsState.raw, input);
	if (payload === undefined) {
		const error = new Error('dsh-editor: the settings payload is invalid');
		error.code = 'settings/invalid';
		throw error;
	}
	const args = { settings: payload };
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
	// The Host stored exactly this payload (full-set replace): it becomes the
	// raw cache, and the normalized view rebuilds defaults over it.
	settingsState.raw = payload;
	settingsState.settings = normalizeSettings(payload);
	settingsState.updatedAt =
		result.value !== null && typeof result.value === 'object' && typeof result.value.updatedAt === 'number'
			? result.value.updatedAt
			: settingsState.updatedAt;
	notifySettingsListeners();
	// Tell the other windows; their handlers refresh ALL FOUR preference
	// caches (the tables share one CAS token), never just this store.
	preferenceBus.notify('settings');
	try {
		await refreshSettings();
	} catch {
		// best-effort resync; the local copy already reflects the write
	}
	// The settings write restamped the SHARED token; resync the other three
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
	// The same restamp invalidates the wrap-overrides cache's CAS token.
	try {
		await refreshWrapOverrides();
	} catch {
		// best-effort; the wrap panel's next open refetches
	}
}

/* -------------------------------------------------- wrap overrides -- */

/**
 * The per-file-type word-wrap override cache (0.11.0, spec §6): the
 * highest-priority layer of `resolveWordWrap(rawSettings, path, overrides)` —
 * a `*.<ext>` → boolean exception list layered on top of the global
 * `wordWrap` setting. Seeded empty (no overrides; the global setting and the
 * builtin extension defaults decide), read once at apply through
 * `dshEditor/getWrapOverrides` (the Host `wrap_overrides` table), refetched
 * whenever another window announces the store, and rewritten by the settings
 * center's wrap section. Same shape as the keymap/settings caches;
 * `updatedAt` is the SHARED CAS token.
 */
const wrapOverridesState = { overrides: [], updatedAt: undefined, listeners: new Set() };

/** The current override array, read-only by convention (highest-priority layer). */
function getWrapOverrides() {
	return wrapOverridesState.overrides;
}

function subscribeWrapOverrides(listener) {
	wrapOverridesState.listeners.add(listener);
	return () => {
		wrapOverridesState.listeners.delete(listener);
	};
}

function notifyWrapOverridesListeners() {
	for (const listener of [...wrapOverridesState.listeners]) {
		try {
			listener();
		} catch {
			// subscriber isolation
		}
	}
}

/**
 * Light client-side validation of a complete override set: an array whose
 * every entry is an object with a non-empty string `glob` and a boolean
 * `enabled`. The Host additionally enforces the `*.<ext>` glob shape and
 * unique globs — that authority stays there; this only rejects obvious
 * client bugs before they reach the wire with a clean `wrap-overrides/invalid`.
 * @param input - the caller's complete override set.
 * @returns a normalized `[{ glob, enabled }]` copy, or undefined when invalid.
 */
function normalizeWrapOverrides(input) {
	if (!Array.isArray(input)) return undefined;
	const normalized = [];
	for (const entry of input) {
		if (entry === null || typeof entry !== 'object') return undefined;
		if (typeof entry.glob !== 'string' || entry.glob.length === 0) return undefined;
		if (typeof entry.enabled !== 'boolean') return undefined;
		normalized.push({ glob: entry.glob, enabled: entry.enabled });
	}
	return normalized;
}

/**
 * Read the complete override set through `dshEditor/getWrapOverrides` and
 * adopt it; a failed read throws and keeps the current cache (the Host stays
 * authoritative — the empty seed simply means "no overrides"). The Host
 * returns the records sorted by glob.
 */
async function refreshWrapOverrides(signal) {
	const result = await rpcCall(`${SERVICE_KEY}/getWrapOverrides`, {}, signal);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		throw new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: reading the word-wrap overrides failed'
		);
	}
	const value = result.value;
	const list = value !== null && typeof value === 'object' && Array.isArray(value.overrides) ? value.overrides : [];
	wrapOverridesState.overrides = list.filter(
		(entry) => entry !== null && typeof entry === 'object' && typeof entry.glob === 'string' && typeof entry.enabled === 'boolean'
	);
	wrapOverridesState.updatedAt =
		value !== null && typeof value === 'object' && typeof value.updatedAt === 'number' ? value.updatedAt : undefined;
	notifyWrapOverridesListeners();
}

/**
 * Replace the complete override set through `dshEditor/setWrapOverrides`
 * (compare-and-set against the cached SHARED token — see the Host module
 * doc). Invalid input rejects before any RPC with `error.code ===
 * 'wrap-overrides/invalid'`. On success the local cache updates, the other
 * windows are notified, and the other three caches are resynced (the write
 * restamped the shared token their CAS guards compare against). A conflicting
 * write refetches and rejects with `error.conflict === true`.
 */
async function writeWrapOverrides(input) {
	const normalized = normalizeWrapOverrides(input);
	if (normalized === undefined) {
		const error = new Error('dsh-editor: the word-wrap overrides are invalid');
		error.code = 'wrap-overrides/invalid';
		throw error;
	}
	const args = { overrides: normalized };
	if (typeof wrapOverridesState.updatedAt === 'number') args.expectedUpdatedAt = wrapOverridesState.updatedAt;
	const result = await rpcCall(`${SERVICE_KEY}/setWrapOverrides`, args, undefined);
	if (result === null || typeof result !== 'object' || result.ok !== true) {
		const failure = result !== null && typeof result === 'object' ? result.error : null;
		const conflict = /conflict/i.test(`${failure !== null && typeof failure.code === 'string' ? failure.code : ''} ${failure !== null && typeof failure.message === 'string' ? failure.message : ''}`);
		const error = new Error(
			failure !== null && typeof failure.message === 'string' && failure.message.length > 0
				? failure.message
				: 'dsh-editor: saving the word-wrap overrides failed'
		);
		if (conflict) {
			error.conflict = true;
			try {
				await refreshWrapOverrides();
			} catch {
				// the conflict path still surfaces; the next open refetches
			}
		}
		throw error;
	}
	wrapOverridesState.overrides = normalized;
	wrapOverridesState.updatedAt =
		result.value !== null && typeof result.value === 'object' && typeof result.value.updatedAt === 'number'
			? result.value.updatedAt
			: wrapOverridesState.updatedAt;
	notifyWrapOverridesListeners();
	// Tell the other windows; their handlers refresh ALL FOUR preference
	// caches (the tables share one CAS token), never just this store.
	preferenceBus.notify('wrapOverrides');
	try {
		await refreshWrapOverrides();
	} catch {
		// best-effort resync; the local copy already reflects the write
	}
	// The wrap write restamped the SHARED token; resync the other three
	// caches so their next writes do not ride a stale CAS token.
	try {
		await refreshSettings();
	} catch {
		// best-effort; defaults stay authoritative until a later read
	}
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

/* ---------------------------------- cross-window preference refresh -- */

/**
 * Refetch every preference cache — the one thing a cross-window announcement
 * and the focus sweep both do. The four tables share ONE `updatedAt` CAS
 * token, so after ANY write (local or remote) all four cached copies and
 * their tokens may be stale: refreshing only the announced store would leave
 * the other three riding a stale token for the next write (a spurious
 * `conflict`). Refetches are idempotent plain GETs, so the bus's dual-source
 * double delivery and overlapping sweeps merely repeat them; every read is
 * best-effort, and a later announcement/sweep retries.
 */
function refreshAllPreferenceCaches() {
	refreshSettings().catch(() => {});
	refreshKeymap().catch(() => {});
	refreshAssociations().catch(() => {});
	refreshWrapOverrides().catch(() => {});
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
	log?.warn('lifecycle', 'closing a tab is not supported by this sidebar-right build');
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
		log?.warn('lifecycle', 'the right-Sidebar service is unavailable');
		return;
	}
	try {
		sidebarRight.openResource(sessionAddressFor(sessionCwdOf(sessionId), sessionId, absolutePath), { kind: EDITOR_KIND });
	} catch (error) {
		log?.warn('lifecycle', 'opening the editor failed:', error);
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
				log?.warn('commands', 'registering command', command.id, 'failed:', fallbackError);
				return undefined;
			}
		}
		log?.warn('commands', 'registering command', command.id, 'failed:', error);
		return undefined;
	}
}

/**
 * The ONE remaining shortcuts command (spec §6): `dshEditor.modeMenu`, no
 * default key (user-bindable). save / saveAll / deleteLines / gotoLine LEFT
 * this surface on purpose — the web runtime's whitelist refuses browser-owned
 * combos as page-level defaults, so the framework actions moved to the
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

/** One shared view-state store for every tab (single storage key). */
const editorViewStateStore = createViewStateStore(resolveStorageAdapter());

/* ---------------------------------------------------- settings center -- */

/**
 * The application-level SINGLETON settings center (0.11.0, spec §5).
 *
 * One host element under `document.body` plus one react-dom root are created
 * per activation; `runtime.openSettings(path)` renders the dialog into that
 * root and `runtime.closeSettings()` renders `null` — the dialog component is
 * mounted on open and UNMOUNTED on close (never hidden-mounted), so its
 * focus-on-open effect runs on every open and the modal owns no page-wide
 * listeners while closed.
 *
 * The module-level state is the framework layer the spec asks for: the open
 * flag, the opener's context `{ path }` (the wrap section's `*.ext`) and the
 * opener tab key used to return focus to that tab's gear. The state is per
 * WINDOW, not per tab: every editor tab opens the same dialog, and it stays
 * usable after its opener tab closes (spec §10).
 *
 * react-dom availability (spec §12 open point ①) was verified against the
 * running DSH web frontend: its boot module loader hands every plugin factory
 * a STATIC module registry containing `react` 18.3.1, `react/jsx-runtime`,
 * `react-dom` (18.3.1, `createRoot` on the main export) and `react-dom/client`,
 * and core plugins (e.g. dsh-client-ui-sidebar-right) call
 * `require('react-dom')` from their factory body. The portal path is therefore
 * the implemented one; the per-EditorTab fallback is not built.
 */
const settingsDialogState = {
	/** Whether the dialog is currently mounted. */
	open: false,
	/** The last opener's file path — the wrap section's per-type context. */
	path: null,
	/** The last opener tab's key; retained after close for focus return. */
	openerTabKey: undefined,
	listeners: new Set(),
	/** The body-level host div (the react-dom root container), once installed. */
	host: null,
	/** The react-dom root; null when react-dom or the DOM is unavailable. */
	root: null,
	/** The component runtime facade handed to the dialog's sections. */
	runtime: null,
	/** The plugin-bound locale lookup (`ctx.locale.bind(NS)`). */
	t: null
};

/** The dialog snapshot editor tabs render from: open state + opener identity. */
function getSettingsDialog() {
	return {
		open: settingsDialogState.open,
		path: settingsDialogState.path,
		openerTabKey: settingsDialogState.openerTabKey
	};
}

/** Subscribe to open/close transitions (the opener tab's focus return). */
function subscribeSettingsDialog(listener) {
	settingsDialogState.listeners.add(listener);
	return () => {
		settingsDialogState.listeners.delete(listener);
	};
}

function notifySettingsDialogListeners() {
	for (const listener of [...settingsDialogState.listeners]) {
		try {
			listener();
		} catch {
			// subscriber isolation
		}
	}
}

/**
 * Resolve which mounted editor tab opened the dialog. The gear passes only the
 * file path (the frozen `openSettings(path)` facade shape), so the opener is
 * the foreground tab when its address names that path, otherwise the first
 * VISIBLE registration whose address does. The answer only drives focus
 * return: a tab that never registered (still loading / failed) simply leaves
 * the focus where the browser puts it.
 */
function openerTabKeyOf(path) {
	if (typeof path !== 'string' || path.length === 0) return undefined;
	const foreground = resolveForegroundTab();
	if (foreground !== undefined) {
		const parsedForeground = parseFileAddress(foreground.address);
		if (parsedForeground !== undefined && parsedForeground.path === path) return foreground.tabKey;
	}
	for (const [tabKey, registration] of tabRegistrations) {
		const parsed = parseFileAddress(typeof registration.address === 'string' ? registration.address : '');
		if (parsed === undefined || parsed.path !== path) continue;
		if (typeof registration.isVisible === 'function' && registration.isVisible() !== true) continue;
		return tabKey;
	}
	return undefined;
}

/** Render the current state into the host root: the dialog, or nothing. */
function renderSettingsDialog() {
	const root = settingsDialogState.root;
	if (root === null) return;
	root.render(
		settingsDialogState.open
			? h(SettingsDialog, {
					runtime: settingsDialogState.runtime,
					t: settingsDialogState.t,
					context: { path: settingsDialogState.path },
					onClose: closeSettings
				})
			: null
	);
}

/**
 * Create the singleton host + root (once per activation). A missing DOM (the
 * build's load smoke test, a non-browser runtime) or a react-dom without
 * `createRoot` degrades to a callable facade that renders nothing.
 */
function installSettingsDialogHost(runtime, t) {
	// A reactivation must never stack a second host/root on top of a live one
	// (one host per window is the singleton invariant).
	if (settingsDialogState.root !== null || settingsDialogState.host !== null) disposeSettingsDialogHost();
	settingsDialogState.runtime = runtime;
	settingsDialogState.t = t;
	settingsDialogState.open = false;
	settingsDialogState.path = null;
	settingsDialogState.openerTabKey = undefined;
	if (typeof document === 'undefined' || document === null || document.body === null || document.body === undefined) return;
	let reactDom;
	try {
		reactDom = require('react-dom');
	} catch (error) {
		log?.warn('settings', 'react-dom is unavailable; the settings center stays closed:', error);
		return;
	}
	if (reactDom === null || reactDom === undefined || typeof reactDom.createRoot !== 'function') {
		log?.warn('settings', 'react-dom exposes no createRoot; the settings center stays closed');
		return;
	}
	try {
		const host = document.createElement('div');
		host.className = 'dsh-editor-settings-dialog-host';
		document.body.appendChild(host);
		settingsDialogState.host = host;
		settingsDialogState.root = reactDom.createRoot(host);
		settingsDialogState.root.render(null);
	} catch (error) {
		settingsDialogState.host = null;
		settingsDialogState.root = null;
		log?.warn('settings', 'creating the settings center host failed:', error);
	}
}

/** Tear the host down on deactivation (a reactivation installs a fresh one). */
function disposeSettingsDialogHost() {
	const root = settingsDialogState.root;
	const host = settingsDialogState.host;
	settingsDialogState.root = null;
	settingsDialogState.host = null;
	settingsDialogState.runtime = null;
	settingsDialogState.t = null;
	settingsDialogState.open = false;
	settingsDialogState.path = null;
	settingsDialogState.openerTabKey = undefined;
	if (root !== null) {
		try {
			root.unmount();
		} catch {
			// already gone
		}
	}
	if (host !== null) {
		try {
			if (typeof host.remove === 'function') host.remove();
			else if (host.parentNode !== null && host.parentNode !== undefined) host.parentNode.removeChild(host);
		} catch {
			// already gone
		}
	}
}

/**
 * The gear's only call: open the singleton dialog with THIS tab's file as the
 * context (the wrap section derives its `*.<ext>` from it). Reopening while
 * already open just re-contextualizes; `open` stays true and the mounted
 * dialog keeps its selected section.
 */
function openSettings(path) {
	if (settingsDialogState.root === null) return;
	settingsDialogState.open = true;
	settingsDialogState.path = typeof path === 'string' ? path : null;
	settingsDialogState.openerTabKey = openerTabKeyOf(settingsDialogState.path);
	renderSettingsDialog();
	notifySettingsDialogListeners();
}

/**
 * Close the singleton dialog (backdrop / close button / Escape all land here
 * through the dialog's `onClose`). The dialog component unmounts; the last
 * opener's tab key is retained so that tab can refocus its gear on the close
 * edge (focus return).
 */
function closeSettings() {
	if (!settingsDialogState.open) return;
	settingsDialogState.open = false;
	renderSettingsDialog();
	notifySettingsDialogListeners();
}

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

	// 0. persistent log channel (0.7.0): every leveled call mirrors to the
	// console and lands in a bounded buffer the flusher drains (debounced,
	// batch-50) into the Host `dshEditor/appendLogs` endpoint; the
	// flush-on-hide block below flushes it early. The channel is created
	// FIRST so every helper below (keymap migration, tab close/open, command
	// registration, components) can log through it.
	const logBuffer = createLogBuffer({ cap: 500 });
	const logFlusher = createLogFlusher({
		call: (endpoint, args) => rpcCall(endpoint, args),
		buffer: logBuffer,
		schedule: (fn, ms) => setTimeout(fn, ms),
		cancel: (handle) => clearTimeout(handle),
		now: Date.now,
		onWarn: (message) => console.warn('[dsh-editor]', message)
	});
	log = createLogChannel({ sink: console, enqueue: (entry) => logFlusher.push(entry), now: Date.now });

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

	// 3b. the highlight engine singleton (0.17.0 code-highlight). This apply
	// scope is the ONLY place `require` is in scope, so the lazy chunk
	// transports live here — TWO require.async call sites now: the
	// language-group loader below (its negative cache dedupes and blocks
	// per group) and the CM6 loader (Task 10) further down. The engine
	// owns the vendored core facade; `createCoreFacade()` starts NO work
	// (the first `engine.ready()` triggers the core init), so plugin
	// activation pays nothing until a code-highlight tab actually opens.
	// Sessions are per tab — created and disposed by each mounted CM6 mode
	// component (engine.createSession), never here; the CM6 highlight
	// adapter then reads the session's token rows per viewport to build
	// the view's decorations. Progressive files (over the sync ceiling)
	// fill their colors across rAF-driven background frames: the engine
	// schedules the frames itself and reports every advance through the
	// progress listener bridge below, which repaints the tab's CM6 view.
	const highlightProgressListeners = new Set();
	const highlightEngine = createEngine({
		core: createCoreFacade(),
		loadGroup: createChunkLoader({
			requireAsync: (f) => require.async('./' + f),
			log
		}).loadGroup,
		log,
		now: Date.now,
		scheduleFrame: (fn) => requestAnimationFrame(() => fn()),
		onProgress: () => {
			for (const listener of highlightProgressListeners) listener();
		}
	});

	// The CM6 chunk loader (Task 10) — the second lazy transport this entry
	// owns, built beside the engine it serves. Same discipline as the
	// language-group loader above: the dedupe/negative-cache logic lives in
	// src/cm6/chunks.js, the component runtime hands the loader to the CM6
	// mode component, its first code-highlight mount pays the transport, and
	// a failed load degrades that activation to plain text (one-way, no
	// retry storm — a new activation builds a new loader).
	const cm6Loader = createCm6Loader({
		requireAsync: (f) => require.async('./' + f),
		log
	});

	const componentRuntime = {
		// The mode surface's progress subscription (the CM6 component's
		// repaint effect) hooks in here so engine-side advances (background
		// frames) repaint the tab that owns the progressing session.
		onHighlightProgress: (fn) => {
			highlightProgressListeners.add(fn);
			return () => highlightProgressListeners.delete(fn);
		},
		draftStore: editorDraftStore,
		// view-state store (0.8.0): the one shared cursor/scroll memory. Tabs
		// key it through the session's workspace root, which is why the
		// module-level resolver is part of the runtime too.
		viewStateStore: editorViewStateStore,
		sessionCwdOf,
		// the persistent log channel (0.7.0): components log through
		// runtime.log so their traces persist with the same scopes
		log,
		// the highlight engine singleton (0.17.0 code-highlight): the
		// code-highlight mode's CM6 surface drives it per tab (see 3b above)
		highlightEngine,
		// the cm6 chunk loader (Task 10): createEditorComponents threads it
		// into the CM6 mode component (the entry owns the transport — see 3b)
		cm6Loader,
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
		getRawSettings,
		subscribeSettings,
		setSettings: writeSettings,
		// the build fingerprint (0.19.0): read by the settings center's About
		// tail, the only place the user can tell WHICH build is running
		buildInfo: { version: VERSION, stamp: BUILD_STAMP },
		// per-file-type word-wrap overrides (0.11.0): the top layer of the
		// wrap resolution, read by the settings dialog and written by its
		// wrap section through the same CAS + bus + resync path as the others
		getWrapOverrides,
		subscribeWrapOverrides,
		setWrapOverrides: writeWrapOverrides,
		refreshWrapOverrides,
		// the application-level settings center (0.11.0): the gear's only two
		// calls plus the state/subscription the opener tab needs for focus
		// return. The dialog itself lives outside every tab (one host per
		// window), so closing it keeps it independent of tab lifecycles.
		openSettings,
		closeSettings,
		getSettingsDialog,
		subscribeSettingsDialog,
		// disk watch IO: the Host push stream (or undefined → manual mode)
		// and the cheap stat used by both the stream fallback and the focus sweep
		openChanges,
		statFile,
		getRegistration: (tabKey) => tabRegistrations.get(tabKey),
		saveAllOfSession: (sessionId) => editorService.saveAll(sessionId),
		requestSaveTab,
		deleteLinesFor
	};

	// 3b. the application-level settings center (0.11.0): one body-level host +
	// react-dom root per activation (see the settings-center section above).
	// Opening renders the singleton dialog, closing unmounts it; the effect
	// disposer removes the host when the plugin deactivates.
	ctx.effect(() => {
		installSettingsDialogHost(componentRuntime, boundT);
		return () => disposeSettingsDialogHost();
	}, 'dsh-editor: settings center host');

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

	// 内置代码高亮模式（0.17.0）：语言表覆盖的扩展名默认用它打开。globs 逐字
	// 派生自语言表（deriveGlobs 的 `**/*.<ext>` 形状，勿手写副本），label 走
	// 同一 t 通道；rank：builtin 高于 plain-text 的 fallback，语言表外文件
	// 仍回落纯文本。
	ctx.effect(
		() =>
			modeRegistryObj.register({
				id: 'code-highlight',
				priority: 'builtin',
				globs: deriveGlobs(),
				label: () => boundT('mode.code'),
				contentKind: 'text',
				// 契约自描述（§5.1）：PlainTextMode 组装壳继承活动行高亮开关。
				activeLine: true,
				component: editorComponents.CodeHighlightMode
			}),
		'dsh-editor: code-highlight mode'
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
	// refetch), the keymap cache (defaults stay authoritative when the read
	// fails or the Host never wrote the table), the settings and word-wrap
	// override caches (builtin defaults / no overrides stay authoritative on a
	// failed read), and flush drafts on hide while any tab controller exists.
	refreshAssociations().catch(() => {
		// surfaced by the menu's next open
	});
	refreshKeymap().catch(() => {
		// defaults stay authoritative; the popover works on the local cache
	});
	refreshSettings().catch(() => {
		// defaults stay authoritative; the toggle works on the local cache
	});
	refreshWrapOverrides().catch(() => {
		// no overrides stay authoritative; the global wordWrap layer still decides
	});
	ctx.effect(() => {
		const flushNow = () => {
			if (liveControllers.size > 0) editorDraftStore.flush();
			// View-state writes are debounced like drafts: flush unconditionally
			// (the store is a no-op when nothing is pending).
			editorViewStateStore.flush();
			// Persistent log channel: fire-and-forget flush (the flusher
			// itself never throws; the catch guards the returned promise).
			logFlusher.flush().catch(() => {});
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
			// Cancel the flusher's pending debounce timer with the block it
			// flushes alongside (log-flush.js wires dispose here by contract).
			logFlusher.dispose();
		};
	}, 'dsh-editor: draft and log flush on hide');

	// 7b. cross-window preference bus (0.11.0): another window announced a
	// preference write; refetch EVERY cache from the Host (the source of truth).
	// The announcement names one store, but the four tables share one
	// `updatedAt` CAS token — refreshing only the named store would leave the
	// other three caches (and their tokens) stale, so this window's next local
	// write could fail with a spurious conflict. One remote write can also
	// arrive through BOTH delivery channels, so the handler triggers only
	// idempotent cache refetches — never toasts, counters or state flips.
	ctx.effect(
		() => preferenceBus.subscribe(() => refreshAllPreferenceCaches()),
		'dsh-editor: cross-window preference notifications'
	);

	// 7c. focus/visibility sweep (0.11.0): coming back to a window that may
	// have missed an announcement refetches all four preference caches through
	// ONE trailing-debounced (1000ms) handler shared by both events; every
	// read is best-effort (a stale local cache still works).
	ctx.effect(() => {
		let timer = null;
		const refreshAll = () => {
			timer = null;
			refreshAllPreferenceCaches();
		};
		const schedule = () => {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(refreshAll, 1000);
		};
		const onVisibility = () => {
			try {
				if (document.visibilityState === 'visible') schedule();
			} catch {
				// document going away
			}
		};
		const hasDocument = typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function';
		const hasWindow = typeof window !== 'undefined' && window !== null && typeof window.addEventListener === 'function';
		if (hasDocument) document.addEventListener('visibilitychange', onVisibility);
		if (hasWindow) window.addEventListener('focus', schedule);
		return () => {
			if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
			if (hasWindow) window.removeEventListener('focus', schedule);
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		};
	}, 'dsh-editor: preference refresh on focus');

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
