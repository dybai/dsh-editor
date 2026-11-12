# @dybai/dsh-editor

在 DSH Web 分栏里编辑文本文件：**保留默认只读查看器**，在文件预览的工具栏上添加一个"编辑"按钮，点击后才以编辑器 tab 打开该文件。

## 它做什么

- 向右侧栏注册一个 tab 类型（kind `editor`），但**不声明任何 `patterns`**——不参与文件地址的默认认领，自带查看器（文本/代码/图片/PDF/Office）完全保持原样。
- 在文件预览工具栏（`sidebar.right.tab.document.actions` 座位）注册一个铅笔"编辑"按钮：只对 Session 范围内、按扩展名/文件名判定为文本的文件渲染；图片、PDF 等预览上不出现。
- 点击按钮 → `openResource(address, { kind: 'editor' })` 打开编辑器 tab（同一文件的编辑器 tab 已打开时只聚焦复用），原只读预览 tab 保留不动。
- 编辑器 tab：保存（Ctrl+S）、从磁盘重新加载、未保存标记、版本冲突横幅（磁盘上的文件被外部修改时，可选择"丢弃本地修改重新加载"或"仍要保存覆盖"）、状态栏（行列号 / 行数 / 字符数 / 保存结果）。
- 打开编辑器 tab 时如导航参数带行号，光标定位到对应行。

## 工作原理

- **读取**：复用自带的 `workspaceFiles` Remote 命名空间（`readBytes`，整文件 UTF-8 读取，≤4 MB）。
- **写入**：Host 半以源码模式注册 `dshEditorFiles` 服务（`ctx.provide` + `typertRemote` 绑定 + 原型 Remote 标记），Typert Gateway 的 SRC 回退使其可按 endpoint 路由；Client 半不经客户端命名空间，直接走通用网关通道 `connection.rpc.call('/api', 'dshEditorFiles/writeFile', …)`。写入在 Host 侧经 `fs.writeText` 并携带读取时的版本号做乐观并发检查（`replaceIfVersion`），不会静默覆盖外部修改。
- 刻意不 import 任何 `@deepseek-ai/*` 包，全部能力从 cordis ctx 获取，保证在 profile node_modules 各种布局下都能加载。

## 集成接口（供其他插件扩展编辑器）

编辑器遵循 documentpreview 的同款模式：body 所有者声明稳定的座位与契约，其他插件零依赖集成。

### 工具栏座位 `dsh-editor.actions`

`kind: 'list'`、`scope: 'session'` 的子槽，渲染在编辑器工具栏（文件名/路径之后、保存按钮之前）。注册方式与向预览工具栏注册完全相同：

```js
ctx.slots.inject('dsh-editor.actions', function* () {
	yield ctx.slots.register(
		{ name: 'dsh-editor.actions', id: 'your-plugin-action', order: 10, locale: 'yourNs' },
		YourComponent
	);
});
```

occupant 收到的 owner props：`{ address, path, sessionId }`（address 为 `dsh-resource://file/…` 完整地址，path 为解码后的路径），另有会话标准 props（`t`、`sessionId` 等）。

### 选区契约（DOM data 属性）

- 编辑器根元素：`data-dsh-editor-address`（完整地址）、`data-dsh-editor-session`（会话 id）、`data-dsh-editor-visible`（`'true' | 'false'`；编辑器 tab 因 keepMounted 可能多个同时挂载，DOM 消费者应以 `visible === 'true'` 的那个为准）。
- textarea：`data-dsh-editor-input`。行号换算：`selectionStart/End` 为字符偏移，行号 = 偏移前 `\n` 数 + 1；选区行范围 = `[offsetToLine(start), offsetToLine(end 对应行)]`。
- 读取失败或没有 `[data-dsh-editor-visible="true"]` 根时按"编辑器未在前台"处理。

### 打开文件到编辑器

`ctx.sidebarRight.openResource(address, { kind: 'editor' })`；导航参数 `params: { file: { line } }` 会定位到对应行。`canOpen` 仍只放行 Session 范围内的文本文件。

## 已知限制（v0.1）

- 只能编辑 Session 工作区内的文本文件（绝对路径地址与二进制格式不接管）。
- 4 MB 以上文件拒绝编辑（textarea 性能考虑）。
- 新建文件暂不支持（只编辑已存在的文件）。
- 编辑器以独立 tab 打开，不替换当前预览 tab（座位的 props 不含 tabId，无法原地替换）。

## 安装

`plugin_manager` → `install_bundle`，目标为本目录的绝对路径。
