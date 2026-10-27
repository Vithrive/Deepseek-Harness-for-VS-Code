'use strict';
/**
 * Remote-SSH / Dev Containers 下的受管认证代理端到端测试（Issue #24）。
 * 运行：node test/remote-auth-proxy.test.js
 *
 * 场景等价性：
 * - 扩展宿主与 dsh 同机（回环），vscode.env.remoteName='ssh-remote'；
 * - 客户端 webview 访问不到宿主回环 → 用 asExternalUri 把端口转发到「客户端」；
 *   这里用真实的 TCP 转发器模拟 VS Code 的端口转发（保留 Host 头），
 *   因此可以验证：Host 变为客户端转发 authority 后的 Cookie 换发、代理来源校验、
 *   以及扩展自身 /api 调用是否带密钥头。
 *
 * 覆盖：
 *  1) 远程判定与代理创建（remote 模式）
 *  2) resolvePanelTarget 返回「客户端可达」的代理地址，并登记 authority 白名单
 *  3) 经转发地址访问面板首页 → 200（代理按客户端 authority 换发 Cookie）
 *  4) 安全：无密钥 + 非白名单 Host → 403；扩展自身带 x-dsh-proxy-key → 放行
 *  5) apiBase + dshRpc（Extension 侧 /api）在远程下可用
 *  6) resolveBrowserUrl 经转发（不再打开客户端本机的 127.0.0.1:3080）
 *  7) remoteAuthProxy=false 时退回无代理（引导路径）
 */
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const Module = require('module');

const FAKE_DSH_PORT = 31118;
const FAKE_DSH_URL = 'http://127.0.0.1:' + FAKE_DSH_PORT;

// ---------------- vscode stub ----------------
const state = { remoteName: 'ssh-remote', allowRemoteProxy: true, throwExternal: false };
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'dshPanel.url') return FAKE_DSH_URL;
        if (k === 'dshPanel.remoteAuthProxy') return state.allowRemoteProxy;
        return d;
      }
    }),
    workspaceFolders: []
  },
  env: {
    get remoteName() { return state.remoteName; },
    async asExternalUri(uri) {
      if (state.throwExternal) throw new Error('端口转发不可用');
      const input = uri.toString();
      const u = new URL(input);
      const clientPort = await ensureForwarder(Number(u.port) || 80);
      return { toString: () => 'http://127.0.0.1:' + clientPort + u.pathname + u.search };
    }
  },
  window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

// ---------------- 客户端端口转发模拟（VS Code asExternalUri 行为） ----------------
const forwarders = new Map(); // serverPort -> clientPort
const forwardServers = [];
function ensureForwarder(serverPort) {
  if (forwarders.has(serverPort)) return forwarders.get(serverPort);
  const p = new Promise((resolve) => {
    const proxy = net.createServer((sock) => {
      const up = net.connect(serverPort, '127.0.0.1');
      sock.pipe(up);
      up.pipe(sock);
      const destroy = () => { try { sock.destroy(); } catch { /* noop */ } try { up.destroy(); } catch { /* noop */ } };
      sock.on('error', destroy);
      up.on('error', destroy);
    });
    proxy.on('error', () => resolve(null));
    proxy.listen(0, '127.0.0.1', () => {
      forwardServers.push(proxy);
      const clientPort = proxy.address().port;
      forwarders.set(serverPort, clientPort);
      resolve(clientPort);
    });
  });
  forwarders.set(serverPort, p); // 占位，避免并发重复创建
  return p;
}

const ext = require(path.join(__dirname, '..', 'extension.js'));
const {
  ensureAuthProxy, learnDshToken, apiBase, dshRpc, resolvePanelTarget, resolveBrowserUrl,
  needsPortForwarding, buildIframeHtml
} = ext.__internals;

// ---------------- 模拟新版 dsh web 认证 ----------------
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

