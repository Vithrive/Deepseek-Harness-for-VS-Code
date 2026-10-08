// dsh-vscode-file-links client bundle (ModuleLoader format)
//
// 作用：DSH 对话里「工作区文件/文件夹链接」由宿主渲染成一个 <button>
// （DSH 的 MarkdownFileLink：className 含 CSS Modules 的 fileLink，title 为目标路径），
// 点击时 DSH 自身会在右侧边栏打开该文件。当 DSH 页面被
// Deepseek-Harness-for-VS-Code 扩展以跨源 iframe 内嵌时，我们希望这次点击改为
// 「在 VS Code 资源管理器中定位并打开」。
//
// 链路：本插件捕获点击 → window.parent.postMessage → webview 中继 → 扩展宿主
//       → revealInExplorer / 打开文件 → 回执沿原路返回。
//
// 三条底线（安全 + 兼容）：
// 1. 只在宿主完成握手（ack）后接管；独立浏览器 / 其它宿主里完全不介入；
// 2. 只有宿主确认「能在当前 VS Code 工作区里打开」才吞掉这次点击；否则回放原始
//    点击，保持 DSH 自身行为（在 DSH 侧边栏打开）——绝不出现「点了没反应」；
// 3. 带修饰键（Ctrl/Cmd/Shift/Alt）的点击一律不接管，随时可强制走 DSH 行为。

