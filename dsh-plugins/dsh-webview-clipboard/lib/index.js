// dsh-webview-clipboard host half: no-op.
//
// 本插件只做客户端（浏览器侧）兼容：
// 1. 跨平台：DSH 页面被 VS Code webview（跨源 iframe）内嵌时，异步 Clipboard API
//    被 Electron 权限处理器拒绝（只对 vscode-webview:// 来源放行 clipboard-*），
//    且 DSH 前端的复制工具只在 writeText 不存在时才回落 execCommand，因此面板内
//    复制按钮会静默失败。客户端半身把 writeText 中继给外层宿主，由宿主
//    vscode.env.clipboard.writeText 写入（Remote/WSL 下即客户端剪贴板）。
// 2. macOS：修复与 Electron 内嵌组合时 ⌘C/⌘V/⌘X 失效（改用 execCommand）。
// 宿主侧无需任何逻辑。
export const name = 'dsh-webview-clipboard'

export const inject = []

export function apply(_ctx) {}
