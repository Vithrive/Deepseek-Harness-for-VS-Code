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
let dshInvocationAt = 0;
// 编辑器标签页模式：当前打开的 DSH 标签页 panel（未打开时为 null）。
let activeTab = null;
// 扩展上下文（globalState 持久化会话映射）。
let gContext = null;
// dsh 语言模型提供方（模型选择器里的 DSH (DeepSeek Harness)）是否注册成功。
let dshModelProviderRegistered = false;
// dsh 0.1.2-rc 起新增 web 浏览器认证：进程启动令牌（每次重启变化，从 stdout 学习）。
let dshLaunchToken = null;
// 本地受管认证代理（null = 未创建或不可用：Remote 场景 / 目标非回环地址）。
let authProxy = null;
// ensureAuthProxy 的并发去重：多个视图/API 同时触发时只创建一次。
let authProxyPromise = null;
// 老版本 dsh 不识别 --no-open 时置位（启动快速退出后自动去掉该参数重试）。
let dshNoOpenBroken = false;
// dsh 是否支持 web 浏览器认证（首次捕获 stdout 令牌行置 true；
// 确认为老版 dsh 后置 false 并持久化，启动等待逻辑据此跳过）。
let dshAuthCapable;
// 「dsh web: <url>」打印行的最后时间戳（新旧版本都打印，作为完全启动信号）。
let dshBootAnnouncedAt = 0;
// 进程内缓存的 --no-open 支持探测结果（undefined=未探测）。
let dshNoOpenSupported;
// 认证引导提示的上次弹出时间（冷却，避免反复打扰）。
let lastAuthPromptAt = 0;
// 标签页模式的重载函数（供认证引导完成后重新渲染标签页）。
let tabReloadFn = null;

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
 * 执行命令并捕获 stdout（用于探测 dsh 能力，如 `dsh web --help`）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>} stdout（失败抛错）
 */
function runCommandOutput(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const quoted = /\s/.test(cmd) ? `"${cmd}"` : cmd;
    exec(`${quoted} ${args.join(' ')}`, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
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
  // 已解析成功过的启动方式直接复用（15 分钟内）：避免每次提问都起子进程探测
  // dsh/npx（并发聊天时重复探测会拖慢扩展宿主、造成后一个聊天卡顿）。
  if (dshInvocation && (Date.now() - dshInvocationAt) < 15 * 60 * 1000) {
    return true;
  }
  const inv = await resolveDshInvocation();
  if (inv) {
    dshInvocation = inv;
    dshInvocationAt = Date.now();
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
    dshInvocationAt = Date.now();
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
        let out;
        try {
          out = JSON.parse(body);
        } catch {
          out = { raw: body };
        }
        out.__httpStatus = res.statusCode;
        resolve(out);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
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
  let m = t.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
  if (m) return m[1].trim();
  // VS Code 也会把真实提问包在 <prompt>…</prompt> 里（前面常跟 instructions/上下文块）
  m = t.match(/<prompt>\s*([\s\S]*?)\s*<\/prompt>/);
  return m ? m[1].trim() : null;
}

/**
 * 剥离 VS Code 注入的 Copilot instructions 前置说明与 <instructions>…</instructions> 块。
 * 这些是「上下文」不是用户提问；DSH 有自己的指令体系，不应作为对话内容回传。
 * @param {string} t
 * @returns {string}
 */
function stripCopilotContext(t) {
  let s = String(t || '');
  // 去掉 <instructions>…</instructions>（含 .copilot/instructions 附件与 AGENTS.md 等引用）
  s = s.replace(/<instructions>[\s\S]*?<\/instructions>/gi, '');
  // 去掉 VS Code 的 instructions 前置说明句（中英文变体兜底）
  s = s.replace(/when generating code, please follow these user provided coding instructions\.?/gi, '');
  s = s.replace(/you can ignore an instruction if it contradicts a system message\.?/gi, '');
  return s.trim();
}

/**
 * 把 VS Code 当前工作区注册到 DSH 的工作区列表。
 * workspace/create 是幂等的：已存在时返回现有记录，不会重复。
 * 尽力而为，失败不影响面板渲染。
 * @returns {Promise<boolean>}
 */
async function registerWorkspace() {
  if (!cfg().get('dshPanel.autoRegisterWorkspace', true)) {
    return false;
  }
  try {
    const base = await apiBase();
    const value = await dshRpc(base, 'workspace.create', { path: getWorkspaceDir() }, 8000);
    return !!value;
  } catch {
    return false;
  }
}

// =====================================================================
// dsh web 浏览器认证（dsh 0.1.2-rc 起新增）与本地受管认证代理
// ---------------------------------------------------------------------
// 新版 dsh web 每次启动都会生成一个「进程启动令牌」，并往 stdout 打印形如
//   dsh web: http://127.0.0.1:3080/?token=<64位令牌>
// 的认证链接；浏览器打开该链接时，服务器用令牌换取 `HttpOnly; SameSite=Strict`
// 的签名 Cookie（绑定请求 Host），此后所有请求凭 Cookie 通过；裸地址一律 401。
// /api 另有浏览器信任围栏：Host 必须回环（或受信）、Origin 必须与 Host 一致、
// 拒绝跨站 sec-fetch-site。
//
// webview 里 dsh 页面处于第三方 iframe 上下文，SameSite=Strict 的 Cookie 在
// 其中无法设置也无法携带，因此「iframe 直接加载 token 链接」不可靠。故改为：
// 扩展捕获 stdout 里的令牌链接，在本机回环随机端口启动「认证代理」，由代理
// 完成令牌→Cookie 换发，随后给每个转发请求注入 Cookie 与 Host。webview 与
// 扩展自身的 /api 调用全部改走代理——不关闭 dsh 任何安全机制，全程无感。
// =====================================================================

const AUTH_PROXY_STATE_KEY = 'dsh.webAuth.tokenCache';

/** 是否为本地（非 Remote）且 dshPanel.url 指向回环地址的场景。 */
function isLocalLoopbackTarget() {
  try {
    if (vscode.env && vscode.env.remoteName) return false;
    const u = new URL(getUrl());
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** 与 dsh 服务端一致的 Host 归一化：new URL('http://' + host).host。 */
function normAuthority(hostHeader) {
  try {
    return new URL('http://' + String(hostHeader || '')).host;
  } catch {
    return undefined;
  }
}

/** 从认证链接或裸令牌字符串中提取 token 参数值。 */
function extractTokenParam(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_.\-]{16,}$/.test(s)) return s; // 本身就是令牌
  const m = s.match(/[?&]token=([A-Za-z0-9_.\-]+)/);
  return m ? m[1] : null;
}

/**
 * 学习/更新 dsh 启动令牌（来自 stdout 行或用户粘贴的认证链接）。
 * 更新后立即为代理的本机来源（127.0.0.1 / localhost）静默换发 Cookie，
 * 并把令牌缓存进 globalState，供其他 VS Code 窗口 / 重载后复用（免打扰）。
 * @param {string} tokenOrUrl
 * @returns {boolean} 是否成功提取到令牌
 */
/** 记录/持久化 dsh 的 web 认证能力（true=支持，false=老版无认证）。 */
function setDshAuthCapable(value) {
  dshAuthCapable = value;
  if (gContext) {
    gContext.globalState.update('dsh.authCapable', value).then(() => {}, () => {});
  }
}

function learnDshToken(tokenOrUrl) {
  const token = extractTokenParam(tokenOrUrl);
  if (!token) return false;
  dshLaunchToken = token;
  if (dshAuthCapable !== true) {
    setDshAuthCapable(true);
  }
  if (gContext) {
    gContext.globalState.update(AUTH_PROXY_STATE_KEY, {
      target: getUrl(),
      token: token,
      ts: Date.now()
    }).then(() => {}, () => {});
  }
  if (authProxy) authProxy.onToken(token);
  return true;
}

/**
 * 确保本地受管认证代理已启动（127.0.0.1 随机端口，仅本机可访问）。
 * Remote 场景或目标非回环地址时返回 null（维持原直连行为）。
 * @returns {Promise<object|null>}
 */
async function ensureAuthProxy() {
  if (!isLocalLoopbackTarget()) return null;
  if (authProxy) {
    if (authProxy.target() !== getUrl()) {
      // 目标被改配置：旧 Cookie/令牌对新实例无效，整组重建。
      const old = authProxy;
      authProxy = null;
      authProxyPromise = null;
      await old.close().catch(() => {});
    } else {
      return authProxy;
    }
  }
  if (authProxyPromise) return authProxyPromise;
  authProxyPromise = (async () => {
    let proxy;
    try {
      proxy = await createAuthProxy(getUrl());
    } catch (e) {
      console.error('[DeepSeek Harness] 认证代理启动失败，回退直连：', e);
      return null;
    }
    authProxy = proxy;
    // 优先复用其他窗口/上次会话缓存的令牌与认证能力标记，尽量无感。
    if (gContext) {
      try {
        if (dshAuthCapable === undefined) {
          const cap = gContext.globalState.get('dsh.authCapable');
          if (typeof cap === 'boolean') dshAuthCapable = cap;
        }
      } catch { /* 忽略缓存读取失败 */ }
    }
    if (!dshLaunchToken && gContext) {
      try {
        const cache = gContext.globalState.get(AUTH_PROXY_STATE_KEY);
        if (cache && cache.target === getUrl() && cache.token) {
          dshLaunchToken = cache.token;
        }
      } catch { /* 忽略缓存读取失败 */ }
    }
    if (dshLaunchToken) proxy.onToken(dshLaunchToken);
    return proxy;
  })();
  const result = await authProxyPromise;
  if (result === null) authProxyPromise = null; // 失败允许下次重试
  return result;
}

/**
 * 创建认证代理 HTTP 服务器：
 * - 监听 127.0.0.1 随机端口（localhost 亦可访问，服务于标签页 origin 隔离）；
 * - 每个来源 authority（请求 Host）独立持有换取到的签名 Cookie；
 * - 转发时注入 Host 与 Cookie；遇 401 且持有令牌时自动重换并重试一次；
 * - 响应剥离 Set-Cookie（Cookie 由代理持有，不进 webview 第三方上下文）；
 * - WebSocket 升级按原头转发并双向透传（注入 Host/Cookie）。
 * @param {string} targetUrl dsh web 服务地址
 * @returns {Promise<object>} 代理句柄
 */
function createAuthProxy(targetUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const cookies = new Map(); // authority -> 'name=value'
    const exchanges = new Map(); // authority -> Promise（并发去重）
    let token = null;
    let port = 0;

    /** 为指定 authority 换发 Cookie（GET /?token=，Host 指向代理自身 authority）。 */
    function exchangeFor(authority) {
      const key = normAuthority(authority) || String(authority);
      if (!token) return Promise.resolve(null);
      const inFlight = exchanges.get(key);
      if (inFlight) return inFlight;
      const p = new Promise((done) => {
        const req = http.request({
          hostname: target.hostname,
          port: targetPort,
          path: '/?token=' + encodeURIComponent(token),
          method: 'GET',
          headers: { host: key, connection: 'close', accept: '*/*' }
        }, (res) => {
          res.resume();
          let cookieValue = null;
          const setCookies = res.headers['set-cookie'];
          if (res.statusCode === 303 && Array.isArray(setCookies) && setCookies.length > 0) {
            const raw = setCookies[0];
            const eq = raw.indexOf('=');
            const semi = raw.indexOf(';');
            if (eq > 0 && (semi < 0 || semi > eq)) cookieValue = raw.slice(0, semi < 0 ? raw.length : semi).trim();
          }
          if (cookieValue) cookies.set(key, cookieValue);
          done(cookieValue);
        });
        req.on('error', () => done(null));
        req.setTimeout(5000, () => req.destroy(new Error('auth exchange timeout')));
        req.end();
      }).finally(() => exchanges.delete(key));
      exchanges.set(key, p);
      return p;
    }

    /** 令牌到位后为两个本机来源静默预换 Cookie。 */
    async function preAuth() {
      if (!token) return;
      await Promise.all([
        exchangeFor(`127.0.0.1:${port}`),
        exchangeFor(`localhost:${port}`)
      ]).catch(() => {});
    }

    /** 无 Cookie 时的鉴权探测：直接访问上游首页的状态码（401 = 需认证）。 */
    function probeIndexStatus(timeoutMs = 4000) {
      return new Promise((done) => {
        try {
          const req = http.request({
            hostname: target.hostname,
            port: targetPort,
            path: '/',
            method: 'GET',
            headers: { accept: '*/*' }
          }, (res) => {
            res.resume();
            done(res.statusCode || 0);
          });
          req.on('error', () => done(0));
          req.setTimeout(timeoutMs, () => { req.destroy(); done(0); });
          req.end();
        } catch {
          done(0);
        }
      });
    }

    /** 端到端自检：请求代理自身首页（走完整转发链），200 即「webview 可用」。 */
    function probeSelf(timeoutMs = 2500) {
      return new Promise((done) => {
        try {
          const req = http.get({
            host: '127.0.0.1',
            port,
            path: '/',
            agent: new http.Agent({ keepAlive: false })
          }, (res) => {
            res.resume();
            done(res.statusCode || 0);
          });
          req.on('error', () => done(0));
          req.setTimeout(timeoutMs, () => { req.destroy(); done(0); });
        } catch {
          done(0);
        }
      });
    }

    /** 清理 hop-by-hop 头，注入 Host/Cookie 后转发。 */
    function buildForwardHeaders(req, authority, cookieValue) {
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.cookie;
      for (const h of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']) {
        delete headers[h];
      }
      headers.host = authority;
      if (cookieValue) headers.cookie = cookieValue;
      return headers;
    }

    /** 普通 HTTP 转发（含 401 自动重换重试一次）。 */
    async function forward(req, res) {
      const authority = normAuthority(req.headers.host) || `127.0.0.1:${port}`;
      let cookie = cookies.get(authority) || null;
      if (!cookie && token) cookie = await exchangeFor(authority);
      let status = await attempt(cookie);
      if (status === 401 && token) {
        const fresh = await exchangeFor(authority);
        if (fresh && fresh !== cookie) status = await attempt(fresh);
      }
      return status;

      function attempt(cookieValue) {
        return new Promise((done) => {
          let settled = false;
          const finish = (v) => { if (!settled) { settled = true; done(v); } };
          let upstream;
          try {
            upstream = http.request({
              hostname: target.hostname,
              port: targetPort,
              path: req.url,
              method: req.method,
              headers: buildForwardHeaders(req, authority, cookieValue)
            }, (ures) => {
              if (ures.statusCode === 401) {
                ures.resume();
                finish(401);
                return;
              }
              const outHeaders = { ...ures.headers };
              delete outHeaders['set-cookie'];
              delete outHeaders['transfer-encoding'];
              delete outHeaders['connection'];
              res.writeHead(ures.statusCode || 502, outHeaders);
              ures.pipe(res);
              ures.on('end', () => finish(ures.statusCode || 0));
              ures.on('error', () => finish(ures.statusCode || 0));
            });
          } catch {
            finish(0);
            return;
          }
          upstream.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            }
            try { res.end('DeepSeek Harness 代理：上游 dsh 连接失败'); } catch { /* noop */ }
            finish(0);
          });
          req.on('error', () => { try { upstream.destroy(); } catch { /* noop */ } });
          req.pipe(upstream);
        });
      }
    }

    /** WebSocket 升级透传（注入 Host/Cookie，原始字节双向转发）。 */
    function onUpgrade(req, socket, head) {
      const authority = normAuthority(req.headers.host) || `127.0.0.1:${port}`;
      const cookie = cookies.get(authority) || null;
      const headers = { ...req.headers };
      headers.host = authority;
      if (cookie) headers.cookie = cookie;
      const upstream = http.request({
        hostname: target.hostname,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers
      });
      upstream.on('upgrade', (ures, usocket, uhead) => {
        try {
          const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage || ''}`.trimEnd()];
          for (const [k, v] of Object.entries(ures.headers)) {
            if (Array.isArray(v)) { for (const vv of v) lines.push(`${k}: ${vv}`); }
            else if (v !== undefined) lines.push(`${k}: ${v}`);
          }
          socket.write(lines.join('\r\n') + '\r\n\r\n');
          if (uhead && uhead.length) usocket.write(uhead);
          const cleanup = () => {
            try { socket.destroy(); } catch { /* noop */ }
            try { usocket.destroy(); } catch { /* noop */ }
          };
          socket.on('error', cleanup);
          usocket.on('error', cleanup);
          socket.on('close', cleanup);
          usocket.on('close', cleanup);
          usocket.pipe(socket);
          socket.pipe(usocket);
        } catch {
          try { socket.destroy(); } catch { /* noop */ }
        }
      });
      upstream.on('response', (ures) => {
        // 上游拒绝升级（如 401/404）：把状态原样回给客户端。
        const chunks = [];
        ures.on('data', (c) => chunks.push(c));
        ures.on('end', () => {
          try {
            socket.write(
              `HTTP/1.1 ${ures.statusCode} ${ures.statusMessage || ''}\r\n` +
              'content-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n' +
              Buffer.concat(chunks).toString('utf8')
            );
            socket.end();
          } catch {
            try { socket.destroy(); } catch { /* noop */ }
          }
        });
      });
      upstream.on('error', () => { try { socket.destroy(); } catch { /* noop */ } });
      upstream.end();
    }

    const server = http.createServer((req, res) => {
      forward(req, res).catch(() => { try { res.destroy(); } catch { /* noop */ } });
    });
    server.on('upgrade', onUpgrade);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      server.removeAllListeners('error');
      server.on('error', (e) => console.error('[DeepSeek Harness] 认证代理错误：', e));
      resolve({
        target: () => targetUrl,
        port: () => port,
        baseUrl: () => `http://127.0.0.1:${port}`,
        urlForTab: () => {
          const u = new URL(`http://127.0.0.1:${port}`);
          u.hostname = 'localhost';
          return u.toString();
        },
        hasCookieForBase: () => cookies.has(`127.0.0.1:${port}`),
        hasCookieForTab: () => cookies.has(`localhost:${port}`),
        token: () => token,
        status: () => ({
          target: targetUrl,
          proxy: `http://127.0.0.1:${port}`,
          tokenKnown: !!token,
          authedAuthorities: [...cookies.keys()]
        }),
        /** 供「在浏览器中打开」：携带当前令牌的认证链接（真实浏览器可自行换 Cookie）。 */
        authenticatedUrl: () => {
          if (!token) return targetUrl;
          try {
            const u = new URL(targetUrl);
            u.pathname = '/';
            u.search = '';
            u.hash = '';
            u.searchParams.set('token', token);
            return u.toString();
          } catch {
            return targetUrl;
          }
        },
        onToken: (t) => { token = t; preAuth().catch(() => {}); },
        exchangeFor,
        probeIndexStatus,
        probeSelf,
        /** 等待基础来源（127.0.0.1）的 Cookie 就绪或超时；无令牌时立即返回。 */
        waitAuthed: (ms = 8000) => new Promise((done) => {
          if (!token || cookies.has(`127.0.0.1:${port}`)) { done(); return; }
          const t0 = Date.now();
          const timer = setInterval(() => {
            if (cookies.has(`127.0.0.1:${port}`) || Date.now() - t0 > ms) {
              clearInterval(timer);
              done();
            }
          }, 120);
        }),
        close: () => new Promise((done) => {
          try {
            server.close(() => done());
            setTimeout(() => done(), 1500).unref();
          } catch { done(); }
        })
      });
    });
  });
}

