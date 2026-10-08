# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。完整提交历史见 [GitHub](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/commits/main)。

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
