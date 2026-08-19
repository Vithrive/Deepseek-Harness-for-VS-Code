const vscode = require('vscode');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');

const VIEW_ID = 'dsh.webview';
const DEFAULT_URL = 'http://127.0.0.1:3080';

// 当前 webview 视图引用，供“刷新”命令使用。
let activeView = null;
// 由扩展自己启动的 dsh 子进程；复用已有服务时不记录、不管理。
let managedChild = null;
// 防止多个视图实例同时触发启动。
let ensurePromise = null;
// 解析出的 dsh 启动方式：{ cmd, prefix }。null 表示尚未解析或都不可用。
// 优先全局安装（dsh 命令），其次 npx 缓存安装（npx 安装不会写入全局 PATH）。
let dshInvocation = null;

/**
 * 读取配置。
 */
function cfg() {
  return vscode.workspace.getConfiguration();
}

function getUrl() {
  return cfg().get('dshPanel.url', DEFAULT_URL);
}

function getHost() {
  return cfg().get('dshPanel.host', '127.0.0.1');
}

function getPort() {
  return cfg().get('dshPanel.port', 3080);
}

function getDshCommand() {
  return cfg().get('dshPanel.dshCommand', 'dsh');
}

/**
 * 执行一条命令并判断是否成功（exit code === 0）。
 * 在扩展运行的机器上执行 —— 本地场景即本机，Remote/vscode-server 场景即远程服务器。
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function runCommandOk(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: process.platform === 'win32',
      stdio: 'ignore',
      windowsHide: true
    });
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      finish(false);
    }, timeoutMs);
  });
}

/**
 * 解析可用的 dsh 启动方式，返回 { cmd, prefix } 或 null。
 * 1) 优先配置的 dsh 命令（默认 'dsh'，即 npm 全局安装、已写入 PATH）；
 * 2) 回退到 npx 缓存安装（npx 安装只缓存到 npx 目录，不写全局 PATH，
 *    此时 'dsh' 不在 PATH 里，但 'npx @deepseek-ai/dsh' 仍可运行）。
 * 探测 npx 用 --no-install：只检查本地/全局/npx 缓存，缺失时不触发下载，
 * 从而保留「完全未安装时弹出安装提示」的既有流程。
 * @returns {Promise<{cmd: string, prefix: string[]} | null>}
 */
async function resolveDshInvocation() {
  const cmd = getDshCommand();
  if (await runCommandOk(cmd, ['--version'])) {
    return { cmd, prefix: [] };
  }
  if (await runCommandOk('npx', ['--no-install', '@deepseek-ai/dsh', '--version'])) {
    return { cmd: 'npx', prefix: ['--yes', '@deepseek-ai/dsh'] };
  }
  return null;
}

/**
 * 安装 dsh（npm 全局安装）。在远程场景即在服务器上执行。
 * @returns {Promise<void>}
 */
function installDsh() {
  return new Promise((resolve, reject) => {
    exec('npm install -g @deepseek-ai/dsh', {
      timeout: 300000,
      windowsHide: true
    }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || '').trim() || err.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * 确保 dsh 已安装。未安装时，按配置提示用户并代为安装。
 * @returns {Promise<boolean>} 最终是否已安装可用。
 */
async function ensureDshInstalled() {
  const inv = await resolveDshInvocation();
  if (inv) {
    dshInvocation = inv;
    return true;
  }

  if (!cfg().get('dshPanel.autoInstallDsh', true)) {
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    '检测到当前环境未安装 DeepSeek Harness (dsh)，是否现在安装？',
    { modal: true },
    '安装'
  );
  if (choice !== '安装') {
    return false;
  }

  const installed = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '正在安装 DeepSeek Harness（npm install -g @deepseek-ai/dsh）…',
    cancellable: false
  }, async () => {
    try {
      await installDsh();
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(`DeepSeek Harness 安装失败：${e.message}`);
      return false;
    }
  });

  if (!installed) {
    return false;
  }
  const after = await resolveDshInvocation();
  if (after) {
    dshInvocation = after;
    return true;
  }
  return false;
}

/**
 * 将服务地址转换为 webview 可访问的显示地址。
 * 本地场景返回原地址；Remote/vscode-server 场景通过 asExternalUri
 * 自动建立端口转发（可能是带本地转发端口的地址，也可能是 HTTPS 转发域名），
 * 把远程 3080 暴露到本地供 iframe 加载。
 * @returns {Promise<string>}
 */
async function resolveDisplayUrl() {
  const url = getUrl();
  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    return external.toString();
  } catch {
    return url;
  }
}