/**
 * 为面板解析最终展示地址：
 * - 代理可用且 Cookie 就绪 → 代理地址（webview 由此获得无感认证）；
 * - 代理可用但未认证且上游 401 → { unauthorized: true }（引导接管）；
 * - 其余（Remote / 非回环 / 老版 dsh 无认证）→ 原直连展示地址。
 * @param {boolean} isTab 是否标签页模式
 * @returns {Promise<{displayUrl: string} | {unauthorized: true}>}
 */
async function resolvePanelTarget(isTab) {
  let displayUrl = isTab ? getTabDisplayUrl(await resolveDisplayUrl()) : await resolveDisplayUrl();
  const proxy = await ensureAuthProxy();
  if (!proxy) return { displayUrl };
  await proxy.waitAuthed(8000);
  if (proxy.hasCookieForBase()) {
    displayUrl = isTab ? proxy.urlForTab() : proxy.baseUrl();
    // 端到端就绪确认：代理链路（注入 Cookie → 上游 → 回包）拿到 200 才交给
    // iframe，避免 dsh 半就绪（端口已监听但插件/连接未加载完）导致首次加载失败。
    const deadline = Date.now() + 6000;
    let probeStatus = 0;
    while (Date.now() < deadline) {
      probeStatus = await proxy.probeSelf(2500);
      if (probeStatus === 200) break;
      await sleep(400);
    }
    return { displayUrl };
  }
  const status = await proxy.probeIndexStatus();
  if (status === 401) return { unauthorized: true };
  return { displayUrl }; // 老版本 dsh（无认证），照旧直连
}

/**
 * 认证引导（免打扰策略：仅在确认 401 且无法静默认证时触发，且带 3 分钟冷却）：
 * 提供两个动作——由扩展受管重启 dsh（自动认证，推荐），或粘贴 dsh web 打印的认证链接。
 * @param {boolean} isTab
 */
function maybeGuideAuth(isTab) {
  const now = Date.now();
  if (now - lastAuthPromptAt < 3 * 60 * 1000) return;
  lastAuthPromptAt = now;
  vscode.window.showWarningMessage(
    '新版 dsh web 启用了浏览器认证，当前实例不是由本窗口启动，无法静默认证。',
    '重启并自动认证（推荐）',
    '粘贴认证链接'
  ).then(async (choice) => {
    if (choice === '重启并自动认证（推荐）') {
      const ok = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在重启 dsh web 以完成自动认证…',
        cancellable: false
      }, async () => {
        const installed = await ensureDshInstalled();
        if (!installed) return false;
        return restartDsh();
      });
      if (ok) {
        lastAuthPromptAt = 0;
        if (isTab && tabReloadFn) tabReloadFn();
        else if (activeView) render(activeView);
      } else {
        vscode.window.showErrorMessage('dsh web 重启失败，请手动重启后重试。');
      }
    } else if (choice === '粘贴认证链接') {
      const input = await vscode.window.showInputBox({
        prompt: '粘贴 dsh web 启动时打印的认证链接（形如 http://127.0.0.1:3080/?token=…，整行粘贴即可）',
        ignoreFocusOut: true
      });
      if (input && learnDshToken(input)) {
        lastAuthPromptAt = 0;
        await (authProxy && authProxy.waitAuthed(8000));
        if (isTab && tabReloadFn) tabReloadFn();
        else if (activeView) render(activeView);
      }
    }
  });
}

/** 扩展自身访问 dsh /api 的基址：代理就绪时走代理（自动带认证）。 */
async function apiBase() {
  if (isLocalLoopbackTarget()) {
    const proxy = await ensureAuthProxy();
    if (proxy) {
      // Cookie 可能尚未换发完成（dsh 刚启动）：短暂等待，避免打到裸地址吃 401。
      await proxy.waitAuthed(5000);
      if (proxy.hasCookieForBase()) {
        return proxy.baseUrl();
      }
    }
  }
  return getUrl().replace(/\/+$/, '');
}

/**
 * 启动 dsh web 进程。Windows 通过 shell 执行以命中 dsh.cmd shim。
 * 兼容新旧版本：--no-open 先经 `dsh web --help` 探测，老版本不支持时不传，
 * 避免未知参数导致启动失败。
 * @returns {Promise<import('child_process').ChildProcess>}
 */
