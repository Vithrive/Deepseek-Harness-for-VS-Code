'use strict';
/**
 * 受管认证代理单元测试（不依赖 VS Code / 真实 dsh）。
 * 运行：node test/auth-proxy.test.js
 * 覆盖：
 *  1) extractTokenParam 各种输入
 *  2) 控制组：裸地址直连新版 dsh（模拟）返回 401
 *  3) 代理 + onToken 后：/ 200、/api POST 200（Cookie 由代理注入）
 *  4) dsh 同端口重启（新令牌+新密钥）：旧 Cookie 失效 → 401 自动重换 → 200
 *  5) SSE 流式转发不被缓冲（分块到达）
 *  6) WebSocket 升级透传（注入 Cookie，双向数据）
 *  7) localhost 来源（标签页隔离）按 authority 独立换发 Cookie
 */
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const assert = require('assert');
const path = require('path');
const Module = require('module');

// ---------------- vscode stub ----------------
const FAKE_DSH_URL = 'http://127.0.0.1:31117';
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k === 'dshPanel.url' ? FAKE_DSH_URL : d) }),
    workspaceFolders: []
  },
  env: { remoteName: undefined },
  window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const ext = require(path.join(__dirname, '..', 'extension.js'));
const { ensureAuthProxy, learnDshToken, extractTokenParam } = ext.__internals;

// ---------------- 模拟新版 dsh web 认证 ----------------
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

