// dsh-vscode-open-external client bundle (ModuleLoader format)
//
// 作用：DSH 页面被 Deepseek-Harness-for-VS-Code 扩展以跨源 iframe 内嵌时，
// 页面里的 window.open 打不开真正的浏览器窗口（VS Code webview 不允许新开窗口）。
// DSH 的「登录 DeepSeek 账号」正是这个路径（packages/client/ui-settings-account 的
// BrowserLogin：先 window.open('about:blank') 预开页，拿到授权链接后再 replace 过去），
// 于是登录流程会卡在「没有自动打开新页面？」。
//
// 链路：本插件接管 window.open → 授权链接经 window.parent.postMessage 交给 webview
//       中继 → 扩展宿主 vscode.env.openExternal → **客户端**（WSL/Remote 场景即
//       Windows 本机）的默认浏览器打开授权页；登录回调地址是 DSH 所在机器的回环
//       地址，Windows 经 WSL localhost 转发可达，登录完成后面板自动刷新为已登录。
//
// 三条底线：
// 1. 只在宿主完成握手（ack）后接管；独立浏览器 / 其它宿主里完全不介入；
// 2. 只转交 http/https 链接（超长、非法 scheme 一律回退原生行为）；
// 3. about:blank 预开页返回一个可导航的桩对象，把后续 location.replace/assign/href
//    的跳转目标转交宿主——与 DSH 官方 BrowserLogin 的用法一一对应。

window.__ModuleLoader__.load({ id: 'dsh-vscode-open-external', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.1.0'
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-vscode-open-external'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  var URL_MAX_LENGTH = 8192
  var pendingPopup = null

  var acked = false
  var helloTimer = null
  var helloTries = 0
  var originalOpen = null
  var patched = false

  /** 是否被宿主内嵌（独立浏览器里 parent === self）。 */
  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  /** 向父级（webview）发消息：附带自身身份标记。 */
  function postToHost(payload) {
    payload.source = SELF_ID
    payload.version = PLUGIN_VERSION
    try {
      window.parent.postMessage(payload, '*')
    } catch (e) { /* 父级不可达：静默失败 */ }
  }

  function stopHello() {
    if (helloTimer !== null) {
      window.clearInterval(helloTimer)
      helloTimer = null
    }
  }

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

  /** 把链接交给宿主（系统浏览器）。非 http/https 或超长链接返回 false。 */
  function handOff(url) {
    if (typeof url !== 'string') return false
    var u = url.trim()
    if (u.length === 0 || u.length > URL_MAX_LENGTH) return false
    if (!/^https?:\/\//i.test(u)) return false
    postToHost({ type: 'open', url: u })
    return true
  }

  /**
   * DSH 登录流程先 window.open('about:blank') 预开页，拿到授权链接后再
   * popup.location.replace(url)。这里返回可导航的桩对象，把跳转目标转交宿主；
   * popup.closed / close() / opener 等常见访问保持可用，避免 DSH 逻辑报错。
   */
  function makePopupStub() {
    var stub = {
      closed: false,
      opener: null,
      focus: function () {},
      blur: function () {},
      postMessage: function () {},
      close: function () { stub.closed = true }
    }
    function navigate(target) {
      if (handOff(target)) pendingPopup = null
    }
    stub.location = {
      replace: navigate,
      assign: navigate,
      reload: function () {},
      toString: function () { return 'about:blank' },
      get href() { return 'about:blank' },
      set href(target) { navigate(target) },
      get origin() { return 'null' }
    }
    pendingPopup = stub
    return stub
  }

  function isAboutBlank(value) {
    return value === '' || value === 'about:blank'
  }

  function patchedOpen(url, target, features) {
    try {
      if (acked) {
        var raw = typeof url === 'string' ? url : ''
        if (isAboutBlank(raw)) {
          return makePopupStub()
        }
        if (handOff(raw)) return null
      }
    } catch (e) { /* 任何异常都回退原生行为 */ }
    return originalOpen.apply(window, arguments)
  }

  function installPatch() {
    if (patched) return
    originalOpen = window.open
    try {
      window.open = patchedOpen
      patched = true
    } catch (e) {
      originalOpen = null
    }
  }

  function removePatch() {
    if (!patched) return
    try { window.open = originalOpen } catch (e) { /* 页面正在卸载：忽略 */ }
    patched = false
    originalOpen = null
    pendingPopup = null
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type === 'ack' && data.openExternal === true) {
      acked = true
      stopHello()
      installPatch()
    }
  }

  function apply(ctx) {
    function arm() {
      window.addEventListener('message', onHostMessage, false)
      startHello()
    }
    function disarm() {
      window.removeEventListener('message', onHostMessage, false)
      stopHello()
      removePatch()
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 供排障使用：控制台可查 __dshVscodeOpenExternal.acked()
    window.__dshVscodeOpenExternal = {
      version: PLUGIN_VERSION,
      acked: function () { return acked }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
