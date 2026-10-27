'use strict';
/**
 * 内置插件 dsh-vscode-open-external 的回归测试（v1.1.0）。
 * 运行：node test/open-external-plugin.test.js
 *
 * 背景：DSH 的「登录 DeepSeek 账号」由客户端 `BrowserLogin` 驱动：
 *   window.open('about:blank') 预开页 → 拿到 Host 授权链接后 popup.location.replace(url)。
 * 面板把 DSH 以跨源 iframe 内嵌进 VS Code webview，而 webview 不允许新开窗口
 * （window.open 返回 null），于是登录页永远不出现——Remote-WSL / Remote-SSH 里
 * 远端又没有图形浏览器，用户无法登录。
 *
 * 修复：内置插件接管 window.open（只在宿主握手后），把 http(s) 链接经 webview
 * 中继交给扩展宿主 `vscode.env.openExternal`，在**客户端**（如 Windows）浏览器打开；
 * about:blank 预开页返回可导航的桩对象，把后续 replace/assign/href 的跳转目标转交宿主。
 *
 * 覆盖：
 *  1) 插件文件完整性与声明（package.json / cordis.patch.yml / 宿主半身）
 *  2) 客户端逻辑：握手前不接管；ack 后 about:blank 桩对象 + 链接转交 + 非法输入回退
 *  3) webview 中继：ack 携带 openExternal、open 消息转发、边界校验、off 模式仍可登录
 *  4) 扩展宿主：dsh-open-link 只放行 http(s)，调用 vscode.env.openExternal
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');
const os = require('os');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩（宿主侧）──
const openedExternal = [];
const vscodeStub = {
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: path.resolve(p), toString: () => 'file://' + p }),
    joinPath: (base, ...segs) => vscodeStub.Uri.file(path.resolve(base.fsPath, ...segs)),
    parse: (u) => ({ toString: () => u, _url: u })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => d }),
    fs: { stat: async () => ({ type: 1 }) }
  },
  env: {
    remoteName: undefined,
    openExternal: (uri) => { openedExternal.push(String(uri)); return Promise.resolve(true); },
    asExternalUri: async (uri) => uri
  },
  window: { setStatusBarMessage: () => ({ dispose() {} }), showInformationMessage: () => {}, showErrorMessage: () => {}, showWarningMessage: () => {} },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-ext-home-'));
const realHomedir = os.homedir;
os.homedir = () => tmpHome;

const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

const DSH_ORIGIN = 'http://127.0.0.1:3080';
const PLUGIN_SRC_FILE = path.join(__dirname, '..', 'dsh-plugins', 'dsh-vscode-open-external', 'lib', 'client.js');

/** 把插件 client.js 装进一个 vm「DSH 页面域」。 */
function makePageRealm() {
  const parentMessages = [];
  const winListeners = [];
  const intervals = new Map();
  let seq = 1;
  const nativeOpenCalls = [];
  const parent = { postMessage: (payload, origin) => parentMessages.push({ payload, origin }) };

  const win = {
    parent,
    addEventListener: (type, fn) => { winListeners.push({ type, fn }); },
    removeEventListener: () => {},
    setInterval: (fn, ms) => { const id = seq++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { fn(); return 0; },
    open: (...args) => { nativeOpenCalls.push(args); return { native: true }; }
  };
  const modules = [];
  win.__ModuleLoader__ = { load: (def) => modules.push(def) };
  const sandbox = { window: win, document: { addEventListener: () => {}, removeEventListener: () => {} }, console, setTimeout: win.setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PLUGIN_SRC_FILE, 'utf8'), sandbox, { filename: 'open-external-client.js' });

  const disposers = [];
  const applyPlugin = () => {
    const module = { exports: {} };
    const factory = modules[0].factory;
    const out = factory(() => ({}));
    const exportsObj = out || module.exports;
    exportsObj.apply({ effect: (fn) => { disposers.push(fn()); } });
    return exportsObj;
  };
  return {
    win,
    parentMessages,
    nativeOpenCalls,
    moduleId: modules[0] && modules[0].id,
    applyPlugin,
    disposers,
    /** 模拟宿主 → 页面消息。 */
    fromHost: (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? parent : overrides.source
    })),
    runIntervals: () => { for (const v of intervals.values()) v.fn(); }
  };
}

