const vscode = require('vscode');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

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
// 编辑器标签页模式：当前打开的 DSH 标签页 panel（未打开时为 null）。
let activeTab = null;
// /dsh ChatParticipant 需要访问扩展上下文（globalState 持久化会话映射）。
let gContext = null;
// /dsh ChatParticipant 是否注册成功（供「检查 /dsh 状态」命令查询）。
let chatParticipantRegistered = false;
// dsh 语言模型提供方（模型选择器里的 DSH (DeepSeek Harness)）是否注册成功。
let dshModelProviderRegistered = false;
// 本地 Copilot 消息截获代理（由扩展启动/复用的子进程）。
let proxyChild = null;

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
 * GET JSON（用于读取本地代理的内部接口）。
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: { Accept: 'application/json' }
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
  });
}

// =====================================================================
// Copilot 消息截获代理：让 @dsh 拿到 Copilot 侧发往自定义模型的完整消息列表
// =====================================================================
const CHAT_PROXY_DEFAULT_PORT = 3050;

function getProxyUrl() {
  return String(cfg().get('dshPanel.chatProxyUrl', 'http://127.0.0.1:' + CHAT_PROXY_DEFAULT_PORT)).replace(/\/+$/, '');
}

function getProxyUpstream() {
  return String(cfg().get('dshPanel.chatProxyUpstream', 'https://api.deepseek.com')).replace(/\/+$/, '');
}

/**
 * 确保本地代理在运行：健康检查 → 未运行则自动启动扩展自带的 dsh-copilot-proxy.js。
 * @returns {Promise<boolean>}
 */
async function ensureProxyRunning() {
  const url = getProxyUrl();
  if (await checkUrl(url + '/__dsh/health')) {
    return true;
  }
  if (!cfg().get('dshPanel.chatProxyAutoStart', true)) {
    return false;
  }
  if (!proxyChild) {
    const script = path.join(gContext.extensionUri.fsPath, 'proxy', 'dsh-copilot-proxy.js');
    let port = String(CHAT_PROXY_DEFAULT_PORT);
    try {
      port = new URL(url).port || String(CHAT_PROXY_DEFAULT_PORT);
    } catch (_) { /* 用默认端口 */ }
    proxyChild = spawn('node', [script, '--port', port, '--upstream', getProxyUpstream()], {
      cwd: getWorkspaceDir(),
      windowsHide: true,
      stdio: 'ignore'
    });
    proxyChild.on('error', () => { proxyChild = null; });
    proxyChild.on('exit', () => { proxyChild = null; });
  }
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (await checkUrl(url + '/__dsh/health')) {
      return true;
    }
  }
  return false;
}

/**
 * 读取代理截获的最近请求（messages 列表）。
 * @returns {Promise<any[]>}
 */
async function proxyRecentItems() {
  const url = getProxyUrl() + '/__dsh/recent?limit=30';
  const data = await httpGetJson(url, 8000);
  return (data && Array.isArray(data.items)) ? data.items : [];
}

/**
 * 取本参与者（@dsh）上一次回答的文本，用于在代理记录中定位当前聊天。
 * @param {any} chatContext
 * @returns {string}
 */
function lastParticipantResponseText(chatContext) {
  const hist = (chatContext && Array.isArray(chatContext.history)) ? chatContext.history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = hist[i];
    if (!t || t.prompt !== undefined) continue; // ChatRequestTurn
    const resp = t.response;
    let text = '';
    if (Array.isArray(resp)) {
      text = resp
        .map((p) => (p && (typeof p.value === 'string' ? p.value : (typeof p.text === 'string' ? p.text : ''))) || '')
        .filter(Boolean)
        .join('\n');
    } else if (typeof resp === 'string') {
      text = resp;
    }
    if (text) return text;
  }
  return '';
}

/**
 * 判断是否为 VS Code 注入的"非对话"内容块（系统提示词/环境信息/上下文提醒等）。
 * @param {string} t
 * @returns {boolean}
 */
function isJunkUserText(t) {
  if (!t) return true;
  if (/^You are an expert/i.test(t)) return true; // VS Code 系统提示词（含 <instructions><skills><description> 等）
  if (t.indexOf('<instructions>') >= 0 && t.indexOf('<skills>') >= 0) return true;
  if (/^\s*<(environment_info|workspace_info|context|reminderInstructions|user_info|instructions|userMemory|sessionMemory|repoMemory)>/.test(t)) return true;
  return false;
}

/**
 * 从 <userRequest>...</userRequest> 包裹中提取真实提问；未包裹返回 null。
 * @param {string} t
 * @returns {string|null}
 */
function extractUserRequest(t) {
  const m = t.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
  return m ? m[1].trim() : null;
}

/**
 * 清洗单条代理消息：跳过 system/tool 与 VS Code 注入块，
 * 用户消息只保留 <userRequest> 内的真实提问。
 * @param {any} m
 * @returns {string} 有效对话文本（可能为空）。
 */
function cleanProxyMessage(m) {
  if (!m) return '';
  if (m.role === 'system' || m.role === 'tool') return '';
  const raw = m.text || '';
  if (m.role === 'user') {
    if (isJunkUserText(raw)) return '';
    const inner = extractUserRequest(raw);
    if (inner !== null) return inner;
    return raw;
  }
  return raw;
}

/**
 * 把代理截获的消息列表序列化为纯对话文本（只保留有效对话内容）。
 * @param {any[]} msgs
 * @returns {string}
 */
function serializeProxyMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    const text = cleanProxyMessage(m);
    if (!text) continue;
    if (m.role === 'user') out.push('用户：' + text);
    else if (m.role === 'assistant') out.push('助手：' + text);
    else out.push('[' + m.role + '] ' + text);
  }
  return out.join('\n\n');
}

/**
 * 超上限时做无损压缩（折叠空行/去行首尾空白）；宁全勿缺，不做截断。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function compressChatText(text, max) {
  if (text.length <= max) return text;
  let out = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
  if (out.length <= max) return out;
  console.warn('[DeepSeek Harness] 中间对话压缩后仍超过上限（' + out.length + ' > ' + max + '），按完整消息发送');
  return out;
}

/**
 * 从代理记录中提取「上次 @dsh 之后、Copilot 侧新增的对话」：
 * - 有 @dsh 历史：找包含我们上次回答片段的最近一条记录，取其后的消息（中间对话）；
 * - 首次 @dsh：取 10 分钟内最近一条记录的完整消息列表（best-effort）。
 * @param {any} chatContext
 * @returns {Promise<string>} 空串表示没有可同步的中间对话。
 */
