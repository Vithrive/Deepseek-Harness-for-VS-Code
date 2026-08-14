# DeepSeek Harness for VS Code

一个零依赖的 VS Code 扩展，把 DeepSeek Harness (DSH) 的 Web GUI 内嵌到 VS Code 侧边栏 / 辅助侧边栏中，并自动检测、启动 DSH 服务。

## 快速安装（下载 .vsix）

1. 从 [GitHub Releases](https://github.com/cszr-liuxiaobo/Deepseek-Harness-for-VS-Code/releases/latest) 下载最新的 `.vsix` 安装包：

   ```
   https://github.com/cszr-liuxiaobo/Deepseek-Harness-for-VS-Code/releases/latest/download/deepseek-harness-vscode-0.1.0.vsix
   ```

2. 在 VS Code 中安装：

   ```bash
   code --install-extension deepseek-harness-vscode-0.1.0.vsix
   ```

   或在 VS Code 中：`Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 选择下载的 `.vsix` 文件。

3. 重载窗口：`Ctrl+Shift+P` → `Reload Window`。

4. 打开项目文件夹，点击 Activity Bar 的「DeepSeek Harness」图标，扩展会自动检测并启动 DSH。

## 特性

- 在 Activity Bar 中新增「DeepSeek Harness」图标，点击后打开内嵌面板
- 支持把面板移动到**辅助侧边栏**（右键图标 → Move to Secondary Side Bar，或直接拖拽）
- **自动检测**：打开面板时探测 `dshPanel.url` 是否可访问
- **自动启动**：检测到未运行时，自动执行 `dsh web --host <host> --port <port>` 启动 DSH
- **工作区自动绑定**：启动 dsh 时使用 VS Code 当前打开的工作区文件夹作为 dsh 工作目录（无工作区则退回用户主目录）
- **就绪等待**：启动后自动轮询等待服务就绪，再渲染界面，避免白屏
- 面板顶部提供「刷新」和「在浏览器中打开」按钮

## 从源码安装（开发模式，零依赖，无需编译）

本扩展是纯 JavaScript，**不需要 npm install、不需要 TypeScript 编译**。

### 方式一：直接加载开发扩展

1. 克隆并打开本目录：

   ```bash
   git clone https://github.com/cszr-liuxiaobo/Deepseek-Harness-for-VS-Code.git
   code Deepseek-Harness-for-VS-Code
   ```

2. 在 VS Code 中按 `F5`，会弹出「扩展开发宿主」窗口。

3. 在扩展开发宿主中打开你的项目文件夹（File → Open Folder），这样 DSH 的工作区就是你的项目。

4. 点击左侧 Activity Bar 的「DeepSeek Harness」图标，面板会：
   - 检测 `http://127.0.0.1:3080` 是否已运行；
   - 若未运行，自动执行 `dsh web --host 127.0.0.1 --port 3080`，工作目录为当前项目；
   - 服务就绪后自动渲染 DSH 界面。

5. 把图标移到辅助侧边栏：右键图标 → **Move to Secondary Side Bar**。

### 方式二：自行打包成 .vsix 并安装

```bash
cd DeepSeek-Harness-for-VS-Code
npx --yes @vscode/vsce package --allow-missing-repository
code --install-extension deepseek-harness-vscode-0.1.0.vsix
```

## 配置

在 VS Code 设置（`settings.json`）中可覆盖默认值：

```json
{
  "dshPanel.url": "http://127.0.0.1:3080",
  "dshPanel.host": "127.0.0.1",
  "dshPanel.port": 3080,
  "dshPanel.autoStart": true,
  "dshPanel.dshCommand": "dsh",
  "dshPanel.killOnDispose": true
}
```

### 各配置项含义

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `dshPanel.url` | `http://127.0.0.1:3080` | 面板连接的 DSH 地址 |
| `dshPanel.host` | `127.0.0.1` | 自动启动时绑定的主机 |
| `dshPanel.port` | `3080` | 自动启动时监听的端口 |
| `dshPanel.autoStart` | `true` | 未运行时是否自动启动 dsh |
| `dshPanel.dshCommand` | `dsh` | dsh 命令（可填完整路径） |
| `dshPanel.killOnDispose` | `true` | 扩展停用时是否结束它启动的 dsh |

### 连接远程服务器上的 DSH

先建立 SSH 隧道：

```bash
ssh -L 3080:127.0.0.1:3080 user@your-server
```

然后把 `dshPanel.autoStart` 设为 `false`（避免在本地又起一个），`dshPanel.url` 保持 `http://127.0.0.1:3080`。

## 工作原理

1. 打开面板 → 先显示「正在启动」加载页；
2. 用 Node 内置 `http`/`https` 探测 `dshPanel.url`；
3. 未连接且 `autoStart` 开启 → `spawn('dsh web --host ... --port ...')`，`cwd` 设为 VS Code 工作区；
4. 轮询等待服务就绪（最多约 30 秒）；
5. 就绪后通过 `WebviewViewProvider` 渲染 iframe；
6. `retainContextWhenHidden: true` 保持面板隐藏时不丢会话状态；
7. 扩展停用时按 `killOnDispose` 决定是否结束它自己启动的 dsh（不影响你手动启动的实例）。

## 分支说明

- `dev-*`：开发分支（当前为 `dev-1.1`）
- `main`：与最新 `dev-*` 内容保持一致，作为默认分支
- `.vsix` 安装包通过 [GitHub Releases](https://github.com/cszr-liuxiaobo/Deepseek-Harness-for-VS-Code/releases) 发布

## 前置条件

- 已安装 DeepSeek Harness，且 `dsh` 命令在 PATH 中（或通过 `dshPanel.dshCommand` 指定完整路径）
- 实测 DSH 默认响应头未设置 `X-Frame-Options` / 严格 `CSP`，可被 iframe 正常内嵌
