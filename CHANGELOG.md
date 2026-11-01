# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。完整提交历史见 [GitHub](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/commits/main)。

## 1.1.1 —— 修复面板内「复制」按钮无反应（Issue #28）

**忠实窗口（面板）**

- **根因**：面板把 DSH 以跨源 iframe 内嵌在 webview 中，VS Code 的 Electron 权限处理器只对 `requestingUrl` 以 `vscode-webview://` 开头的请求放行 `clipboard-read` / `clipboard-sanitized-write`（`src/vs/code/electron-main/app.ts` 的 `configureSession`；本机 1.134.0 打包产物逻辑相同）；iframe 来源是 `http://127.0.0.1:<port>`，`navigator.clipboard.writeText()` 因此被拒（`Write permission denied`）。iframe 的 `allow="clipboard-read; clipboard-write"` 只是 Permissions Policy 委派，管不到这层权限处理器（上游 microsoft/vscode#182642 仍 open）。
- **静默原因**：DSH Web 前端（dsh 0.2.1-rc.4）的复制工具 `zo()` 只在 `navigator.clipboard.writeText` **不存在**时才回落 `textarea + execCommand('copy')`；`writeText()` 存在但被拒时直接 `return false`，复制按钮仅在成功时切 ✓——所以点击毫无反应。
- **修复：宿主剪贴板中继**。内置插件 `dsh-webview-clipboard` 升级到 **0.3.0**：宿主握手（ack 带 `clipboard:true`）后包裹 `navigator.clipboard.writeText`，把文本经 `postMessage` → webview 中继 → 扩展宿主 `vscode.env.clipboard.writeText()` 写入，结果沿原路返回并 resolve/reject。
  - 不受 Electron 权限处理器限制；Remote-WSL / Remote-SSH 下写入的正是客户端（Windows）剪贴板；
  - 宿主通道失败（旧版扩展无此消息 / 4s 超时 / 宿主明确拒绝）时自动回落原生实现，不放大故障面；
  - 仅在被 iframe 内嵌且宿主握手后接管；独立浏览器 / 其它宿主里行为完全不变；
  - 覆盖 DSH 所有走 `navigator.clipboard.writeText` 的复制入口（回答、代码块、消息、JSON 树等）。
- **插件改为真实文件分发**：`dsh-webview-clipboard` 源码移到 `dsh-plugins/dsh-webview-clipboard/`（与 file-links / open-external 一致），不再由扩展内模板字面量生成——消除正则反斜杠被模板转义的隐患，可单独语法检查。
- 既有的 macOS `⌘C/⌘V/⌘X` 修复保持不变；配置沿用 `dshPanel.installClipboardPlugin`（默认 `true`）。

**测试**

- 新增 `clipboard-write` 测试套（36 项）：插件握手前后行为、copy 中继与 resolve、宿主 ok/失败/超时回落、`navigator.clipboard` 缺失与伪造 ack、webview 中继（ack 字段兼容、copy 转发、origin/source/字段校验、4 MiB 截断、结果回传）、宿主写入与回执（成功/失败/空/超长/缺字段/webview 缺失）。
- 更新 `clipboard-plugin`（插件文件结构 + 中继协议断言，25 项）与 `macos-keysim`（版本 0.3.0）。
- 全套 16 个测试套件通过（454 项断言 + 真实 dsh e2e）。

## 1.1.0 —— Remote-WSL / Remote-SSH 下用本机浏览器登录 DeepSeek 账号

**忠实窗口（面板）**

- **修复：远端窗口（Remote-WSL / Remote-SSH / Dev Containers）里点 DSH 的「登录」没有反应**。DSH 的登录由页面内 `BrowserLogin` 驱动：`window.open('about:blank')` 预开页 → 拿到 Host 授权链接后 `popup.location.replace(url)`。面板把 DSH 以跨源 iframe 内嵌进 VS Code webview，而 webview 不允许新开窗口（`window.open` 返回 null），远端也没有图形浏览器兜底，登录流程卡在「没有自动打开新页面？」。
- 新增内置插件 **`dsh-vscode-open-external`**（随扩展分发，不经 npm）：接管面板内网页的 `window.open` —— 对 `about:blank` 预开页返回可导航的占位对象，DSH 把授权链接 `location.replace/assign/href` 过来后，经 webview 中继交给扩展宿主 `vscode.env.openExternal`，在**客户端**（WSL/Remote 场景即本机 Windows）默认浏览器打开授权页；登录回跳地址是 DSH 所在机器的回环，Windows 经 WSL localhost 转发可达，完成后面板自动刷新为已登录。
- 安全与兼容边界：只转交 http/https 链接（长度校验）、仅在宿主握手后接管；`file:` / `javascript:` 等一律回退原生行为；独立浏览器里行为不变；新增配置 `dshPanel.installOpenExternalPlugin`（默认 `true`）可关闭。
- 手动兜底：登录对话框的「复制登录链接」仍可把授权链接复制到本机浏览器打开（任何版本可用）。