async function fetchInterimConversation(chatContext) {
  const items = await proxyRecentItems();
  if (!items.length) return '';
  const hist = (chatContext && Array.isArray(chatContext.history)) ? chatContext.history : [];
  const maxChars = Number(cfg().get('dshPanel.chatSyncMaxChars', 500000)) || 500000;

  // 锚点候选（按可靠性排序）：最后一次 @dsh 用户提问 → 我们上次回答 → 本对话第一条 @dsh 提问。
  // 原因：用户消息必然出现在 Copilot 发给自定义模型的上下文里；
  // 助手消息是否包含参与者回答取决于 VS Code 的组装策略，故只作备选。
  const anchors = [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = hist[i];
    if (t && typeof t.prompt === 'string' && t.prompt) {
      anchors.push(t.prompt);
      break;
    }
  }
  const lastResp = lastParticipantResponseText(chatContext);
  if (lastResp && !anchors.includes(lastResp)) anchors.push(lastResp);
  if (hist.length > 0 && hist[0] && typeof hist[0].prompt === 'string' && hist[0].prompt && !anchors.includes(hist[0].prompt)) {
    anchors.push(hist[0].prompt);
  }

  for (const anchor of anchors) {
    const snippet = anchor.slice(0, 120).replace(/\s+/g, ' ');
    if (!snippet) continue;
    for (const it of items) {
      const msgs = it.messages || [];
      const joined = msgs.map((m) => (m && m.text ? m.text : '')).join('\n');
      if (!joined.includes(snippet)) continue;
      let idx = -1;
      for (let i = 0; i < msgs.length; i++) {
        const t = msgs[i] && msgs[i].text ? msgs[i].text : '';
        if (t.includes(snippet)) { idx = i; break; }
      }
      if (idx < 0) continue;
      // 取锚点消息之后的中间对话
      return compressChatText(serializeProxyMessages(msgs.slice(idx + 1)), maxChars);
    }
  }

  // 首次 @dsh（本参与者无历史）：取最近一条请求的完整消息列表作为一次性全量补课。
  // 原理：Copilot 每次把整个对话重新发给模型，因此最新一条记录已包含该对话窗口的全部问答；
  // 清洗后即"完整对话内容"。超上限时压缩但绝不截断。
  if (hist.length === 0) {
    const newest = items[0];
    if (newest) {
      return compressChatText(serializeProxyMessages(newest.messages || []), maxChars);
    }
  }
  return '';
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

/**
 * 标签页模式下的侧边栏占位页：DSH 已由标签页接管，侧边栏不再重复加载，
 * 避免两个 webview 同时加载 DSH 导致插件加载互斥（DSH 前端在 webview 双实例场景的限制）。
 */
function buildSuspendedHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: var(--vscode-editor-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .box { text-align: center; max-width: 80%; }
  .title { font-weight: 600; }
  .sub { margin-top: 8px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="box">
    <div class="title">DeepSeek Harness 已在标签页中打开</div>
    <div class="sub">关闭标签页后，本侧边栏面板会自动恢复加载。</div>
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
      // 注意：此处必须写成 \\/\\/ —— 模板字面量会把 \/ 折叠成 /，
      // 若写成 \/\/ 则注入的脚本变成 /^https?:///i，整段内联脚本语法错误，
      // 导致 insert-selection 消息监听器注册失败（发送选中内容不生效）。
      if (/^https?:\\/\\//i.test(u)) {
        vscode.postMessage({ type: 'dsh-open-link', url: u });
      }
    } else if (data.type === 'insert-selection') {
      // 扩展宿主发来的「选中代码」：转发给 DSH iframe，由 dsh-drop-caret 插件插入对话框。
      try {
        if (!frame || !frame.contentWindow) {
          vscode.postMessage({ type: 'insert-selection-ack', status: 'no-frame' });
        } else {
          frame.contentWindow.postMessage(data, '*');
          vscode.postMessage({ type: 'insert-selection-ack', status: 'forwarded' });
        }
      } catch (e) {
        try {
          vscode.postMessage({ type: 'insert-selection-ack', status: 'error' });
        } catch (e2) { /* ignore */ }
      }
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

// =====================================================================
// DSH 配套插件自动安装/管理
// 架构原因：面板把 DSH Web GUI 内嵌在跨域 iframe 中，扩展（webview 是
// iframe 的父容器）受安全隔离无法直接操作 DSH 页面内部的输入框。
// 「拖文件/文件夹/选中代码段插入对话框」必须在 DSH 页面内部由插件接收，
// 因此扩展自动在 DSH web profile 中补齐配套插件 dsh-drop-caret，
// 用户只需安装本扩展，无需手动安装 DSH 插件。
// =====================================================================
const DSH_PLUGIN_NAME = 'dsh-drop-caret';
const DSH_PLUGIN_MIN = '0.2.2';
const NPMJS_REGISTRY = 'https://registry.npmjs.org/';

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dshWebProfileDir() {
  return path.join(dshHomeDir(), 'profiles', 'web');
}

/** 简单版本比较：a >= b 返回 >=0，a < b 返回 <0。 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonFile(file, obj) {
  await fs.promises.writeFile(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** 幂等：确保 profile 的 package.json 声明该插件（dependencies + dsh.profile.bundles）。 */
async function ensureProfileDeclaration(profileDir, plugin, versionSpec) {
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = (await readJsonFile(pkgFile)) || { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
  let changed = false;
  if (!pkg.dependencies[plugin]) {
    pkg.dependencies[plugin] = versionSpec;
    changed = true;
  }
  if (!pkg.dsh.profile.bundles.includes(plugin)) {
    pkg.dsh.profile.bundles.push(plugin);
    changed = true;
  }
  if (changed) await writeJsonFile(pkgFile, pkg);
}

/** 读取已安装插件版本；未安装返回 null。 */
async function installedPluginVersion(profileDir, plugin) {
  const pkg = await readJsonFile(path.join(profileDir, 'node_modules', plugin, 'package.json'));
  return pkg && pkg.version ? pkg.version : null;
}

/** 用 npm pack 拉取插件并解压到 profile 的 node_modules（不依赖 pnpm）。 */
async function installPluginViaNpm(profileDir, plugin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-'));
  try {
    const packOut = await new Promise((resolve, reject) => {
      exec(
        `npm pack ${plugin} --pack-destination "${tmp}" --registry ${NPMJS_REGISTRY} --json`,
        { timeout: 180000, windowsHide: true },
        (err, stdout) => (err ? reject(new Error((stdout || '').trim() || err.message)) : resolve(stdout))
      );
    });
    const parsed = JSON.parse(packOut);
    const tarball = parsed && parsed[0] && parsed[0].filename ? parsed[0].filename : null;
    if (!tarball) throw new Error('npm pack 未能解析 tarball 文件名');
    const extractDir = path.join(tmp, 'extract');
    await fs.promises.mkdir(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      exec(`tar -xzf "${path.join(tmp, tarball)}" -C "${extractDir}"`, { timeout: 60000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    const pkgSrc = path.join(extractDir, 'package');
    const dest = path.join(profileDir, 'node_modules', plugin);
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.cp(pkgSrc, dest, { recursive: true });
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 尝试用官方 dsh plugin add 安装（依赖 dsh + pnpm）；成功返回 true。 */
function tryDshPluginAdd(plugin) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const env = Object.assign({}, process.env, {
      // npm 全局 bin 前置，避开旧 corepack shim 干扰 pnpm
      Path: path.join(os.homedir(), 'AppData', 'Roaming', 'npm') + path.delimiter + (process.env.Path || process.env.PATH || ''),
      npm_config_registry: NPMJS_REGISTRY
    });
    const child = spawn(cmd, ['plugin', '--profile', 'web', 'add', plugin], {
      stdio: 'ignore',
      env,
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      finish(false);
    }, 180000);
  });
}

/**
 * 确保 DSH web profile 已安装并声明 dsh-drop-caret 插件。
 * @returns {Promise<boolean>} 本次是否发生了新增/升级安装（true 时通常需重启 dsh web 生效）。
 */
async function ensureDshPlugins() {
  const profileDir = dshWebProfileDir();
  try {
    const installed = await installedPluginVersion(profileDir, DSH_PLUGIN_NAME);
    await ensureProfileDeclaration(profileDir, DSH_PLUGIN_NAME, `^${DSH_PLUGIN_MIN}`);
    if (installed && compareVersions(installed, DSH_PLUGIN_MIN) >= 0) {
      return false; // 已满足，无需安装
    }
    // 未安装或版本过低：先试官方 dsh plugin add，失败回退 npm pack。
    const viaCli = await tryDshPluginAdd(DSH_PLUGIN_NAME);
    if (!viaCli) {
      await installPluginViaNpm(profileDir, DSH_PLUGIN_NAME);
    }
    await ensureProfileDeclaration(profileDir, DSH_PLUGIN_NAME, `^${DSH_PLUGIN_MIN}`);
    return true;
  } catch (e) {
    console.error(`[DeepSeek Harness] 自动安装 ${DSH_PLUGIN_NAME} 失败：`, e);
    vscode.window.showWarningMessage(`自动安装 DSH 插件 ${DSH_PLUGIN_NAME} 失败：${e.message}`);
    return false;
  }
}

/**
 * 处理 webview 消息：DSH 页面内点击外部链接用系统浏览器打开；发送选中内容回执提示。
 * 侧边栏面板与编辑器标签页共用。
 * @param {any} msg
 */
function handleWebviewMessage(msg) {
  if (msg && msg.type === 'dsh-open-link' && typeof msg.url === 'string') {
    const u = msg.url;
    if (/^https?:\/\//i.test(u)) {
      vscode.env.openExternal(vscode.Uri.parse(u));
    }
  } else if (msg && msg.type === 'insert-selection-ack') {
    if (msg.status === 'forwarded') {
      vscode.window.showInformationMessage('已转发到 DSH 对话框');
    } else if (msg.status === 'no-frame') {
      vscode.window.showErrorMessage('转发失败：面板未加载 DSH iframe，请点「刷新」后重试');
    } else {
      vscode.window.showErrorMessage('转发失败：未知错误');
    }
  }
}

/**
 * 标签页专用显示地址：本地场景把 host 在 127.0.0.1 与 localhost 之间互换，
 * 制造与侧边栏不同的 origin，避免两个 webview 同 origin 时 DSH 前端的插件加载互斥。
 * 仅当 host 为 127.0.0.1 或 localhost 时互换；其它地址（如远程转发域名）原样返回。
 * @param {string} displayUrl
 * @returns {string}
 */
function getTabDisplayUrl(displayUrl) {
  try {
    const u = new URL(displayUrl);
    if (u.hostname === '127.0.0.1') {
      u.hostname = 'localhost';
      return u.toString();
    }
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1';
      return u.toString();
    }
    return displayUrl;
  } catch {
    return displayUrl;
  }
}

/**
 * 准备面板内容 HTML：确保 dsh 已安装、配套插件在位、服务就绪，
 * 返回 iframe HTML 或错误。侧边栏视图与编辑器标签页共用。
 * @param {boolean} [isTab] 是否为标签页模式（标签页用不同 origin 以与侧边栏隔离）。
 * @returns {Promise<{ok: true, html: string} | {ok: false, kind: 'not-installed'|'unreachable'|'unloadable', reason: string}>}
 */
async function preparePanelHtml(isTab) {
  // 先确保 dsh 已安装（远程场景即在服务器上检查/安装）。
  const installed = await ensureDshInstalled();
  if (!installed) {
    return {
      ok: false,
      kind: 'not-installed',
      reason: '未检测到 DeepSeek Harness (dsh)，且已取消安装。请手动安装后点击“刷新”。'
    };
  }

  // 自动确保 DSH 侧配套插件 dsh-drop-caret 在位（拖文件/代码段插入对话框）。
  const pluginInstalled = await ensureDshPlugins();
  if (pluginInstalled && (await checkUrl(getUrl()))) {
    // 服务已在运行但插件刚装上，需重启 dsh web 才加载。
    vscode.window.showInformationMessage('已自动安装 DSH 插件 dsh-drop-caret，请点击面板顶部的「重启 dsh web」使其生效。');
  }

  const ok = await ensureRunningOnce();
  if (!ok) {
    return {
      ok: false,
      kind: 'unreachable',
      reason: `无法连接 ${getUrl()}，且自动启动未成功（或已关闭自动启动）。`
    };
  }

  // 服务就绪后，尽力把 VSCode 当前工作区注册进 DSH 工作区列表（不阻塞渲染）。
  registerWorkspace().catch(() => {});
  // iframe 用显示地址（远程场景经端口转发），检测/API 仍用服务地址。
  const displayUrl = isTab ? getTabDisplayUrl(await resolveDisplayUrl()) : await resolveDisplayUrl();
  try {
    return { ok: true, html: buildIframeHtml(displayUrl, getFontScale()) };
  } catch (e) {
    // 显示地址无法解析或协议不是 http/https 时，拒绝加载 iframe 并展示错误页。
    return { ok: false, kind: 'unloadable', reason: e.message };
  }
}

async function render(view) {
  // 标签页已接管 DSH 时，侧边栏不再重复加载（避免双 webview 插件加载互斥），显示占位。
  if (activeTab) {
    view.description = '在标签页中打开';
    view.webview.html = buildSuspendedHtml();
    return;
  }
  view.description = getUrl();
  view.webview.html = buildLoadingHtml();
  const r = await preparePanelHtml(false);
  // await 期间视图可能已被关闭；只有仍是当前活动视图时才继续渲染。
  if (activeView !== view) return;
  if (!r.ok) {
    view.description = r.kind === 'not-installed' ? '未安装 dsh' : (r.kind === 'unloadable' ? '无法加载' : '未连接');
    view.webview.html = buildErrorHtml(r.reason);
    return;
  }
  view.description = getUrl();
  view.webview.html = r.html;
}

// =====================================================================
// /dsh ChatParticipant —— 在 Copilot Chat 里提问，由 DSH 执行并流式回写
// =====================================================================
const CHAT_MAP_KEY = 'dsh.chatSessions';
const CHAT_TIMEOUT_DEFAULT = 900000; // 15 分钟

/**
 * 执行 DSH RPC（client-request 信封），成功返回 result.value，失败抛错。
 * @param {string} base
 * @param {string} method
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function dshRpc(base, method, payload, timeoutMs) {
  const body = {
    type: 'client-request',
    rpcId: 'dsh-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    method,
    payload
  };
  const resp = await httpPostJson(base + '/api/' + method, body, timeoutMs || 15000);
  const result = resp && resp.result;
  if (result && result.ok) {
    return result.value;
  }
  const err = result && result.error;
  const msg = (err && (err.message || err.code)) || ('DSH RPC 失败: ' + method);
  throw new Error(msg);
}

/**
 * 把 Copilot 会话历史（ChatRequestTurn / ChatResponseTurn）序列化为文本。
 * @param {any[]} turns
 * @returns {string}
 */
function serializeChatHistory(turns) {
  const out = [];
  for (const t of turns) {
    if (!t) continue;
    if (typeof t.prompt === 'string') {
      out.push('用户：' + t.prompt);
    } else {
      let text = '';
      const resp = t.response;
      if (Array.isArray(resp)) {
        text = resp
          .map((p) => (p && (typeof p.value === 'string' ? p.value : (typeof p.text === 'string' ? p.text : ''))) || '')
          .filter(Boolean)
          .join('\n');
      } else if (typeof resp === 'string') {
        text = resp;
      }
      out.push(text ? '助手：' + text : '助手：（无文本）');
    }
  }
  return out.join('\n\n');
}

/**
 * 提取当前请求里的文件引用（#file / @file 等），转成路径列表文本。
 * @param {any} request
 * @returns {string}
 */
function serializeChatReferences(request) {
  const refs = request && Array.isArray(request.references) ? request.references : [];
  const paths = [];
  for (const ref of refs) {
    try {
      const v = ref && ref.value;
      if (v && typeof v === 'object' && typeof v.fsPath === 'string') {
        paths.push(v.fsPath);
      } else if (v && typeof v === 'object' && v.uri && typeof v.uri.fsPath === 'string') {
        paths.push(v.uri.fsPath);
      } else if (typeof v === 'string' && v.trim()) {
        // 字符串引用只接受"真实路径"：Windows/Unix 绝对路径或 file:// URI 且单行、长度合理。
        // 防止把 VS Code 注入的 <instructions>/<skills>/<agents> 等内容型引用当成文件发进 DSH。
        const s = v.trim();
        const isPath = /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]/.test(s) || /^file:\/\//i.test(s);
        const singleLine = s.indexOf('\n') < 0 && s.indexOf('\r') < 0;
        if (isPath && singleLine && s.length < 1000) {
          paths.push(s);
        }
      }
    } catch (_) { /* 忽略无法序列化的引用 */ }
  }
  const unique = [...new Set(paths)];
  return unique.length ? unique.map((p) => '- ' + p).join('\n') : '';
}

/**
 * 从 step/start 事件提取可展示的进度描述（尽力而为）。
 * @param {any} e
 * @returns {string}
 */
function stepDescription(e) {
  const d = e && e.data;
  if (!d) return '';
  const turn = typeof d.turn === 'number' ? d.turn : null;
  const step = typeof d.step === 'number' ? d.step : null;
  if (turn == null && step == null) return '';
  return '第 ' + (turn != null ? turn : '?') + ' 轮 · 第 ' + (step != null ? step : '?') + ' 步';
}

/**
 * /dsh 主处理函数：把 Copilot 本会话历史 + 当前提问交给 DSH，
 * 轮询 DSH 会话事件流，把 text-delta 增量流式回写进 Copilot 聊天。
 * @param {any} request
 * @param {any} chatContext
 * @param {any} stream
 * @param {any} token
 * @returns {Promise<void>}
 */
async function dshChatHandler(request, chatContext, stream, token) {
  const base = getUrl().replace(/\/+$/, '');
  const workspacePath = getWorkspaceDir();
  try {
    // 0. DSH 服务就绪（复用面板的安装/启动/等待逻辑）
    stream.progress('正在确保 DeepSeek Harness 就绪…');
    const installed = await ensureDshInstalled();
    if (!installed) {
      stream.markdown('❌ 未检测到 DeepSeek Harness (dsh)。请先安装 npm install -g @deepseek-ai/dsh，或打开 DSH 面板触发自动安装。');
      return;
    }
    const running = await ensureRunningOnce();
    if (!running) {
      stream.markdown('❌ 无法连接 DSH 服务（' + getUrl() + '）。请打开 DSH 面板确认其已启动。');
      return;
    }

    // 1. 定位当前 Copilot 聊天并建立 DSH 会话映射：
    //    - 磁盘直读：会话文件 kind:0 的 sessionId 是 Copilot 新会话的唯一标签，
    //      用 sessionId 作映射键 → 新聊天必新建 DSH 会话、同一聊天必复用；
    //    - 定位失败时回退到「首条 @dsh 提问哈希」（可能碰撞，仅兜底）。
    const source = cfg().get('dshPanel.chatSyncSource', 'disk');
    const hist = (chatContext && Array.isArray(chatContext.history)) ? chatContext.history : [];
    let currentChat = null;
    if (source !== 'proxy') {
      currentChat = locateCurrentChatFromDisk(chatContext, request);
    }
    let chatKey = null;
    if (currentChat && currentChat.sessionId) {
      chatKey = 'chat-' + String(currentChat.sessionId);
    }
    if (!chatKey) {
      let seed = (request && request.prompt) || '';
      if (hist.length > 0 && hist[0] && typeof hist[0].prompt === 'string' && hist[0].prompt) {
        seed = hist[0].prompt;
      }
      chatKey = 'chat-' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
    }
    const map = Object.assign({}, gContext.globalState.get(CHAT_MAP_KEY) || {});
    let entry = map[chatKey];
    if (!entry || !entry.dshSessionId || entry.workspacePath !== workspacePath) {
      stream.progress('正在创建新的 DSH 会话…');
      const createPayload = { cwd: workspacePath };
      const preset = cfg().get('dshPanel.chatAgentPreset', '');
      if (preset) createPayload.agentPreset = preset;
      const created = await dshRpc(base, 'session.create', createPayload, 20000);
      entry = {
        dshSessionId: created.sessionId,
        modelSet: false,
        workspacePath
      };
      map[chatKey] = entry;
    } else {
      stream.progress('复用本对话的 DSH 会话：' + entry.dshSessionId);
    }
    await gContext.globalState.update(CHAT_MAP_KEY, map);

    // 2. 可选：按配置把 DSH 会话切换到指定模型（如 DeepSeek v4 pro）
    const provider = cfg().get('dshPanel.chatProvider', '');
    const model = cfg().get('dshPanel.chatModel', '');
    if (provider && model && !entry.modelSet) {
      stream.progress('正在为 DSH 会话选择模型：' + provider + '/' + model + '…');
      try {
        await dshRpc(base, 'session.selectModel', { sessionId: entry.dshSessionId, provider, model }, 20000);
        entry.modelSet = true;
      } catch (e) {
        stream.progress('设置模型失败（' + e.message + '），将使用 DSH 默认模型');
      }
    }

    // 2.5 Copilot 侧对话同步（复用已定位的聊天轮次，不重复解析）
    let interimText = '';
    if (cfg().get('dshPanel.chatSyncInterim', true)) {
      try {
        if (source === 'proxy') {
          if (await ensureProxyRunning()) {
            interimText = await fetchInterimConversation(chatContext);
          }
        } else if (currentChat) {
          interimText = extractInterimFromLocated(currentChat, chatContext, request);
        }
        if (interimText) {
          stream.progress('已同步 Copilot 侧对话（' + interimText.length + ' 字符）');
        }
      } catch (e) {
        console.warn('[DeepSeek Harness] 对话同步失败：', e && e.message);
      }
    }

    // 3. 组装任务文本：中间对话 + 本对话此前 @dsh 问答（context.history）+ 文件引用 + 当前提问
    const parts = [];
    if (interimText) {
      parts.push('【Copilot 侧中间对话（上次 @dsh 之后、你切换到其它模型产生的问答）】\n' + interimText);
    }
    if (hist.length > 0) {
      parts.push('【本对话中此前通过 @dsh 的问答上下文】\n' + serializeChatHistory(hist));
    }
    const refsText = serializeChatReferences(request);
    if (refsText) {
      parts.push('【本次提问相关的文件引用】\n' + refsText);
    }
    parts.push('【当前需要你解决的问题】\n' + ((request && request.prompt) || ''));
    const task = parts.join('\n\n---\n\n');

    // 4. 记录当前会话已有事件的游标（复用会话时避免把旧对话重放回 Copilot）。
    let lastSeq = 0;
    try {
      const pre = await dshRpc(base, 'session.history', { sessionId: entry.dshSessionId }, 15000);
      const preEvents = (pre && Array.isArray(pre.events)) ? pre.events : [];
      for (const item of preEvents) {
        const e = item && item.event ? item.event : item;
        if (e && typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
      }
    } catch (_) { /* 读不到游标就从 0 开始（新会话无旧事件，不影响） */ }

    // 5. 提交给 DSH（异步队列）
    stream.progress('已提交给 DSH' + (provider && model ? '（' + provider + '/' + model + '）' : '（DSH 默认模型）') + '，正在执行…可在 DSH 面板查看实时过程');
    await dshRpc(base, 'session.prompt', {
      sessionId: entry.dshSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: task }]
    }, 30000);
    // 6. 轮询 DSH 会话事件流，text-delta 增量流式回写
    const timeoutMs = Number(cfg().get('dshPanel.chatTimeoutMs', CHAT_TIMEOUT_DEFAULT)) || CHAT_TIMEOUT_DEFAULT;
    const deadline = Date.now() + timeoutMs;
    const pollMs = 1000;
    let pending = '';
    let lastFlush = Date.now();
    let started = false;
    let completed = false;
    let finalText = '';
    let lastAssistantText = '';

    while (Date.now() < deadline) {
      if (token.isCancellationRequested) {
        stream.markdown('\n\n> ⏹ 已停止等待。任务仍在 DSH 中运行，可打开 DSH 面板查看或继续追问。');
        return;
      }
      let hist;
      try {
        hist = await dshRpc(base, 'session.history', { sessionId: entry.dshSessionId }, 15000);
      } catch (e) {
        stream.markdown('\n\n> ⚠️ 读取 DSH 任务状态失败：' + e.message + '（任务可能仍在运行，可到 DSH 面板查看）');
        break;
      }
      const events = (hist && Array.isArray(hist.events)) ? hist.events : [];
      for (const item of events) {
        const e = item && item.event ? item.event : item;
        if (!e || typeof e.seq !== 'number' || e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        if (e.type === 'turn/start') {
          started = true;
        } else if (e.type === 'step/start' && started) {
          const desc = stepDescription(e);
          stream.progress(desc ? 'DSH 执行中：' + desc : 'DSH 执行中…');
        } else if (e.type === 'assistant/chunk' && started && e.data && e.data.chunk) {
          const c = e.data.chunk;
          if (c.type === 'text-delta' && typeof c.text === 'string' && c.text.length > 0) {
            pending += c.text;
            finalText += c.text;
            if (pending.length >= 80 || (Date.now() - lastFlush) >= 1500) {
              stream.markdown(pending);
              pending = '';
              lastFlush = Date.now();
            }
          }
        } else if (e.type === 'assistant/message' && e.data && e.data.message) {
          const blocks = (e.data.message.content || [])
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text);
          const joined = blocks.join('');
          if (joined) lastAssistantText = joined;
        } else if (e.type === 'turn/end' && started) {
          if (pending) {
            stream.markdown(pending);
            pending = '';
          }
          completed = true;
          const reason = e.data && e.data.reason;
          if (reason && reason.kind !== 'completed') {
            const errDesc = reason.error
              ? (reason.error.code + ': ' + reason.error.message)
              : reason.kind;
            stream.markdown('\n\n> ⚠️ DSH 任务未正常完成（' + errDesc + '）。可打开 DSH 面板查看详细过程。');
          }
          break;
        }
      }
      if (completed) break;
      await sleep(pollMs);
    }

    if (!completed && !token.isCancellationRequested) {
      if (!finalText && lastAssistantText) {
        stream.markdown(lastAssistantText);
      }
      stream.markdown('\n\n> ⏱ 超过等待上限（' + Math.round(timeoutMs / 60000) + ' 分钟）仍未完成。任务仍在 DSH 面板中运行，可稍后查看，或调大 dshPanel.chatTimeoutMs。');
    }

    await gContext.globalState.update(CHAT_MAP_KEY, map);
  } catch (e) {
    stream.markdown('❌ /dsh 执行出错：' + (e && e.message ? e.message : String(e)));
  }
}


// =====================================================================
// 磁盘直读：解析 VS Code 私有的 chatSessions/*.jsonl 会话文件
// 优点：不动任何模型配置（无代理依赖），卸载扩展零残留
// =====================================================================

/**
 * 解析一个会话 .jsonl 文件，回放 kind:0/kind:2 补丁。
 * 轮次结构：{ ts, agent, model, user, assistant }
 * @param {string} filePath
 * @returns {{ sessionId: string|null, turns: any[] }}
 */
function parseChatSessionFile(filePath) {
  const turns = [];
  let sessionId = null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    let state = null;
    const seen = new Set();
    for (const line of lines) {
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (j && j.kind === 0 && j.v) {
        state = j.v;
        sessionId = (j.v && typeof j.v.sessionId === 'string') ? j.v.sessionId : null;
      }
      if (!state) continue;
      if (!Array.isArray(state.requests)) state.requests = [];
      if (j && j.kind === 2 && Array.isArray(j.k) && j.k[0] === 'requests') {
        if (j.k.length === 1 && Array.isArray(j.v)) {
          // k:["requests"] → 追加新请求
          for (const r of j.v) {
            if (r && r.requestId) state.requests.push(r);
          }
        } else if (j.k.length === 3 && typeof j.k[1] === 'number' && j.k[2] === 'response' && Array.isArray(j.v)) {
          // k:["requests",i,"response"] → 把回复补进第 i 个请求
          const idx = j.k[1];
          if (state.requests[idx]) state.requests[idx].response = j.v;
        }
      }
    }
    for (const req of state.requests || []) {
      if (!req || !req.requestId || seen.has(req.requestId)) continue;
      seen.add(req.requestId);
      const user = (req.message && (typeof req.message.text === 'string'
        ? req.message.text
        : (req.message.parts && req.message.parts[0] && req.message.parts[0].text))) || '';
      const assistant = ((req.response || [])
        .map((p) => (p && typeof p.value === 'string' ? p.value : ''))
        .filter(Boolean))
        .join('\n');
      turns.push({
        ts: typeof req.timestamp === 'number' ? req.timestamp : 0,
        agent: (req.agent && req.agent.id) || '',
        model: req.modelId || '',
        user,
        assistant
      });
    }
  } catch (e) {
    console.warn('[DeepSeek Harness] 解析会话文件失败：', filePath, e && e.message);
  }
  return { sessionId, turns };
}

/**
 * 枚举最近修改的会话文件（工作区窗口 + 空窗口）。
 * @returns {{file: string, mtimeMs: number}[]} 按修改时间倒序。
 */
function listChatSessionFiles() {
  const out = [];
  const now = Date.now();
  const lookbackMs = (Number(cfg().get('dshPanel.chatSyncLookbackMin', 60)) || 60) * 60 * 1000;
  const userDirs = [];
  if (process.platform === 'win32') {
    userDirs.push(path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User'));
  }
  userDirs.push(path.join(os.homedir(), '.config', 'Code', 'User'));
  const roots = [];
  for (const u of userDirs) {
    const ws = path.join(u, 'workspaceStorage');
    try {
      for (const d of fs.readdirSync(ws)) {
        const p = path.join(ws, d, 'chatSessions');
        if (fs.existsSync(p)) roots.push(p);
      }
    } catch (_) { /* 不存在则跳过 */ }
    const empty = path.join(u, 'globalStorage', 'emptyWindowChatSessions');
    if (fs.existsSync(empty)) roots.push(empty);
  }
  for (const dir of roots) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs < lookbackMs) out.push({ file: fp, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * 轮次文本序列化（去掉 @dsh 前缀，跳过垃圾内容）。
 * @param {any[]} turns
 * @returns {string}
 */
function serializeDiskTurns(turns) {
  const out = [];
  for (const t of turns) {
    if (!t) continue;
    const u = (t.user || '').trim().replace(/^\s*@dsh\s+/i, '');
    const a = (t.assistant || '').trim();
    if (u && !isJunkUserText(u)) out.push('用户：' + u);
    if (a) out.push('助手：' + a);
  }
  return out.join('\n\n');
}

/**
 * 磁盘直读同步：定位当前聊天会话文件，提取对话内容。
 * - 有 @dsh 历史：用「最后一次 @dsh 提问」定位，取其后（中间对话增量）；
 * - 首次 @dsh：当前请求已写在会话文件末尾（agent=dsh 且 user 匹配当前提问），
 *   取其前全部自定义模型问答 = 整个对话窗口的完整补课；
 *   回退：取最近一条含自定义模型轮次的会话的全部轮次。
 * @param {any} chatContext
 * @param {any} request
 * @returns {Promise<string>}
 */
function diskMatchUser(t, p) {
  const q = String(p || '').trim();
  if (!q || !t || !t.user) return false;
  const u = t.user.trim();
  return u === q || u === '@dsh ' + q || u.endsWith(q);
}

function diskAnchorPrompts(chatContext) {
  const hist = (chatContext && Array.isArray(chatContext.history)) ? chatContext.history : [];
  const anchors = [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = hist[i];
    if (t && typeof t.prompt === 'string' && t.prompt) { anchors.push(t.prompt); break; }
  }
  if (hist.length > 0 && hist[0] && typeof hist[0].prompt === 'string' && hist[0].prompt && !anchors.includes(hist[0].prompt)) {
    anchors.push(hist[0].prompt);
  }
  return anchors;
}

/**
 * 定位当前 Copilot 聊天：会话文件 kind:0 的 sessionId 是 Copilot 新会话的唯一标签，
 * 用「当前 @dsh 提问 / 上次 @dsh 提问」在文件轮次中精确匹配（有的放矢，非盲扫）。
 * @param {any} chatContext
 * @param {any} request
 * @returns {{ sessionId: string|null, turns: any[], anchorIdx: number } | null}
 */
function locateCurrentChatFromDisk(chatContext, request) {
  try {
    const prompt = (request && request.prompt) || '';
    const sessions = listChatSessionFiles()
      .map((f) => {
        const p = parseChatSessionFile(f.file);
        return { mtimeMs: f.mtimeMs, sessionId: p.sessionId, turns: p.turns };
      })
      .filter((s) => s.turns.length > 0);

    if (diskAnchorPrompts(chatContext).length > 0) {
      for (const anchor of diskAnchorPrompts(chatContext)) {
        for (const s of sessions) {
          for (let i = s.turns.length - 1; i >= 0; i--) {
            if (s.turns[i].agent === 'dsh' && diskMatchUser(s.turns[i], anchor)) {
              return { sessionId: s.sessionId, turns: s.turns, anchorIdx: i };
            }
          }
        }
      }
      return null;
    }
    // 首次 @dsh：当前请求已写入会话文件末尾（agent=dsh 且提问匹配）
    for (const s of sessions) {
      const last = s.turns[s.turns.length - 1];
      if (last && last.agent === 'dsh' && diskMatchUser(last, prompt)) {
        return { sessionId: s.sessionId, turns: s.turns, anchorIdx: s.turns.length - 1 };
      }
    }
    // 回退：最近一条含自定义模型轮次的会话（仅用于补课；sessionId 置 null 不作映射键）
    for (const s of sessions) {
      if (s.turns.some((t) => t.agent !== 'dsh' && t.user)) {
        return { sessionId: null, turns: s.turns, anchorIdx: -1 };
      }
    }
    return null;
  } catch (e) {
    console.warn('[DeepSeek Harness] 定位当前聊天失败：', e && e.message);
    return null;
  }
}

/**
 * 从已定位的聊天轮次中提取要注入 DSH 的对话内容。
 * @param {{ sessionId: string|null, turns: any[], anchorIdx: number }} located
 * @param {any} chatContext
 * @param {any} request
 * @returns {string}
 */
function extractInterimFromLocated(located, chatContext, request) {
  const maxChars = Number(cfg().get('dshPanel.chatSyncMaxChars', 500000)) || 500000;
  const turns = (located && Array.isArray(located.turns)) ? located.turns : [];
  if (!turns.length) return '';
  const anchors = diskAnchorPrompts(chatContext);
  if (anchors.length > 0) {
    for (const anchor of anchors) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].agent === 'dsh' && diskMatchUser(turns[i], anchor)) {
          return compressChatText(serializeDiskTurns(turns.slice(i + 1)), maxChars);
        }
      }
    }
    return '';
  }
  const prompt = (request && request.prompt) || '';
  const last = turns[turns.length - 1];
  if (last && last.agent === 'dsh' && diskMatchUser(last, prompt)) {
    return compressChatText(serializeDiskTurns(turns.slice(0, -1)), maxChars);
  }
  return compressChatText(serializeDiskTurns(turns.filter((t) => t.agent !== 'dsh' && t.user)), maxChars);
}

// =====================================================================
// DSH 语言模型提供方（v0.7.0）：把 DSH 注册为 VS Code 聊天模型，
// 模型选择器中出现「DSH (DeepSeek Harness)」——选中它，VS Code 会把
// 组织好的完整对话直接交给扩展（含 VS Code 负责的 compact），
// 过滤杂音后转发 DSH 执行，流式回写。卸载扩展零残留。
// =====================================================================

const DSH_MODEL_MAP_KEY = 'dsh.modelSessions';

/**
 * 提取消息列表里第一个/最后一个/倒数第二个真实用户提问。
 * 注意：记忆块消息（【Copilot 记忆】开头）不是提问，跳过。
 */
function firstLmQuestionText(messages) {
  for (const m of messages || []) {
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (full.startsWith('用户：')) return full.slice(3).trim();
  }
  return '';
}

function lastLmUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (full.startsWith('用户：')) return full.slice(3).trim();
  }
  return '';
}

