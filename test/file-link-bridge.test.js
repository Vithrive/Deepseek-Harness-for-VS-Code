'use strict';
/**
 * 工作区文件链接「桥」的协议集成测试（webview 中继脚本 ⇄ 扩展宿主）。
 * 运行：node test/file-link-bridge.test.js
 *
 * 用 vm 把 buildIframeHtml 生成的内联中继脚本真跑起来，验证三级链路的消息协议：
 *   DSH 页面内插件 → webview 中继 → 扩展宿主（revealInExplorer/打开）→ 回执 → 插件。
 * 覆盖：握手 ack、reveal 转发、回执回传、origin/source 校验、off 模式不转发、
 * 既有 dsh-open-link / insert-selection 中继不受影响。
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

// ── vscode 桩（宿主侧）──
const executed = [];
const statusMessages = [];
const vscodeStub = {
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: path.resolve(p), toString: () => 'file://' + p }),
    joinPath: (base, ...segs) => vscodeStub.Uri.file(path.resolve(base.fsPath, ...segs)),
    parse: (u) => ({ toString: () => u })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => d }),
    fs: {
      stat: async (uri) => {
        const st = await fs.promises.stat(uri.fsPath);
        return { type: st.isDirectory() ? vscodeStub.FileType.Directory : vscodeStub.FileType.File };
      }
    }
  },
  env: { openExternal: () => {} },
  window: {
    setStatusBarMessage: (t) => { statusMessages.push(t); return { dispose() {} }; },
    showInformationMessage: () => {}, showErrorMessage: () => {}, showWarningMessage: () => {}
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async (...a) => { executed.push(a); } }
};
const origLoad = Module._load;
vscodeStub.workspace.workspaceFolders = [{ uri: vscodeStub.Uri.file(path.resolve(__dirname, '..')) }];
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

const DSH_ORIGIN = 'http://127.0.0.1:3080';

/** 把面板内联中继脚本装进一个 vm「webview 域」。 */
function makeWebviewRealm(mode) {
  const html = I.buildIframeHtml(DSH_ORIGIN, 1, mode);
  const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];

  const frameMessages = [];   // webview → iframe
  const toHost = [];          // webview → 扩展宿主（acquireVsCodeApi().postMessage）
  const loadHandlers = [];
  const winListeners = [];
  const timers = [];
  let timerSeq = 1;

  const frameWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
  const frame = {
    contentWindow: frameWindow,
    style: {},
    addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); }
  };
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
    // 中继脚本用裸 setTimeout/clearTimeout 排 ack 重试：这里接到可控定时器队列上。
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
    /** 模拟 iframe 触发 load（DSH 页面加载完成）。 */
    fireLoad: () => loadHandlers.forEach((fn) => fn()),
    runTimers: () => { for (const t of timers.splice(0)) t.fn(); },
    /** 模拟「某个窗口」向 webview 投递消息。 */
    receive: (event) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn(event)),
    /** 模拟扩展宿主 → webview 的消息。 */
    fromHost: (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({ data, origin: 'vscode-webview://x', source: null })),
    /** 模拟 DSH 页面内插件 → webview 的消息（默认来源/来源 origin 都正确）。 */
    fromPlugin: (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? frameWindow : overrides.source,
      origin: overrides.origin === undefined ? DSH_ORIGIN : overrides.origin
    }))
  };
}