class FakeDsh {
  constructor() {
    this.token = b64url(crypto.randomBytes(32));
    this.minted = new Map(); // authority -> cookie value
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }
  listen(port) { return new Promise((done) => this.server.listen(port, '127.0.0.1', done)); }
  close() { return new Promise((done) => this.server.close(() => done())); }
  onRequest(req, res) {
    const authority = String(req.headers.host || '');
    const url = new URL(req.url, 'http://x');
    const given = url.searchParams.getAll('token');
    if (url.pathname === '/' && given.length > 0) {
      if (req.method === 'GET' && given.length === 1 && given[0] === this.token && authority) {
        const value = 'v1.' + b64url(crypto.randomBytes(16));
        this.minted.set(authority, `dsh-auth-${authority}=${value}`);
        res.writeHead(303, {
          location: '/',
          'set-cookie': `dsh-auth-${authority}=${value}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('auth required');
      return;
    }
    if (!this.isAuthed(req, authority)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('auth required');
      return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>REMOTE-FAKE-DSH</body></html>');
      return;
    }
    if (url.pathname === '/api/session/list' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true, value: { items: [{ id: 's1', host: authority }] } } }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
  isAuthed(req, authority) {
    const raw = req.headers.cookie;
    if (!raw || !authority) return false;
    const expected = this.minted.get(authority);
    return !!expected && String(raw).split(/;\s*/).includes(expected);
  }
}

// ---------------- 小工具 ----------------
const testAgent = new http.Agent({ keepAlive: false, maxSockets: 8 });
function request(port, method, reqPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: reqPath, method, agent: testAgent,
      headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

async function main() {
  const dsh = new FakeDsh();
  await dsh.listen(FAKE_DSH_PORT);

  console.log('[1] 远程判定 + 代理创建');
  ok(needsPortForwarding() === true, 'remoteName=ssh-remote → 需要端口转发');
  const proxy = await ensureAuthProxy();
  ok(!!proxy, '远程 + 回环目标 → 代理已创建');
  ok(proxy.remoteMode() === true, '代理为 remote 模式（启用来源校验）');
  const proxyPort = proxy.port();
  ok(proxy.baseUrl() === 'http://127.0.0.1:' + proxyPort, '代理地址仍是宿主回环');

  console.log('[2] resolvePanelTarget：返回客户端可达地址');
  ok(learnDshToken('dsh web: ' + FAKE_DSH_URL + '/?token=' + dsh.token), '学习启动令牌');
  await proxy.waitAuthed(4000);
  ok(proxy.hasCookieForBase(), '宿主来源 Cookie 已换发');
  const target = await resolvePanelTarget(false);
  ok(target && typeof target.displayUrl === 'string', '返回 displayUrl');
  ok(target.displayUrl.startsWith('http://127.0.0.1:') && target.displayUrl !== proxy.baseUrl(), 'displayUrl 是转发后的客户端地址（不等于宿主代理地址）');
  const clientPort = Number(new URL(target.displayUrl).port);
  ok(clientPort > 0 && clientPort !== proxyPort, '客户端端口与宿主代理端口不同（真实转发）');
  const authorities = proxy.status().clientAuthorities;
  ok(authorities.includes('127.0.0.1:' + clientPort), '已登记客户端 authority 白名单');

  console.log('[3] 经客户端转发地址加载面板（Host=客户端 authority）');
  const page = await request(clientPort, 'GET', '/');
  ok(page.status === 200 && /REMOTE-FAKE-DSH/.test(page.body), '经转发地址访问首页 → 200（代理按客户端 authority 换发 Cookie）');
  const again = await request(clientPort, 'GET', '/');
  ok(again.status === 200, '重复访问仍然 200（Cookie 已缓存）');
  // 面板 HTML：CSP frame-src 必须精确放行客户端转发地址的 origin，iframe src 就是该地址。
  const panelHtml = buildIframeHtml(target.displayUrl, 1, 'off');
  ok(panelHtml.includes('frame-src http://127.0.0.1:' + clientPort), '面板 CSP frame-src 指向客户端转发 origin');
  ok(panelHtml.includes('src="' + target.displayUrl + '"'), 'iframe src 使用转发后的地址');

  console.log('[4] 远程来源校验（安全加固）');
  const noKeyOwnHost = await request(proxyPort, 'GET', '/', { headers: { host: '127.0.0.1:' + proxyPort } });
  ok(noKeyOwnHost.status === 403, '无密钥直接打宿主代理端口 → 403');
  const foreignHost = await request(proxyPort, 'GET', '/', { headers: { host: 'evil.example' } });
  ok(foreignHost.status === 403, '伪造 Host → 403');
  const key = proxy.keyHeaders();
  const withKey = await request(proxyPort, 'GET', '/', { headers: { host: '127.0.0.1:' + proxyPort, ...key } });
  ok(withKey.status === 200, '扩展自身带 x-dsh-proxy-key → 200');

  console.log('[5] 扩展侧 /api（apiBase + dshRpc）在远程下可用');
  const base = await apiBase();
  ok(base === proxy.baseUrl(), 'apiBase → 代理基址（扩展宿主侧）');
  const rpc = await dshRpc(base, 'session/list', {});
  ok(rpc && Array.isArray(rpc.items) && rpc.items.length === 1, 'dshRpc 经代理成功（httpPostJson 自带密钥头）');
  const noKeyPost = await request(proxyPort, 'POST', '/api/session/list', {
    body: '{}', headers: { host: '127.0.0.1:' + proxyPort, 'content-type': 'application/json' }
  });
  ok(noKeyPost.status === 403, '无密钥 POST /api → 403（同机他人无法借代理调 API）');

  console.log('[6] resolveBrowserUrl：经转发打开（不再是客户端本机 3080）');
  const browserUrl = await resolveBrowserUrl();
  ok(browserUrl.startsWith('http://127.0.0.1:'), '浏览器地址为客户端地址: ' + browserUrl);
  ok(/token=/.test(browserUrl), '仍携带认证令牌');
  ok(browserUrl !== FAKE_DSH_URL && !browserUrl.startsWith(FAKE_DSH_URL), '不是宿主侧裸地址');

  console.log('[7] remoteAuthProxy=false → 退回无代理引导');
  state.allowRemoteProxy = false;
  ok((await ensureAuthProxy()) === null, '关闭远程代理 → ensureAuthProxy 返回 null');
  state.allowRemoteProxy = true;

  const proxPorxy = await ensureAuthProxy();
  ok(!!proxPorxy, '重新开启 → 代理可再次创建');

  console.log('[8] asExternalUri 失败 → 明确报错（不返回白屏地址）');
  state.throwExternal = true;
  const failed = await resolvePanelTarget(false);
  ok(failed && failed.forwardFailed === true, '转发失败返回 forwardFailed');
  ok(/端口转发失败/.test(String(failed.reason || '')), 'reason 说明端口转发失败');
  state.throwExternal = false;
  const recovered = await resolvePanelTarget(false);
  ok(recovered && typeof recovered.displayUrl === 'string' && recovered.displayUrl.startsWith('http://127.0.0.1:'), '恢复后可正常解析');

  // 关闭：先释放代理与 dsh，再关转发器；超时兜底保证进程确定性退出。
  await Promise.race([
    Promise.all([proxPorxy && proxPorxy.close ? proxPorxy.close().catch(() => {}) : Promise.resolve(), dsh.close().catch(() => {})]),
    new Promise((r) => setTimeout(r, 1500))
  ]);
  for (const s of forwardServers) { try { s.close(); } catch { /* noop */ } }
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