function prevLmUserText(messages) {
  let seen = 0;
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (!full.startsWith('用户：')) continue;
    const t = full.slice(3).trim();
    if (!t) continue;
    seen++;
    if (seen === 2) return t;
  }
  return '';
}

function findLmUserIndex(messages, lastUserText) {
  if (!lastUserText) return -1;
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (full.startsWith('用户：') && full.slice(3).trim() === lastUserText) return i;
  }
  return -1;
}

/**
 * 从磁盘会话文件中定位当前聊天（当前提问已落盘为最后一条请求）。
 * @param {string} currentPrompt
 * @returns {string|null}
 */
function locateModelChatSessionId(currentPrompt) {
  const q = String(currentPrompt || '').trim();
  if (!q) return null;
  try {
    const sessions = listChatSessionFiles()
      .map((f) => {
        const p = parseChatSessionFile(f.file);
        return { sessionId: p.sessionId, turns: p.turns };
      })
      .filter((s) => s.turns.length > 0);
    for (const s of sessions) {
      const last = s.turns[s.turns.length - 1];
      if (last && last.user) {
        const u = last.user.trim();
        if (u === q || u === '@dsh ' + q || u.endsWith(q)) return s.sessionId;
      }
    }
  } catch (_) { /* 定位失败回退哈希键 */ }
  return null;
}