class FakeDsh {
  constructor() {
    this.secret = b64url(crypto.randomBytes(32));
    this.token = b64url(crypto.randomBytes(32));
    this.minted = new Map(); // authority -> cookie value
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on('upgrade', (req, socket) => this.onUpgrade(req, socket));
  }
  listen(port) {
    return new Promise((done) => this.server.listen(port, '127.0.0.1', done));
  }
  close() {
    return new Promise((done) => this.server.close(done));
  }
  indexHtml() { return '<!DOCTYPE html><html><body>FAKE-DSH-INDEX</body></html>'; }
  onRequest(req, res) {
    const authority = String(req.headers.host || '');
    const url = new URL(req.url, 'http://x');
    const given = url.searchParams.getAll('token');
    if (url.pathname === '/' && given.length > 0) {
      if (req.method === 'GET' && given.length === 1 && given[0] === this.token && authority) {
        const value = 'v1.' + b64url(crypto.randomBytes(16)) + '.' + b64url(crypto.randomBytes(32));
        this.minted.set(authority, `dsh-auth-${authority}=${value}`);
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: '/',
          'set-cookie': `dsh-auth-${authority}=${value}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
      return;
    }
    if (this.isAuthed(req, authority)) {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.indexHtml());
        return;
      }
      if (url.pathname === '/api/echo' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, echoed: Buffer.concat(chunks).toString('utf8'), host: authority }));
        });
        return;
      }
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const timer = setInterval(() => {
          i += 1;
          res.write('data: chunk-' + i + '\n\n');
          if (i >= 3) { clearInterval(timer); res.end(); }
        }, 150);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  }
  isAuthed(req, authority) {
    const raw = req.headers.cookie;
    if (!raw || !authority) return false;
    const expected = this.minted.get(authority);
    if (!expected) return false;
    return String(raw).split(/;\s*/).includes(expected);
  }
  onUpgrade(req, socket) {
    const authority = String(req.headers.host || '');
    if (!this.isAuthed(req, authority)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.end();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('pong:'), d])));
    socket.on('error', () => socket.destroy());
  }
}

// ---------------- 小工具 ----------------
// 测试用短连接 agent：禁用 keep-alive，避免 server.close() 被空闲连接挂住。
const testAgent = new http.Agent({ keepAlive: false, maxSockets: 8 });
function request(port, method, reqPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: reqPath, method, agent: testAgent,
      headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers
    }, (res) => {
      const chunks = [];
      const times = [];
      res.on('data', (c) => { chunks.push(c); times.push(Date.now()); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), times }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ---------------- 用例 ----------------
async function main() {
  console.log('[1] extractTokenParam');
  ok(extractTokenParam('http://127.0.0.1:3080/?token=abcABC012-_xyz90') === 'abcABC012-_xyz90', '完整链接提取');
  ok(extractTokenParam('dsh web: http://127.0.0.1:3080/?token=TOKEN123 (LAN: http://192.168.1.2:3080/?token=TOKEN123)') === 'TOKEN123', '整行提取');
  ok(extractTokenParam('PLAIN_TOKEN_abcd12345678') === 'PLAIN_TOKEN_abcd12345678', '裸令牌');
  ok(extractTokenParam('http://127.0.0.1:3080/') === null, '无令牌返回 null');
  ok(extractTokenParam('') === null, '空输入');

  const dsh = new FakeDsh();
  await dsh.listen(31117);

  console.log('[2] 控制组：裸地址直连新版 dsh → 401');
  const direct = await request(31117, 'GET', '/');
  ok(direct.status === 401, '直连 / 返回 401');
  ok(/authentication required/.test(direct.body), '401 文案匹配');

  console.log('[3] 代理 + 令牌 → 无感认证');
  const proxy = await ensureAuthProxy();
  ok(proxy !== null, '本地受管代理已创建（生产入口 ensureAuthProxy）');
  ok(!learnDshToken('http://127.0.0.1:3080/'), '无令牌链接学习失败');
  ok(learnDshToken('dsh web: ' + FAKE_DSH_URL + '/?token=' + dsh.token), '从 stdout 行学习令牌');
  await proxy.waitAuthed(3000);
  ok(proxy.hasCookieForBase(), '127.0.0.1 来源 Cookie 已换发');
  const pport = proxy.port();
  const viaProxy = await request(pport, 'GET', '/');
  ok(viaProxy.status === 200 && /FAKE-DSH-INDEX/.test(viaProxy.body), '经代理访问 / 返回 200 首页');
  const echo = await request(pport, 'POST', '/api/echo', { body: JSON.stringify({ hello: 'dsh' }), headers: { 'content-type': 'application/json' } });
  ok(echo.status === 200 && JSON.parse(echo.body).echoed === '{"hello":"dsh"}', '经代理 POST /api/echo 正常');
  ok(JSON.parse(echo.body).host === '127.0.0.1:' + pport, '上游收到 Host=代理 authority（围栏一致）');

  console.log('[4] dsh 同端口重启（新令牌+新密钥）→ 401 自动重换');
  await dsh.close(); // 模拟 dsh 进程退出
  const dsh2 = new FakeDsh(); // 新进程：新 token/secret
  await dsh2.listen(31117);
  ok(learnDshToken(FAKE_DSH_URL + '/?token=' + dsh2.token), '学习新令牌（重启后 stdout）');
  await sleep(50);
  const afterRestart = await request(pport, 'GET', '/');
  ok(afterRestart.status === 200 && /FAKE-DSH-INDEX/.test(afterRestart.body), '旧 Cookie 失效后自动重换并重试成功');
  const echo2 = await request(pport, 'POST', '/api/echo', { body: '2', headers: { 'content-type': 'text/plain' } });
  ok(echo2.status === 200, '重启后 API 继续可用');

  console.log('[5] SSE 流式转发不被缓冲');
  const t0 = Date.now();
  const stream = await request(pport, 'GET', '/api/stream');
  const spread = stream.times[stream.times.length - 1] - t0;
  ok(stream.status === 200 && stream.body.includes('chunk-3'), '流内容完整');
  ok(spread >= 300, '分块到达（总耗时 ' + spread + 'ms ≥ 300ms，未整体缓冲）');

  console.log('[6] WebSocket 升级透传');
  const wsResult = await new Promise((resolve) => {
    const sock = net.connect(pport, '127.0.0.1');
    let buf = '';
    let phase = 'handshake';
    const fail = () => resolve({ ok: false });
    sock.setTimeout(3000, fail);
    sock.on('error', fail);
    sock.on('connect', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:' + pport + '\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    sock.on('data', (d) => {
      if (phase === 'handshake') {
        buf += d.toString('utf8');
        if (buf.includes('101')) {
          phase = 'data';
          sock.write(Buffer.from('hello-ws'));
        }
      } else {
        const s = d.toString('utf8');
        if (s.startsWith('pong:hello-ws')) { sock.destroy(); resolve({ ok: true }); }
      }
    });
    sock.on('close', () => { if (phase !== 'done') resolve({ ok: false }); });
  });
  ok(wsResult.ok, 'WS 握手 101 + 注入 Cookie + 双向数据');

  console.log('[7] localhost 来源（标签页隔离）独立换发');
  const viaLocalhost = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pport, path: '/', method: 'GET', agent: testAgent, headers: { host: 'localhost:' + pport } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  ok(viaLocalhost.status === 200 && /FAKE-DSH-INDEX/.test(viaLocalhost.body), 'Host=localhost 来源自动换发并通过');

  // 关闭阶段不信任优雅退出（keep-alive 空闲连接可能拖住 server.close 回调）：
  // 超时兜底 + 强制退出，保证测试进程确定性结束。
  await Promise.race([
    Promise.all([proxy.close().catch(() => {}), dsh2.close().catch(() => {})]),
    sleep(1500)
  ]);
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
