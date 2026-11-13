# DSH 编辑器（@dybai/dsh-editor）部署手册

本手册覆盖：本地开发循环、以 **git + 自托管市场索引** 方式发布新版本、**npm 发布**路径，以及常见坑。读完即可独立完成"编译 → 发布 → 升级"全流程。发布动作本身不引入契约变更，但每次发版必须核对 [docs/contracts.md](contracts.md) §1 的契约变更记录已登记当前版本。

## 1. 前提

- Node.js ≥ 20（`npm test` 与构建脚本运行环境）。
- DSH 已安装并能启动（`dsh web` 提供 http://127.0.0.1:3080）。
- git（推送用 SSH/HTTPS 凭据由你本机配置；本仓库远程为 `github.com/dybai/dsh-editor`）。
- npm 模式：npmjs.com 账号，且拥有 `@dybai` scope（scope 名 = npm 用户名或你拥有的组织名）。

## 2. 目录结构

```
dsh-editor/
├── index.js               # Host 半端：组装并注册 dshEditor 服务（七方法 Remote）
├── host/
│   ├── write-service.js   # 文件写入服务（fs/sandboxPolicy/sessions 之上的整文件 UTF-8 写）
│   └── preferences-service.js  # 模式偏好/键位/设置持久化（storage kv 之上）
├── client.js              # 构建产物：src/ 打包为 window.__ModuleLoader__ 工厂（必须入库！）
├── cordis.patch.yml       # bundle patch：往 profile 插一行 @dybai/dsh-editor
├── package.json           # dsh.bundle.patch / dsh.client 声明 + engines.dsh + exports/files
├── icon.svg               # 插件图标
├── locale/*.json          # Host 侧包信息展示（插件管理器里的标题/描述）
├── src/                   # 浏览器半端源码（框架层 + 内置 plain-text 模式）
│   ├── client-entry.js    # 打包入口（loader 调 exports.apply(ctx)）
│   └── *.test.js          # 与源码同目录的 node:test 单测
├── host/*.test.js         # Host 服务单测
├── scripts/build.mjs      # 构建脚本：src/client-entry.js 拓扑排序打包进 client.js
└── docs/
    ├── contracts.md       # 第三方集成契约（发布前核对 §1 契约变更记录）
    └── deploy.zh-CN.md    # 本手册
```

与 file-line-reference 的关键差异：本插件 **Host 半端是真实现**（`index.js` + `host/*.js`），不是空壳——npm 包必须带上 `host/` 两个服务文件；浏览器半端由 `scripts/build.mjs` 从 `src/` 打包（单行具名导入 + 具名导出声明，入口必须导出 `apply`，依赖绑定逐一校验，缺失即构建失败），没有独立的 loader 模拟脚本。

## 3. 本地开发循环

```powershell
npm run build    # 重新生成 client.js（改了 src/ 之后必须跑）
npm run build    # 构建自带校验：导入绑定对不上导出、入口缺 apply 都会直接报错
node --check client.js      # 语法检查
node --check index.js       # Host 半端语法检查
npm test         # 全部单测（src/**/*.test.js + host/**/*.test.js）
```

然后在 DSH 里用 `plugin_manager` → `install_bundle` 以**本地目录**安装（已装过时直接刷新页面即可，服务器按文件内容计算修订，无需重启 harness），浏览器 **Ctrl+F5** 验证。

经验法则：`node --check` 查不出打包契约类错误（入口缺 `apply`、导入名不存在于依赖导出），这类错误 `npm run build` 会直接失败；插槽渲染崩溃看浏览器控制台的 `[dsh-editor]` 前缀日志。

## 4. 发布新版本（git 模式，无 npm 账号）

Git 安装 = 安装端直接从 GitHub 仓库按 **commit SHA** 拉取，**不执行任何构建脚本**，所以 `client.js` 必须已提交入库。流程：

1. **改版本号**：`package.json` 的 `version`（SemVer），并在 [docs/contracts.md](contracts.md) §1 登记契约增量（无契约变更也要确认当前版本已在表中）。
2. **重新构建并跑完第 3 节全部检查**。
3. **提交并推送**：

   ```powershell
   git add -A
   git commit -m "release: vX.Y.Z"
   git push
   ```

4. **取锁定 SHA**（小写 40 位十六进制）：

   ```powershell
   git rev-parse HEAD
   ```

5. **更新市场索引**：编辑仓库根 `market-index.json`（首次发布参照 file-line-reference 的 `docs/market-index.example.json` 创建），在 `plugins[].versions[]` 里**追加**一条新版本：
   - `version`：与 package.json 一致；
   - `publishTimestamp`：当前 Unix 秒（`[DateTimeOffset]::Now.ToUnixTimeSeconds()`）；
   - `source`：`{ "type": "git", "url": "https://github.com/dybai/dsh-editor", "commit": "<第 4 步的 SHA>" }`；
   - `engines.dsh`：与 package.json 一致。
6. **推送索引**：`git add market-index.json && git commit -m "market: vX.Y.Z" && git push`。

索引 URL 固定为 `https://raw.githubusercontent.com/dybai/dsh-editor/main/market-index.json`——它永远指向 main 分支最新提交，所以"追加版本条目再 push"就完成了发布。

## 5. 用户侧安装（首次）

1. DSH 设置 → 插件 → 安装官方可选 bundle **`@deepseek-ai/dsh-experimental-plugin-market-bundle`**（实验性插件市场，提供 Discover 标签页）。
2. 在市场设置里**添加索引源**：填第 4 节的 raw URL。
3. Discover 里找到「DSH 编辑器」→ 安装 → 刷新页面。
4. 不想装市场组件的话，也可以直接 `install_bundle`：git 模式给 spec `git+https://github.com/dybai/dsh-editor.git#<SHA>`；npm 模式给 `@dybai/dsh-editor@X.Y.Z`；本地开发给目录绝对路径。