/**
 * 构造文本响应 part（优先用官方类，兼容旧版本回落普通对象）。
 * @param {string} text
 * @returns {any}
 */
function makeTextPart(text) {
  try {
    if (vscode.LanguageModelTextPart) {
      return new vscode.LanguageModelTextPart(String(text));
    }
  } catch (_) { /* 回落 */ }
  return { type: 'text', value: String(text) };
}

/**
 * 单条消息 → 纯对话文本（过滤系统提示词/工具/环境等 harness 噪音）。
 * @param {any} m
 * @returns {string}
 */
/**
 * 提取 Copilot 记忆注入块（userMemory/sessionMemory/repoMemory）的正文——
 * 这些是 Copilot 侧独有的有效记忆，只去掉 XML 包装与"空"提示，转纯文本保留。
 * @param {string} t
 * @returns {string}
 */
function extractMemoryBlocks(t) {
  const re = /<(userMemory|sessionMemory|repoMemory)>\s*([\s\S]*?)\s*<\/\1>/g;
  const parts = [];
  let m;
  while ((m = re.exec(t))) {
    let inner = m[2].trim();
    // 去掉 Copilot 的说明性引言（如 "The following are your persistent user memory notes..."），
    // 只保留实际记忆正文（从第一个 markdown 标题开始）
    const lines = inner.split('\n');
    const headIdx = lines.findIndex((l) => /^\s*#{1,6}\s/.test(l));
    if (headIdx > 0) inner = lines.slice(headIdx).join('\n').trim();
    if (!inner) continue;
    if (/is empty\.|no [^.]+ notes have been created/i.test(inner)) continue; // 跳过"空"提示
    parts.push(inner);
  }
  return parts.join('\n\n');
}

/**
 * 剥离 VS Code 注入的垃圾块前缀（context/reminderInstructions/environment 等），
 * 保留其后的真实内容（用户提问可能混在同一条消息的尾部）。
 * @param {string} t
 * @returns {string}
 */
function stripJunkPrefix(t) {
  const markers = ['</reminderInstructions>', '</editorContext>', '</context>', '</environment_info>', '</workspace_info>', '</instructions>', '</skills>', '</agents>', '</user_info>', '</userMemory>', '</sessionMemory>', '</repoMemory>'];
  let idx = -1;
  for (const marker of markers) {
    const i = t.lastIndexOf(marker);
    if (i >= 0 && i + marker.length > idx) idx = i + marker.length;
  }
  if (idx > 0) {
    const rest = t.slice(idx).trim();
    // 尾注本身就是 VS Code 元信息（如 "This is the state of the context..."）→ 丢弃
    if (/^This is the state of the context/i.test(rest)) return '';
    if (rest) return rest;
  }
  return '';
}

function lmMessageText(m) {
  const role = m && m.role;
  const isUser = role === 'user' || role === 1 || role === 'User';
  const isAssistant = role === 'assistant' || role === 2 || role === 'Assistant';
  if (!isUser && !isAssistant) return ''; // system(role=3)/tool 等一律忽略（DSH 有自己的 harness）
  let text = '';
  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    text = m.content
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p.value === 'string') return p.value;
        if (typeof p.content === 'string') return p.content;
        if (typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (!text.trim()) return '';
  if (isUser) {
    // 环境/工作区快照消息：整条丢弃（DSH 有实时文件访问，静态快照无用；尾注也是 VS Code 元信息）
    if (/^\s*<(environment_info|workspace_info)>/.test(text)) return '';
    // 保留 Copilot 独有记忆（userMemory/sessionMemory/repoMemory 的正文，去掉 XML 包装）
    const memText = extractMemoryBlocks(text);
    if (memText) {
      const rest = text.replace(/<(userMemory|sessionMemory|repoMemory)>\s*[\s\S]*?\s*<\/\1>/g, '').trim();
      if (rest) {
        const innerQ = extractUserRequest(rest);
        return '【Copilot 记忆】\n' + memText + '\n\n用户：' + (innerQ !== null ? innerQ : rest);
      }
      return '【Copilot 记忆】\n' + memText;
    }
    // 优先提取 <userRequest> 内的真实提问
    const inner = extractUserRequest(text);
    if (inner !== null) return '用户：' + inner;
    // 垃圾块开头：剥离前缀保留尾部真实内容，而不是整条丢弃
    if (isJunkUserText(text)) {
      const stripped = stripJunkPrefix(text);
      if (stripped) return '用户：' + stripped;
      return '';
    }
    return '用户：' + text;
  }
  // 助手消息：剥掉我们上一轮发出的「⏳ 已提交给 DeepSeek Harness…」占位前缀，
  // 避免它作为对话上下文回传给 DSH（保留其后真正的回答内容）
  {
    const marker = '⏳ 已提交给 DeepSeek Harness';
    const mi = text.indexOf(marker);
    if (mi >= 0) {
      const nl = text.indexOf('\n\n', mi + marker.length);
      if (nl >= 0) {
        text = text.slice(nl + 2);
      } else {
        text = '';
      }
    }
  }
  if (!text.trim()) return '';
  return '助手：' + text;
}

/**
 * 把 VS Code 交给模型的消息列表序列化为纯对话文本。
 * @param {any[]} messages
 * @returns {string}
 */
function serializeLmMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const s = lmMessageText(m);
    if (s) out.push(s);
  }
  return out.join('\n\n');
}

