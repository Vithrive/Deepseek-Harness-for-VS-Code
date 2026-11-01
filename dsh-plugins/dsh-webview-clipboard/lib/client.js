// dsh-webview-clipboard client bundle (ModuleLoader format)
//
// 两个职责（仅在「被宿主以跨源 iframe 内嵌」时激活）：
//
// A. 跨平台剪贴板写中继（v0.3.0 新增，修复面板内「复制」按钮静默失效）
//    VS Code 的 Electron 权限处理器只对 requestingUrl 以 `vscode-webview://`
//    开头的请求放行 clipboard-read/clipboard-sanitized-write；面板 iframe 的
//    来源是 http://127.0.0.1:<port>，异步 Clipboard API 一律被拒
//    （microsoft/vscode#182642 仍 open）。而 DSH 前端的复制工具只在
//    navigator.clipboard.writeText 不存在时才回落 textarea+execCommand，
//    writeText 被拒时直接返回 false → 复制按钮无任何反应。
//
//    修复：宿主握手（ack 带 clipboard:true）后包裹 navigator.clipboard.writeText，
//    把文本经 window.parent.postMessage 交给 webview 中继 → 扩展宿主
//    vscode.env.clipboard.writeText（Remote-WSL / Remote-SSH 下写入的正是
//    客户端剪贴板），结果沿原路返回并 resolve/reject。宿主通道失败时回落原生实现，
//    未握手（独立浏览器 / 其它宿主）时行为完全不变。
//
// B. macOS 快捷键修复（v0.2.x 既有）：拦截 ⌘C/⌘V/⌘X，preventDefault 后改用
//    document.execCommand('copy'/'paste'/'cut') 显式执行；其余编辑快捷键不处理。
//    仅在「被 Electron 内嵌 + macOS」时启用。

