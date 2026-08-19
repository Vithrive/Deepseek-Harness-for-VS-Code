# DeepSeek Harness VSCode 扩展 v0.2.12 发布说明

## 新功能

✨ **发送选中代码到 DSH 对话框**

- 在编辑器中选中代码后，通过右键菜单或命令将代码片段发送到 DeepSeek Harness 对话框
- 自动包含文件路径、行号范围、代码内容
- 格式化为 Markdown 代码块，支持语法高亮

## 使用方法

### 1. 选中代码
在编辑器中框选需要发送的代码片段

### 2. 发送到 DSH
两种方式：
- **右键菜单**：右键点击选中内容 → 选择 **DeepSeek Harness: 发送选中内容到对话框**
- **命令面板**：`Ctrl+Shift+P` → 输入 `DeepSeek Harness: 发送选中内容到对话框`

### 3. 自动插入
选中内容会自动插入到 DSH 输入框的光标位置，格式为：

```
V:\project\src\main.py:12-18
```python
def calculate(x, y):
    result = x + y
    return result
```
```

## 配套 DSH 插件

需要安装配套的 DSH client 插件 `dsh-vscode-selection` 来接收并插入选中内容。

插件位置：`C:\Users\admin\.dsh\plugins\dsh-vscode-selection`

安装到 DSH：
```bash
cd C:\Users\admin\.dsh\plugins\dsh-vscode-selection
npm publish
dsh plugin --profile web add dsh-vscode-selection
```

## 技术实现

- VS Code 扩展通过 `webview.postMessage` 发送选区数据
- DSH client 插件监听 `window.message` 事件
- 使用 `slash/input-insert-text` 事件插入到输入框

## 发布清单

### 1. GitHub Release
- [x] 代码已推送到 main 分支
- [ ] 手动创建 Release v0.2.12
- [ ] 上传 `deepseek-harness-vscode-0.2.12.vsix` 到 Release Assets

### 2. VS Code Marketplace
需要使用 `vsce` 发布：

```bash
cd V:\PythonProject\C_UtilizeSpace\DeepSeek-Harness-for-VS-Code
vsce publish
```

或手动上传 vsix 到 https://marketplace.visualstudio.com/manage/publishers/vithrive

---

## 文件位置

- **VS Code 扩展**：`V:\PythonProject\C_UtilizeSpace\DeepSeek-Harness-for-VS-Code\deepseek-harness-vscode-0.2.12.vsix`
- **DSH 插件**：`C:\Users\admin\.dsh\plugins\dsh-vscode-selection`
- **GitHub 仓库**：https://github.com/Vithrive/Deepseek-Harness-for-VS-Code