/**
 * 识别 VS Code 的 UI 辅助合成请求（进度文案/标题生成等），返回 { kind, count, scenario, titleSeed } 或 null。
 * 这些请求不是用户提问，不应转发给 DSH。
 * @param {any[]} messages
 * @returns {any|null}
 */
function detectSyntheticRequest(messages) {
  const q = lastLmUserText(messages);
  if (!q) return null;
  let m = q.match(/generate exactly (\d+) unique progress messages for the "([^"]+)" scenario/i);
  if (m) return { kind: 'progress', count: parseInt(m[1], 10) || 10, scenario: m[2] || 'task' };
  m = q.match(/write a brief title for the following request[:：]\s*([\s\S]*)/i);
  if (m) return { kind: 'title', titleSeed: (m[1] || '').trim() };
  if (/^Please generate/i.test(q) || /^Return only a JSON array/i.test(q)) {
    return { kind: 'generic' };
  }
  return null;
}

const SYNTHETIC_PROGRESS_TEXTS = {
  'edit code': ['正在读取文件…', '正在分析代码结构…', '正在生成修改方案…', '正在编辑文件…', '正在校验修改…', '正在应用更改…', '正在检查语法…', '正在运行测试…', '正在复查结果…', '即将完成…'],
  'generate code': ['正在理解需求…', '正在设计结构…', '正在生成代码…', '正在组织模块…', '正在补充细节…', '正在检查语法…', '正在优化逻辑…', '正在生成测试…', '正在复查结果…', '即将完成…']
};