async function startDsh() {
  // 使用 ensureDshInstalled 解析出的启动方式（全局 dsh 或 npx）。
  // 兜底回退到配置的命令，避免异常时序下拿到空值。
  const inv = dshInvocation || { cmd: getDshCommand(), prefix: [] };
  const args = [
    ...inv.prefix,
    'web',
    '--host', String(getHost()),
    '--port', String(getPort())
  ];
  // dsh 0.1.2-rc 起的 web 浏览器认证由扩展自动完成（受管认证代理），
  // 默认不再弹系统浏览器；需要保留旧行为时打开 dshPanel.openSystemBrowser。
  // 老版本 dsh 不识别 --no-open：探测支持才传，探测失败按支持处理（仍有回退）。
  if (!cfg().get('dshPanel.openSystemBrowser', false) && (dshNoOpenBroken !== true)) {
    if (await dshWebSupportsNoOpen(inv)) {
      args.push('--no-open');
    }
  }
  const child = spawn(inv.cmd, args, {
    cwd: getWorkspaceDir(),
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  managedChild = child;
  attachDshOutputReader(child);

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
 * 探测当前 dsh 的 web 子命令是否支持 --no-open（读 `dsh web --help` 输出）。
 * 结果按进程缓存；探测异常时按支持处理（保留 dshNoOpenBroken 回退兜底）。
 * @param {{cmd: string, prefix: string[]}} inv
 * @returns {Promise<boolean>}
 */
async function dshWebSupportsNoOpen(inv) {
  if (dshNoOpenSupported !== undefined) return dshNoOpenSupported;
  try {
    const out = await runCommandOutput(inv.cmd, [...inv.prefix, 'web', '--help'], 12000);
    dshNoOpenSupported = /--no-open/.test(out);
  } catch {
    dshNoOpenSupported = true;
  }
  if (dshNoOpenSupported === false) {
    dshNoOpenBroken = true; // 老版本：不再尝试该参数（等待逻辑也直接跳过认证链接等待）
  }
  return dshNoOpenSupported;
}

/**
 * 逐行读取 dsh web 的 stdout：
 * - 捕获「完全启动」信号：任何 `dsh web: <url>` 打印行（新版带 token=，
 *   老版为纯 URL，都代表 dsh 自身就绪）；
 * - 带令牌的行交给 learnDshToken（认证代理据此换发 Cookie）；
 * - 不带令牌的行说明当前 dsh 无 web 认证（老版本），记 dshAuthCapable=false。
 * stderr 仅记录日志便于排障。
 * @param {import('child_process').ChildProcess} child
 */
function attachDshOutputReader(child) {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const m = line.match(/dsh web:\s*(\S+)/);
      if (m) {
        dshBootAnnouncedAt = Date.now();
        if (extractTokenParam(m[1])) {
          learnDshToken(m[1]);
        } else if (dshAuthCapable !== true) {
          setDshAuthCapable(false); // 老版 dsh：URL 无 token 参数
        }
      }
      if (line.indexOf('opening the default browser') >= 0) {
        // --no-open 未生效（老版本不支持该参数等）：提示一次便于定位。
        console.warn('[DeepSeek Harness] dsh 自行打开了系统浏览器（--no-open 未生效）。' +
          '新版 dsh 由扩展自动抑制弹页；若仍弹页请检查 dshPanel.openSystemBrowser 与 dsh 配置。');
      }
    }
    if (buf.length > 64 * 1024) buf = '';
  };
  if (child.stdout) child.stdout.on('data', onData);
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8').trimEnd();
      if (s) console.error('[dsh web]', s);
    });
  }
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

  return startDshAndWaitReady(url);
}

