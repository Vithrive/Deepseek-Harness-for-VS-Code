// dsh-vscode-open-external host half: no-op.
//
// 本插件只做客户端（浏览器侧）工作：DSH 页面被「Deepseek-Harness-for-VS-Code」扩展
// 以跨源 iframe 内嵌时，页面里的 window.open（典型场景：DeepSeek 账号登录时预开
// 授权页）无法真正打开浏览器窗口；本插件把授权链接转发给外层宿主，由宿主调用
// VS Code 的 openExternal 在**客户端**（如 WSL/Remote 场景下的 Windows 本机）
// 默认浏览器里打开。宿主侧无需任何逻辑。
export const name = 'dsh-vscode-open-external'

export const inject = []

export function apply(_ctx) {}