/**
 * dsh 语言模型提供方的请求处理。
 * @param {any[]} messages
 * @param {any} progress Progress<LanguageModelResponsePart>
 * @param {any} token CancellationToken
 * @returns {Promise<void>}
 */
async function handleDshModelRequest(messages, options, progress, token) {
  const base = getUrl().replace(/\/+$/, '');
  const provider = cfg().get('dshPanel.chatProvider', '');
  const model = cfg().get('dshPanel.chatModel', '');
  try {
    // 合成请求（VS Code UI 辅助）：本地秒答，不转发 DSH、不建 DSH 会话
    const synthetic = detectSyntheticRequest(messages);
    if (synthetic) {
      if (synthetic.kind === 'progress') {
        const texts = SYNTHETIC_PROGRESS_TEXTS[synthetic.scenario]
          || Array.from({ length: Math.min(synthetic.count, 10) }, (_, i) => '正在处理（' + (i + 1) + '/' + Math.min(synthetic.count, 10) + '）…');
        progress.report(makeTextPart(JSON.stringify(texts.slice(0, Math.min(synthetic.count, 10)))));
      } else if (synthetic.kind === 'title') {
        const title = (synthetic.titleSeed || 'DeepSeek Harness 对话').slice(0, 40);
        progress.report(makeTextPart(title));
      } else {
        progress.report(makeTextPart('[]'));
      }
      return;
    }
    const installed = await ensureDshInstalled();
    if (!installed) {
      progress.report(makeTextPart('❌ 未检测到 DeepSeek Harness (dsh)。请安装 npm install -g @deepseek-ai/dsh，或打开 DSH 面板触发自动安装。'));
      return;
    }
    const running = await ensureRunningOnce();
    if (!running) {
      progress.report(makeTextPart('❌ 无法连接 DSH 服务（' + getUrl() + '）。请打开 DSH 面板确认其已启动。'));
      return;
    }

    const fullConvText = serializeLmMessages(messages);

    // 调试捕获：把 VS Code 交给模型的消息结构原样落盘（排查序列化问题用）
    if (cfg().get('dshPanel.debugModelMessages', false)) {
      try {
        const debugDir = path.join(getWorkspaceDir(), '.dsh-debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const dump = {
          ts: Date.now(),
          options: {
            modelOptionsKeys: (options && options.modelOptions) ? Object.keys(options.modelOptions) : [],
            toolsCount: (options && Array.isArray(options.tools)) ? options.tools.length : 0
          },
          messages: (messages || []).map((m) => ({
            role: m.role,
            name: m.name,
            parts: Array.isArray(m.content)
              ? m.content.map((p) => {
                  if (p == null) return null;
                  const o = (typeof p === 'object' && p !== null) ? p : null;
                  return {
                    ctor: (o && o.constructor && o.constructor.name) || typeof p,
                    keys: o ? Object.keys(o) : [],
                    value: o && typeof o.value === 'string' ? o.value : undefined,
                    content: o && typeof o.content === 'string' ? o.content : undefined,
                    text: o && typeof o.text === 'string' ? o.text : undefined
                  };
                })
              : (typeof m.content === 'string' ? m.content : null)
          })),
          convText: fullConvText
        };
        fs.writeFileSync(path.join(debugDir, 'lm-messages-' + Date.now() + '.json'), JSON.stringify(dump, null, 2), 'utf8');
      } catch (e) {
        console.warn('[DeepSeek Harness] 写模型消息调试文件失败：', e && e.message);
      }
    }

    // 聊天身份 → DSH 会话映射：同一 Copilot 聊天复用同一 DSH 会话（磁盘 sessionId 优先，哈希兜底）
    const workspacePath = getWorkspaceDir();
    const currentPrompt = lastLmUserText(messages);
    const map = Object.assign({}, gContext.globalState.get(DSH_MODEL_MAP_KEY) || {});
    const diskId = locateModelChatSessionId(currentPrompt);
    const chatKey = diskId
      ? ('m-' + String(diskId))
      : ('m-' + crypto.createHash('sha1').update(firstLmQuestionText(messages) || currentPrompt || 'first').digest('hex').slice(0, 16));
    let entry = map[chatKey];
    // 跨键容错：按 chatKey 没找到时（首轮哈希兜底、后续轮拿到磁盘 sessionId 等混用情况），
    // 用「上一个提问」在映射表里找回属于同一聊天的条目。
    if (!entry || !entry.dshSessionId || entry.workspacePath !== workspacePath) {
      const prevPrompt = prevLmUserText(messages);
      if (prevPrompt) {
        for (const k of Object.keys(map)) {
          const e = map[k];
          if (e && e.dshSessionId && e.workspacePath === workspacePath && e.lastUserText === prevPrompt) {
            entry = e;
            map[chatKey] = e; // 登记到当前键下，后续保持一致
            break;
          }
        }
      }
    }
    let sid = null;
    let taskText = fullConvText;
    let isNewSession = false;
    if (entry && entry.dshSessionId && entry.workspacePath === workspacePath) {
      sid = entry.dshSessionId;
      // 增量：找到上次已发的用户提问，只发其后新增的消息（DSH 会话自累积上下文）
      const idx = findLmUserIndex(messages, entry.lastUserText);
      if (idx >= 0) {
        const delta = serializeLmMessages((messages || []).slice(idx + 1));
        if (delta.trim()) taskText = delta;
      }
      // 找不到上次提问（消息被编辑等）则用全量（重复但正确）
    } else {
      const createPayload = { cwd: workspacePath };
      const preset = cfg().get('dshPanel.chatAgentPreset', '');
      if (preset) createPayload.agentPreset = preset;
      const created = await dshRpc(base, 'session.create', createPayload, 20000);
      sid = created.sessionId;
      isNewSession = true;
      entry = { dshSessionId: sid, workspacePath, lastUserText: '' };
      map[chatKey] = entry;
      if (provider && model) {
        try {
          await dshRpc(base, 'session.selectModel', { sessionId: sid, provider, model }, 20000);
        } catch (_) { /* 选择失败则用 DSH 默认模型 */ }
      }
    }
    entry.lastUserText = currentPrompt;
    await gContext.globalState.update(DSH_MODEL_MAP_KEY, map);
    if (!taskText.trim()) taskText = '用户：' + currentPrompt;
    // 先取事件游标（必须在提交任务之前，避免把 turn/start 一并吃掉导致流式判定失效）
    const timeoutMs = Number(cfg().get('dshPanel.chatTimeoutMs', 900000)) || 900000;
    const deadline = Date.now() + timeoutMs;
    let lastSeq = 0;
    let started = false;
    try {
      const pre = await dshRpc(base, 'session.history', { sessionId: sid }, 15000);
      const preEvents = (pre && Array.isArray(pre.events)) ? pre.events : [];
      for (const item of preEvents) {
        const e = item && item.event ? item.event : item;
        if (e && typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
      }
    } catch (_) { /* 读不到游标从 0 开始 */ }

    await dshRpc(base, 'session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: taskText }]
    }, 30000);
    progress.report(makeTextPart('⏳ 已提交给 DeepSeek Harness' + (provider && model ? '（' + provider + '/' + model + '）' : '（默认模型）') + (isNewSession ? '（新会话）' : '（续聊）') + '，正在执行…\n\n'));
    console.log('[DeepSeek Harness] dsh 模型请求已提交，session=' + sid);

    while (Date.now() < deadline) {
      if (token.isCancellationRequested) {
        progress.report(makeTextPart('\n\n> ⏹ 已停止等待。任务仍在 DSH 中运行，可到 DSH 面板查看。'));
        return;
      }
      let hist;
      try {
        hist = await dshRpc(base, 'session.history', { sessionId: sid }, 15000);
      } catch (e) {
        progress.report(makeTextPart('\n\n> ⚠️ 读取 DSH 任务状态失败：' + e.message + '（任务可能仍在运行，可到 DSH 面板查看）'));
        return;
      }
      const events = (hist && Array.isArray(hist.events)) ? hist.events : [];
      for (const item of events) {
        const e = item && item.event ? item.event : item;
        if (!e || typeof e.seq !== 'number' || e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        if (e.type === 'turn/start') {
          started = true;
        } else if (e.type === 'assistant/chunk' && e.data && e.data.chunk) {
          const c = e.data.chunk;
          if (c.type === 'text-delta' && typeof c.text === 'string' && c.text.length > 0) {
            if (!started) started = true; // 防御：错过 turn/start 也照常流式
            progress.report(makeTextPart(c.text));
          }
        } else if (e.type === 'turn/end') {
          started = true; // 防御：即使错过 turn/start 也正常结束
          const reason = e.data && e.data.reason;
          if (reason && reason.kind !== 'completed') {
            const errDesc = reason.error ? (reason.error.code + ': ' + reason.error.message) : reason.kind;
            progress.report(makeTextPart('\n\n> ⚠️ DSH 任务未正常完成（' + errDesc + '）。可到 DSH 面板查看。'));
          }
          console.log('[DeepSeek Harness] dsh 模型请求完成');
          return;
        }
      }
      await sleep(1000);
    }
    progress.report(makeTextPart('\n\n> ⏱ 超过等待上限（' + Math.round(timeoutMs / 60000) + ' 分钟）仍未完成。任务仍在 DSH 面板运行。'));
  } catch (e) {
    progress.report(makeTextPart('❌ DSH 模型执行出错：' + (e && e.message ? e.message : String(e))));
  }
}

/**
 * 注册 dsh 语言模型提供方（VS Code 1.94+，vscode.lm）。
 * @param {import('vscode').ExtensionContext} context
 */
function registerDshModelProvider(context) {
  if (!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
    console.warn('[DeepSeek Harness] vscode.lm 不可用，跳过 dsh 语言模型提供方注册');
    return;
  }
  if (!cfg().get('dshPanel.enableDshModel', true)) return;
  try {
    const provider = {
      provideLanguageModelChatInformation(_options, _token) {
        return [{
          id: 'dsh',
          name: 'DSH (DeepSeek Harness)',
          family: 'dsh',
          version: '0.7.0',
          detail: '由 DeepSeek Harness 在工作区执行工具后解答',
          maxInputTokens: 250000,
          maxOutputTokens: 128000,
          // toolCalling 声明为 true：Agent 模式的模型选择器只列出支持工具的模型。
          // DSH 用自己的工具执行，VS Code 传入的工具（options.tools）一律忽略、不返回工具调用，无冲突。
          capabilities: { toolCalling: true, imageInput: false }
        }];
      },
      provideLanguageModelChatResponse(_model, messages, options, progress, token) {
        return handleDshModelRequest(messages, options, progress, token);
      },
      provideTokenCount(_model, text, _token) {
        const s = typeof text === 'string' ? text : (text && text.value ? text.value : '');
        return Promise.resolve(Math.max(1, Math.ceil(String(s).length / 3)));
      }
    };
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('dsh', provider));
    dshModelProviderRegistered = true;
    console.log('[DeepSeek Harness] dsh 语言模型提供方已注册（模型选择器可见）');
  } catch (e) {
    console.error('[DeepSeek Harness] 注册 dsh 语言模型提供方失败：', e);
  }
}