**测试**

- 新增 `open-external-plugin` 测试套（43 项）：插件文件/声明完整性、客户端握手前后行为、`about:blank` 占位对象导航转交、非法 scheme/超长链接回退、webview 中继（ack/open/边界/off 模式仍可登录）、宿主侧 `dsh-open-link` 只放行 http(s)。
- 更新 `file-link-bridge` / `workspace-file-link` 断言：握手回执新增 `openExternal` 字段，`off` 模式改为「`fileLinks:false` 但允许外链/登录链接」。
- 全套 15 个测试套件通过（411 项断言 + 真实 dsh e2e）。

## 1.0.2 —— 支持 Remote-SSH / Dev Containers（Issue #24）

**忠实窗口（面板）**

- **修复：Remote-SSH / Dev Containers 下 dsh 已经启动、面板却稳定 401「无法连接 DeepSeek Harness」**。根因是 `isLocalLoopbackTarget()` 在 `remoteName` 非 `wsl` 时一律返回 false，受管认证代理被整体禁用——但扩展声明 `extensionKind: ["workspace"]`，真远程下扩展宿主与 dsh 本来就同机，代理前提完全成立。
- 现在改为按「`dshPanel.url` 是否回环」判定代理可用性，真远程下：
  - 代理仍在服务器回环随机端口监听，面板地址经 `vscode.env.asExternalUri` 转发到客户端后再加载；
  - Copilot 桥接（扩展自身 `/api`）留在服务器侧直连代理，不再 401；
  - 「在浏览器中打开」同样经转发，不再打开客户端本机的 `127.0.0.1:3080`（而是服务器上的 DSH）；`asExternalUri` 失败时面板给出可读错误页，不再白屏。
- **安全加固（远程模式）**：代理不再无条件接受匿名请求——远程模式下只放行「Host 等于扩展已转发给客户端的 authority」的请求，其余一律 403；扩展自身的请求带一次性随机密钥头 `x-dsh-proxy-key`。新增 `dshPanel.remoteAuthProxy`（默认 `true`），多用户共享服务器可关闭，回到「浏览器认证引导」旧行为；非回环目标仍然不启用代理。
- 已知边界：Codespaces / Remote Tunnels 这类转发到公网 HTTPS 域名的场景不在覆盖范围（dsh 的 `/api` 围栏只接受回环 authority）；真远程下标签页与侧边栏的 origin 隔离可能退化为同源（单活动视图策略仍生效）。

**测试**

- 新增 `remote-auth-proxy` 测试套（28 项）：用真实 TCP 转发器模拟 VS Code 端口转发，覆盖客户端 authority 的 Cookie 换发、远程 403 拦截、扩展侧 `/api` 密钥头、浏览器打开地址转发、面板 CSP 与 `asExternalUri` 失败报错。
- 重写 `remote-mode` 测试套（34 项）：URL-only 回环判定、`needsPortForwarding` 分类、远程代理开关与实例重建、转发失败时的可读错误。
- WSL2 真机端到端（Linux 服务器 + Windows 客户端 + 真实 dsh 0.2.1-rc.2）：经转发的客户端地址返回 200（37 KB GUI HTML）、经转发的 `/api` 返回 200、直连代理端口 403、带密钥 200。
- 全套 14 个测试套件通过（366 项断言 + 真实 dsh e2e）。

## 1.0.1 —— 支持官网 Windows 桌面版

**忠实窗口（面板）**

