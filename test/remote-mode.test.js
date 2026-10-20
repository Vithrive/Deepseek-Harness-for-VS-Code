'use strict';
/**
 * Remote 模式判定与端口转发回归测试（Issue #13 / #16）：
 * - 本地 / WSL / Remote-SSH / Dev Containers：只要 dshPanel.url 指向回环地址，
 *   就启用受管认证代理（扩展宿主与 dsh 同机，回环前提成立）；
 * - 真远程（Remote-SSH / Dev Container）多一步：代理地址经 asExternalUri 端口
 *   转发后才交给 webview。本测试用真实的本地转发监听器模拟 VS Code 的端口转发，
 *   验证「客户端 authority 经转发 → 远端代理 → dsh」整条链路能通过认证；
 * - 非回环地址一律不启用代理；
 * - WSL 不需要转发（Windows 侧可直达 WSL 回环）。
 * 运行：node test/remote-mode.test.js
 */
const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

// ---------------- 模拟 VS Code 端口转发 ----------------
// 真远程下 asExternalUri 会把扩展宿主回环端口映射到客户端的一个回环端口，
// 请求经该端口原样转发（Host 头保持客户端 authority）。这里用真实 TCP 转发复刻。
const forwards = new Map(); // target 'host:port' -> { port, server }
function ensureForward(targetHost, targetPort) {
  const key = targetHost + ':' + targetPort;
  if (forwards.has(key)) return Promise.resolve(forwards.get(key).port);
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(targetPort, targetHost);
      client.pipe(upstream);
      upstream.pipe(client);
      const bye = () => { client.destroy(); upstream.destroy(); };
      client.on('error', bye);
      upstream.on('error', bye);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      forwards.set(key, { port: server.address().port, server });
      resolve(server.address().port);
    });
  });
}
function closeForwards() {
  return Promise.all([...forwards.values()].map(({ server }) => new Promise((done) => {
    server.close(() => done());
    setTimeout(done, 1000).unref();
  })));
}

// ---------------- vscode stub ----------------
const state = { remoteName: undefined, url: 'http://127.0.0.1:31118', forwarded: [] };
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'dshPanel.url') return state.url;
        if (k === 'dshPanel.port') return 31118;
        if (k === 'dshPanel.host') return '127.0.0.1';
        return d;
      }
    }),
    workspaceFolders: []
  },
  env: {
    get remoteName() { return state.remoteName; },
    async asExternalUri(uri) {
      const u = new URL(uri.toString());
      const port = await ensureForward(u.hostname, Number(u.port));
      const out = new URL(u.toString());
      out.port = String(port);
      state.forwarded.push(out.toString());
      return { toString: () => out.toString() };
    }
  },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const { isLocalLoopbackTarget, needsClientForwarding, forwardToClient, ensureAuthProxy, resolvePanelTarget, probeDirectIndexStatus, learnDshToken } = ext.__internals;

// ---------------- 模拟新版 dsh web 认证 ----------------
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