## 6. npm 发布路径

npm 模式的安装物是 tarball，更轻，但需要账号与发布权（scope 名必须等于你的 npm 用户名，或你拥有的组织名）：

1. `npm whoami` 确认登录身份与 scope 匹配（当前为 `dybai`）。
2. `npm pack --dry-run` 核对包内容：应只有 `package.json / LICENSE / README.md / index.js / client.js / cordis.patch.yml / locale/*.json / icon.svg / host/write-service.js / host/preferences-service.js`，不应出现 `src/ host/*.test.js scripts/ docs/ .superpowers/`。
3. `npm publish --access public` —— **scoped 包默认 restricted，漏掉 `--access public` 别人装不了**；另外：
   - 开了 2FA 的账号会报 **EOTP**：用 `npm publish --access public --otp <验证器6位码>`，或按提示走浏览器认证；
   - 成功标志是输出 `+ @dybai/dsh-editor@X.Y.Z`，且含 `Publishing to https://registry.npmjs.org/ with tag latest and public access` 一行；
   - **不要把 `--dry-run` 当作发布**——`npm publish --dry-run` 打印同样的 `+ 包名@版本` 样式，但并不真正上传。
4. 发布成功后 `npm view @dybai/dsh-editor` 复核；**新 scoped 包可能出现几分钟的 404（CDN 传播延迟），属正常**——再次 publish 报 `EPUBLISHCONFLICT`（cannot publish over previously published versions）恰恰证明已经发上去了。
5. 市场索引里新版本的 `source` 写 `{ "type": "npm" }`（省略 `registry` = 安装方默认 registry）。
6. GitHub Release 可附 `npm pack` 产物存档（市场不直接消费它，仅作备份）。

## 7. market-index.json 字段速查

| 字段 | 说明 |
| --- | --- |
| `format` | 固定 `1`；格式不符会被市场拒绝 |
| `title` / `description` | 字符串或 `{ "en": 必填, "zh-cn": ... }`（小写语言 id，en 是兜底） |
| `metadata.categories/labels/sortKeys` | 声明市场里出现的分类/标签/排序键及其标题；插件只能引用已声明的 id |
| `plugins[].name` | npm 包名形状，索引内唯一 |
| `plugins[].metadata.keywords` | 搜索命中字段之一（约定来自 package keywords） |
| `plugins[].versions[].source` | `git`：`url`（无凭据 https）+ `commit`（小写 40 hex）+ 可选 `path`；`npm`：可选 `registry` |
| `plugins[].versions[].engines.dsh` | SemVer 范围；与运行版本不符会显示不兼容（可申请豁免） |
| 安装目标 | 索引不写 install 字段——市场端自动从 `source` 推导（npm → `name@version`；git → `git+url#commit`） |

## 8. 常见坑

- **git 安装不跑构建脚本**：忘了提交新构建的 `client.js`，用户装到的就是旧代码。发版检查单第一条。
- **npm 包必须带 `host/` 服务文件**：与空壳 Host 半端的插件不同，本包 `index.js` 会 `import './host/write-service.js'` 和 `./host/preferences-service.js`——`files` 清单漏掉它们，npm 安装直接加载失败。发版前 `npm pack --dry-run` 必看。
- **`files` 字段只在打包（`npm pack` / npm 发布）时生效**；本地目录与 git 安装按仓库原样取。
- **SHA 必须是小写 40 位十六进制**，且必须是远端已存在的提交——本地未 push 的 SHA 会让安装端 404。
- **索引 URL 必须 http(s)、无凭据、无 fragment**；`raw.githubusercontent.com` 的 main 链接即可。
- **`engines.dsh` 不匹配**：安装界面会标不兼容；确要强装需在插件管理里做版本豁免（有崩溃风险）。
- **升级判定**：市场按"包名 + 版本比较"给出 `update-available`，所以每次发版务必递增 `package.json` 的 `version`。
- **npm 渠道三连**：EOTP = 开了 2FA，加 `--otp` 或走浏览器认证；EPUBLISHCONFLICT = 这个版本已经发过了（想清楚是要改版本号还是只是核对）；刚发布完 `npm view` 404 = CDN 传播延迟，等几分钟。
- **契约名字是稳定面，永远不要改**：服务 key `dshEditor` 与 `dshEditorModes`、三个座位名（`dsh-editor.actions` / `dsh-editor.status` / `dsh-editor.unavailable`）、七个 Remote 方法名、导航契约的 `kind: 'editor'`——第三方只依赖这些名字。行为演进走 [docs/contracts.md](contracts.md) §10 演进流程，发版必须在 §1 登记契约增量。

## 9. 当前版本历史

| 版本 | 内容 |
| --- | --- |
| 0.4.0 | 活动行高亮：光标行上下细边线实时跟随（VS Code 风格），`activeLine` 模式契约 + `highlightActiveLine` prop，设置面板新增高亮开关；**本次为 npm + 市场索引首发版本** |
| 0.3.0 | 外部修改/删除检测：`workspaceFiles/changes` 推送流实时感知（流不可用降级为聚焦检查）、修改冲突横幅、删除标红与 Ctrl+S 原样重建、草稿恢复、设置面板（自动重载开关） |
| 0.2.0 | 编辑器框架成型：tab 状态机与保存队列（乐观并发 + 冲突横幅）、座位 ×3、`dshEditor` 服务与句柄切片、模式注册、导航契约、键位录制、初版集成契约（[docs/contracts.md](contracts.md)） |
| 0.1.0 | 初始文件编辑插件：编辑按钮 + 就地编辑保存 |
