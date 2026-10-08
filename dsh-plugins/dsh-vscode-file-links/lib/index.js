// dsh-vscode-file-links host half: no-op.
//
// 本插件只做客户端（浏览器侧）工作：把 DSH 对话里「工作区文件/文件夹链接」的点击
// 转发给外层宿主（Deepseek-Harness-for-VS-Code 扩展的 webview），由宿主在 VS Code
// 资源管理器中定位并打开。宿主侧不需要任何逻辑。
export const name = 'dsh-vscode-file-links'

export const inject = []

export function apply(_ctx) {}
