# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。完整提交历史见 [GitHub](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/commits/main)。

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