- **修复：只装了官网 Windows 桌面版（Electron 应用）的用户，面板打不开**。桌面版的 DSH 运行时内嵌在 `app.asar` 里、`dsh` 不在 PATH、用户通常也没有 npm，旧逻辑会把它误判成「未安装」，随后 `npm install -g @deepseek-ai/dsh` 也必然失败。
  现在扩展把桌面版内置 CLI 作为**第三种启动来源**：从注册表卸载项的 `InstallLocation`（兼容 HKCU/HKLM）定位安装目录，兜底常见默认目录，然后调用 `<安装目录>\resources\runtime\cli\bin\dsh.cmd` 启动 `dsh web`——不需要 PATH / npm / Node。启动方式优先级：`dshPanel.dshCommand`（PATH 上的 `dsh`）→ 桌面版内置 CLI → `npx`。
- 桌面版 CLI 起的实例仍是 **web profile**（默认端口 3080），扩展的配套插件、受管认证代理、Copilot 桥接全部照旧生效；与桌面 App 自己的 `127.0.0.1:19387` + `desktop` profile 实例并存，**会话与凭据共享**（同一个 `~/.dsh`）。
- 含空格的 CLI 路径统一走 cmd.exe 引号处理（`shellCommandText`），`startDsh` 与 `dsh plugin add` 共用同一规则；插件安装改用已解析的启动方式，不再写死 `dsh.cmd`。
- 「未安装」错误页与安装失败提示补充桌面版路径说明。

**测试**

- 新增 `desktop-app-support` 测试套（37 项断言）：安装目录定位、注册表输出解析、启动方式优先级、含空格路径引号、源码级接线；另有真实桌面版实例的端到端验证（启动 5.2s、无令牌 401、经代理首页 200、`session/list` 返回 323 个会话）。

## 1.0.0 —— 第一个正式版本

**Copilot 桥接**

- **修复：在 Copilot 里能转接到 DSH、却收不到回答**——dsh 0.2.x 起助手正文改为「每个 step 一条 `assistant/message`」事件（正文在 `data.message.content` 的 `text` 块里），旧的 `assistant/chunk` 增量通道不再发送。扩展现在两代协议都认，实时轮询与历史回放共用同一套事件消费逻辑；某一轮结束却没有正文时会在回答里明确提示，不再静默空白。
- **模型条目对齐 DeepSeek 现役模型**：选择器里只保留现役条目——`DSH (DeepSeek Harness)`（跟随 DSH 设置）、`DeepSeek-V4.1-Flash (DSH)`（DSH 模型 id `deepseek-flash`）、`DeepSeek-V4-Pro (DSH)`（`deepseek-v4-pro`）；退役的 `DeepSeek-V4-Flash (DSH)` / `deepseek-v4-flash-vision-exp (DSH)` 条目移除，旧条目 id 仍解析到 `deepseek-flash`。
- **映射漂移自检**：每次会话首次提问时读一次 DSH 的 `session/modelCatalog`，条目与 DSH 在册模型失配时直接告警（DSH 的 `session.selectModel` 校验失败原本会静默回落默认模型）。
- 成本信息按 DeepSeek 调价后的价格更新；上下文/输出上限对齐 DSH 模型配置（1M / 384K）。

**忠实窗口（面板）**

- **点击对话里的工作区文件/文件夹链接 → 在 VS Code 资源管理器中定位并打开**：新增内置 DSH 插件 `dsh-vscode-file-links`（随扩展分发，不经 npm）。只有目标位于当前工作区且真实存在时才接管，否则自动回落到 DSH 侧边栏行为；`Ctrl/Cmd/Shift/Alt` + 点击可强制走 DSH 行为。行为由 `dshPanel.workspaceFileLinkAction` 控制（`revealAndOpen` / `revealOnly` / `off`）。

**测试**

- 11 套单测（280+ 项断言）覆盖面板桥接、路径解析、模型映射、事件消费、认证代理、配置净化等；另有真实 dsh 实例的端到端回归（含模型在册校验）。

## 0.8.45

- 从 VS Code 资源管理器拖拽文件到对话框时，引用源文件本身（`dsh-drop-caret` 0.2.3）。

## 0.8.44

- WSL Remote 场景启用受管认证代理；Remote 无代理时引导可达。

## 0.8.42 / 0.8.40

- 安全加固：配置输入净化、POSIX 场景去掉 shell 执行（采纳 PR #12 报告的第二层防御）。

## 0.8.41

- macOS 面板内 ⌘C/⌘V/⌘X 修复收敛范围为剪贴板三键（PR #14，内置插件 `dsh-webview-clipboard` 0.2.1）。

## 0.7.13

- Copilot 桥接首次发布：把 DSH 注册为 Copilot 聊天模型（`DSH (DeepSeek Harness)`）。