/**
 * 工作区目录：优先 VS Code 打开的第一个工作区文件夹，否则退回用户主目录。
 * 这就是 dsh 启动时的工作区（cwd）。
 * @returns {string}
 */
function getWorkspaceDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.homedir();
}

/**
 * 探测 DSH 服务是否可访问。连接成功（任意状态码）即视为已打开。
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function checkUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 向 DSH 的 /api 端点发送 JSON RPC 请求。
 * @param {string} url
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function httpPostJson(url, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ raw: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

/**
 * 把 VS Code 当前工作区注册到 DSH 的工作区列表。
 * workspace.create 是幂等的：已存在时返回现有记录，不会重复。
 * 尽力而为，失败不影响面板渲染。
 * @returns {Promise<boolean>}
 */
async function registerWorkspace() {
  if (!cfg().get('dshPanel.autoRegisterWorkspace', true)) {
    return false;
  }
  const base = getUrl().replace(/\/+$/, '');
  const path = getWorkspaceDir();
  const payload = {
    type: 'client-request',
    rpcId: 'vscode-' + Date.now().toString(36),
    method: 'workspace.create',
    payload: { path }
  };
  try {
    const resp = await httpPostJson(base + '/api/workspace.create', payload);
    return !!(resp && resp.result && resp.result.ok);
  } catch {
    return false;
  }
}

/**
 * 启动 dsh web 进程。Windows 通过 shell 执行以命中 dsh.cmd shim。
 * @returns {import('child_process').ChildProcess}
 */
function startDsh() {
  // 使用 ensureDshInstalled 解析出的启动方式（全局 dsh 或 npx）。
  // 兜底回退到配置的命令，避免异常时序下拿到空值。
  const inv = dshInvocation || { cmd: getDshCommand(), prefix: [] };
  const args = [
    ...inv.prefix,
    'web',
    '--host', String(getHost()),
    '--port', String(getPort())
  ];
  const child = spawn(inv.cmd, args, {
    cwd: getWorkspaceDir(),
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: 'ignore'
  });
  managedChild = child;

  child.on('error', (err) => {
    if (activeView) {
      activeView.description = '启动失败';
    }
    vscode.window.showErrorMessage(`DeepSeek Harness 启动失败: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (managedChild === child) {
      managedChild = null;
    }
  });

  return child;
}

/**
 * 杀掉进程树。Windows 上 spawn 走 shell 时，child.kill() 只能杀 cmd.exe，
 * 需要 taskkill /t 才能连同真正的 node 进程一起结束。
 */
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (_) {
      child.kill('SIGTERM');
    }
  }
}

/**
 * 确保 DSH 正在运行：检测 ->（未运行时）启动 -> 轮询等待就绪。
 * 返回是否成功就绪。
 * @returns {Promise<boolean>}
 */
async function ensureRunning() {
  const url = getUrl();
  const autoStart = cfg().get('dshPanel.autoStart', true);

  if (await checkUrl(url)) {
    return true; // 已有服务，直接复用
  }

  if (!autoStart) {
    return false;
  }

  startDsh();

  // 最多等约 30 秒让服务就绪
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await checkUrl(url)) {
      return true;
    }
  }
  return false;
}

/**
 * 并发去重：确保无论有多少视图同时 resolve，都只跑一次启动流程。
 */
function ensureRunningOnce() {
  if (!ensurePromise) {
    ensurePromise = ensureRunning().finally(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

/**
 * 释放指定端口上监听的进程（best-effort）。
 * 用于「重启」：本窗口持有的 dsh 由 killTree 结束，这里再兜底清掉本窗口未持有的
 * dsh（外部启动 / 残留进程），确保新进程能成功绑定端口。仅在用户确认重启后调用。
 * @param {number} port
 * @returns {Promise<void>}
 */
function freePort(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('netstat -ano -p tcp', { windowsHide: true, timeout: 10000 }, (err, stdout) => {
        if (err) { resolve(); return; }
        const pids = new Set();
        for (const line of (stdout || '').split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 &&
              parts[0].toUpperCase() === 'TCP' &&
              parts[1] && parts[1].endsWith(`:${port}`) &&
              parts[3] && parts[3].toUpperCase() === 'LISTENING' &&
              parts[4]) {
            pids.add(parts[4]);
          }
        }
        if (pids.size === 0) { resolve(); return; }
        let remaining = pids.size;
        const done = () => { if (--remaining === 0) resolve(); };
        for (const pid of pids) {
          const k = spawn('taskkill', ['/pid', pid, '/t', '/f'], { stdio: 'ignore', windowsHide: true });
          k.on('exit', done);
          k.on('error', done);
        }
      });
    } else {
      // POSIX：fuser 优先，失败退回 lsof + kill。命令本身 best-effort，忽略退出码。
      exec(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 10000 }, () => {
        exec(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9 2>/dev/null`, { timeout: 10000 }, () => resolve());
      });
    }
  });
}

