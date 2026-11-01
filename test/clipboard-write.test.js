'use strict';
/**
 * 剪贴板写中继回归测试（v1.1.1 / dsh-webview-clipboard 0.3.0）。
 * 运行：node test/clipboard-write.test.js
 *
 * 背景（Issue #28）：面板以跨源 iframe 嵌入 DSH 页面，VS Code 的 Electron 权限
 * 处理器只对 requestingUrl 以 vscode-webview:// 开头的请求放行 clipboard-*，
 * iframe（http://127.0.0.1:<port>）的 navigator.clipboard.writeText 一律被拒
 * （microsoft/vscode#182642 仍 open）；而 DSH 前端复制工具在被拒时静默返回 false，
 * 复制按钮因此毫无反应。
 *
 * 修复：内置插件 dsh-webview-clipboard 在宿主握手后包裹 writeText，把文本经
 * webview 中继交给扩展宿主 vscode.env.clipboard.writeText，结果沿原路返回。
 *
 * 覆盖：
 *  [1] 客户端插件：握手前不接管；ack 后中继；ok/失败/超时；回落原生
 *  [2] webview 中继：ack 携带 clipboard;：copy 转发、结果回传、边界与来源校验
 *  [3] 扩展宿主：写入剪贴板并回执 ok/失败；空/超长/异常输入拒绝
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩（宿主侧；env.clipboard.writeText 可切换行为）──
const clipboardWrites = [];
let clipboardMode = 'ok'; // 'ok' | 'fail'
const vscodeStub = {
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: path.resolve(p), toString: () => 'file://' + p }),
    joinPath: (base, ...segs) => vscodeStub.Uri.file(path.resolve(base.fsPath, ...segs)),
    parse: (u) => ({ toString: () => u })
  },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, d) => d }), fs: { stat: async () => ({ type: 1 }) } },
  env: {
    remoteName: undefined,
    openExternal: () => {},
    asExternalUri: async (u) => u,
    clipboard: {
      writeText: (text) => {
        clipboardWrites.push(text);
        return clipboardMode === 'ok' ? Promise.resolve() : Promise.reject(new Error('clipboard denied'));
      }
    }
  },
  window: { setStatusBarMessage: () => ({ dispose() {} }), showInformationMessage: () => {}, showErrorMessage: () => {}, showWarningMessage: () => {} },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;
const DSH_ORIGIN = 'http://127.0.0.1:3080';
const CLIENT_JS = I.clipboardPluginFiles()['lib/client.js'];

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 把插件 client.js 装进一个「DSH 页面域」，暴露可控的宿主消息与定时器。 */
function makePageRealm(opts = {}) {
  const iframe = opts.iframe !== false;
  const hasClipboard = opts.clipboard !== false;
  const mac = opts.mac === true;
  const parentMessages = [];
  const listeners = {};
  const timers = [];
  let timerSeq = 1;
  const nativeWrites = [];

  const parent = { postMessage: (payload, origin) => parentMessages.push({ payload, origin }) };
  const win = {
    parent: iframe ? parent : null,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    setInterval: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms, interval: true }); return id; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: () => {},
    __ModuleLoader__: null
  };
  if (!iframe) win.parent = win;
  const nav = {
    userAgent: 'Mozilla/5.0 (' + (mac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0') + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Electron/28.0.0',
    platform: mac ? 'MacIntel' : 'Win32',
    userAgentData: undefined
  };
  if (hasClipboard) {
    nav.clipboard = {
      writeText: (text) => {
        nativeWrites.push(text);
        return Promise.resolve();
      }
    };
  }
  const doc = { execCommand: () => true, addEventListener: () => {} };
  win.__ModuleLoader__ = { load: ({ factory }) => { const mod = factory(() => ({})); mod.apply(); } };
  new Function('window', 'navigator', 'document', CLIENT_JS)(win, nav, doc);

  const dispatchFromHost = (data, source) => {
    const ev = { data, source: source === undefined ? win.parent : source };
    (listeners['message'] || []).forEach((fn) => fn(ev));
  };
  return {
    win, nav, parentMessages, nativeWrites, timers, dispatchFromHost,
    runTimers: () => { timers.splice(0).forEach((t) => t.fn()); },
    state: () => win.__dshWebviewClipboard
  };
}