(async function run() {
  console.log('[1] 内置插件文件与声明');
  {
    const files = I.openExternalPluginFiles();
    ok(Object.keys(files).length === 4, '包含 package.json / cordis.patch.yml / lib/index.js / lib/client.js');
    const pkg = JSON.parse(files['package.json']);
    ok(pkg.name === 'dsh-vscode-open-external', 'package.json name 正确');
    ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform = web（浏览器侧插件）');
    ok(pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', '声明 bundle patch 文件');
    ok(/id:\s*vscode-open-external/.test(files['cordis.patch.yml']) && /name:\s*'dsh-vscode-open-external'/.test(files['cordis.patch.yml']), 'cordis.patch.yml 注册行完整');
    ok(/export const name = 'dsh-vscode-open-external'/.test(files['lib/index.js']), '宿主半身导出 name 与包名一致');
    ok(I.OPEN_EXTERNAL_PLUGIN_NAME === 'dsh-vscode-open-external' && I.OPEN_EXTERNAL_PLUGIN_SOURCE === I.OPEN_EXTERNAL_PLUGIN_NAME, '扩展侧常量与插件名一致');
    ok(/__ModuleLoader__\.load\(\{\s*id:\s*'dsh-vscode-open-external'/.test(files['lib/client.js']), 'client bundle 使用 ModuleLoader 格式且 id 正确');
  }

  console.log('[2] 客户端逻辑：握手前不接管');
  {
    const realm = makePageRealm();
    ok(realm.moduleId === 'dsh-vscode-open-external', '注册的模块 id 正确');
    realm.applyPlugin();
    ok(realm.parentMessages.some((m) => m.payload.type === 'hello' && m.payload.source === 'dsh-vscode-open-external'), '加载后向宿主打招呼（hello）');
    realm.win.open('https://example.com/a', '_blank');
    ok(realm.nativeOpenCalls.length === 1 && realm.nativeOpenCalls[0][0] === 'https://example.com/a', '未 ack 前 window.open 走原生实现（不接管）');
  }

  console.log('[3] 客户端逻辑：ack 后接管 about:blank 预开页与 http(s) 链接');
  {
    const realm = makePageRealm();
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, fileLinks: true });
    ok(realm.win.__dshVscodeOpenExternal.acked() === true, 'ack 后进入接管状态');

    // DSH BrowserLogin：先 window.open('about:blank') 预开页
    const popup = realm.win.open('about:blank', '_blank');
    ok(popup && popup.closed === false, 'about:blank 返回可用的桩对象（closed=false）');
    popup.opener = null;
    ok(popup.opener === null, 'opener 可被置空（DSH 会做这一步）');
    ok(typeof popup.location.replace === 'function' && typeof popup.close === 'function', '桩对象提供 location.replace 与 close');

    // 拿到授权链接后 replace → 应转交宿主用系统浏览器打开
    popup.location.replace('https://platform.deepseek.com/authorize?state=abc&client_id=dsh');
    const opens = realm.parentMessages.filter((m) => m.payload.type === 'open');
    ok(opens.length === 1 && opens[0].payload.url === 'https://platform.deepseek.com/authorize?state=abc&client_id=dsh', 'location.replace 的授权链接转交宿主');
    ok(opens[0].payload.source === 'dsh-vscode-open-external', '转交消息带插件身份标记');

    // href 赋值 / assign 同样转交
    popup.location.href = 'https://platform.deepseek.com/authorize?state=def';
    ok(realm.parentMessages.filter((m) => m.payload.type === 'open').length === 2, 'location.href 赋值同样转交');
    popup.close();
    ok(popup.closed === true, 'close() 后 closed=true（DSH 成功路径会关闭预开页）');

    // 直接 window.open(http 链接)：转交并返回 null（等价于弹出被拦截）
    const ret = realm.win.open('https://platform.deepseek.com/account', '_blank', 'noopener');
    ok(ret === null, '直接打开 http(s) 链接返回 null（不再依赖 webview 弹窗）');
    ok(realm.parentMessages.filter((m) => m.payload.type === 'open').length === 3, '直接打开 http(s) 链接也转交宿主');
  }

  console.log('[4] 客户端逻辑：非法输入回退原生行为');
  {
    const realm = makePageRealm();
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true });
    realm.win.open('mailto:a@b.com');
    ok(realm.nativeOpenCalls.length === 1 && realm.nativeOpenCalls[0][0] === 'mailto:a@b.com', '非 http(s) scheme 回退原生');
    realm.win.open('javascript:alert(1)');
    ok(realm.nativeOpenCalls.length === 2, 'javascript: 回退原生（不转交宿主）');
    realm.win.open('https://example.com/' + 'x'.repeat(9000));
    ok(realm.nativeOpenCalls.length === 3, '超长链接回退原生');
    ok(realm.parentMessages.filter((m) => m.payload.type === 'open').length === 0, '以上均未转交宿主');
    // 非本宿主来源的 ack 不认
    const realm2 = makePageRealm();
    realm2.applyPlugin();
    realm2.fromHost({ source: 'evil-host', type: 'ack', openExternal: true });
    realm2.win.open('https://example.com/a');
    ok(realm2.nativeOpenCalls.length === 1, '非本宿主 ack 不接管');
    // ack 缺少 openExternal 标记时不接管
    const realm3 = makePageRealm();
    realm3.applyPlugin();
    realm3.fromHost({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true });
    realm3.win.open('https://example.com/a');
    ok(realm3.nativeOpenCalls.length === 1, '无 openExternal 标记的 ack 不接管');
  }

  console.log('[5] webview 中继：ack 与 open 转发');
  {
    const html = I.buildIframeHtml(DSH_ORIGIN, 1, 'revealAndOpen');
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];
    const frameMessages = [];
    const toHost = [];
    const loadHandlers = [];
    const winListeners = [];
    const timers = [];
    let timerSeq = 1;
    const frameWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
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

    const fromPlugin = (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? frameWindow : overrides.source,
      origin: overrides.origin === undefined ? DSH_ORIGIN : overrides.origin
    }));
    const fireLoad = () => loadHandlers.forEach((fn) => fn());

    fireLoad();
    const acks = frameMessages.filter((m) => m.payload.type === 'ack');
    ok(acks.length >= 1 && acks[0].payload.openExternal === true, 'iframe load 的 ack 携带 openExternal=true');
    ok(acks[0].payload.fileLinks === true && acks[0].origin === DSH_ORIGIN, '既有 fileLinks 语义与精确 origin 保持不变');

    fromPlugin({ source: 'dsh-vscode-open-external', type: 'hello' });
    ok(frameMessages.filter((m) => m.payload.type === 'ack').length >= 2, '外链插件 hello 也会收到 ack');

    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://platform.deepseek.com/authorize?state=x' });
    ok(toHost.length === 1 && toHost[0].type === 'dsh-open-link' && toHost[0].url === 'https://platform.deepseek.com/authorize?state=x', 'open 消息转发为宿主的 dsh-open-link');

    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'javascript:alert(1)' });
    ok(toHost.length === 1, '非 http(s) 链接被拒绝');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://x.test/' + 'y'.repeat(9000) });
    ok(toHost.length === 1, '超长链接被拒绝');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://evil.test/a' }, { origin: 'http://evil.example.com' });
    ok(toHost.length === 1, 'origin 不符的 open 被丢弃');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://evil.test/a' }, { source: { evil: true } });
    ok(toHost.length === 1, 'source 不是本 iframe 的 open 被丢弃');
    fromPlugin({ source: 'other', type: 'open', url: 'https://evil.test/a' });
    ok(toHost.length === 1, '其它插件 source 的 open 被丢弃');
  }

  console.log('[6] webview 中继：文件链接 off 时仍允许登录链接');
  {
    const html = I.buildIframeHtml(DSH_ORIGIN, 1, 'off');
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];
    const frameMessages = [];
    const toHost = [];
    const loadHandlers = [];
    const winListeners = [];
    const frameWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
    const frame = { contentWindow: frameWindow, style: {}, addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); } };
    const win = {
      addEventListener: (type, fn) => winListeners.push({ type, fn }),
      removeEventListener: () => {},
      setTimeout: (fn) => { fn(); return 1; },
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
    loadHandlers.forEach((fn) => fn());
    const ack = frameMessages.filter((m) => m.payload.type === 'ack')[0];
    ok(ack && ack.payload.fileLinks === false, 'off 模式的 ack 明确 fileLinks=false（文件链接插件保持惰性）');
    ok(ack && ack.payload.openExternal === true, 'off 模式的 ack 仍允许外链/登录链接');
    winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data: { source: 'dsh-vscode-open-external', type: 'open', url: 'https://platform.deepseek.com/authorize' },
      source: frameWindow,
      origin: DSH_ORIGIN
    }));
    ok(toHost.length === 1 && toHost[0].type === 'dsh-open-link', 'off 模式仍转发登录链接');
  }

  console.log('[7] 扩展宿主：dsh-open-link 只放行 http(s) 并打开系统浏览器');
  {
    openedExternal.length = 0;
    const wv = { postMessage: () => {} };
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://platform.deepseek.com/authorize?state=abc' }, wv);
    ok(openedExternal.length === 1 && openedExternal[0] === 'https://platform.deepseek.com/authorize?state=abc', 'http(s) 链接调用 vscode.env.openExternal');
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'javascript:alert(1)' }, wv);
    ok(openedExternal.length === 1, '非 http(s) 链接被拒绝');
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'file:///etc/passwd' }, wv);
    ok(openedExternal.length === 1, 'file: 链接被拒绝');
    I.handleWebviewMessage({ type: 'dsh-open-link' }, wv);
    I.handleWebviewMessage(null, wv);
    ok(openedExternal.length === 1, '缺失 url / 空消息安全忽略');
  }

  const disposers = [];
  for (const p of []) { if (typeof p === 'function') disposers.push(p()); }
  os.homedir = realHomedir;
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  os.homedir = realHomedir;
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