/**
 * 启动 dsh 并等待就绪（最多约 30 秒）。
 * 老版本 dsh 可能不识别 --no-open（启动即退出）：自动去掉该参数重试一次。
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function startDshAndWaitReady(url) {
  // 记录启动前的「启动广播」快照：dsh 完全就绪（插件/连接加载完）才会打印
  // `dsh web: <url>` 行——新版带 token=，老版为纯 URL。端口可达 ≠ 就绪，
  // 过早渲染 iframe 会让前端在半就绪服务上启动失败（表现为重启后首次
  // 加载不出来、刷新一次才好）。
  const announceBefore = dshBootAnnouncedAt;
  if (!await startDshAndAwaitPort(url)) {
    return false;
  }
  return await waitDshFullBoot(announceBefore);
}

/** 端口可达即返回（401 也算）；含「探测漏判 --no-open」时的一次去参重试。 */
async function startDshAndAwaitPort(url) {
  startDsh().catch(() => {});
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await checkUrl(url)) {
      return true;
    }
  }
  if (!dshNoOpenBroken && !cfg().get('dshPanel.openSystemBrowser', false)) {
    // 兜底：探测误判（如 --help 输出异常）导致带参启动失败，去掉参数重试一次。
    startDsh().catch(() => {});
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (await checkUrl(url)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 等待本次启动的 dsh 打印启动广播行（完全启动信号，新旧版本通用）。
 * - 「从不广播的安静 dsh」在 globalState 记忆（dsh.quietBoot），之后直接跳过；
 * - 广播超时的兜底：进程仍存活则放行（渲染前还有代理自检兜底），并记忆
 *   quietBoot，之后不再等待。
 * @param {number} announceBefore 启动前的广播时间戳快照
 * @returns {Promise<boolean>}
 */
async function waitDshFullBoot(announceBefore) {
  if (gContext && gContext.globalState.get('dsh.quietBoot') === true) {
    return true;
  }
  const budget = dshAuthCapable === true ? 30000 : 20000;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    await sleep(250);
    if (managedChild === null) {
      return false; // 启动即退出/被杀
    }
    if (dshBootAnnouncedAt !== announceBefore) {
      // 广播到位；带令牌时认证代理已开始预换 Cookie，稍候片刻。
      await sleep(300);
      return true;
    }
  }
  if (managedChild === null) {
    return false;
  }
  // 进程存活但始终没有广播行（极老版本的安静 dsh）：记忆后不再等待。
  if (gContext) {
    gContext.globalState.update('dsh.quietBoot', true).then(() => {}, () => {});
  }
  return true;
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
  // 4. 重新启动并等待就绪（最多约 30 秒；含 --no-open 兼容回退）。
  return startDshAndWaitReady(url);
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
  // 用 CSS zoom 缩放（重新布局、按设备分辨率渲染，任意字号下清晰），
  // 不用 transform:scale（渲染后栅格化缩放，非整数倍缩放时整页模糊）。
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${escapeHtml(origin)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head>
<body style="margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;background:var(--vscode-editor-background);">
<iframe id="dsh-frame" src="${escapeHtml(url)}"
        style="width:100%;height:100%;border:none;display:block;zoom:${s};"
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
    frame.style.zoom = String(n);
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
// 内置分发的兼容插件（随扩展文件直接写入 DSH web profile，不经 npm）：
// 修复 macOS 上 DSH 页面被本扩展以跨源 iframe 内嵌时，复制/粘贴/剪切/全选
// 快捷键失效的问题（详见 clipboardPluginFiles 内注释）。
const CLIPBOARD_PLUGIN_NAME = 'dsh-webview-clipboard';
const CLIPBOARD_PLUGIN_VERSION = '0.2.0';

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

/**
 * 幂等：确保 profile 的 package.json 声明该插件（dependencies + dsh.profile.bundles）。
 * @param {string|null} versionSpec 依赖版本范围；传 null 表示不写入 dependencies
 *   （用于随扩展内置分发、直接落盘的插件——npm 注册表上没有该包，写进
 *   dependencies 反而会让用户后续 pnpm / dsh plugin add 解析失败）。
 */
async function ensureProfileDeclaration(profileDir, plugin, versionSpec) {
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = (await readJsonFile(pkgFile)) || { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
  let changed = false;
  if (versionSpec !== null && !pkg.dependencies[plugin]) {
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
 * 生成内置兼容插件 dsh-webview-clipboard 的全部文件内容。
 *
 * 问题（macOS）：面板把 DSH Web GUI 以跨源 iframe 内嵌在
 * VS Code webview 中，macOS 上 ⌘C/⌘V/⌘X/⌘A 的按键虽能到达 DSH 页面，
 * 但 Chromium 对这些按键的「原生默认动作」（复制/粘贴/剪切/全选）在这条
 * iframe 链路上不会发生，VS Code 自己的剪贴板命令又只作用于工作台文档，
 * 于是面板里复制、粘贴全部失效（Windows 原生默认动作正常，无此问题）。
 *
 * 修复：DSH 页面内部（经本插件注入）拦截这些组合键，preventDefault 后用
 * document.execCommand('paste'/'copy'/'cut'/'selectAll') 显式执行——该
 * 命令路径不受上述限制，可正确作用于聚焦的可编辑元素 / 当前选区
 * （已在 macOS VS Code webview 中实测验证）。
 *
 * 启用条件（全部满足，均在 DSH 页面本地判定，天然兼容 Remote 场景）：
 *   1. 被 iframe 内嵌（window.parent !== window，普通浏览器打开不启用）
 *   2. macOS（UA / userAgentData / platform 三路判定）
 *   3. 宿主是 Electron 应用（UA 含 "Electron/"；浏览器内嵌 DSH——例如
 *      Chrome 扩展——不启用，保持原生剪贴板行为，避免误伤）
 * @returns {Record<string, string>} 相对路径 → 文件内容
 */
function clipboardPluginFiles() {
  const pkgJson = JSON.stringify({
    name: CLIPBOARD_PLUGIN_NAME,
    version: CLIPBOARD_PLUGIN_VERSION,
    description: 'DeepSeek Harness 插件：DSH 页面被 VS Code webview（跨源 iframe）内嵌时，修复 macOS 上复制/粘贴/剪切/全选快捷键失效的问题（改用 execCommand 显式执行剪贴板编辑命令）。由 Deepseek-Harness-for-VS-Code 扩展内置分发。',
    keywords: ['deepseek', 'harness', 'dsh', 'cordis', 'plugin', 'clipboard', 'webview', 'vscode'],
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json'
    },
    files: ['lib', 'cordis.patch.yml'],
    license: 'MIT',
    dsh: {
      client: {
        inject: ['@deepseek-ai/dsh-client-runtime'],
        platform: 'web'
      },
      bundle: {
        patch: './cordis.patch.yml'
      }
    }
  }, null, 2) + '\n';

  const patchYml = [
    '# dsh-webview-clipboard bundle patch: one insert registering the dual-face plugin.',
    "# The row name must match the npm package name and the host half's exported `name`.",
    '- insert:',
    '    - id: webview-clipboard',
    `      name: '${CLIPBOARD_PLUGIN_NAME}'`,
    ''
  ].join('\n');

  const indexJs = `// ${CLIPBOARD_PLUGIN_NAME} host half: no-op.
// 本插件只做客户端（浏览器侧）兼容：修复 DSH 页面被 VS Code webview 内嵌时
// macOS 上复制/粘贴等剪贴板编辑命令失效的问题。宿主侧无需任何逻辑。
export const name = '${CLIPBOARD_PLUGIN_NAME}'

export const inject = []

export function apply(_ctx) {}
`;

  // 注意：本文件内容嵌在扩展的模板字面量里，正则里的反斜杠须写成 \\\\，
  // 否则模板字面量会把 \\/ 折叠成 / 造成注入脚本语法错误（同 buildIframeHtml 的前车之鉴）。
  const clientJs = `// ${CLIPBOARD_PLUGIN_NAME} client bundle (ModuleLoader format)
//
// 背景（macOS + VS Code webview）：
// DSH Web GUI 被扩展以「跨源 iframe」形式内嵌在 VS Code webview 里。
// 在 macOS 上，按键虽然能到达页面，但 Chromium 对 ⌘C/⌘V/⌘X/⌘A 的
// 「原生默认动作」（复制/粘贴/剪切/全选）在这条 iframe 链路上不会发生，
// VS Code 自己的剪贴板命令也只会路由到工作台文档——于是面板里复制、
// 粘贴全部失效（Windows 上原生默认动作正常，无此问题）。
//
// 修复：拦截这些组合键，preventDefault 后改用 document.execCommand(
// 'paste'/'copy'/'cut'/'selectAll') 显式执行——这条命令路径不受上述限制，
// 可正确作用于当前聚焦的可编辑元素/当前选区。
//
// 启用条件（在 DSH 页面本地判定，天然兼容 Remote 场景）：
//   1. 被 iframe 内嵌（window.parent !== window；普通浏览器打开不启用）
//   2. macOS（UA / userAgentData / platform 三路判定）
//   3. 宿主是 Electron 应用（UA 含 "Electron/"；浏览器内嵌 DSH——例如
//      Chrome 扩展——不启用，保持原生剪贴板行为，避免误伤）

window.__ModuleLoader__.load({ id: '${CLIPBOARD_PLUGIN_NAME}', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '${CLIPBOARD_PLUGIN_VERSION}'

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
    return /Electron\\//.test(navigator.userAgent || '')
  }

  /** 是否启用兼容层。 */
  function enabled() {
    return inIframe() && isMac() && inElectron()
  }

  /** 事件目标是否为可编辑元素（本插件处理的键只对它们有意义）。 */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true
    return el.isContentEditable === true
  }

  // ── 光标位置辅助 ─────────────────────────────────────────────
  function lineStart(v, p) { return v.lastIndexOf('\\n', p - 1) + 1 }
  function lineEnd(v, p) { var i = v.indexOf('\\n', p); return i === -1 ? v.length : i }
  /** 词首（向前跳过空白，再跳过非空白）。 */
  function wordBack(v, p) {
    var i = p
    while (i > 0 && /\\s/.test(v.charAt(i - 1))) i--
    while (i > 0 && !/\\s/.test(v.charAt(i - 1))) i--
    return i
  }
  /** 词尾（向后跳过空白，再跳过非空白）。 */
  function wordFwd(v, p) {
    var n = v.length, i = p
    while (i < n && /\\s/.test(v.charAt(i))) i++
    while (i < n && !/\\s/.test(v.charAt(i))) i++
    return i
  }

  // Shift+移动需要记住「选区锚点」。锚点可能因外部操作（输入/点击/普通移动）过期，
  // 因此除我们自己处理的位置外，还在 input / focusin / mouseup / 普通按键后刷新锚点。
  var anchors = new WeakMap()
  function anchorOf(el) {
    var a = anchors.get(el)
    if (a === undefined) a = el.selectionStart === el.selectionEnd ? el.selectionStart : el.selectionEnd
    return a
  }
  function moveCaret(el, pos, shift) {
    if (shift) {
      var a = anchorOf(el)
      el.setSelectionRange(Math.min(a, pos), Math.max(a, pos), pos < a ? 'backward' : 'forward')
    } else {
      el.setSelectionRange(pos, pos)
      anchors.set(el, pos)
    }
  }
  /** 把锚点刷新到目标当前光标（异步一拍，等默认动作完成）。 */
  function refreshAnchorSoon(el) {
    setTimeout(function () {
      try { if (el.isConnected) anchors.set(el, el.selectionStart) } catch (e) { /* ignore */ }
    }, 0)
  }
  function onInput(e) {
    if (isEditable(e.target)) anchors.set(e.target, e.target.selectionStart)
  }
  function onFocusIn(e) {
    if (isEditable(e.target)) anchors.set(e.target, e.target.selectionStart)
  }
  function onMouseUp(e) {
    if (isEditable(e.target)) refreshAnchorSoon(e.target)
  }

  // ⌘C/⌘V/⌘X 直接映射 execCommand；其余编辑键在 onKeyDown 内特判。
  function onKeyDown(e) {
    if (e.defaultPrevented) return                 // DSH 自身已处理，尊重之
    if (!enabled()) return
    if (e.isComposing || e.keyCode === 229) return // IME 组合中不干预
    var mod = e.metaKey || e.ctrlKey
    if (!mod && !e.altKey) {
      // 普通按键（含输入）：异步刷新锚点，保证 Shift 选区语义正确。
      if (!e.shiftKey && isEditable(e.target)) refreshAnchorSoon(e.target)
      return
    }
    if (mod && e.altKey) return                    // 混合修饰键不处理，避免误伤
    var el = e.target
    var editable = isEditable(el)
    var k = String(e.key || '')
    var lower = k.toLowerCase()

    // ── 剪贴板/撤销重做（execCommand 族）──
    var cmd = null
    if (mod && lower === 'v') cmd = 'paste'
    else if (mod && lower === 'c') cmd = 'copy'
    else if (mod && lower === 'x') cmd = 'cut'
    else if (mod && lower === 'a' && !e.shiftKey) cmd = 'selectAll'
    else if (mod && lower === 'z' && !e.shiftKey) cmd = 'undo'
    else if (mod && ((e.shiftKey && lower === 'z') || lower === 'y')) cmd = 'redo'
    if (cmd) {
      if (cmd === 'paste' && !editable) return
      e.preventDefault()
      try {
        var ok = document.execCommand(cmd)
        if (editable) anchors.set(el, el.selectionStart)
        if (!ok) console.warn('[${CLIPBOARD_PLUGIN_NAME}] execCommand("' + cmd + '") returned false')
      } catch (err) {
        console.warn('[${CLIPBOARD_PLUGIN_NAME}] execCommand("' + cmd + '") failed:', err)
      }
      return
    }

    // ── 光标移动 / 删除（execCommand 无对应命令，手动计算后走编辑管线）──
    if (!editable) return
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'Backspace') return
    var isCmd = mod, isAlt = e.altKey && !mod
    if (!isCmd && !isAlt) return
    if (k === 'Backspace' && e.shiftKey) return

    var v = el.value
    var caret = el.selectionEnd

    if (k === 'Backspace') {
      // ⌘⌫ 删至行首；⌥⌫ 删除前一个词。先选中区间再走 delete，保持撤销栈完整。
      var from = isCmd ? lineStart(v, caret) : wordBack(v, caret)
      if (from >= caret) return
      el.setSelectionRange(from, caret)
      e.preventDefault()
      document.execCommand('delete')
      anchors.set(el, el.selectionStart)
      return
    }

    var target
    if (k === 'ArrowLeft') target = isCmd ? lineStart(v, caret) : wordBack(v, caret)
    else if (k === 'ArrowRight') target = isCmd ? lineEnd(v, caret) : wordFwd(v, caret)
    else if (k === 'ArrowUp') target = 0            // 单行即行首；多行即文首
    else target = v.length                          // ArrowDown：行尾/文末
    if (target === caret && !e.shiftKey) { e.preventDefault(); return }
    e.preventDefault()
    moveCaret(el, target, e.shiftKey)
  }

  function apply() {
    window.addEventListener('keydown', onKeyDown, false)
    window.addEventListener('input', onInput, true)
    window.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('mouseup', onMouseUp, true)
    window.__dshWebviewClipboard = {
      version: PLUGIN_VERSION,
      enabled: enabled(),
      mac: isMac(),
      electron: inElectron()
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
`;

  return {
    'package.json': pkgJson,
    'cordis.patch.yml': patchYml,
    'lib/index.js': indexJs,
    'lib/client.js': clientJs
  };
}

/**
 * 确保内置兼容插件 dsh-webview-clipboard 已落盘并声明（不经 npm）。
 * @returns {Promise<boolean>} 本次是否发生新增/升级（true 时需重启 dsh web 生效）。
 */
async function ensureClipboardPlugin(profileDir) {
  try {
    const installed = await installedPluginVersion(profileDir, CLIPBOARD_PLUGIN_NAME);
    if (installed === CLIPBOARD_PLUGIN_VERSION) {
      await ensureProfileDeclaration(profileDir, CLIPBOARD_PLUGIN_NAME, null);
      return false; // 版本一致，无需写入
    }
    const files = clipboardPluginFiles();
    const base = path.join(profileDir, 'node_modules', CLIPBOARD_PLUGIN_NAME);
    for (const rel of Object.keys(files)) {
      const dest = path.join(base, rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, files[rel], 'utf8');
    }
    // dependencies 不写入该包（npm 注册表上没有），只登记 bundles 供 DSH 加载。
    await ensureProfileDeclaration(profileDir, CLIPBOARD_PLUGIN_NAME, null);
    return true;
  } catch (e) {
    console.error(`[DeepSeek Harness] 安装内置插件 ${CLIPBOARD_PLUGIN_NAME} 失败：`, e);
    vscode.window.showWarningMessage(`安装 DSH 剪贴板兼容插件 ${CLIPBOARD_PLUGIN_NAME} 失败：${e.message}`);
    return false;
  }
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
    let changed = false;
    if (installed && compareVersions(installed, DSH_PLUGIN_MIN) >= 0) {
      // dsh-drop-caret 已满足，无需安装
    } else {
      // 未安装或版本过低：先试官方 dsh plugin add，失败回退 npm pack。
      const viaCli = await tryDshPluginAdd(DSH_PLUGIN_NAME);
      if (!viaCli) {
        await installPluginViaNpm(profileDir, DSH_PLUGIN_NAME);
      }
      await ensureProfileDeclaration(profileDir, DSH_PLUGIN_NAME, `^${DSH_PLUGIN_MIN}`);
      changed = true;
    }
    // 内置剪贴板兼容插件（文件随扩展直接写入，不走 npm）。
    // 仅在 macOS 的 VS Code webview 内嵌场景激活（DSH 页面本地判定），
    // Windows/Linux 上为惰性文件；可经 dshPanel.installClipboardPlugin 关闭。
    if (cfg().get('dshPanel.installClipboardPlugin', true)) {
      if (await ensureClipboardPlugin(profileDir)) {
        changed = true;
      }
    }
    return changed;
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
 * @returns {Promise<{ok: true, html: string} | {ok: false, kind: 'not-installed'|'unreachable'|'unloadable'|'unauthorized', reason: string}>}
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
    vscode.window.showInformationMessage('已自动安装/更新 DSH 插件（dsh-drop-caret / dsh-webview-clipboard），请点击面板顶部的「重启 dsh web」使其生效。');
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
  // 解析最终展示地址：本地场景走受管认证代理（无感通过 dsh web 浏览器认证）；
  // Remote / 非回环 / 老版 dsh（无认证）维持原直连显示地址（远程场景经端口转发）。
  const target = await resolvePanelTarget(isTab);
  if (target.unauthorized) {
    maybeGuideAuth(isTab);
    return {
      ok: false,
      kind: 'unauthorized',
      reason: 'dsh web 新版启用了浏览器认证，当前实例不是由本窗口启动，无法静默认证。' +
        '点击面板顶部的「重启 dsh web」，由扩展接管并自动完成认证。'
    };
  }
  try {
    return { ok: true, html: buildIframeHtml(target.displayUrl, getFontScale()) };
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

// dsh 0.1.2-rc 起把 /api RPC 端点从「点号」改为「命名空间/方法」斜杠规范
// （如 workspace.create → workspace/create）。这里维护新旧名字映射：
// 先请求新端点，得到 404（老版本 dsh 无此路由）时自动回退旧点号端点。
const DSH_RPC_ENDPOINT_RENAME = {
  'workspace.create': 'workspace/create',
  'session.create': 'session/create',
  'session.prompt': 'session/prompt',
  'session.selectModel': 'session/selectModel',
  'session.page': 'session/page'
};

/** 响应是否为「路由不存在」（用于新旧端点回退判断）。 */
function isRpcRouteMissing(resp) {
  return !!resp && (resp.__httpStatus === 404 || resp.raw === 'not found');
}

/**
 * 执行 DSH RPC（client-request 信封），成功返回 result.value，失败抛错。
 * 兼容两代 dsh：
 * - 新版（0.1.2-rc.x）：斜杠端点（如 workspace/create），payload 必须为
 *   「恰好一个普通对象字段」的命名参数包裹 { args: { request: <业务参数> } }；
 * - 老版本：点号端点（workspace.create），payload 即业务参数本体。
 * 先按新格式请求，路由不存在（404）时自动回退旧格式。
 * @param {string} base
 * @param {string} method
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function dshRpc(base, method, payload, timeoutMs) {
  const renamed = DSH_RPC_ENDPOINT_RENAME[method];
  const rpcId = 'dsh-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const attempts = [];
  if (renamed) {
    attempts.push({
      path: '/api/' + renamed,
      body: {
        type: 'client-request',
        rpcId,
        method: renamed,
        payload: { args: { request: payload } }
      }
    });
  }
  attempts.push({
    path: '/api/' + method,
    body: { type: 'client-request', rpcId, method, payload }
  });

  let resp = null;
  for (const attempt of attempts) {
    resp = await httpPostJson(base + attempt.path, attempt.body, timeoutMs || 15000);
    if (!isRpcRouteMissing(resp)) break;
  }
  const result = resp && resp.result;
  if (result && result.ok) {
    return result.value;
  }
  const err = result && result.error;
  const msg = (err && (err.message || err.code)) || ('DSH RPC 失败: ' + method);
  throw new Error(msg);
}

/**
 * 拉取 DSH 会话历史（供流式回放轮询）。
 * 新版 dsh（0.1.2-rc.x）端点改名为 session/page，入参变为
 * { address: {kind:'session', sessionId}, throughSeq, maxMessages }，其中
 * throughSeq 不可超过会话当前游标（超出时网关报 "past cursor N" 并回带 N）。
 * 这里先用 0 探测游标，再按游标取尾部一页，并归一化为旧 { events: [...] }
 * 形态；老版本 dsh 回退 session.history（{sessionId}）。
 * @param {string} base
 * @param {string} sid DSH 会话 id
 * @returns {Promise<{events: any[]}>}
 */
async function fetchSessionHistory(base, sid) {
  const pagePayload = (seq, maxMessages) => ({
    address: { kind: 'session', sessionId: sid },
    throughSeq: seq,
    maxMessages
  });
  try {
    // 1) 游标探测：空会话返回 "past cursor -1"；非空会话 throughSeq=0 总是合法，
    //    但为了拿到“最新游标”，这里直接解析探测错误的 cursor 值更省一轮——
    //    因此先用一个必然越界的大值试探，从错误里解析当前游标。
    let cursor = -1;
    try {
      await dshRpc(base, 'session.page', pagePayload(Number.MAX_SAFE_INTEGER, 1), 15000);
      // 理论不可达（MAX_SAFE_INTEGER 必然越界）；可达时说明没有游标校验，直接按 0 取。
      cursor = 0;
    } catch (e) {
      const m = /past cursor (-?\d+)/.exec(String((e && e.message) || ''));
      if (!m) throw e;
      cursor = parseInt(m[1], 10);
      if (!Number.isFinite(cursor)) cursor = -1;
    }
    if (cursor < 0) {
      return { events: [] }; // 空会话
    }
    // 2) 按游标取尾部一页（从最新事件向前回溯 maxMessages 条）。
    const page = await dshRpc(base, 'session.page', pagePayload(cursor, 4000), 15000);
    const records = Array.isArray(page && page.records) ? page.records : [];
    return { events: records.map((x) => (x && x.event) ? x.event : x) };
  } catch (_) {
    // 老版本 dsh：旧端点 + 旧入参。
    const hist = await dshRpc(base, 'session.history', { sessionId: sid }, 15000);
    return hist;
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
function parseChatSessionText(text) {
  const turns = [];
  let sessionId = null;
  try {
    const lines = String(text || '').split(/\r?\n/).filter(Boolean);
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
        : (Array.isArray(req.message.parts)
          ? req.message.parts.map((pp) => (pp && typeof pp.text === 'string' ? pp.text : '')).join('\n')
          : ''))) || '';
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
    console.warn('[DeepSeek Harness] 解析会话文本失败：', e && e.message);
  }
  return { sessionId, turns };
}

/**
 * 同步解析一个会话 .jsonl 文件（读盘 + 解析）。
 * @param {string} filePath
 * @returns {{sessionId: string|null, turns: any[]}}
 */
function parseChatSessionFile(filePath) {
  try {
    return parseChatSessionText(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn('[DeepSeek Harness] 解析会话文件失败：', filePath, e && e.message);
    return { sessionId: null, turns: [] };
  }
}

/**
 * 异步 + 缓存的会话文件读取（mtime+size 不变则 10 秒内命中缓存）：
 * 并发聊天时避免每个请求重复全量读盘/解析，减少扩展宿主阻塞。
 * @param {string} file
 * @returns {Promise<{sessionId: string|null, turns: any[]}|null>}
 */
const chatFileReadCache = new Map();
async function readChatSessionCached(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  const hit = chatFileReadCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && (Date.now() - hit.ts) < 10000) {
    return hit.value;
  }
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (_) { return null; }
  const value = parseChatSessionText(text);
  chatFileReadCache.set(file, { ts: Date.now(), mtimeMs: st.mtimeMs, size: st.size, value });
  if (chatFileReadCache.size > 40) {
    const oldest = chatFileReadCache.keys().next().value;
    if (oldest) chatFileReadCache.delete(oldest);
  }
  return value;
}

/**
 * 枚举 VS Code 用户数据目录（跨平台 + 远程）：
 * - Windows: %APPDATA%\Code\User
 * - macOS: ~/Library/Application Support/Code/User
 * - Linux 桌面: ~/.config/Code/User
 * - vscode-server（Remote-SSH / WSL / 容器）: ~/.vscode-server/data/User
 * - 旧版 vscode-remote: ~/.vscode-remote/data/User
 * 全部候选都会尝试，不存在的自动跳过（存在性由调用方检查）。
 * @returns {string[]}
 */
function chatUserDataDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'win32') dirs.push(path.join(home, 'AppData', 'Roaming', 'Code', 'User'));
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
  dirs.push(path.join(home, '.config', 'Code', 'User'));
  dirs.push(path.join(home, '.vscode-server', 'data', 'User'));
  dirs.push(path.join(home, '.vscode-remote', 'data', 'User'));
  const seen = new Set();
  return dirs.filter((d) => { if (seen.has(d)) return false; seen.add(d); return true; });
}

/**
 * 从 workspace.json 的 folder 字段提取本地路径（file:/// 与 vscode-remote:// 均支持），
 * 用于判断某个 workspaceStorage 哈希目录是否属于当前工作区。
 * @param {string} folderUri
 * @returns {string|null}
 */
function folderPathFromWorkspaceJson(folderUri) {
  if (!folderUri || typeof folderUri !== 'string') return null;
  try {
    const u = new URL(folderUri);
    let p = decodeURIComponent(u.pathname || '');
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return path.normalize(p);
  } catch (_) {
    return null;
  }
}

/**
 * 枚举最近修改的会话文件（工作区窗口 + 空窗口），当前工作区优先、其余工作区兜底。
 * @param {number} [lookbackMinOverride]
 * @returns {{file: string, mtimeMs: number}[]} 按（当前工作区优先 →）修改时间倒序。
 */
function listChatSessionFiles(lookbackMinOverride) {
  const out = [];
  const now = Date.now();
  const lookbackMs = ((lookbackMinOverride != null ? lookbackMinOverride : (Number(cfg().get('dshPanel.chatSyncLookbackMin', 60)) || 60))) * 60 * 1000;
  const localDir = getWorkspaceDir();
  const normLocal = (() => {
    try {
      const n = path.normalize(String(localDir || ''));
      return process.platform === 'win32' ? n.toLowerCase() : n;
    } catch (_) { return String(localDir || ''); }
  })();
  const roots = []; // { dir, pri } pri=1 当前工作区，0 其他
  for (const u of chatUserDataDirs()) {
    const ws = path.join(u, 'workspaceStorage');
    try {
      for (const d of fs.readdirSync(ws)) {
        let pri = 0;
        try {
          const wj = JSON.parse(fs.readFileSync(path.join(ws, d, 'workspace.json'), 'utf8'));
          const folder = (wj && (wj.folder || (wj.workspace && typeof wj.workspace === 'string' ? wj.workspace : null))) || null;
          const fp = folderPathFromWorkspaceJson(folder);
          if (fp) {
            const n = process.platform === 'win32' ? fp.toLowerCase() : fp;
            if (n === normLocal || n.startsWith(normLocal + path.sep) || normLocal.startsWith(n + path.sep)) pri = 1;
          }
        } catch (_) { /* workspace.json 缺失/异常则视为其他工作区 */ }
        const p = path.join(ws, d, 'chatSessions');
        if (fs.existsSync(p)) roots.push({ dir: p, pri });
      }
    } catch (_) { /* 不存在则跳过 */ }
    const empty = path.join(u, 'globalStorage', 'emptyWindowChatSessions');
    if (fs.existsSync(empty)) roots.push({ dir: empty, pri: 1 });
  }
  for (const r of roots) {
    let files = [];
    try { files = fs.readdirSync(r.dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const fp = path.join(r.dir, f);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs < lookbackMs) out.push({ file: fp, mtimeMs: st.mtimeMs, pri: r.pri });
    }
  }
  out.sort((a, b) => (b.pri - a.pri) || (b.mtimeMs - a.mtimeMs));
  return out;
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
    if (full.startsWith('用户：')) return stripAttachSuffix(full.slice(3));
  }
  return '';
}

function lastLmUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (full.startsWith('用户：')) return stripAttachSuffix(full.slice(3));
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
    const t = stripAttachSuffix(full.slice(3));
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
    if (full.startsWith('用户：') && stripAttachSuffix(full.slice(3)) === lastUserText) return i;
  }
  return -1;
}

/**
 * 归一化聊天文件里记录的原始用户提问（去掉 <prompt>/<userRequest>/instructions 包裹），
 * 与 lmMessageText 对 VS Code 消息的清洗规则对齐。
 * @param {string} u
 * @returns {string}
 */
function normalizeFileUserText(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  const inner = extractUserRequest(raw);
  if (inner !== null) return stripAttachSuffix(inner);
  const cleaned = stripCopilotContext(raw);
  if (!cleaned) return '';
  const inner2 = extractUserRequest(cleaned);
  if (inner2 !== null) return stripAttachSuffix(inner2);
  return stripAttachSuffix(cleaned);
}

/**
 * 定位当前 Copilot 聊天的 sessionId（聊天文件名）。
 * 主路径（零竞态）：当前请求落盘有几秒延迟，但「上一轮提问」早已落盘——
 * 用「文件最后一条提问（归一化）== 当前转录里的上一个提问（prevPrompt）」认领聊天文件；
 * 多个候选（多聊天同开、镜像聊天）时取「最后提问时间戳最大」者 = 最近活跃的那个聊天。
 * 兜底：首轮（无 prevPrompt）或历史被编辑时，轮询等当前请求落盘（文本全等 + ts 新鲜）。
 * @param {string} currentPrompt
 * @param {any[]} messages
 * @returns {Promise<string|null>}
 */
async function locateModelChatSessionId(currentPrompt, messages) {
  const q = String(currentPrompt || '').trim();
  const prevPrompt = prevLmUserText(messages);
  if (!q && !prevPrompt) return null;
  const FRESH_TURN_MS = 3 * 60 * 1000;
  const FRESH_EMPTY_MS = 60 * 1000;
  // 单次扫描：宽回看（24h）+ 最近 12 文件（当前工作区优先 + mtime 倒序）。
  // - hitPrev：文件最后一条提问（归一化）== 上一轮提问（无 ts 门控，老聊天恢复兼容）；
  // - hitCur：文件最后一条提问 == 当前提问且 ts 新鲜（请求已落盘的快路径）；
  // - 空聊天文件（只有 kind:0 元数据、无任何请求）：新建聊天在第一问期间就是这种状态
  //   （实测请求在回答完成后才写入文件），记录最近 60 秒内最新的一个作为首轮候选。
  const scanOnce = async () => {
    const now = Date.now();
    let bestId = null;
    let bestTs = 0;
    let newestEmptyId = null;
    let newestEmptyMtime = 0;
    try {
      const files = listChatSessionFiles(60 * 24).slice(0, 12);
      for (const f of files) {
        const p = await readChatSessionCached(f.file);
        if (!p || !p.sessionId) continue;
        if (!Array.isArray(p.turns) || !p.turns.length) {
          if ((now - f.mtimeMs) < FRESH_EMPTY_MS && f.mtimeMs > newestEmptyMtime) {
            newestEmptyMtime = f.mtimeMs;
            newestEmptyId = p.sessionId;
          }
          continue;
        }
        const last = p.turns[p.turns.length - 1];
        if (!last || !last.user) continue;
        const nu = normalizeFileUserText(last.user);
        const lastTs = (typeof last.ts === 'number' && last.ts > 0) ? last.ts : 0;
        const hitPrev = prevPrompt ? (nu === prevPrompt) : false;
        const hitCur = q ? (nu === q && (now - lastTs) < FRESH_TURN_MS) : false;
        if ((hitPrev || hitCur) && lastTs > bestTs) {
          bestTs = lastTs;
          bestId = p.sessionId;
        }
      }
    } catch (_) { /* 定位失败回退哈希键 */ }
    return { bestId, newestEmptyId };
  };
  if (prevPrompt) {
    // 非首轮：上一轮必已落盘，通常一次命中；仍轻量重试两次覆盖「恢复很久没聊的聊天」
    // （当前请求一落盘即可通过 hitCur 命中）。
    for (let i = 0; i < 3; i++) {
      if (i > 0) await sleep(i === 1 ? 600 : 1500);
      const { bestId } = await scanOnce();
      if (bestId) return bestId;
    }
    return null;
  }
  // 首轮：不轮询等落盘（实测请求在回答完成后才写入文件，等待只会白耗约 8 秒、
  // 拖慢新聊天第一问并造成并发聊天「串行」观感）。先试 hitCur 快路径，
  // 再取「最近 60 秒内新建的空聊天文件」= 当前新聊天（零等待）。
  const { bestId, newestEmptyId } = await scanOnce();
  return bestId || newestEmptyId || null;
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

/**
 * 解析一条「附件消息」（VS Code 把拖进聊天框的文件作为独立的 user 消息投递，
 * 整条消息形如 <attachment id="...">…文件内容…</attachment>）并提取文件路径。
 * 路径来源（按优先级）：
 *  1) 正文 filepath 注释（三种实测变体：<!-- filepath: p --> / // filepath: p / # filepath: p）；
 *  2) 开标签 filePath/path/uri 属性（file:// URI 归一化为本地路径）；
 *  3) id 属性（"file:NAME" 或 "NAME"，仅文件名——拼接当前工作区路径，找不到就原样传）。
 * 注意不能用「<attachment …>…</attachment>」内部配对正则剥离：文件内容里可能有
 * 字面 <attachment> 文本（比如拖进本扩展的源码），配对会被内容里的字面量击穿。
 * @param {string} t 整条消息文本
 * @returns {string[]}
 */
function stripAndExtractAttachments(t) {
  const s = String(t || '');
  const paths = [];
  const push = (p) => { if (p && !paths.includes(p)) paths.push(p); };
  // 路径提取：优先开标签 filePath 属性（实测主格式 <attachment id=... filePath="...">），
  // 其次正文 filepath 注释（<!-- --> / // / # 变体），最后 id 属性兜底（拼工作区）。
  const attrRe = /<attachment\b[^>]*\bfilePath\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = attrRe.exec(s))) push(m[1].trim());
  if (!paths.length) {
    const attrRe2 = /<attachment\b[^>]*\b(?:path|uri)\s*=\s*"([^"]+)"/gi;
    while ((m = attrRe2.exec(s))) {
      let p = m[1].trim();
      if (/^file:\/\//i.test(p)) {
        try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { /* 保持原样 */ }
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      }
      push(p);
    }
  }
  if (!paths.length) {
    const cm = s.match(/<!--\s*filepath:\s*([^>\r\n]+?)\s*-->/i)
      || s.match(/(?:^|\n)\s*(?:\/\/|#)\s*filepath:\s*(.+?)(?:\r?\n|$)/i);
    if (cm) push(cm[1].trim());
  }
  if (!paths.length) {
    const im = s.match(/<attachment\b[^>]*\bid\s*=\s*"([^"]+)"/i);
    if (im) {
      let name = im[1].trim().replace(/^file:/i, '').replace(/^active editor:/i, '').trim();
      if (name && !/^[A-Za-z]:[\\/]/.test(name) && !/^[\\/]/.test(name)) {
        const ws = getWorkspaceDir();
        if (ws) name = path.join(ws, name);
      }
      push(name);
    }
  }
  // 容器剥离：优先 <attachments>…</attachments>（复数包裹是 VS Code 专用，
  // 文件内容里几乎不可能出现 </attachments>，可安全取最后一个）；
  // 回退 <attachment>…</attachment>（首个开标签到最后一个闭标签，内容里的
  // 字面 <attachment> 文本位于中间，不影响首尾定位）。
  let cleaned = s;
  const a1 = s.search(/<attachments\b/i);
  const z1 = s.lastIndexOf('</attachments>');
  if (a1 >= 0 && z1 > a1) {
    cleaned = s.slice(0, a1) + s.slice(z1 + '</attachments>'.length);
  } else {
    const a2 = s.search(/<attachment\b/i);
    const z2 = s.lastIndexOf('</attachment>');
    if (a2 >= 0 && z2 > a2) {
      cleaned = s.slice(0, a2) + s.slice(z2 + '</attachment>'.length);
    }
  }
  return { cleaned: cleaned.trim(), paths };
}