async function run() {
  console.log('[1] 客户端插件：握手前不接管 writeText');
  {
    const realm = makePageRealm();
    ok(realm.state() && realm.state().version === '0.3.0', '版本 0.3.0');
    ok(realm.parentMessages.some((m) => m.payload.type === 'hello'), '加载后向宿主打招呼');
    await realm.nav.clipboard.writeText('before-ack');
    ok(realm.nativeWrites.length === 1 && realm.nativeWrites[0] === 'before-ack', '未 ack 前 writeText 走原生实现');
    ok(realm.parentMessages.every((m) => m.payload.type !== 'copy'), '未 ack 前不产生中继请求');
  }

  console.log('[2] 客户端插件：ack 后 writeText 经宿主中继');
  {
    const realm = makePageRealm();
    realm.dispatchFromHost({ source: 'dsh-vscode-host', type: 'ack', clipboard: true, fileLinks: true, openExternal: true });
    ok(realm.state().relay() === true, 'ack 后进入中继状态');

    const p = realm.nav.clipboard.writeText('hello 世界');
    const copies = realm.parentMessages.filter((m) => m.payload.type === 'copy');
    ok(copies.length === 1, 'writeText 产生一条 copy 中继请求');
    ok(copies[0].payload.text === 'hello 世界' && copies[0].payload.source === 'dsh-webview-clipboard', '中继请求带文本与插件身份');
    ok(typeof copies[0].payload.token === 'string' && copies[0].payload.token.length > 0, '请求带 token');
    ok(realm.nativeWrites.length === 0, '中继路径不写原生剪贴板');

    realm.dispatchFromHost({ source: 'dsh-vscode-host', type: 'clipboard-result', token: copies[0].payload.token, ok: true });
    await p;
    ok(true, '宿主回执 ok=true → Promise resolve（复制按钮可切成 ✓）');
  }

  console.log('[3] 客户端插件：宿主明确失败 → 回落原生实现');
  {
    const realm = makePageRealm();
    realm.dispatchFromHost({ source: 'dsh-vscode-host', type: 'ack', clipboard: true });
    const p = realm.nav.clipboard.writeText('fallback');
    const token = realm.parentMessages.filter((m) => m.payload.type === 'copy')[0].payload.token;
    realm.dispatchFromHost({ source: 'dsh-vscode-host', type: 'clipboard-result', token, ok: false });
    await p;
    ok(realm.nativeWrites.length === 1 && realm.nativeWrites[0] === 'fallback', '失败后回落原生 writeText');
  }

  console.log('[4] 客户端插件：宿主无响应（超时）→ 回落原生实现');
  {
    const realm = makePageRealm();
    realm.dispatchFromHost({ source: 'dsh-vscode-host', type: 'ack', clipboard: true });
    const p = realm.nav.clipboard.writeText('timeout');
    ok(realm.parentMessages.filter((m) => m.payload.type === 'copy').length === 1, '超时前已发出中继请求');
    realm.runTimers(); // 触发 COPY_TIMEOUT_MS 回调
    await p;
    ok(realm.nativeWrites.length === 1 && realm.nativeWrites[0] === 'timeout', '超时后回落原生 writeText');
  }

  console.log('[5] 客户端插件：不满足条件时保持原生行为');
  {
    const winRealm = makePageRealm({ mac: false });
    winRealm.dispatchFromHost({ source: 'dsh-vscode-host', type: 'ack', clipboard: false });
    await winRealm.nav.clipboard.writeText('x');
    ok(winRealm.nativeWrites.length === 1, 'ack 带 clipboard=false 时不接管');
    const browserRealm = makePageRealm({ iframe: false });
    ok(browserRealm.state().enabled === false, '顶层浏览器：不激活');
    ok(browserRealm.parentMessages.length === 0, '顶层浏览器：不打招呼、不中继');
    const noClip = makePageRealm({ clipboard: false });
    let threw = false;
    try { noClip.dispatchFromHost({ source: 'dsh-vscode-host', type: 'ack', clipboard: true }); } catch (e) { threw = true; }
    ok(!threw, '页面没有 navigator.clipboard 时不报错（放弃包裹）');
    // 伪造宿主 ack（source 不符）不触发包裹
    const spoof = makePageRealm();
    spoof.dispatchFromHost({ source: 'dsh-vscode-host', type: 'ack', clipboard: true }, { postMessage: () => {} });
    await spoof.nav.clipboard.writeText('spoof');
    ok(spoof.nativeWrites.length === 1, '非本宿主来源的 ack 不接管');
  }

  console.log('[6] webview 中继：ack 与 copy 转发');
  {
    const relay = makeRelayRealm('http://127.0.0.1:3080', 'revealAndOpen');
    relay.fireLoad();
    const acks = relay.frameMessages.filter((m) => m.payload.type === 'ack');
    ok(acks.length >= 1 && acks[0].payload.clipboard === true, 'iframe load 的 ack 携带 clipboard=true');
    ok(acks[0].payload.openExternal === true && acks[0].payload.fileLinks === true, '既有 ack 字段保持不变');

    relay.fromPlugin({ source: 'dsh-webview-clipboard', type: 'hello' });
    ok(relay.frameMessages.filter((m) => m.payload.type === 'ack').length >= 2, '剪贴板插件 hello 也会收到 ack');

    relay.fromPlugin({ source: 'dsh-webview-clipboard', type: 'copy', token: 't1', text: '复制内容' });
    ok(relay.toHost.length === 1 && relay.toHost[0].type === 'dsh-clipboard-write' && relay.toHost[0].token === 't1' && relay.toHost[0].text === '复制内容', 'copy 转发为宿主的 dsh-clipboard-write');

    relay.fromPlugin({ source: 'dsh-webview-clipboard', type: 'copy', token: 't2', text: 'x' }, { origin: 'http://evil.example.com' });
    ok(relay.toHost.length === 1, 'origin 不符的 copy 被丢弃');
    relay.fromPlugin({ source: 'dsh-webview-clipboard', type: 'copy', token: 't3', text: 'x' }, { source: { evil: true } });
    ok(relay.toHost.length === 1, 'source 不是本 iframe 的 copy 被丢弃');
    relay.fromPlugin({ source: 'dsh-webview-clipboard', type: 'copy', token: 't4' });
    ok(relay.toHost.length === 1, '缺少 text 的 copy 被丢弃');
    relay.fromPlugin({ source: 'other-plugin', type: 'copy', token: 't5', text: 'x' });
    ok(relay.toHost.length === 1, '其它插件 source 的 copy 被丢弃');

    // 宿主回执 → 页面
    const before = relay.frameMessages.length;
    relay.fromHost({ type: 'dsh-clipboard-result', token: 't1', ok: true });
    const results = relay.frameMessages.slice(before).filter((m) => m.payload.type === 'clipboard-result');
    ok(results.length === 1 && results[0].payload.token === 't1' && results[0].payload.ok === true, '宿主回执转发回 DSH 页面');
    relay.fromHost({ type: 'dsh-clipboard-result', token: 't2', ok: false });
    ok(relay.frameMessages.filter((m) => m.payload.type === 'clipboard-result').length >= 2, '失败回执同样转发');

    // 超长文本在 webview 中继处截断到 4 MiB（宿主侧还会再校验一次）
    relay.fromPlugin({ source: 'dsh-webview-clipboard', type: 'copy', token: 't6', text: 'y'.repeat(4 * 1024 * 1024 + 5) });
    const big = relay.toHost[relay.toHost.length - 1];
    ok(big && big.type === 'dsh-clipboard-write' && big.text.length === 4 * 1024 * 1024, '超长文本在 webview 中继处截断到 4 MiB');
  }

  console.log('[7] 扩展宿主：写入剪贴板并回执');
  {
    clipboardWrites.length = 0;
    clipboardMode = 'ok';
    const messages = [];
    const webview = { postMessage: (m) => messages.push(m) };
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'host-1', text: 'code block' }, webview);
    await flush();
    ok(clipboardWrites.length === 1 && clipboardWrites[0] === 'code block', 'vscode.env.clipboard.writeText 收到文本');
    ok(messages.some((m) => m.type === 'dsh-clipboard-result' && m.token === 'host-1' && m.ok === true), '成功回执 ok=true');

    clipboardMode = 'fail';
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'host-2', text: 'x' }, webview);
    await flush();
    ok(messages.some((m) => m.type === 'dsh-clipboard-result' && m.token === 'host-2' && m.ok === false), '写入失败回执 ok=false');

    clipboardMode = 'ok';
    clipboardWrites.length = 0;
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: '', text: 'x' }, webview);
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'host-3', text: '' }, webview);
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'host-4', text: 'z'.repeat(4 * 1024 * 1024 + 1) }, webview);
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'host-5' }, webview);
    I.handleWebviewMessage(null, webview);
    await flush();
    ok(clipboardWrites.length === 0, '空 token / 空文本 / 超长 / 缺字段 / 空消息均不写剪贴板');
    const rejected = messages.filter((m) => m.type === 'dsh-clipboard-result' && m.ok === false);
    ok(rejected.length >= 3, '被拒绝的请求也回执 ok=false（页面不会挂起）');

    // webview 已销毁时不抛异常
    let threw = false;
    try { I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'host-6', text: 'ok' }); } catch (e) { threw = true; }
    await flush();
    ok(!threw, 'webview 缺失时不抛异常');
  }

  console.log('[8] 普通浏览器 / 顶层页面：插件不激活、不改写 writeText');
  {
    const realm = makePageRealm({ iframe: false });
    await realm.nav.clipboard.writeText('top');
    ok(realm.nativeWrites.length === 1 && realm.parentMessages.length === 0, '顶层页面 writeText 保持原生');
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
}

/** 构造一个 webview 中继脚本沙箱（与其它桥接测试同构）。 */
function makeRelayRealm(origin, mode) {
  const html = I.buildIframeHtml(origin, 1, mode);
  const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];
  const frameMessages = [];
  const toHost = [];
  const loadHandlers = [];
  const winListeners = [];
  const timers = [];
  let timerSeq = 1;
  const frameWindow = { postMessage: (payload, origin2) => frameMessages.push({ payload, origin: origin2 }) };
  const frame = { contentWindow: frameWindow, style: {}, addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); } };
  const win = {
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: () => {},
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: () => {}
  };
  const sandbox = {
    window: win,
    document: { getElementById: (id) => (id === 'dsh-frame' ? frame : null) },
    acquireVsCodeApi: () => ({ postMessage: (m) => toHost.push(m) }),
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'iframe-relay.js' });
  return {
    frameMessages,
    toHost,
    frameWindow,
    fireLoad: () => loadHandlers.forEach((fn) => fn()),
    fromPlugin: (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? frameWindow : overrides.source,
      origin: overrides.origin === undefined ? origin : overrides.origin
    })),
    fromHost: (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({ data }))
  };
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

void assert;
void fs;
