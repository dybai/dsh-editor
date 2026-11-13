# @dybai/dsh-editor

DSH Web 分栏的可扩展**编辑器框架**：让会话工作区里的文本文件可以就地编辑、保存（Ctrl+S），并把工具栏、状态栏、空态区、编辑区（模式）、状态快照、命令全部开放为稳定的第三方集成面。

## 框架概述

三层架构：

- **集成层**（任意第三方插件，零依赖）：注册座位 occupant、消费 `dshEditor` 服务、注册编辑模式、经导航契约打开文件——只依赖"名字"，不 require 本包；
- **框架层**（本包）：唯一状态与编排所有者——tab 状态机与保存队列（乐观并发 + 冲突横幅）、模式解析与挂载、工具栏/状态栏 chrome 与座位渲染、草稿持久化、Host RPC 桥；
- **模式层**（React 组件）：内容视图。内置 `plain-text`（fallback）；第三方以 `extension`/`builtin` 带注册排序接入，切换模式保草稿。

完整契约见 **[docs/contracts.md](docs/contracts.md)**（座位 owner props、句柄切片、模式描述符、Host RPC、导航契约、持久化、演进规则）。

## 快速开始

**安装**：`plugin_manager` → `install_bundle`，目标为本目录的绝对路径（引擎要求 `dsh >= 0.2.1-rc.5`）。

**打开**：

- 交互：文件预览工具栏的铅笔"编辑"按钮（只对文本文件渲染，原只读预览保留不动）；
- 程序化：`ctx.get('dshEditor').open(address, { line })` 或 `ctx.sidebarRight.openResource(address, { kind: 'editor', params: { file: { line } } })`——带 `line` 时打开后定位到该行。

**保存与键位**：

- `Ctrl+S` 保存前台编辑器；`Ctrl+Shift+S` 保存当前会话全部未保存的编辑器；`Ctrl+D` 删除光标行/选区触及行。这三条是**框架自管键位**：编辑器根元素拦截 keydown 并自行 `preventDefault`（对任何组合有效，不受 DSH web 快捷键白名单限制），编辑器之外浏览器默认行为照旧；
- 键位是全局用户偏好：编辑器状态栏右端的小键盘图标打开键位面板，逐动作「录制」新组合（允许任何组合，含浏览器保留键）或「恢复默认」，持久化到 Host 存储、所有已挂载编辑器立即生效（详见 [docs/contracts.md](docs/contracts.md) §6）；
- 磁盘文件被外部修改时出现冲突横幅：**重新加载并丢弃本地修改** 或 **仍要保存（覆盖磁盘）**；
- 编辑中途崩溃/刷新后重新打开同一文件，未保存草稿自动恢复（磁盘文件也变过时先出冲突横幅，绝不静默覆盖）。

**外部修改与删除检测**（0.3.0）：

- 打开中的文件被外部修改时，编辑器顶部弹出浅黄悬浮条：**是[重新加载]**（丢弃本地修改读入磁盘）/ **否[放弃更新]**（保留本地修改，保存时冲突横幅兜底）/ **否[不再询问]**（本页签内不再询问，保存时仍兜底）；
- 文件被外部删除时，页签文件名标红并画上删除线，悬浮条询问是否关闭页签；选择保留可继续编辑，**Ctrl+S 保存即重建文件**（成功后红标消失）。外部同路径重建会被识别并清除红标；
- 删除后**原样保存不需要先修改内容**：干净草稿下保存按钮/Ctrl+S 首次触发只布防确认（按钮变「确认重建」警示色），再次触发才执行重建；任何编辑或外部状态变化自动解除布防；
- 检测走宿主 `workspaceFiles/changes` 推送流（实时、零轮询），流不可用时自动降级为切换回页面/窗口聚焦时检查；
- 干净文件自动重载可在状态栏右端齿轮图标的**设置面板**中开启（默认关闭 = 一律询问），持久化到 Host 存储。

**活动行高亮**（0.4.0）：

- 编辑区以光标所在行的上下细边线标记当前行（VS Code 风格，不填背景——为将来的语法高亮留出颜色空间），随光标移动、内容编辑与滚动实时跟随；多行选区仍由浏览器原生选区样式呈现，不逐行描边；
- 设置面板新增「高亮光标所在行」开关（默认开，全局持久化，对所有已挂载编辑器立即生效）；
- 第三方模式可在描述符声明 `activeLine: true` 接入同一契约：经组件 prop `highlightActiveLine` 接收偏好、以快照 `selection.lineStart`/`lineEnd` 为高亮范围自行绘制（见 [docs/contracts.md](docs/contracts.md) §5.1 / §5.5）。

## 集成接口摘要

| 契约面 | 入口 | 一句话 |
|---|---|---|
| 座位 ×3 | `ctx.slots.inject('dsh-editor.actions' / 'dsh-editor.status' / 'dsh-editor.unavailable', …)` | 向工具栏/状态栏/失败空态放 occupant，owner props 含 `address`/`path`/`sessionId`（status 另有渲染时刻 `snapshot`） |
| 客户端服务 | `ctx.get('dshEditor')` | `version` / `active`（前台句柄） / `open(address, { line })`；句柄提供 `content`/`selection`/`state`/`mode` 四个可观察切片与 `save()`/`navigateToLine()`/`close()`，失效后明确错误、从不抛异常 |
| 模式注册 | `ctx.get('dshEditorModes').register(descriptor)` | 一种内容渲染实现：`{ id, priority, globs, matches, label, contentKind, component } → disposer`；pin > 关联 > 三带排序 > `matches` 否决 |
| 导航契约 | `sidebarRight.openResource(address, { kind: 'editor', params: { file: { line } } })` | 把会话文件地址送进编辑器 tab 的唯一入口 |

各面的形状、门控语义、代码示例与演进承诺以 [docs/contracts.md](docs/contracts.md) 为准。

## 已知限制（v0.2 非目标）

以下为契约已预留、v1 **不实现**的能力：

- `contentKind: 'raw'` 路径与自定义传输（二进制/分页内容由模式自带读写）；
- hex / CodeMirror 高亮等 builtin 富模式及细粒度扩展面（编辑区浮层座位：find/minimap）；
- `fs` 字节写 facet（当前仅整文件 UTF-8 文本写，≤4 MB，文本格式白名单）；
- 光标位置恢复（草稿恢复后光标不回位）；
- 模式关联管理设置页（关联目前仅经模式菜单"设为默认/恢复默认"管理）。

另有：只能编辑会话工作区内的文本文件；编辑器以独立 tab 打开，不替换当前预览 tab；键位录制会拒绝浏览器生命周期保留组合（Ctrl/⌘+W/T/N/Q、Ctrl+Tab 等）并给出提示——页面层无法可靠拦截这类浏览器默认行为。

## 契约变更记录

维护在 [docs/contracts.md](docs/contracts.md) 顶部（`0.2.0 → 初版契约（全部条目）`）；后续发布必须在该章节登记契约增量。