/**
 * 身份键清洗：把「用户：提问」末尾的【文件引用】段截掉，
 * 让 lastLmUserText/prevLmUserText/findLmUserIndex 等身份判定只比对真实提问文本。
 * @param {string} t
 * @returns {string}
 */
function stripAttachSuffix(t) {
  const idx = String(t || '').indexOf('\n\n【文件引用】');
  return idx >= 0 ? t.slice(0, idx).trim() : t;
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
    // 文件引用处理：VS Code 把拖进聊天框的文件以 <attachments>/<attachment> 容器包裹在
    // user 消息里（独立消息或与 <userRequest> 提问同消息两种形态均有）。统一先剥离
    // 附件容器、提取 filePath 路径，再对剩余文本走提问解析——只透传路径不传内容。
    const noInstr0 = text.replace(/<instructions>[\s\S]*?<\/instructions>/gi, '').trim();
    const { cleaned: noAttach, paths: attachPaths } = stripAndExtractAttachments(noInstr0);
    const attachSuffix = attachPaths.length ? ('\n\n【文件引用】\n' + attachPaths.map((p) => '- ' + p).join('\n')) : '';
    if (!noAttach) {
      // 整条消息只有附件：输出引用块（不带「用户：」前缀，身份键会自动跳过，
      // 引用块与其后真正的问题消息一起序列化发给 DSH）
      return attachPaths.length ? ('【文件引用】\n' + attachPaths.map((p) => '- ' + p).join('\n')) : '';
    }
    text = noAttach; // 后续解析都基于剥离附件后的文本，文件内容绝不透传
    // 保留 Copilot 独有记忆（userMemory/sessionMemory/repoMemory 的正文，去掉 XML 包装）
    const memText = extractMemoryBlocks(text);
    if (memText) {
      const rest = text.replace(/<(userMemory|sessionMemory|repoMemory)>\s*[\s\S]*?\s*<\/\1>/g, '').trim();
      if (rest) {
        const innerQ = extractUserRequest(rest);
        return '【Copilot 记忆】\n' + memText + '\n\n用户：' + (innerQ !== null ? innerQ : rest) + attachSuffix;
      }
      return '【Copilot 记忆】\n' + memText + attachSuffix;
    }
    // 优先提取 <userRequest> / <prompt> 内的真实提问（VS Code 会把提问包在 <prompt> 里，
    // 前面是 instructions/AGENTS.md 等上下文——只保留提问本身，避免污染会话与身份键）
    const inner = extractUserRequest(text);
    if (inner !== null) return '用户：' + inner + attachSuffix;
    // 剥掉 Copilot instructions 前置说明与 <instructions> 块后，若还有真实内容则继续
    const cleaned = stripCopilotContext(text);
    if (cleaned !== text) {
      if (!cleaned) return ''; // 纯 instructions/上下文 → 丢弃
      text = cleaned;
      const inner2 = extractUserRequest(text);
      if (inner2 !== null) return '用户：' + inner2 + attachSuffix;
    }
    // 垃圾块开头：剥离前缀保留尾部真实内容，而不是整条丢弃
    if (isJunkUserText(text)) {
      const stripped = stripJunkPrefix(text);
      if (stripped) return '用户：' + stripped + attachSuffix;
      return '';
    }
    return '用户：' + text + attachSuffix;
  }
  // 助手消息：剥掉我们上一轮发出的「⏳ 已提交给 DeepSeek Harness…」占位前缀，
  // 避免它作为对话上下文回传给 DSH（保留其后真正的回答内容）
  {
    const marker = DSH_ANSWER_MARKER;
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
  // 助手消息里的 VS Code 注入块（<system-reminder> 等）：剥离前缀只留回答正文，
  // 避免 system 提示词作为「已答内容」重复回传给 DSH
  {
    const sm = text.match(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/i);
    if (sm) text = text.replace(sm[0], '');
  }
  if (!text.trim()) return '';
  return '助手：' + text;
}