(async function run() {
  console.log('[1] 握手：iframe 加载 → ack 到 DSH 页面');
  {
    const wv = makeWebviewRealm('revealAndOpen');
    wv.fireLoad();
    const acks = wv.frameMessages.filter((m) => m.payload.type === 'ack');
    ok(acks.length >= 1, 'iframe load 后发出 ack');
    ok(acks[0].payload.source === 'dsh-vscode-host' && acks[0].payload.fileLinks === true && acks[0].payload.mode === 'revealAndOpen', 'ack 携带宿主标识与模式');
    ok(acks.every((m) => m.origin === DSH_ORIGIN), 'ack 使用精确 targetOrigin（非 *）');
    wv.receive({}); wv.fromHost(null); // 边界输入不抛错
    ok(true, '空消息安全忽略');
    const hello = { source: 'dsh-vscode-file-links', type: 'hello', version: '0.1.0' };
    wv.fromPlugin(hello);
    ok(wv.frameMessages.filter((m) => m.payload.type === 'ack').length >= 2, '收到 hello 也会补发 ack（插件后加载时也能连上）');
  }

  console.log('[2] reveal 全链路：插件点击 → 宿主定位/打开 → 回执回传');
  {
    const wv = makeWebviewRealm('revealAndOpen');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'reveal', token: 'tok-1', path: 'package.json' });
    ok(wv.toHost.length === 1 && wv.toHost[0].type === 'dsh-reveal-path' && wv.toHost[0].path === 'package.json' && wv.toHost[0].token === 'tok-1', 'webview 把 reveal 转发给扩展宿主');
    ok(wv.frameMessages.length === 0, '此时还没有回执');

    const hostWebview = { postMessage: (m) => wv.fromHost(m) };
    executed.length = 0;
    I.handleWebviewMessage(wv.toHost[0], hostWebview);
    await new Promise((r) => setTimeout(r, 200));
    ok(executed.length === 2 && executed[0][0] === 'revealInExplorer' && executed[1][0] === 'vscode.open', '扩展宿主执行 revealInExplorer + vscode.open');
    const results = wv.frameMessages.filter((m) => m.payload.type === 'reveal-result');
    ok(results.length === 1 && results[0].payload.token === 'tok-1' && results[0].payload.ok === true, '回执经 webview 转发回 DSH 页面（ok=true）');
    ok(results[0].origin === DSH_ORIGIN, '回执同样用精确 targetOrigin');
  }

  console.log('[3] 失败回执：目标不在工作区 → ok=false（插件据此回放）');
  {
    const wv = makeWebviewRealm('revealAndOpen');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'reveal', token: 'tok-2', path: '不存在的/文件.xyz' });
    const hostWebview = { postMessage: (m) => wv.fromHost(m) };
    executed.length = 0;
    I.handleWebviewMessage(wv.toHost[0], hostWebview);
    await new Promise((r) => setTimeout(r, 200));
    ok(executed.length === 0, '未命中不执行任何命令');
    const result = wv.frameMessages.filter((m) => m.payload.type === 'reveal-result')[0];
    ok(result && result.payload.ok === false, '回执 ok=false');
  }

  console.log('[4] 中继的边界校验');
  {
    const wv = makeWebviewRealm('revealAndOpen');
    const reveal = { source: 'dsh-vscode-file-links', type: 'reveal', token: 't', path: 'package.json' };
    wv.fromPlugin(reveal, { origin: 'http://evil.example.com' });
    ok(wv.toHost.length === 0, 'origin 不符的消息被丢弃');
    wv.fromPlugin(reveal, { source: { evil: true } });
    ok(wv.toHost.length === 0, 'source 不是本 iframe 的消息被丢弃');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'reveal', token: 't' });
    ok(wv.toHost.length === 0, '缺 path 的 reveal 被丢弃');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'reveal', path: 'a.ts' });
    ok(wv.toHost.length === 0, '缺 token 的 reveal 被丢弃');
    wv.fromPlugin({ source: 'other-plugin', type: 'reveal', token: 't', path: 'a.ts' });
    ok(wv.toHost.length === 0, '非本插件 source 的消息被丢弃');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'reveal', token: 'x'.repeat(200), path: 'y'.repeat(9000) });
    ok(wv.toHost.length === 1 && wv.toHost[0].token.length <= 64 && wv.toHost[0].path.length <= 4096, '超长 token/path 被截断（不放大到宿主）');
  }

  console.log('[5] off 模式：只做环境标记，不握手不转发');
  {
    const wv = makeWebviewRealm('off');
    wv.fireLoad();
    ok(wv.frameMessages.length === 0, 'off 模式不发 ack（DSH 页面内插件保持惰性）');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'reveal', token: 't', path: 'package.json' });
    ok(wv.toHost.length === 0, 'off 模式不把 reveal 转发给宿主');
  }

  console.log('[6] 既有中继未被破坏');
  {
    const wv = makeWebviewRealm('revealAndOpen');
    // 外链：DSH 页面 → webview → 宿主
    wv.receive({ data: { type: 'dsh-open-link', url: 'https://example.com/x' }, origin: DSH_ORIGIN, source: wv.frameWindow });
    ok(wv.toHost.some((m) => m.type === 'dsh-open-link' && m.url === 'https://example.com/x'), '外链点击仍转发给宿主');
    wv.receive({ data: { type: 'dsh-open-link', url: 'javascript:alert(1)' }, origin: DSH_ORIGIN, source: wv.frameWindow });
    ok(wv.toHost.filter((m) => m.type === 'dsh-open-link').length === 1, '非 http(s) 外链仍被拒绝');
    // 缩放：宿主 → webview
    const before = wv.frameMessages.length;
    wv.fromHost({ type: 'dsh-font-scale', scale: 1.2 });
    ok(wv.frameMessages.length === before, '字号消息只作用于 iframe 样式（不产生额外消息）');
    // 选中内容：宿主 → iframe
    wv.fromHost({ type: 'insert-selection', filePath: 'a.ts', content: 'x', startLine: 1, endLine: 1, language: 'ts' });
    ok(wv.frameMessages.some((m) => m.payload.type === 'insert-selection'), '发送选中内容仍然转发进 iframe');
    ok(wv.toHost.some((m) => m.type === 'insert-selection-ack' && m.status === 'forwarded'), '发送选中内容回执仍然正常');
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