window.__ModuleLoader__.load({ id: 'dsh-webview-clipboard', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.3.0'
  // 父级 webview（VS Code 扩展）的身份标记：消息 source 字段。
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-webview-clipboard'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  var COPY_TIMEOUT_MS = 4000
  var TOKEN_MAX_LENGTH = 64
  // 与扩展宿主侧保持一致：单次转交文本上限 4 MiB。
  var TEXT_MAX_LENGTH = 4 * 1024 * 1024

  var acked = false
  var helloTimer = null
  var helloTries = 0
  var pendingCopy = {}
  var writePatch = null // {target, key, original}

  /** 是否被宿主内嵌（独立浏览器里 parent === self）。 */
  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  function isMac() {
    var ua = navigator.userAgent || ''
    if (/Macintosh|Mac OS X/i.test(ua)) return true
    if (typeof navigator.platform === 'string' && /Mac/i.test(navigator.platform)) return true
    try {
      if (navigator.userAgentData && navigator.userAgentData.platform === 'macOS') return true
    } catch (e) { /* ignore */ }
    return false
  }

  function inElectron() {
    return /Electron\//.test(navigator.userAgent || '')
  }

  /** macOS 快捷键兼容层是否启用（与剪贴板写中继相互独立）。 */
  function enabled() {
    return inIframe() && isMac() && inElectron()
  }

  /** 向父级（webview）发消息：附带自身身份标记。 */
  function postToHost(payload) {
    payload.source = SELF_ID
    payload.version = PLUGIN_VERSION
    try {
      window.parent.postMessage(payload, '*')
    } catch (e) { /* 父级不可达：静默失败，行为回落到原生实现 */ }
  }

  function stopHello() {
    if (helloTimer !== null && typeof window.clearInterval === 'function') {
      window.clearInterval(helloTimer)
    }
    helloTimer = null
  }

  /** 周期性向宿主打招呼，直到拿到 ack（插件可能在 webview 就绪前后任意时刻加载）。 */
  function startHello() {
    if (!inIframe() || acked) return
    postToHost({ type: 'hello' })
    helloTries += 1
    if (helloTries >= HELLO_MAX_TRIES) return
    if (typeof window.setInterval !== 'function') return
    helloTimer = window.setInterval(function () {
      if (acked || helloTries >= HELLO_MAX_TRIES) { stopHello(); return }
      helloTries += 1
      postToHost({ type: 'hello' })
    }, HELLO_INTERVAL_MS)
  }

  function nextToken() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  /** 结束一次待回执的复制：ok=true 时 resolve，否则 reject。 */
  function settleCopy(token, ok) {
    var entry = pendingCopy[token]
    if (!entry) return
    delete pendingCopy[token]
    if (entry.timer !== null && typeof window.clearTimeout === 'function') {
      window.clearTimeout(entry.timer)
    }
    if (ok) {
      entry.resolve()
    } else {
      var err = new Error('clipboard write was not completed by the host')
      err.code = 'DSH_CLIPBOARD_DENIED'
      entry.reject(err)
    }
  }

  /** 经宿主写入剪贴板；返回 Promise<void>。 */
  function relayWriteText(text) {
    return new Promise(function (resolve, reject) {
      var token = nextToken()
      var entry = { resolve: resolve, reject: reject, timer: null }
      if (typeof window.setTimeout === 'function') {
        entry.timer = window.setTimeout(function () {
          settleCopy(token, false)
        }, COPY_TIMEOUT_MS)
      }
      pendingCopy[token] = entry
      postToHost({ type: 'copy', token: token, text: text })
    })
  }

  /**
   * 包裹 navigator.clipboard.writeText：握手后改走宿主中继；宿主通道失败时回落
   * 原生实现（独立浏览器里原生实现本来就能用，回落可避免中继异常放大故障面）。
   */
  function installWritePatch() {
    if (writePatch !== null) return
    try {
      var clipboard = navigator.clipboard
      if (!clipboard || typeof clipboard.writeText !== 'function') return
      var original = clipboard.writeText
      var patched = function (text) {
        if (!acked) return original.call(clipboard, text)
        var value = String(text)
        return relayWriteText(value).catch(function (err) {
          // 宿主通道不可用（旧版扩展 / 超时 / 明确拒绝）：回落原生实现。
          return original.call(clipboard, text).catch(function () {
            throw err
          })
        })
      }
      try {
        clipboard.writeText = patched
        writePatch = { target: clipboard, key: 'writeText', original: original }
      } catch (e) {
        // 实例属性不可写时，尝试改原型（Chromium 上 writeText 通常在 Clipboard.prototype）。
        var proto = Object.getPrototypeOf(clipboard)
        if (proto && typeof proto.writeText === 'function') {
          proto.writeText = patched
          writePatch = { target: proto, key: 'writeText', original: original }
        }
      }
    } catch (e) { /* 页面不允许改写：放弃，保持原生行为 */ }
  }

  function removeWritePatch() {
    if (writePatch === null) return
    try { writePatch.target[writePatch.key] = writePatch.original } catch (e) { /* ignore */ }
    writePatch = null
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type === 'ack') {
      // 老宿主不带 clipboard 字段：视为支持（v1.1.1 起才有该中继）。
      if (data.clipboard === false) { stopHello(); return }
      acked = true
      stopHello()
      installWritePatch()
      return
    }
    if (data.type === 'clipboard-result' && typeof data.token === 'string') {
      settleCopy(data.token.slice(0, TOKEN_MAX_LENGTH), data.ok === true)
    }
  }

  /** 事件目标是否为可编辑元素（paste 只对它们有意义）。 */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true
    return el.isContentEditable === true
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return                 // 页面自身已处理，尊重之
    if (!enabled()) return
    if (e.isComposing || e.keyCode === 229) return // IME 组合中不干预
    var mod = e.metaKey || e.ctrlKey
    if (!mod || e.altKey || e.shiftKey) return     // 仅裸 ⌘/Ctrl + 字母
    var lower = String(e.key || '').toLowerCase()
    var cmd = null
    if (lower === 'v') cmd = 'paste'
    else if (lower === 'c') cmd = 'copy'
    else if (lower === 'x') cmd = 'cut'
    if (!cmd) return
    if (cmd === 'paste' && !isEditable(e.target)) return
    e.preventDefault()
    try {
      var ok = document.execCommand(cmd)
      if (!ok) console.warn('[dsh-webview-clipboard] execCommand("' + cmd + '") returned false')
    } catch (err) {
      console.warn('[dsh-webview-clipboard] execCommand("' + cmd + '") failed:', err)
    }
  }

  function apply(ctx) {
    function arm() {
      window.addEventListener('keydown', onKeyDown, false)
      window.addEventListener('message', onHostMessage, false)
      startHello()
    }
    function disarm() {
      window.removeEventListener('keydown', onKeyDown, false)
      window.removeEventListener('message', onHostMessage, false)
      stopHello()
      removeWritePatch()
      for (var token in pendingCopy) {
        if (Object.prototype.hasOwnProperty.call(pendingCopy, token)) {
          if (pendingCopy[token].timer !== null && typeof window.clearTimeout === 'function') {
            window.clearTimeout(pendingCopy[token].timer)
          }
          pendingCopy[token].reject(new Error('clipboard plugin disposed'))
        }
      }
      pendingCopy = {}
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 供排障使用：控制台可查 __dshWebviewClipboard
    window.__dshWebviewClipboard = {
      version: PLUGIN_VERSION,
      enabled: enabled(),
      mac: isMac(),
      electron: inElectron(),
      relay: function () { return acked }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