/** DSH 答案在 VS Code 转录里的产地标记（流式回写时作为首段文本）。 */
const DSH_ANSWER_MARKER = '⏳ 已提交给 DeepSeek Harness';

/**
 * 提取单条消息的原始文本（不做任何清洗），用于产地标记检测。
 * @param {any} m
 * @returns {string}
 */
function lmRawText(m) {
  if (!m) return '';
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
  return text;
}

/**
 * 判断一条消息是否为 DSH 自己产出的回答（带 ⏳ 产地标记的 assistant 消息）。
 * @param {any} m
 * @returns {boolean}
 */
function isDshProducedAnswer(m) {
  const role = m && m.role;
  const isAssistant = role === 'assistant' || role === 2 || role === 'Assistant';
  if (!isAssistant) return false;
  return lmRawText(m).indexOf(DSH_ANSWER_MARKER) >= 0;
}

/**
 * 找到 messages 里最后一条「DSH 已知」消息的下标（边界）。
 * - 主信号：最后一条带 ⏳ 产地标记的 assistant（DSH 自己流式产出的答案），最可靠；
 * - 辅信号（无标记时兜底）：lastUserText 对应的用户提问，紧邻其后的 assistant 即 DSH 同轮答案；
 * 找不到返回 -1。
 * 边界之后 = 切走期间其他模型的问答（外来段）+ 当前提问，是 DSH 唯一需要接收的增量。
 */
function findDshKnownBoundary(messages, lastUserText) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (isDshProducedAnswer(messages[i])) return i;
  }
  // 辅信号（无 ⏳ 标记时兜底）：从末尾扫描所有与 lastUserText 同文本的提问，
  // 取第一个「其后紧跟 assistant」的——支持用户重复提问同一文本的场景
  //（最后一次提问尚无答案，会被跳过，取上一组问答的答案为边界）。
  if (lastUserText) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const m = messages[i];
      const role = m && m.role;
      if (role !== 1 && role !== 'user' && role !== 'User') continue;
      const full = lmMessageText(m);
      if (!full.startsWith('用户：') || stripAttachSuffix(full.slice(3)) !== lastUserText) continue;
      for (let j = i + 1; j < (messages || []).length; j++) {
        const mm = messages[j];
        const r2 = mm && mm.role;
        const isUser = r2 === 'user' || r2 === 1 || r2 === 'User';
        const isAssistant = r2 === 'assistant' || r2 === 2 || r2 === 'Assistant';
        if (isAssistant) return j;
        if (isUser) break; // 答案被编辑/丢失 → 该组问答不完整，继续找更早的同文本提问
      }
    }
  }
  return -1;
}

/**
 * 把 VS Code 交给模型的消息列表序列化为纯对话文本。
 * @param {any[]} messages
 * @param {{markForeignAssistant?: boolean}} [opts] markForeignAssistant=true 时给外来 assistant 打产地标签
 * @returns {string}
 */