class FakeDsh {
  constructor() {
    this.token = b64url(crypto.randomBytes(32));
    this.minted = new Map(); // authority -> cookie pair
    this.seenHosts = [];
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }
  listen(port) { return new Promise((done) => this.server.listen(port, '127.0.0.1', done)); }
  close() { return new Promise((done) => this.server.close(done)); }
  onRequest(req, res) {
    const authority = String(req.headers.host || '');
    this.seenHosts.push(authority);
    const url = new URL(req.url, 'http://x');
    const given = url.searchParams.getAll('token');
    if (url.pathname === '/' && given.length === 1) {
      if (given[0] === this.token && authority) {
        const pair = 'dsh-auth-' + b64url(Buffer.from(authority)) + '=v1.sig';
        this.minted.set(authority, pair);
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: './',
          'set-cookie': pair + '; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
      return;
    }
    if (this.isAuthed(req, authority)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>FAKE-DSH-INDEX</body></html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  }
  isAuthed(req, authority) {
    const expected = this.minted.get(authority);
    if (!expected || !req.headers.cookie) return false;
    return String(req.headers.cookie).split(/;\s*/).includes(expected);
  }
}

const testAgent = new http.Agent({ keepAlive: false, maxSockets: 8 });
function request(host, port, method, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: reqPath, method, agent: testAgent, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
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

async function main() {
  console.log('[1] isLocalLoopbackTarget：回环地址 + 各 remoteName 一律启用');
  state.url = 'http://127.0.0.1:31118';
  for (const remote of [undefined, 'wsl', 'ssh-remote', 'dev-container', 'attached-container']) {
    state.remoteName = remote;
    ok(isLocalLoopbackTarget() === true, String(remote) + ' + 回环 → 启用');
  }
  state.url = 'https://dsh.example.com';
  state.remoteName = 'ssh-remote';
  ok(isLocalLoopbackTarget() === false, 'SSH Remote + 非回环域名 → 不启用');
  state.url = 'http://192.168.1.10:31118';
  ok(isLocalLoopbackTarget() === false, 'SSH Remote + 非回环私网地址 → 不启用');
  state.url = 'http://[::1]:31118';
  ok(isLocalLoopbackTarget() === true, 'SSH Remote + IPv6 回环 → 启用');

  console.log('[2] needsClientForwarding：只有真远程需要端口转发');
  state.remoteName = undefined;
  ok(needsClientForwarding() === false, '本地 → 不转发');
  state.remoteName = 'wsl';
  ok(needsClientForwarding() === false, 'WSL → 不转发（Windows 侧直达回环）');
  state.remoteName = 'ssh-remote';
  ok(needsClientForwarding() === true, 'SSH Remote → 需要转发');
  state.remoteName = 'dev-container';
  ok(needsClientForwarding() === true, 'Dev Container → 需要转发');

  console.log('[3] forwardToClient：本地原样 / 真远程经 asExternalUri');
  state.url = 'http://127.0.0.1:31118';
  state.remoteName = undefined;
  ok((await forwardToClient('http://127.0.0.1:12345')) === 'http://127.0.0.1:12345', '本地地址不变');
  state.remoteName = 'ssh-remote';
  const forwarded = await forwardToClient('http://127.0.0.1:12345');
  ok(/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(forwarded) && !forwarded.includes(':12345'), 'SSH Remote → 换成转发端口：' + forwarded);

  console.log('[4] 真远程 + 新版 dsh：代理生效，且经转发链路可认证');
  const dsh = new FakeDsh();
  await dsh.listen(31118);
  state.remoteName = 'ssh-remote';
  state.url = 'http://127.0.0.1:31118';
  const direct = await request('127.0.0.1', 31118, 'GET', '/');
  ok(direct.status === 401, '控制组：远端裸地址直连 → 401');
  const proxy = await ensureAuthProxy();
  ok(!!proxy, 'SSH Remote → 代理已创建（不再返回 null）');
  learnDshToken('dsh web: http://127.0.0.1:31118/?token=' + dsh.token);
  await proxy.waitAuthed(3000);
  ok(proxy.hasCookieForBase(), '代理已换发 127.0.0.1 来源 Cookie');

  const target = await resolvePanelTarget(false);
  ok(typeof target.displayUrl === 'string', 'resolvePanelTarget 返回展示地址');
  const displayUrl = new URL(target.displayUrl);
  ok(displayUrl.port !== String(proxy.port()), '展示地址是转发端口而非代理端口：' + target.displayUrl);
  const viaForward = await request(displayUrl.hostname, Number(displayUrl.port), 'GET', '/');
  ok(viaForward.status === 200 && /FAKE-DSH-INDEX/.test(viaForward.body), '客户端经转发端口访问 → 200 首页（端到端认证通过）');
  const fwdAuthority = displayUrl.host;
  ok(dsh.seenHosts.includes(fwdAuthority), '上游收到 Host=客户端转发 authority（围栏一致）：' + fwdAuthority);
  ok(proxy.status().authedAuthorities.includes(fwdAuthority), '代理按转发 authority 独立换发 Cookie');

  console.log('[5] 真远程 + 非回环目标：维持引导路径');
  state.url = 'http://192.168.1.10:31118';
  const none = await ensureAuthProxy();
  await sleep(0);
  ok(none === null, '非回环目标 → 不创建代理');
  state.remoteName = 'ssh-remote';
  state.url = 'http://127.0.0.1:1'; // 必然无监听
  const st = await probeDirectIndexStatus(1500);
  ok(st === 0, '上游不可达 → probeDirectIndexStatus 返回 0（不抛错）');

  await proxy.close().catch(() => {});
  await dsh.close().catch(() => {});
  await closeForwards();
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
