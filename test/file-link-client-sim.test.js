'use strict';
/**
 * dsh-vscode-file-links 客户端半边的行为仿真测试（无浏览器依赖）。
 * 运行：node test/file-link-client-sim.test.js
 *
 * 用最小 DOM/事件/定时器仿真把 client.js 真正跑起来，验证最容易出错的交互语义：
 *  - 未握手（ack）前完全不介入；
 *  - 握手后：命中文件链接按钮 → 阻断 DSH 自身打开 + 向父级发 reveal；
 *  - 宿主回执 ok=true → 不回放；ok=false → 回放原始点击（DSH 侧边栏照旧打开）；
 *  - 宿主超时无回执 → 回放；修饰键点击 → 不接管；非文件链接按钮 → 不接管；
 *  - 独立浏览器（无父级）→ 不打招呼、不介入。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const clientSource = fs.readFileSync(
  path.join(__dirname, '..', 'dsh-plugins', 'dsh-vscode-file-links', 'lib', 'client.js'),
  'utf8'
);

/** 造一个仿真环境：document/window/定时器/事件派发（含「React 委托 handler」模型）。 */
function makeEnv(options = {}) {
  const docCapture = [];
  const winListeners = [];
  const posted = [];      // 插件 → 父级（webview）
  const timers = [];
  const reactCalls = [];  // DSH 自身行为（侧边栏打开）被调用的次数
  let timerSeq = 1;

  const win = {
    name: options.name === undefined ? '' : options.name,
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
    postMessage: (payload) => posted.push(payload),
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms, interval: null }); return id; },
    setInterval: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms, interval: ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  win.parent = options.standalone
    ? win
    // 父级（VS Code 面板 webview）：插件只往这里 postMessage
    : { isParent: true, postMessage: (payload) => posted.push(payload) };

  const document = {
    addEventListener: (type, fn, capture) => docCapture.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = docCapture.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) docCapture.splice(i, 1);
    }
  };

  /** 派发一次点击：document 捕获阶段 → （未被 stopPropagation 时）DSH 的委托 handler。 */
  function dispatchClick(target, modifiers = {}) {
    const event = {
      type: 'click',
      target,
      button: modifiers.button === undefined ? 0 : modifiers.button,
      metaKey: !!modifiers.metaKey,
      ctrlKey: !!modifiers.ctrlKey,
      shiftKey: !!modifiers.shiftKey,
      altKey: !!modifiers.altKey,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    };
    for (const l of docCapture.slice()) l.fn(event);
    // React 18 把 onClick 委托挂在根容器（document 之下）：被 stopPropagation 挡住。
    if (!event.stopped) reactCalls.push(target);
    return event;
  }

  /** 模拟元素：button 或 button 内部的子节点（图标/文字 span）。 */
  function makeButton(opts = {}) {
    const attrs = {};
    if (opts.cls !== null) attrs.class = opts.cls === undefined ? '_fileMention_abc _fileLink_def' : opts.cls;
    if (opts.title !== undefined) attrs.title = opts.title;
    const btn = {
      nodeType: 1,
      tagName: 'BUTTON',
      textContent: opts.text === undefined ? '' : opts.text,
      getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
      closest: (sel) => (sel === 'button' ? btn : null),
      click: () => dispatchClick(btn)
    };
    return btn;
  }
  function makeChild(button) {
    return {
      nodeType: 1,
      tagName: 'SPAN',
      closest: (sel) => (sel === 'button' ? button : null)
    };
  }

  /** 把某来源的消息交给插件（默认来自父级 webview）。 */
  function hostMessageFrom(source, data) {
    const event = { source, data };
    for (const l of winListeners.slice()) {
      if (l.type === 'message') l.fn(event);
    }
  }
  function hostMessage(data) {
    hostMessageFrom(win.parent, data);
  }

  function runTimers(which) {
    for (const t of timers.slice()) {
      if (which && t.ms !== which) continue;
      if (t.interval === null) {
        const i = timers.findIndex((x) => x.id === t.id);
        if (i >= 0) timers.splice(i, 1);
      }
      t.fn();
    }
  }

  const sandbox = { window: win, document, console };
  vm.createContext(sandbox);
  let pluginExports = null;
  sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => { pluginExports = factory(() => {}); } };
  vm.runInContext(clientSource, sandbox, { filename: 'dsh-vscode-file-links/client.js' });
  let disposed = null;
  pluginExports.apply({ effect: (fn) => { disposed = fn(); } });

  return { win, posted, dispatchClick, makeButton, makeChild, hostMessage, hostMessageFrom, runTimers, reactCalls, timers, dispose: () => disposed && disposed() };
}

console.log('[1] 未握手（宿主未 ack）：完全不介入');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  const btn = env.makeButton({ title: 'src/a.ts' });
  const event = env.dispatchClick(btn);
  ok(env.reactCalls.length === 1 && event.defaultPrevented === false, '未握手时点击照旧走 DSH 自身行为（不吞点击）');
  ok(env.posted.some((m) => m.type === 'hello'), '插件主动打招呼（hello，带自身 source 标记）');
  ok(env.posted.filter((m) => m.type === 'reveal').length === 0, '未握手时不发 reveal');
}