function serializeLmMessages(messages, opts) {
  const markForeign = !!(opts && opts.markForeignAssistant);
  const out = [];
  const emittedBlocks = new Set();
  for (const m of messages || []) {
    const s = lmMessageText(m);
    if (!s) continue;
    if (s.startsWith('【文件引用】')) {
      // 引用块消息：跨消息去重——VS Code 会把同一文件以 active file 与附件各传一次
      if (emittedBlocks.has(s)) continue;
      emittedBlocks.add(s);
      out.push(s);
      continue;
    }
    if (markForeign && s.startsWith('助手：')) {
      out.push('【Copilot 其他模型回答】' + s);
    } else {
      out.push(s);
    }
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
 * 回放/等待 DSH 会话当前轮的回答到本次 provider 调用（去重场景专用）：
 * 同一提问被 VS Code 重复投递时，不新建会话、不重复提交 prompt，只把已有/正在产出的回答
 * 再流式给本调用，保证「裸提问」与「带上下文」两次调用都能拿到答案。
 */
async function replayDshAnswer(base, sid, timeoutMs, progress, token) {
  const deadline = Date.now() + timeoutMs;
  let lastSeq = 0;
  let started = false;
  try {
    const pre = await fetchSessionHistory(base, sid);
    const events = (pre && Array.isArray(pre.events)) ? pre.events : [];
    for (const item of events) {
      const e = item && item.event ? item.event : item;
      if (e && typeof e.seq === 'number' && e.type === 'turn/start') lastSeq = e.seq > 0 ? e.seq - 1 : 0;
    }
  } catch (_) { /* 拿不到起点就从 0 开始 */ }
  let blockEndSeen = false;
  while (Date.now() < deadline) {
    if (token.isCancellationRequested) return;
    let hist;
    try {
      hist = await fetchSessionHistory(base, sid);
    } catch (_) { return; }
    const events = (hist && Array.isArray(hist.events)) ? hist.events : [];
    let ended = false;
    for (const item of events) {
      const e = item && item.event ? item.event : item;
      if (!e || typeof e.seq !== 'number' || e.seq <= lastSeq) continue;
      lastSeq = e.seq;
      if (e.type === 'turn/start') {
        started = true;
        blockEndSeen = false;
      } else if (e.type === 'assistant/chunk' && e.data && e.data.chunk) {
        const c = e.data.chunk;
        if (c.type === 'block-end' && c.block && typeof c.block.text === 'string' && c.block.text.length > 0) {
          blockEndSeen = true;
          if (!started) started = true;
          progress.report(makeTextPart(c.block.text));
        } else if (c.type === 'text-delta' && !blockEndSeen && typeof c.text === 'string' && c.text.length > 0) {
          if (!started) started = true;
          progress.report(makeTextPart(c.text));
        }
      } else if (e.type === 'turn/end') {
        ended = true;
      }
    }
    if (ended) return;
    await sleep(1000);
  }
}

/**
 * dsh 语言模型提供方的请求处理。
 * @param {any[]} messages
 * @param {any} progress Progress<LanguageModelResponsePart>
 * @param {any} token CancellationToken
 * @returns {Promise<void>}
 */
async function handleDshModelRequest(model, messages, options, progress, token) {
  const base = await apiBase();
  // 解析模型选择：dsh-deepseek-* 固定映射 DeepSeek 官方模型；dsh 条目跟随 VS Code 配置
  const fixed = resolveDshModelSelection((model && model.id) || 'dsh');
  const provider = fixed ? fixed.provider : cfg().get('dshPanel.chatProvider', '');
  const chatModel = fixed ? fixed.model : cfg().get('dshPanel.chatModel', '');
  // 推理档位：VS Code 界面选择（options.modelConfiguration.reasoningEffort）优先，
  // 其次 dshPanel.dshReasoningEffort 配置兜底，最后跟随 DSH 默认。
  // 映射：none/off → off；low/high/max 直通（DSH 实测支持值）；其余忽略。
  const DSH_EFFORTS = ['off', 'low', 'high', 'max'];
  const EFFORT_MAP = { none: 'off', off: 'off', low: 'low', high: 'high', max: 'max' };
  const uiEffort = String((options && (options.modelConfiguration || {}).reasoningEffort) || (options && (options.configuration || {}).reasoningEffort) || '');
  let effort = uiEffort || String(cfg().get('dshPanel.dshReasoningEffort', '') || '');
  if (EFFORT_MAP[effort]) effort = EFFORT_MAP[effort];
  if (effort && !DSH_EFFORTS.includes(effort)) effort = ''; // 无效档位 → 跟随 DSH 默认
  const displayModel = fixed ? fixed.model : (chatModel || 'DSH 默认模型');
  const selectionKey = provider && chatModel ? (provider + '/' + chatModel + (effort ? '/' + effort : '')) : '';
  const currentPrompt = lastLmUserText(messages);
  // 提前并行定位当前聊天 sessionId（聊天文件名）：落盘有几秒竞态，
  // 提前开始轮询可把等待藏在 DSH 就绪检查之后，不拖慢首答。
  const sessionIdPromise = currentPrompt ? locateModelChatSessionId(currentPrompt, messages) : Promise.resolve(null);
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
          model: {
            id: model && model.id,
            vendor: model && model.vendor,
            family: model && model.family,
            version: model && model.version,
            name: model && model.name,
            modelKeys: model ? Object.keys(model) : []
          },
          options: {
            allKeys: options ? Object.keys(options) : [],
            shallow: (() => {
              const o = {};
              if (!options) return o;
              for (const k of Object.keys(options)) {
                try {
                  const v = options[k];
                  if (v === null || v === undefined) { o[k] = String(v); continue; }
                  if (typeof v === 'object') {
                    if (Array.isArray(v)) { o[k] = 'array[' + v.length + ']'; continue; }
                    o[k] = { keys: Object.keys(v), json: JSON.stringify(v).slice(0, 600) };
                  } else {
                    o[k] = String(v).slice(0, 300);
                  }
                } catch (e) { o[k] = '<unserializable>'; }
              }
              return o;
            })()
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

    // 聊天身份 → DSH 会话映射：直接以 Copilot 聊天文件名（sessionId）为键——
    // 每个聊天唯一且稳定，一聊天对应一个 DSH 会话；仅当请求迟迟未落盘（极罕见）
    // 才退到首问哈希兜底（仅供同题二次投递去重，转录校验防撞）。
    const workspacePath = getWorkspaceDir();
    const map = Object.assign({}, gContext.globalState.get(DSH_MODEL_MAP_KEY) || {});
    const diskId = await sessionIdPromise;
    const chatKey = diskId
      ? ('m-' + String(diskId))
      : ('m-' + crypto.createHash('sha1').update(firstLmQuestionText(messages) || currentPrompt || 'first').digest('hex').slice(0, 16));
    const FRESH_MS = 15 * 60 * 1000;
    const entryFresh = (e, ms) => e && typeof e.lastUsedAt === 'number' && (Date.now() - e.lastUsedAt) < (ms || FRESH_MS);
    let entry = map[chatKey];
    // 直接命中校验（防串线）：同一聊天的转录里必然还留着「上次已发提问」；
    // 找不到说明键撞车（别的聊天/旧聊天）→ 视作无条目（宁可新建，不可串线）。
    // 首轮（无上一个提问）无法用转录校验，只能靠「同题 + 60 秒内活跃」判定是否为
    // 同一提问的二次投递（VS Code 裸提问/带上下文两次调用相隔仅数秒）；
    // 超过 60 秒视为别的聊天撞题 → 新建会话。
    if (entry && entry.dshSessionId && entry.workspacePath === workspacePath) {
      const prevPrompt = prevLmUserText(messages);
      const isSameChat = prevPrompt
        ? findLmUserIndex(messages, entry.lastUserText) >= 0
        : (entry.lastUserText === currentPrompt && entryFresh(entry, 60 * 1000));
      if (!isSameChat) entry = null;
    }
    // 兜底找回：极少数「请求迟迟未落盘 → 上一轮走了哈希键、本轮才拿到 sessionId 键」的情况，
    // 在映射表里找回属于同一聊天的条目（sessionId 直接映射下的安全网）。
    if (!entry || !entry.dshSessionId || entry.workspacePath !== workspacePath) {
      const prevPrompt = prevLmUserText(messages);
      if (prevPrompt) {
        // 非首轮转录找回：在所有同工作区、15 分钟内活跃的条目里，找「记录的上个提问仍出现在
        // 当前转录中」的候选，优先选出现位置最靠后的（最接近当前提问 → 最可能是同一条对话）。
        // 注意不能锚定 prevPrompt：切到其它模型后，紧邻的上一个提问是别的模型答的，
        // 而条目记录的是最后一次 DSH 提问，两者未必相同（第二次切回时的断链根因）。
        let best = null;
        let bestIdx = -1;
        for (const k of Object.keys(map)) {
          const e = map[k];
          if (!e || !e.dshSessionId || e.workspacePath !== workspacePath || !entryFresh(e)) continue;
          const idx = findLmUserIndex(messages, e.lastUserText);
          if (idx >= 0 && idx > bestIdx) { best = e; bestIdx = idx; }
        }
        if (best) {
          entry = best;
          map[chatKey] = best; // 登记到当前键下，后续保持一致
        }
      } else {
        // 首轮：只允许 60 秒内的同题合并（VS Code 裸提问/带上下文两次调用相隔数秒）
        for (const k of Object.keys(map)) {
          const e = map[k];
          if (e && e.dshSessionId && e.workspacePath === workspacePath
            && e.lastUserText === currentPrompt && entryFresh(e, 60 * 1000)) {
            entry = e;
            map[chatKey] = e;
            break;
          }
        }
      }
    }
    // 当前提问（最后一条用户消息）的附件签名：引用变化说明带来了新文件，
    // 不属于「同一提问的重复投递」，必须放行发送（否则新拖的文件永远发不出去）。
    // 只取最后一条用户消息——裸提问/带上下文两次投递的 history 序列化可能不同，
    // 全对话拼接会误伤去重（此前 v0.8.30 的教训）。
    let currentAttachSig = '';
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const mm = messages[i];
      const r2 = mm && mm.role;
      if (r2 !== 1 && r2 !== 'user' && r2 !== 'User') continue;
      const s = lmMessageText(mm);
      if (s) {
        const ai = s.indexOf('【文件引用】');
        if (ai >= 0) currentAttachSig = s.slice(ai);
        break;
      }
    }
    // 去重：VS Code 会把同一次提问投递两次（「裸提问」+「instructions+<prompt>提问」），
    // 归一化后 currentPrompt 相同且附件签名一致；此时若该会话已有进行中/已完成的同题
    // 回合（20 秒内），直接回放答案，避免 DSH 出现两个会话或同题重复提交。
    if (entry && entry.dshSessionId && entry.workspacePath === workspacePath
      && entry.lastUserText === currentPrompt
      && (entry.lastAttachSig || '') === currentAttachSig
      && (entry.pending || entry.completed)
      && entryFresh(entry, 20 * 1000)) {
      await replayDshAnswer(base, entry.dshSessionId, Number(cfg().get('dshPanel.chatTimeoutMs', 900000)) || 900000, progress, token);
      return;
    }
    let sid = null;
    let taskText = fullConvText;
    let isNewSession = false;
    if (entry && entry.dshSessionId && entry.workspacePath === workspacePath) {
      sid = entry.dshSessionId;
      // 增量（方案A）：定位最后一条「DSH 已知」消息的边界，只发其后的内容——
      // DSH 自己答过的轮次由 DSH 会话回放、不回传（省 token）；
      // 切走期间其他模型的问答（外来段）+ 当前提问是 DSH 唯一缺失的信息，补发并打产地标签。
      const boundary = findDshKnownBoundary(messages, entry.lastUserText);
      if (boundary >= 0) {
        const delta = serializeLmMessages((messages || []).slice(boundary + 1), { markForeignAssistant: cfg().get('dshPanel.markForeignAssistant', true) });
        if (delta.trim()) taskText = delta;
      } else {
        // 兜底：找不到产地标记（历史被编辑等）→ 退化为「上次已发提问之后」的增量
        const idx = findLmUserIndex(messages, entry.lastUserText);
        if (idx >= 0) {
          const delta = serializeLmMessages((messages || []).slice(idx + 1));
          if (delta.trim()) taskText = delta;
        }
      }
      // 模型/档位切换：与上次选择不一致时重新 selectModel（同一聊天保持同一 DSH 会话）
      if (selectionKey && entry.selection !== selectionKey) {
        await selectModelForSession(base, sid, provider, chatModel, effort);
        entry.selection = selectionKey;
      }
      // 找不到上次提问（消息被编辑等）则用全量（重复但正确）
    } else {
      const createPayload = { cwd: workspacePath };
      const preset = cfg().get('dshPanel.chatAgentPreset', '');
      if (preset) createPayload.agentPreset = preset;
      const created = await dshRpc(base, 'session.create', createPayload, 20000);
      sid = created.sessionId;
      isNewSession = true;
      entry = { dshSessionId: sid, workspacePath, lastUserText: '', selection: '', pending: false, completed: false, lastUsedAt: Date.now() };
      map[chatKey] = entry;
      if (selectionKey) {
        await selectModelForSession(base, sid, provider, chatModel, effort);
        entry.selection = selectionKey;
      }
    }
    entry.lastUserText = currentPrompt;
    entry.lastAttachSig = currentAttachSig;
    entry.pending = true;
    entry.completed = false;
    entry.lastUsedAt = Date.now();
    await gContext.globalState.update(DSH_MODEL_MAP_KEY, map);
    if (!taskText.trim()) taskText = '用户：' + currentPrompt;
    // 先取事件游标（必须在提交任务之前，避免把 turn/start 一并吃掉导致流式判定失效）
    const timeoutMs = Number(cfg().get('dshPanel.chatTimeoutMs', 900000)) || 900000;
    const deadline = Date.now() + timeoutMs;
    let lastSeq = 0;
    let started = false;
    try {
      const pre = await fetchSessionHistory(base, sid);
      const preEvents = (pre && Array.isArray(pre.events)) ? pre.events : [];
      for (const item of preEvents) {
        const e = item && item.event ? item.event : item;
        if (e && typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
      }
    } catch (_) { /* 读不到游标从 0 开始 */ }

    await dshRpc(base, 'session.prompt', {
      requestId: 'vscode-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: taskText }]
    }, 30000);
    progress.report(makeTextPart('⏳ 已提交给 DeepSeek Harness（' + displayModel + (effort ? ' · 档位 ' + effort : '') + '）' + (isNewSession ? '（新会话）' : '（续聊）') + '，正在执行…\n\n'));
    console.log('[DeepSeek Harness] dsh 模型请求已提交，session=' + sid);

    while (Date.now() < deadline) {
      if (token.isCancellationRequested) {
        entry.pending = false;
        try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
        progress.report(makeTextPart('\n\n> ⏹ 已停止等待。任务仍在 DSH 中运行，可到 DSH 面板查看。'));
        return;
      }
      let hist;
      try {
        hist = await fetchSessionHistory(base, sid);
      } catch (e) {
        entry.pending = false;
        try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
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
          entry.pending = false;
          entry.completed = true;
          try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
          return;
        }
      }
      await sleep(1000);
    }
    entry.pending = false;
    try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
    progress.report(makeTextPart('\n\n> ⏱ 超过等待上限（' + Math.round(timeoutMs / 60000) + ' 分钟）仍未完成。任务仍在 DSH 面板运行。'));
  } catch (e) {
    progress.report(makeTextPart('❌ DSH 模型执行出错：' + (e && e.message ? e.message : String(e))));
  }
}

/**
 * 解析 DSH 模型条目 → DeepSeek 官方固定选择；'dsh' 条目返回 null（跟随 VS Code 配置）。
 * @param {string} modelId
 * @returns {{provider: string, model: string} | null}
 */
function resolveDshModelSelection(modelId) {
  if (modelId === 'dsh-deepseek-v4-pro') return { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
  if (modelId === 'dsh-deepseek-v4-flash') return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  if (modelId === 'dsh-deepseek-v4-flash-vision-exp') return { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' };
  return null;
}

/**
 * 为 DSH 会话选择模型（含可选推理档位）；失败静默回退 DSH 默认。
 * @param {string} base
 * @param {string} sid
 * @param {string} provider
 * @param {string} chatModel
 * @param {string} effort
 * @returns {Promise<boolean>}
 */
async function selectModelForSession(base, sid, provider, chatModel, effort) {
  const payload = { sessionId: sid, provider, model: chatModel };
  if (effort) payload.reasoningEffort = effort;
  try {
    await dshRpc(base, 'session.selectModel', payload, 20000);
    return true;
  } catch (_) {
    return false; // 选择失败则用 DSH 默认模型/档位
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
    // 关键（借鉴 vizards.deepseek-v4-for-copilot）：提供 onDidChangeLanguageModelChatInformation
    // 事件，并在注册后触发一次——VS Code 会缓存模型信息，若不触发变更事件，
    // 缓存里可能是不含 configurationSchema 的旧数据，导致「推理档位」UI 不渲染。
    const dshModelEmitter = new vscode.EventEmitter();
    // 与 vizards.deepseek-v4-for-copilot 对齐：VS Code 核心依据 provider 返回的
    // languageModelChatInformation 顶级字段渲染「推理档位」配置 pill。成本用合法货币串
    // （避免 '—' 这类非法值），reasoningEffort 属性带 group:'navigation'。
    const dshModelDefs = [
      { id: 'dsh', name: 'DSH (DeepSeek Harness)', detail: '默认：跟随 DSH 设置模型 · 档位可配',
        cost: { inputCost: '$0.14', outputCost: '$0.28', cacheCost: '$0.0028' } },
      { id: 'dsh-deepseek-v4-pro', name: 'DeepSeek-V4-Pro (DSH)', detail: 'DeepSeek 官方 · 档位 off/low/high/max',
        cost: { inputCost: '$0.435', outputCost: '$0.87', cacheCost: '$0.003625' } },
      { id: 'dsh-deepseek-v4-flash', name: 'DeepSeek-V4-Flash (DSH)', detail: 'DeepSeek 官方 · 档位 off/low/high/max',
        cost: { inputCost: '$0.14', outputCost: '$0.28', cacheCost: '$0.0028' } },
      { id: 'dsh-deepseek-v4-flash-vision-exp', name: 'deepseek-v4-flash-vision-exp (DSH)', detail: 'DeepSeek 官方视觉模型 · 档位 off/low/high/max',
        cost: { inputCost: '$0.14', outputCost: '$0.28', cacheCost: '$0.0028' } }
    ];
    const dshReasoningEffortSchema = {
      type: 'string',
      title: '推理档位',
      default: 'high',
      enum: ['none', 'low', 'high', 'max'],
      enumItemLabels: ['关闭（off）', '低', '高', '最高'],
      enumDescriptions: [
        '关闭推理（对应 DSH 档位 off）',
        '低档推理',
        '高档推理（DSH 默认档位）',
        '最高档推理'
      ],
      group: 'navigation'
    };
    const provider = {
      onDidChangeLanguageModelChatInformation: dshModelEmitter.event,
      provideLanguageModelChatInformation(_options, _token) {
        const info = dshModelDefs.map((m) => ({
          id: m.id,
          name: m.name,
          family: 'dsh',
          version: '0.8.9',
          detail: m.detail,
          tooltip: 'DeepSeek Harness：在工作区解析任务、执行工具后解答；模型与推理档位可配置',
          maxInputTokens: 250000,
          maxOutputTokens: 128000,
          // 门控字段（对齐 vizards：isBYOK/isUserSelectable 让模型可被选、可配置）
          isBYOK: true,
          isUserSelectable: true,
          // toolCalling 声明为 true：Agent 模式的模型选择器只列出支持工具的模型。
          // DSH 用自己的工具执行，VS Code 传入的工具（options.tools）一律忽略、不返回工具调用，无冲突。
          capabilities: { toolCalling: true, imageInput: false },
          // 成本信息（对齐 vizards toModelCostInfo 字段，用合法货币串以免核心解析异常）
          priceCategory: 'low',
          ...m.cost,
          // 模型配置 schema：让 VS Code 在模型选择器里显示「推理档位」下拉，
          // 用户选中值经 options.modelConfiguration.reasoningEffort 传回 provider。
          configurationSchema: { properties: { reasoningEffort: dshReasoningEffortSchema } }
        }));
        // 落盘实际返回的 provider info，便于确认 configurationSchema 是否传给 VS Code。
        try {
          const dbgDir = path.join(os.homedir(), '.dsh-debug');
          fs.mkdirSync(dbgDir, { recursive: true });
          fs.writeFileSync(path.join(dbgDir, 'provider-info.json'), JSON.stringify({ ts: Date.now(), models: info }, null, 2), 'utf8');
        } catch (_) { /* 忽略 */ }
        return info;
      },
      provideLanguageModelChatResponse(model, messages, options, progress, token) {
        return handleDshModelRequest(model, messages, options, progress, token);
      },
      provideTokenCount(_model, text, _token) {
        const s = typeof text === 'string' ? text : (text && text.value ? text.value : '');
        return Promise.resolve(Math.max(1, Math.ceil(String(s).length / 3)));
      }
    };
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('dsh', provider));
    // ① 激活 Copilot Chat（若已安装），确保模型信息的实时监听器存在；
    // ② 多次触发变更事件 + 主动 selectChatModels 强制重查，覆盖核心/聊天扩展的模型缓存。
    try {
      const copilotChat = vscode.extensions.getExtension('github.copilot-chat');
      if (copilotChat) {
        copilotChat.activate().then(() => {
          setTimeout(() => { try { dshModelEmitter.fire(); } catch (_) { /* 已释放则忽略 */ } }, 50);
        }).catch(() => { /* 无监听器则忽略 */ });
      }
    } catch (_) { /* 未安装或无监听器则忽略 */ }
    [300, 1200, 3000, 6000].forEach((ms) => {
      setTimeout(() => { try { dshModelEmitter.fire(); } catch (_) { /* 已释放则忽略 */ } }, ms);
    });
    setTimeout(() => { try { vscode.lm.selectChatModels({ vendor: 'dsh' }).catch(() => {}); } catch (_) { /* 忽略 */ } }, 700);
    context.subscriptions.push(dshModelEmitter);
    dshModelProviderRegistered = true;
    console.log('[DeepSeek Harness] dsh 语言模型提供方已注册（模型选择器可见），已触发模型信息刷新');
  } catch (e) {
    console.error('[DeepSeek Harness] 注册 dsh 语言模型提供方失败：', e);
  }
}

/**
 * 诊断：列出 VS Code 语言模型注册表里的模型及其 metadata（含 configurationSchema 是否存在），
 * 与 vizards（vendor=deepseek）对比，用于定位「推理档位」UI 不渲染的原因。
 */
async function diagnoseModels() {
  // 固定输出到用户主目录（不依赖当前工作区，保证一定可找到）
  const debugDir = path.join(os.homedir(), '.dsh-debug');
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const all = await vscode.lm.selectChatModels();
    const vendors = {};
    for (const m of all || []) {
      const obj = m;
      const vendor = String(obj.vendor || '?');
      vendors[vendor] = vendors[vendor] || [];
      const meta = obj.metadata !== undefined ? obj.metadata : null;
      vendors[vendor].push({
        id: obj.id,
        name: obj.name,
        family: obj.family,
        version: obj.version,
        maxInputTokens: obj.maxInputTokens,
        maxOutputTokens: obj.maxOutputTokens,
        priceCategory: obj.priceCategory,
        category: obj.category,
        inputCost: obj.inputCost,
        outputCost: obj.outputCost,
        cacheCost: obj.cacheCost,
        capabilities: obj.capabilities,
        isUserSelectable: obj.isUserSelectable,
        isBYOK: obj.isBYOK,
        hasConfigSchema: !!(meta && meta.configurationSchema),
        metaKeys: meta ? Object.keys(meta) : [],
        metaPreview: meta ? JSON.stringify(meta).slice(0, 500) : null,
        objKeys: Object.keys(obj)
      });
    }
    const file = path.join(debugDir, 'models-diagnose.json');
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), vendors }, null, 2), 'utf8');
    vscode.window.showInformationMessage('模型注册表诊断已写入：' + file);
  } catch (e) {
    vscode.window.showErrorMessage('诊断失败：' + (e && e.message ? e.message : String(e)));
  }
}