/**
 * 重启 dsh web：停掉当前 dsh、释放端口、重新启动并等待就绪。
 * 本窗口持有的 dsh 直接 killTree；本窗口未持有的（外部启动/残留）由 freePort 按端口释放，
 * 调用方需先征得用户确认，避免误杀其他窗口正在使用的 dsh。
 * @returns {Promise<boolean>} 是否重启成功就绪。
 */
async function restartDsh() {
  const url = getUrl();
  // 1. 结束本窗口启动的 dsh 进程树。
  if (managedChild) {
    killTree(managedChild);
    managedChild = null;
  }
  // 2. 释放端口（兜底外部启动 / 残留进程）。
  await freePort(getPort());
  // 3. 等端口真正释放（最多约 5 秒）。
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!(await checkUrl(url))) break;
  }
  // 4. 重新启动。
  startDsh();
  // 5. 等待就绪（最多约 30 秒）。
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await checkUrl(url)) return true;
  }
  return false;
}

/**
 * 计算 iframe 的字体缩放比例。
 * DSH 对话正文基准字号为 16px，按 editor.fontSize / 16 缩放，
 * 使面板字号跟随编辑器；编辑器字号安全夹取到 8..72，缩放夹取到 0.5..2。
 * @returns {number}
 */
function getFontScale() {
  const raw = vscode.workspace.getConfiguration('editor').get('fontSize', 16);
  const fontSize = Number(raw);
  const base = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
  const clamped = Math.min(72, Math.max(8, base));
  const scale = clamped / 16;
  return Math.min(2, Math.max(0.5, scale));
}

/**
 * 生成一次性 CSP nonce，用于放行内联缩放监听脚本。
 * @returns {string}
 */
function makeNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function buildLoadingHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--vscode-editor-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .sub { margin-top: 8px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div style="text-align:center;">
    <div>正在启动 DeepSeek Harness…</div>
    <div class="sub">工作区：${escapeHtml(getWorkspaceDir())}</div>
  </div>
</body>
</html>`;
}

function buildErrorHtml(reason) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--vscode-editor-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-errorForeground);
    background: var(--vscode-editor-background);
  }
  .box { text-align: center; max-width: 80%; }
  .title { font-weight: 600; }
  .sub { margin-top: 8px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .hint { margin-top: 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="box">
    <div class="title">无法连接 DeepSeek Harness</div>
    <div class="sub">${escapeHtml(reason)}</div>
    <div class="hint">请确认 dsh 已安装，或点击面板顶部的“刷新”重试。</div>
    <div class="hint">如未安装 dsh 请参考：https://www.runoob.com/deepseek-harness/deepseek-harness-install.html</div>
  </div>
</body>
</html>`;
}

