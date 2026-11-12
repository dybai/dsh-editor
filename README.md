# @dybai/dsh-editor

DSH Web 分栏的可扩展**编辑器框架**：让会话工作区里的文本文件可以就地编辑、保存（Ctrl+Alt+S），并把工具栏、状态栏、空态区、编辑区（模式）、状态快照、命令全部开放为稳定的第三方集成面。

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

**保存**：

- `Ctrl+Alt+S` 保存前台编辑器；`Ctrl+Alt+A` 保存当前会话全部未保存的编辑器（默认键须避开浏览器保留组合，详见 [docs/contracts.md](docs/contracts.md) §6 的 web 白名单说明，可在快捷键设置中自行改绑）；
- 磁盘文件被外部修改时出现冲突横幅：**重新加载并丢弃本地修改** 或 **仍要保存（覆盖磁盘）**；
- 编辑中途崩溃/刷新后重新打开同一文件，未保存草稿自动恢复（磁盘文件也变过时先出冲突横幅，绝不静默覆盖）。

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

另有：只能编辑会话工作区内的文本文件；编辑器以独立 tab 打开，不替换当前预览 tab。

## 契约变更记录

维护在 [docs/contracts.md](docs/contracts.md) 顶部（`0.2.0 → 初版契约（全部条目）`）；后续发布必须在该章节登记契约增量。