window.__ModuleLoader__.load({ id: 'dsh-vscode-file-links', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.1.0'
  // 父级 webview（VS Code 扩展）的身份标记：iframe name 属性 + 消息 source 字段。
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-vscode-file-links'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  var REVEAL_TIMEOUT_MS = 2500
  var PATH_MAX_LENGTH = 4096
  // 形如 `_fileLink_<hash>` 的 CSS Modules 类名：哈希后缀随版本变化，
  // 因此按 token 里的局部名匹配，不绑定完整类名。
  var FILE_LINK_CLASS = 'fileLink'

  var acked = false
  var replaying = false
  var helloTimer = null
  var helloTries = 0
  var pending = {}

  /** 是否被宿主内嵌（独立浏览器里 parent === self）。 */
  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  /** 父级是否为 VS Code 扩展的 webview（iframe name 标记，仅用于判断要不要打招呼）。 */
  function hostHinted() {
    try { return window.name === HOST_ID } catch (e) { return false }
  }

  /** 向父级（webview）发消息：附带自身身份标记。 */
  function postToHost(payload) {
    payload.source = SELF_ID
    payload.version = PLUGIN_VERSION
    try {
      // 目标 origin 无法从 iframe 内可靠得知（跨源），固定用户点击产生的路径本身
      // 也不敏感；宿主侧按 event.source + event.origin 双重校验，只认自己的 iframe。
      window.parent.postMessage(payload, '*')
    } catch (e) { /* 父级不可达：静默失败，行为回落到 DSH 自身 */ }
  }

  /** 停止握手重试。 */
  function stopHello() {
    if (helloTimer !== null) {
      window.clearInterval(helloTimer)
      helloTimer = null
    }
  }

  /** 周期性向宿主打招呼，直到拿到 ack（插件可能在 webview 就绪前后任意时刻加载）。 */
  function startHello() {
    if (!inIframe() || acked || helloTimer !== null) return
    postToHost({ type: 'hello' })
    helloTries += 1
    if (helloTries >= HELLO_MAX_TRIES) return
    helloTimer = window.setInterval(function () {
      if (acked || helloTries >= HELLO_MAX_TRIES) { stopHello(); return }
      helloTries += 1
      postToHost({ type: 'hello' })
    }, HELLO_INTERVAL_MS)
  }

  /** 事件目标是否为 DSH 渲染的文件链接按钮（含点击落在内部图标/文字上的情形）。 */
  function fileLinkButtonOf(node) {
    if (!node || typeof node.closest !== 'function') return null
    var button = node.closest('button')
    if (!button) return null
    var cls = button.getAttribute('class') || ''
    var parts = cls.split(/\s+/)
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(FILE_LINK_CLASS) >= 0) return button
    }
    return null
  }

  /** 友好的本地路径形状检查：排除 URL、多行文本、超长字符串。 */
  function looksLikePath(value) {
    if (typeof value !== 'string') return false
    var v = value.trim()
    if (v.length === 0 || v.length > PATH_MAX_LENGTH) return false
    if (v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0 || v.indexOf('\u0000') >= 0) return false
    // 带 scheme 的 URL（http://、data: 等）不是本地路径；Windows 盘符 `C:\` 不受影响。
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false
    return true
  }

  /**
   * 取出链接目标路径：DSH 把路径写在 title 上；带图片预览的链接没有 title，
   * 退回到链接文字（模型书写的 Markdown label，通常就是同样的相对路径）。
   */
  function pathOfButton(button) {
    var title = button.getAttribute('title')
    if (typeof title === 'string' && looksLikePath(title)) return title.trim()
    var text = button.textContent || ''
    if (looksLikePath(text)) return text.trim()
    return ''
  }

  function nextToken() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  /**
   * 回放原始点击：宿主不能处理（不在工作区内 / 面板未接管）时，让 DSH 自己把文件
   * 打开在 DSH 侧边栏，保持既有行为。click() 是同步派发，用 replaying 标记避免
   * 再次被本插件捕获。
   */
  function replayClick(button) {
    if (!button || typeof button.click !== 'function') return
    replaying = true
    try {
      button.click()
    } catch (e) { /* 按钮已卸载等情况：忽略 */ }
    replaying = false
  }

  function requestReveal(button, path) {
    var token = nextToken()
    pending[token] = {
      el: button,
      timer: window.setTimeout(function () {
        delete pending[token]
        // 宿主没回执（面板关闭 / 扩展未升级）：回放点击，行为退回 DSH 自身。
        replayClick(button)
      }, REVEAL_TIMEOUT_MS)
    }
    postToHost({ type: 'reveal', token: token, path: path })
  }

  function onClickCapture(event) {
    if (!acked || replaying) return
    if (event.defaultPrevented) return
    // 修饰键点击 = 用户明确要求走 DSH 自身行为（在 DSH 侧边栏打开）。
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    var button = fileLinkButtonOf(event.target)
    if (!button) return
    var path = pathOfButton(button)
    if (path === '') return
    // 先吞掉这次点击（阻止 React 的委托 handler 调用 DSH 的 openFile），
    // 再由宿主回执决定是否回放；其它 DOM 监听器不受影响。
    event.preventDefault()
    event.stopPropagation()
    requestReveal(button, path)
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type === 'ack') {
      // 宿主明确声明「已启用接管」；fileLinks 缺省视为启用（老宿主不带该字段）。
      if (data.fileLinks === false) { stopHello(); return }
      acked = true
      stopHello()
      return
    }
    if (data.type === 'reveal-result' && typeof data.token === 'string') {
      var entry = pending[data.token]
      if (!entry) return
      delete pending[data.token]
      window.clearTimeout(entry.timer)
      if (data.ok !== true) replayClick(entry.el)
    }
  }

  function apply(ctx) {
    function arm() {
      document.addEventListener('click', onClickCapture, true)
      window.addEventListener('message', onHostMessage, false)
      startHello()
    }
    function disarm() {
      document.removeEventListener('click', onClickCapture, true)
      window.removeEventListener('message', onHostMessage, false)
      stopHello()
      for (var token in pending) {
        if (Object.prototype.hasOwnProperty.call(pending, token)) {
          window.clearTimeout(pending[token].timer)
        }
      }
      pending = {}
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 供排障使用：控制台可查 __dshVscodeFileLinks.acked()
    window.__dshVscodeFileLinks = {
      version: PLUGIN_VERSION,
      hostHint: hostHinted(),
      acked: function () { return acked }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
