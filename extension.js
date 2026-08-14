const vscode = require('vscode');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');

const VIEW_ID = 'dsh.webview';
const DEFAULT_URL = 'http://127.0.0.1:3080';

// 当前 webview 视图引用，供“刷新”命令使用。
let activeView = null;
// 由扩展自己启动的 dsh 子进程；复用已有服务时不记录、不管理。
let managedChild = null;
// 防止多个视图实例同时触发启动。
let ensurePromise = null;

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
  const args = [
    'web',
    '--host', String(getHost()),
    '--port', String(getPort())
  ];
  const child = spawn(getDshCommand(), args, {
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

function buildLoadingHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
</head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
            font-family:-apple-system,Segoe UI,sans-serif;color:#cccccc;background:#1e1e1e;">
  <div style="text-align:center;">
    <div>正在启动 DeepSeek Harness…</div>
    <div style="margin-top:8px;font-size:12px;color:#888;">工作区：${escapeHtml(getWorkspaceDir())}</div>
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
</head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
            font-family:-apple-system,Segoe UI,sans-serif;color:#e06c75;background:#1e1e1e;">
  <div style="text-align:center;max-width:80%;">
    <div style="font-size:14px;">无法连接 DeepSeek Harness</div>
    <div style="margin-top:8px;font-size:12px;color:#888;word-break:break-all;">${escapeHtml(reason)}</div>
    <div style="margin-top:12px;font-size:12px;color:#888;">请确认 dsh 已安装，或点击面板顶部的“刷新”重试。</div>
  </div>
</body>
</html>`;
}

function buildIframeHtml(url) {
  // 只允许 iframe 加载目标地址，其余资源一律禁止，保持 webview 沙箱安全。
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${url} http://127.0.0.1:3080; style-src 'unsafe-inline';">
</head>
<body style="margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;background:#1e1e1e;">
<iframe src="${url}"
        style="width:100%;height:100%;border:none;display:block;"
        allow="clipboard-read; clipboard-write; autoplay"></iframe>
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

  const ok = await ensureRunningOnce();
  // await 期间视图可能已被关闭；只有仍是当前活动视图时才继续渲染。
  if (activeView !== view) return;

  if (ok) {
    // 服务就绪后，尽力把 VSCode 当前工作区注册进 DSH 工作区列表（不阻塞渲染）。
    registerWorkspace().catch(() => {});
    view.description = getUrl();
    view.webview.html = buildIframeHtml(getUrl());
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

      const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dshPanel')) {
          render(view);
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

  const refreshCmd = vscode.commands.registerCommand('dshPanel.refresh', () => {
    if (activeView) {
      render(activeView);
    } else {
      vscode.window.showInformationMessage('DeepSeek Harness 面板尚未打开，请先点击侧边栏图标。');
    }
  });

  const openBrowserCmd = vscode.commands.registerCommand('dshPanel.openInBrowser', () => {
    vscode.env.openExternal(vscode.Uri.parse(getUrl()));
  });

  // VS Code 切换工作区（文件夹）时，把新工作区也注册进 DSH 列表。
  const wsSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    registerWorkspace().catch(() => {});
  });

  context.subscriptions.push(viewSub, refreshCmd, openBrowserCmd, wsSub);
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