/**
 * 「DSH 状态」诊断命令：报告模型提供方注册情况、DSH 连通性与当前模型配置。
 */
async function showChatStatus() {
  const reachable = await checkUrl(getUrl());
  const provider = cfg().get('dshPanel.chatProvider', '');
  const model = cfg().get('dshPanel.chatModel', '');
  const effort = cfg().get('dshPanel.dshReasoningEffort', '');
  const lines = [
    'DeepSeek Harness DSH 状态',
    'DSH 服务可达: ' + (reachable ? '是 (' + getUrl() + ')' : '否'),
    'Web 认证: ' + (await authStatusText()),
    'dsh 语言模型提供方: ' + (dshModelProviderRegistered ? '已注册（模型选择器可见）' : '未注册'),
    '模型配置: provider=' + (provider || '(跟随 DSH 默认)') + ' / model=' + (model || '(跟随 DSH 默认)'),
    '推理档位: ' + (effort || '(跟随 DSH 默认)'),
    '已映射聊天数: ' + Object.keys(gContext.globalState.get(DSH_MODEL_MAP_KEY) || {}).length
  ];
  vscode.window.showInformationMessage(lines.join('\n'), { modal: false });
}

/**
 * 生成认证状态的诊断文本（「DSH 状态」命令用）。
 * @returns {Promise<string>}
 */
async function authStatusText() {
  const proxy = await ensureAuthProxy();
  if (!proxy) {
    return '未启用受管认证代理（Remote 场景或目标非回环地址），面板走直连';
  }
  const s = proxy.status();
  if (proxy.hasCookieForBase()) {
    return '已认证（受管代理 ' + s.proxy + '）';
  }
  if (!s.tokenKnown) {
    return '未认证（尚未捕获 dsh 启动令牌；若 dsh 正在运行且返回 401，请重启 dsh web 由扩展接管）';
  }
  return '令牌已捕获，Cookie 换发中/失败（代理 ' + s.proxy + '）';
}

function activate(context) {
  gContext = context;
  registerDshModelProvider(context);

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
    tabReloadFn = reloadTab;
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
      if (tabReloadFn === reloadTab) tabReloadFn = null;
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

  const openBrowserCmd = vscode.commands.registerCommand('dshPanel.openInBrowser', async () => {
    // 新版 dsh web 有浏览器认证：优先打开携带启动令牌的认证链接（真实浏览器
    // 顶层导航可正常换取 Cookie）；无令牌时退回裸地址。
    let url = getUrl();
    const proxy = await ensureAuthProxy();
    if (proxy && proxy.token()) {
      url = proxy.authenticatedUrl();
    }
    vscode.env.openExternal(vscode.Uri.parse(url));
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
      const target = await resolvePanelTarget(false);
      if (activeView !== view) return;
      if (target.unauthorized) {
        maybeGuideAuth(false);
        view.description = '等待认证';
        view.webview.html = buildErrorHtml('dsh web 需要浏览器认证，且当前实例无法静默认证。请查看通知提示完成接管或粘贴认证链接。');
        return;
      }
      view.description = getUrl();
      try {
        view.webview.html = buildIframeHtml(target.displayUrl, getFontScale());
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

  const diagnoseModelsCmd = vscode.commands.registerCommand('dshPanel.diagnoseModels', () => {
    diagnoseModels().catch((e) => vscode.window.showErrorMessage('诊断失败：' + (e && e.message ? e.message : String(e))));
  });

  const chatStatusCmd = vscode.commands.registerCommand('dshPanel.chatStatus', () => {
    showChatStatus().catch((e) => vscode.window.showErrorMessage('检查 DSH 状态失败：' + (e && e.message ? e.message : String(e))));
  });

  const resetChatCmd = vscode.commands.registerCommand('dshPanel.resetChatMapping', async () => {
    if (gContext) {
      await gContext.globalState.update(DSH_MODEL_MAP_KEY, {});
    }
    vscode.window.showInformationMessage('已重置 DSH 会话映射：下次提问将创建新的 DSH 会话。');
  });

  context.subscriptions.push(viewSub, openInTabCmd, refreshCmd, openBrowserCmd, restartCmd, wsSub, sendSelectionCmd, chatStatusCmd, diagnoseModelsCmd, resetChatCmd);
}

function deactivate() {
  // 扩展停用时，按配置决定是否结束由本扩展启动的 dsh 进程。
  const killOnDispose = cfg().get('dshPanel.killOnDispose', true);
  if (killOnDispose && managedChild) {
    killTree(managedChild);
    managedChild = null;
  }
  // 关闭受管认证代理（令牌已缓存进 globalState，下次启动可无感复用）。
  if (authProxy) {
    const p = authProxy;
    authProxy = null;
    p.close().catch(() => {});
  }
}

module.exports = { activate, deactivate };

// 仅供测试钩子使用（打包体积无影响；运行时行为不变）。
module.exports.__internals = {
  createAuthProxy,
  ensureAuthProxy,
  learnDshToken,
  extractTokenParam,
  apiBase,
  normAuthority,
  startDshAndWaitReady,
  clipboardPluginFiles,
  CLIPBOARD_PLUGIN_NAME
};