/**
 * 注册 /dsh ChatParticipant（VS Code 1.94+，需已安装 GitHub Copilot Chat）。
 * @param {import('vscode').ExtensionContext} context
 */
function registerChatParticipant(context) {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
    console.warn('[DeepSeek Harness] vscode.chat.createChatParticipant 不可用（未安装 Copilot Chat 或 VS Code 版本过低），/dsh 未注册。可用「DeepSeek Harness: 检查 /dsh 状态」查看详情。');
    return;
  }
  try {
    const participant = vscode.chat.createChatParticipant('dsh', dshChatHandler);
    try {
      participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    } catch (_) { /* icon 可选 */ }
    participant.description = 'DSH：由 DeepSeek Harness 在工作区分析数据、执行工具后解答';
    try { participant.isSticky = true; } catch (_) { /* 新版本可选字段 */ }
    context.subscriptions.push(participant);
    chatParticipantRegistered = true;
    console.log('[DeepSeek Harness] /dsh ChatParticipant 已注册');
  } catch (e) {
    console.error('[DeepSeek Harness] 注册 /dsh ChatParticipant 失败：', e);
  }
}

/**
 * 「检查 /dsh 状态」诊断命令：报告 chat API 可用性、参与者注册情况、DSH 连通性与当前模型配置。
 */
