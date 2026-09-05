'use strict';
/**
 * macOS 操作方式仿真测试：以 macOS UA + Electron + iframe 环境驱动
 * dsh-webview-clipboard 0.2.1 的 onKeyDown，逐键核对行为（PR #14 收敛后）。
 * 运行：node test/macos-keysim.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), workspaceFolders: [] },
  env: { remoteName: undefined },
  window: {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const { clipboardPluginFiles } = require(path.join(__dirname, '..', 'extension.js')).__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

/** 构造一个 macOS + Electron + iframe 的页面沙箱，装载生成的 client.js。 */
function makeSandbox({ mac = true, electron = true, iframe = true } = {}) {
  const ua = 'Mozilla/5.0 (' + (mac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0') + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' + (electron ? ' Electron/28.0.0' : '');
  const listeners = {};
  const execCalls = [];
  let execResult = true;
  const win = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    parent: iframe ? {} : null // 顶层窗口在真实浏览器中 parent === window（自引用）
  };
  if (!iframe) win.parent = win;
  win.__ModuleLoader__ = {
    load: ({ factory }) => {
      const mod = factory(function () { throw new Error('client.js 不应 require 宿主模块'); });
      mod.apply();
    }
  };
  const nav = { userAgent: ua, platform: mac ? 'MacIntel' : 'Win32', userAgentData: undefined };
  const doc = {
    execCommand: (cmd) => { execCalls.push(cmd); return execResult; },
    addEventListener: () => {}
  };
  const code = clipboardPluginFiles()['lib/client.js'];
  new Function('window', 'navigator', 'document', code)(win, nav, doc);
  const keydown = listeners['keydown'][0];
  return {
    keydown, execCalls,
    setExecResult: (v) => { execResult = v; },
    state: () => win.__dshWebviewClipboard
  };
}

/** 合成 KeyboardEvent。 */
function makeEvent(target, opts) {
  const o = opts || {};
  const ev = { target, key: o.key || '', metaKey: !!o.metaKey, ctrlKey: !!o.ctrlKey, altKey: !!o.altKey, shiftKey: !!o.shiftKey, isComposing: !!o.isComposing, keyCode: o.keyCode || 0, defaultPrevented: !!o.defaultPrevented, preventDefaultCount: 0 };
  ev.preventDefault = () => { ev.preventDefaultCount += 1; ev.defaultPrevented = true; };
  return ev;
}
const textarea = () => ({ nodeType: 1, tagName: 'TEXTAREA', isContentEditable: false, value: 'hello 世界', selectionStart: 5, selectionEnd: 5 });
const richtext = () => ({ nodeType: 1, tagName: 'DIV', isContentEditable: true }); // 故意不给 value（contentEditable 无此属性）

console.log('[1] macOS · 可编辑元素（textarea）');
{
  const sb = makeSandbox();
  ok(sb.state().enabled === true && sb.state().mac === true, '激活门命中（macOS+Electron+iframe）');
  ok(sb.state().version === '0.2.1', '版本 0.2.1');
  let ev = makeEvent(textarea(), { key: 'c', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('copy'), '⌘C → preventDefault + execCommand(copy)');
  ev = makeEvent(textarea(), { key: 'v', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('paste'), '⌘V → preventDefault + execCommand(paste)');
  ev = makeEvent(textarea(), { key: 'x', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('cut'), '⌘X → preventDefault + execCommand(cut)');
}

console.log('[2] macOS · contentEditable 富文本（对话框正文，v0.2.0 崩溃点回归）');
{
  const sb = makeSandbox();
  let ev = makeEvent(richtext(), { key: 'ArrowLeft', metaKey: true });
  let threw = false;
  try { sb.keydown(ev); } catch (e) { threw = true; }
  ok(!threw, '⌘← 不再抛 TypeError（v0.2.0 读取 el.value 崩溃点已移除）');
  ok(ev.preventDefaultCount === 0, '⌘← 交还原生行为');
  ev = makeEvent(richtext(), { key: 'c', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('copy'), '⌘C 在富文本上仍被修复拦截');
}

console.log('[3] macOS · 非编辑区域（选中聊天内容复制）');
{
  const sb = makeSandbox();
  const staticText = { nodeType: 1, tagName: 'P', isContentEditable: false };
  let ev = makeEvent(staticText, { key: 'c', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('copy'), '⌘C 复制页面选中内容仍生效');
  ev = makeEvent(staticText, { key: 'x', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1, '⌘X 显式执行（对只读内容等效无操作，与原生一致）');
}

console.log('[4] macOS · 不再接管的键（交还原生/编辑器，PR #14 收敛）');
{
  const sb = makeSandbox();
  const cases = [
    [{ key: 'a', metaKey: true }, '⌘A'],
    [{ key: 'z', metaKey: true }, '⌘Z'],
    [{ key: 'z', metaKey: true, shiftKey: true }, '⌘⇧Z'],
    [{ key: 'ArrowLeft', metaKey: true }, '⌘←'],
    [{ key: 'ArrowRight', altKey: true }, '⌥→'],
    [{ key: 'Backspace', altKey: true }, '⌥⌫'],
    [{ key: 'x', metaKey: true, shiftKey: true }, '⌘⇧X（混合修饰）']
  ];
  for (const c of cases) {
    const ev = makeEvent(textarea(), c[0]);
    let threw = false;
    try { sb.keydown(ev); } catch (e) { threw = true; }
    ok(!threw && ev.preventDefaultCount === 0, c[1] + ' 不拦截、不报错（交还原生）');
  }
}

console.log('[5] macOS · 安全阀');
{
  const sb = makeSandbox();
  let ev = makeEvent(textarea(), { key: 'c', metaKey: true, defaultPrevented: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 0, '页面已处理的按键不覆盖');
  ev = makeEvent(textarea(), { key: 'c', metaKey: true, isComposing: true, keyCode: 229 });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 0, 'IME 组合中不干预');
  ev = makeEvent(textarea(), { key: 'c', metaKey: true, altKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 0, '⌘⌥ 混合修饰不干预');
}

console.log('[6] Windows / 非内嵌环境（回归：行为完全不变）');
{
  const sbWin = makeSandbox({ mac: false });
  ok(sbWin.state().enabled === false, 'Windows：插件不激活');
  let ev = makeEvent(textarea(), { key: 'c', metaKey: true });
  sbWin.keydown(ev);
  ok(ev.preventDefaultCount === 0 && sbWin.execCalls.length === 0, 'Windows：⌘C 原生行为不受任何影响');
  const sbBrowser = makeSandbox({ iframe: false });
  ok(sbBrowser.state().enabled === false, '普通浏览器打开 DSH：不激活');
  const ev2 = makeEvent(textarea(), { key: 'v', metaKey: true });
  sbBrowser.keydown(ev2);
  ok(ev2.preventDefaultCount === 0 && sbBrowser.execCalls.length === 0, '浏览器内嵌场景：原生剪贴板不受影响');
}

console.log('\n全部通过：' + passed + ' 项断言 ✓');
process.exit(0);