console.log('[2] 握手后：接管并转发，DSH 自身行为被阻断');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'src/deep/nested/a.ts' });
  const event = env.dispatchClick(env.makeChild(btn));
  const reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(event.defaultPrevented === true && event.stopped === true, '接管时 preventDefault + stopPropagation');
  ok(env.reactCalls.length === 0, 'DSH 自身打开被阻断（不会既开侧边栏又跳 VS Code）');
  ok(reveal.length === 1 && reveal[0].path === 'src/deep/nested/a.ts', '路径取 title 并转发（点击落在内部子节点也命中）');
  ok(reveal[0].source === 'dsh-vscode-file-links' && typeof reveal[0].token === 'string' && reveal[0].token.length > 0, '转发消息带插件标识与 token');
  ok(env.win.name === 'dsh-vscode-host', '（仿真前提）iframe name 标记存在');

  // 宿主回执 ok=true：不回放
  env.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-result', token: reveal[0].token, ok: true });
  ok(env.reactCalls.length === 0, '回执 ok=true：不回放，DSH 侧边栏保持关闭');
}

console.log('[3] 宿主无法处理：回放原始点击（不会点了没反应）');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'outside/x.txt' });
  env.dispatchClick(btn);
  const reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(env.reactCalls.length === 0, '先阻断');
  env.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-result', token: reveal[0].token, ok: false });
  ok(env.reactCalls.length === 1 && env.reactCalls[0] === btn, '回执 ok=false：回放一次原始点击（DSH 侧边栏打开）');
  ok(env.posted.filter((m) => m.type === 'reveal').length === 1, '回放不会再触发一次 reveal（无环）');
}

console.log('[4] 宿主超时（面板关闭 / 扩展未升级）：超时回放');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'src/b.ts' });
  env.dispatchClick(btn);
  ok(env.reactCalls.length === 0, '阻断等待回执');
  env.runTimers(2500); // REVEAL_TIMEOUT_MS
  ok(env.reactCalls.length === 1, '超时后回放（绝不出现点了没反应）');
}

console.log('[5] 不接管的场景');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });

  const plain = env.makeButton({ cls: 'some-other-button', title: 'src/a.ts' });
  env.dispatchClick(plain);
  ok(env.reactCalls.length === 1 && env.posted.filter((m) => m.type === 'reveal').length === 0, '非文件链接按钮不接管');

  const modBtn = env.makeButton({ title: 'src/a.ts' });
  env.reactCalls.length = 0;
  env.dispatchClick(modBtn, { ctrlKey: true });
  ok(env.reactCalls.length === 1 && env.posted.filter((m) => m.type === 'reveal').length === 0, 'Ctrl+点击不接管（强制走 DSH 行为）');
  env.reactCalls.length = 0;
  env.dispatchClick(modBtn, { metaKey: true });
  env.dispatchClick(modBtn, { shiftKey: true });
  env.dispatchClick(modBtn, { altKey: true });
  env.dispatchClick(modBtn, { button: 1 });
  ok(env.reactCalls.length === 4 && env.posted.filter((m) => m.type === 'reveal').length === 0, 'Cmd/Shift/Alt/中键点击一律不接管');

  const noPath = env.makeButton({ title: '' });
  env.reactCalls.length = 0;
  env.dispatchClick(noPath);
  ok(env.reactCalls.length === 1, '没有可用路径时不接管（退回 DSH 行为）');
}

console.log('[6] 图片链接（无 title）退回链接文字；伪造来源的 ack 被忽略');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const imgBtn = env.makeButton({ title: undefined, text: 'assets/plot.png' });
  env.dispatchClick(imgBtn);
  const reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(reveal.length === 1 && reveal[0].path === 'assets/plot.png', '无 title 时退回链接文字（图片预览链接）');
}
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessageFrom({ evil: true }, { source: 'dsh-vscode-host', type: 'ack', fileLinks: true });
  const event = env.dispatchClick(env.makeButton({ title: 'src/a.ts' }));
  ok(env.reactCalls.length === 1 && event.defaultPrevented === false, '非父级来源的 ack 不生效（不会被第三方页面接管）');
  ok(env.posted.filter((m) => m.type === 'reveal').length === 0, '未被授权时不发 reveal');
  env.hostMessageFrom(env.win.parent, { source: 'dsh-vscode-host', type: 'ack', fileLinks: false });
  const event2 = env.dispatchClick(env.makeButton({ title: 'src/a.ts' }));
  ok(event2.defaultPrevented === false && env.reactCalls.length === 2, '宿主持有 fileLinks:false（配置为 off）时不接管');
}

console.log('[7] 独立浏览器（无父级宿主）：完全惰性');
{
  const env = makeEnv({ standalone: true });
  ok(env.posted.length === 0, '不打招呼（postMessage 一次都没有）');
  const btn = env.makeButton({ title: 'src/a.ts' });
  const event = env.dispatchClick(btn);
  ok(env.reactCalls.length === 1 && event.defaultPrevented === false, '照旧走 DSH 自身行为');
  ok(env.win.__dshVscodeFileLinks.version === '0.1.0' && env.win.__dshVscodeFileLinks.acked() === false, '暴露排障对象（version/acked）');
}

console.log('[8] 插件卸载：监听器与定时器清理');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'src/a.ts' });
  env.dispatchClick(btn);
  env.dispose();
  const before = env.reactCalls.length;
  env.dispatchClick(env.makeButton({ title: 'src/a.ts' }));
  ok(env.reactCalls.length === before + 1, '卸载后不再拦截');
  ok(env.timers.length === 0, '卸载后清掉待定定时器（不留悬挂回放）');
}

console.log('\n全部通过：' + passed + ' 项断言 ✓');
process.exit(0);