function buildIframeHtml(url, scale) {
  // 解析显示地址，仅放行 http/https，并把其精确 origin 写入 frame-src，
  // 不再通配整个本机回环地址段，保持 webview 沙箱最小权限。
  // Remote 场景下 asExternalUri 可能返回带转发端口的 localhost 地址，也可能返回 HTTPS 转发域名，
  // 这里都按其实际 origin 精确放行，因此两种形式都兼容。
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error(`无法解析显示地址：${url}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`不允许的显示地址协议：${target.protocol}`);
  }
  const origin = target.origin; // 形如 http://127.0.0.1:3080 或 https://xxxx.example.com
  const nonce = makeNonce();
  const s = Number.isFinite(scale) ? Math.min(2, Math.max(0.5, scale)) : 1;
  const pct = (100 / s).toFixed(4);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${escapeHtml(origin)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head>
<body style="margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;background:var(--vscode-editor-background);">
<iframe id="dsh-frame" src="${escapeHtml(url)}"
        style="width:${pct}%;height:${pct}%;border:none;display:block;transform:scale(${s});transform-origin:0 0;"
        allow="clipboard-read; clipboard-write; autoplay"></iframe>
<script nonce="${nonce}">
(function () {
  var frame = document.getElementById('dsh-frame');
  var current = ${s};
  var vscode = acquireVsCodeApi();
  function apply(scale) {
    var n = Number(scale);
    if (!isFinite(n)) return;
    n = Math.min(2, Math.max(0.5, n));
    if (n === current) return;
    current = n;
    var pct = (100 / n).toFixed(4) + '%';
    frame.style.transform = 'scale(' + n + ')';
    frame.style.width = pct;
    frame.style.height = pct;
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data) return;
    if (data.type === 'dsh-font-scale' && typeof data.scale === 'number') {
      apply(data.scale);
    } else if (data.type === 'dsh-open-link' && typeof data.url === 'string') {
      // DSH 页面内点击外部链接：转发给扩展宿主，用系统浏览器打开。
      var u = data.url;
      if (/^https?:\/\//i.test(u)) {
        vscode.postMessage({ type: 'dsh-open-link', url: u });
      }
    } else if (data.type === 'insert-selection') {
      // 扩展宿主发来的「选中代码」：转发给 DSH iframe，由 dsh-drop-caret 插件插入对话框。
      try {
        frame.contentWindow.postMessage(data, '*');
      } catch (e) { /* ignore */ }
    }
  });
}());
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function render(view) {
  view.description = getUrl();
  view.webview.html = buildLoadingHtml();

  // 先确保 dsh 已安装（远程场景即在服务器上检查/安装）。
  const installed = await ensureDshInstalled();
  if (activeView !== view) return;
  if (!installed) {
    view.description = '未安装 dsh';
    view.webview.html = buildErrorHtml(
      '未检测到 DeepSeek Harness (dsh)，且已取消安装。请手动安装后点击“刷新”。'
    );
    return;
  }

  const ok = await ensureRunningOnce();
  // await 期间视图可能已被关闭；只有仍是当前活动视图时才继续渲染。
  if (activeView !== view) return;

  if (ok) {
    // 服务就绪后，尽力把 VSCode 当前工作区注册进 DSH 工作区列表（不阻塞渲染）。
    registerWorkspace().catch(() => {});
    // iframe 用显示地址（远程场景经端口转发），检测/API 仍用服务地址。
    const displayUrl = await resolveDisplayUrl();
    if (activeView !== view) return;
    view.description = getUrl();
    try {
      view.webview.html = buildIframeHtml(displayUrl, getFontScale());
    } catch (e) {
      // 显示地址无法解析或协议不是 http/https 时，拒绝加载 iframe 并展示错误页。
      view.description = '无法加载';
      view.webview.html = buildErrorHtml(e.message);
    }
  } else {
    view.description = '未连接';
    view.webview.html = buildErrorHtml(
      `无法连接 ${getUrl()}，且自动启动未成功（或已关闭自动启动）。`
    );
  }
}

function activate(context) {
  const provider = {
    resolveWebviewView(view) {
      activeView = view;
      view.title = 'DeepSeek Harness';

      view.webview.options = {
        enableScripts: true
      };

      render(view);

      // DSH 页面（iframe）内点击外部链接时，由 dsh-open-links 插件通过
      // postMessage 逐级转发到这里，用系统默认浏览器打开。
      view.webview.onDidReceiveMessage((msg) => {
        if (msg && msg.type === 'dsh-open-link' && typeof msg.url === 'string') {
          const u = msg.url;
          if (/^https?:\/\//i.test(u)) {
            vscode.env.openExternal(vscode.Uri.parse(u));
          }
        }
      });

      const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dshPanel')) {
          render(view);
        } else if (e.affectsConfiguration('editor.fontSize')) {
          // 仅字号变化时不重载 iframe（避免打断当前对话），只推送新的缩放值。
          view.webview.postMessage({ type: 'dsh-font-scale', scale: getFontScale() });
        }
      });

      view.onDidDispose(() => {
        cfgSub.dispose();
        if (activeView === view) {
          activeView = null;
        }
      });
    }
  };

  const viewSub = vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
    webviewOptions: { retainContextWhenHidden: true }
  });

  const refreshCmd = vscode.commands.registerCommand('dshPanel.refresh', async () => {
    if (!activeView) {
      vscode.window.showInformationMessage('DeepSeek Harness 面板尚未打开，请先点击侧边栏图标。');
      return;
    }
    const view = activeView;
    // 服务在线：不重载 iframe（避免打断正在运行的对话），仅确认状态并同步工作区。
    if (await checkUrl(getUrl())) {
      view.description = getUrl();
      registerWorkspace().catch(() => {});
      vscode.window.showInformationMessage('DeepSeek Harness: 服务已连接，无需重载（运行中的任务不受影响）。');
      return;
    }
    // 服务离线：走完整渲染（自动启动 + 重载 iframe）。
    render(view);
  });

  const openBrowserCmd = vscode.commands.registerCommand('dshPanel.openInBrowser', () => {
    vscode.env.openExternal(vscode.Uri.parse(getUrl()));
  });

  const restartCmd = vscode.commands.registerCommand('dshPanel.restart', async () => {
    if (!activeView) {
      vscode.window.showInformationMessage('DeepSeek Harness 面板尚未打开，请先点击侧边栏图标。');
      return;
    }
    const view = activeView;

    // dsh 正在运行、且不是本窗口启动时，重启会中断其他窗口的任务，先征得确认。
    // dsh 未运行、或本就是本窗口启动时，无需确认直接重启/启动。
    const running = await checkUrl(getUrl());
    if (running && !managedChild) {
      const choice = await vscode.window.showWarningMessage(
        '当前 dsh web 不是由本窗口启动的，重启会中断所有正在使用它的窗口及其任务。确定要重启吗？',
        { modal: true },
        '重启'
      );
      if (choice !== '重启') {
        return;
      }
    }

    view.description = '正在重启';
    view.webview.html = buildLoadingHtml();

    const installed = await ensureDshInstalled();
    if (activeView !== view) return;
    if (!installed) {
      view.description = '未安装 dsh';
      view.webview.html = buildErrorHtml('未检测到 DeepSeek Harness (dsh)，无法重启。请先安装后重试。');
      return;
    }

    const ok = await restartDsh();
    if (activeView !== view) return;
    if (ok) {
      registerWorkspace().catch(() => {});
      const displayUrl = await resolveDisplayUrl();
      if (activeView !== view) return;
      view.description = getUrl();
      try {
        view.webview.html = buildIframeHtml(displayUrl, getFontScale());
      } catch (e) {
        view.description = '无法加载';
        view.webview.html = buildErrorHtml(e.message);
      }
    } else {
      view.description = '重启失败';
      view.webview.html = buildErrorHtml('重启 dsh web 后仍无法连接，请确认端口未被占用或 dsh 可正常启动。');
    }
  });

  // VS Code 切换工作区（文件夹）时，把新工作区也注册进 DSH 列表。
  const wsSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    registerWorkspace().catch(() => {});
  });

  // 发送选中内容到 DSH 对话框
  const sendSelectionCmd = vscode.commands.registerCommand('dsh.sendSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !activeView) {
      vscode.window.showWarningMessage('请先打开 DeepSeek Harness 面板并选中代码');
      return;
    }
    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showWarningMessage('请先选中代码片段');
      return;
    }
    const document = editor.document;
    const selectedText = document.getText(selection);
    const filePath = document.uri.fsPath;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    
    activeView.webview.postMessage({
      type: 'insert-selection',
      filePath: filePath,
      startLine: startLine,
      endLine: endLine,
      content: selectedText,
      language: document.languageId
    });
    
    vscode.window.showInformationMessage('已发送选中内容到 DSH');
  });

  context.subscriptions.push(viewSub, refreshCmd, openBrowserCmd, restartCmd, wsSub, sendSelectionCmd);
}

function deactivate() {
  // 扩展停用时，按配置决定是否结束由本扩展启动的 dsh 进程。
  const killOnDispose = cfg().get('dshPanel.killOnDispose', true);
  if (killOnDispose && managedChild) {
    killTree(managedChild);
    managedChild = null;
  }
}

module.exports = { activate, deactivate };