async function showChatStatus() {
  const hasChat = !!(vscode.chat && typeof vscode.chat.createChatParticipant === 'function');
  const reachable = await checkUrl(getUrl());
  const provider = cfg().get('dshPanel.chatProvider', '');
  const model = cfg().get('dshPanel.chatModel', '');
  const lines = [
    'DeepSeek Harness /dsh 状态',
    'chat API 可用: ' + (hasChat ? '是' : '否'),
    '/dsh 参与者已注册: ' + (chatParticipantRegistered ? '是' : '否'),
    'DSH 服务可达: ' + (reachable ? '是 (' + getUrl() + ')' : '否'),
    '模型配置: provider=' + (provider || '(跟随 DSH 默认)') + ' / model=' + (model || '(跟随 DSH 默认)'),
    '已映射聊天数: ' + Object.keys(gContext.globalState.get(CHAT_MAP_KEY) || {}).length,
    '对话同步来源: ' + (cfg().get('dshPanel.chatSyncSource', 'disk') === 'proxy' ? '代理' : '磁盘直读'),
    '对话同步开关: ' + (cfg().get('dshPanel.chatSyncInterim', true) ? '开启' : '关闭'),
    'dsh 语言模型提供方: ' + (dshModelProviderRegistered ? '已注册（模型选择器可见）' : '未注册')
  ];
  if (!hasChat) {
    lines.push('');
    lines.push('提示: 当前环境没有可用的 Chat API，/dsh 无法注册。');
    lines.push('请确认安装了官方 GitHub Copilot Chat，或使用 VS Code 内置 Chat 视图的兼容 provider。');
  } else if (!chatParticipantRegistered) {
    lines.push('');
    lines.push('提示: chat API 可用但注册失败，请查看 Output → Extension Host 日志。');
  } else {
    lines.push('');
    lines.push('正常: 在 Chat 面板 (Ctrl+Alt+I) 输入 /dsh 即可调用。');
  }
  vscode.window.showInformationMessage(lines.join('\n'), { modal: false });
}

function activate(context) {
  gContext = context;
  registerChatParticipant(context);
  registerDshModelProvider(context);

  // 启动本地 Copilot 消息代理（后台静默）：保证指向代理的 DeepSeek 模型随时可用。
  if (cfg().get('dshPanel.chatProxyAutoStart', true)) {
    ensureProxyRunning().catch(() => {});
  }

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
      view.webview.onDidReceiveMessage(handleWebviewMessage);

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

  // 编辑器标签页模式：在编辑器区域以标签页打开 DSH（页面宽度最大化、可右键 Pin 住）。
  // 复用侧边栏的渲染与消息逻辑，单例：已打开则聚焦，未打开则新建。
  const openInTabCmd = vscode.commands.registerCommand('dshPanel.openInTab', async () => {
    if (activeTab) {
      activeTab.reveal();
      return;
    }
    // 在当前活跃编辑器所在的列打开（不另开一栏）；无活跃编辑器时用第一列。
    const column = (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn) || vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      'dsh.tab',
      'DeepSeek Harness',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    activeTab = panel;
    // 标签页接管 DSH：侧边栏若已打开则改为占位，避免双 webview 同时加载 DSH 互斥。
    if (activeView) {
      activeView.description = '在标签页中打开';
      activeView.webview.html = buildSuspendedHtml();
    }
    let disposed = false;
    const reloadTab = async () => {
      if (disposed) return;
      panel.webview.html = buildLoadingHtml();
      try {
        const r = await preparePanelHtml(true);
        if (disposed) return;
        panel.webview.html = r.ok ? r.html : buildErrorHtml(r.reason);
      } catch (e) {
        if (disposed) return;
        console.error('[DeepSeek Harness] 标签页渲染失败：', e);
        panel.webview.html = buildErrorHtml('标签页渲染失败：' + (e && e.message ? e.message : String(e)));
      }
    };

    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (disposed) return;
      if (e.affectsConfiguration('dshPanel')) {
        reloadTab();
      } else if (e.affectsConfiguration('editor.fontSize')) {
        // 仅字号变化时不重载 iframe（避免打断当前对话），只推送新的缩放值。
        panel.webview.postMessage({ type: 'dsh-font-scale', scale: getFontScale() });
      }
    });

    panel.onDidDispose(() => {
      disposed = true;
      cfgSub.dispose();
      if (activeTab === panel) activeTab = null;
      // 标签页关闭后，恢复侧边栏（若侧边栏仍存在）。
      if (activeView) {
        render(activeView);
      }
    });
    panel.webview.onDidReceiveMessage(handleWebviewMessage);

    await reloadTab();
  });

  const refreshCmd = vscode.commands.registerCommand('dshPanel.refresh', () => {
    if (activeView) {
      // 始终重载面板页面：render 会重建 iframe 重新加载 DSH Web GUI；
      // 服务在线时 ensureRunningOnce 仅复用不重启，不影响 dsh web 进程与运行中的任务。
      render(activeView);
    } else {
      vscode.window.showInformationMessage('DeepSeek Harness 面板尚未打开，请先点击侧边栏图标。');
    }
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
    // 发送目标：优先编辑器标签页，其次侧边栏面板。
    const target = activeTab || activeView;
    if (!editor || !target) {
      vscode.window.showWarningMessage('请先打开 DeepSeek Harness 面板或标签页并选中代码');
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
    
    const ok = await target.webview.postMessage({
      type: 'insert-selection',
      filePath: filePath,
      startLine: startLine,
      endLine: endLine,
      content: selectedText,
      language: document.languageId
    });

    if (ok) {
      vscode.window.showInformationMessage('已发送选中内容到 DSH，等待面板转发…');
    } else {
      vscode.window.showErrorMessage('发送失败：DSH 面板 webview 未就绪，请先打开面板并等待加载完成');
    }
  });

  const stopProxyCmd = vscode.commands.registerCommand('dshPanel.stopProxy', async () => {
    try {
      await httpPostJson(getProxyUrl() + '/__dsh/shutdown', {}, 5000);
      vscode.window.showInformationMessage('已停止 Copilot 消息代理。注意：停止后 Copilot 中指向代理的 DeepSeek 模型将无法使用；再次使用 @dsh 会自动重启。');
    } catch (e) {
      vscode.window.showWarningMessage('停止代理失败：' + (e && e.message ? e.message : String(e)) + '（可能未在运行）');
    }
  });

  const chatStatusCmd = vscode.commands.registerCommand('dshPanel.chatStatus', () => {
    showChatStatus().catch((e) => vscode.window.showErrorMessage('检查 /dsh 状态失败：' + (e && e.message ? e.message : String(e))));
  });

  const resetChatCmd = vscode.commands.registerCommand('dshPanel.resetChatMapping', async () => {
    if (gContext) {
      await gContext.globalState.update(CHAT_MAP_KEY, {});
      await gContext.globalState.update(DSH_MODEL_MAP_KEY, {});
    }
    vscode.window.showInformationMessage('已重置 /dsh 与 DSH 模型的会话映射：下次提问将创建新的 DSH 会话。');
  });

  context.subscriptions.push(viewSub, openInTabCmd, refreshCmd, openBrowserCmd, restartCmd, wsSub, sendSelectionCmd, chatStatusCmd, stopProxyCmd, resetChatCmd);
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
