'use strict';
/**
 * 真实 dsh web 端到端验证（本机另起独立实例，不影响正在运行的 dsh）。
 * 运行：node test/e2e-real-dsh.test.js
 * 流程：
 *  1) spawn `dsh web --host 127.0.0.1 --port <p> --no-open`（与扩展同款参数）；
 *  2) 从 stdout 捕获 `dsh web: http://127.0.0.1:<p>/?token=...` 认证链接；
 *  3) 控制组：裸地址直连 → 401（新版权限生效）；
 *  4) ensureAuthProxy + learnDshToken → waitAuthed → hasCookieForBase；
 *  5) 经代理 GET / → 200 首页；POST /api/workspace.create（真实 RPC 信封）→ 200；
 *  6) 清理：taskkill 结束测试实例。
 */
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const net = require('net');
const assert = require('assert');
const Module = require('module');

const PORT = 3199;
const DSH_URL = 'http://127.0.0.1:' + PORT;

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function getJson(port, reqPath, method, body) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    const req = http.request({
      host: '127.0.0.1', port, path: reqPath, method, agent,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  if (!(await portFree(PORT))) {
    console.error('端口 ' + PORT + ' 被占用，请释放后重试。');
    process.exit(2);
  }

  // ---- vscode stub（配置指向测试实例）----
  const vscodeStub = {
    workspace: {
      getConfiguration: () => ({
        get: (k, d) => {
          if (k === 'dshPanel.url') return DSH_URL;
          if (k === 'dshPanel.port') return PORT;
          if (k === 'dshPanel.host') return '127.0.0.1';
          return d;
        }
      }),
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
  const { ensureAuthProxy, learnDshToken } = ext.__internals;

  // ---- 启动真实 dsh web（与扩展同款 spawn 方式）----
  console.log('[1] 启动 dsh web --port ' + PORT + ' --no-open …');
  const child = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(PORT), '--no-open'], {
    cwd: os.homedir(),
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let authLine = null;
  let buf = '';
  const authReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('120 秒内未捕获 dsh web 认证链接')), 120000);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) console.log('    | ' + line.slice(0, 160));
        const m = line.match(/dsh web:\s*(\S+)/);
        if (m && /[?&]token=/.test(m[1]) && !authLine) {
          authLine = m[1];
          clearTimeout(timer);
          resolve(authLine);
        }
      }
      if (buf.length > 256 * 1024) buf = '';
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8').trimEnd();
      if (s) console.error('    ! ' + s.slice(0, 160));
    });
    child.on('exit', (code) => {
      if (!authLine) { clearTimeout(timer); reject(new Error('dsh 提前退出 code=' + code)); }
    });
  });

  let failed = null;
  let killedOwnChild = false; // [5] 阶段会杀掉自拉起实例，改由扩展函数拉起新实例
  try {
    const line = await authReady;
    console.log('[2] 捕获认证链接: ' + line.slice(0, 60) + '…(token 已截断)');

    console.log('[3] 控制组：裸地址直连真实 dsh →');
    const direct = await getJson(PORT, '/', 'GET', null);
    console.log('    status=' + direct.status);
    assert.strictEqual(direct.status, 401, '裸地址应 401');
    const directApi = await getJson(PORT, '/api/workspace.create', 'POST', JSON.stringify({
      type: 'client-request', rpcId: 'e2e-direct', method: 'workspace.create', payload: { path: os.homedir() }
    }));
    console.log('    /api/workspace.create status=' + directApi.status);
    assert.strictEqual(directApi.status, 401, '裸 API 应 401');

    console.log('[4] 代理 + stdout 令牌 → 无感认证');
    const proxy = await ensureAuthProxy();
    assert.ok(proxy, '代理应创建');
    assert.ok(learnDshToken(line), '令牌应学习成功');
    await proxy.waitAuthed(20000);
    assert.ok(proxy.hasCookieForBase(), 'Cookie 应换发成功');

    const pport = proxy.port();
    const index = await getJson(pport, '/', 'GET', null);
    console.log('    GET  代理 /            → ' + index.status + '（' + index.body.length + ' 字节）');
    assert.strictEqual(index.status, 200, '经代理首页应 200');
    assert.ok(index.body.length > 200, '首页应为真实前端页面');

    const envelope = JSON.stringify({
      type: 'client-request',
      rpcId: 'e2e-' + crypto.randomBytes(3).toString('hex'),
      method: 'workspace/create',
      payload: { args: { request: { path: os.homedir() } } }
    });
    const api = await getJson(pport, '/api/workspace/create', 'POST', envelope);
    console.log('    POST 代理 /api/workspace/create → ' + api.status);
    console.log('    ↳ ' + api.body.slice(0, 400));
    assert.strictEqual(api.status, 200, '经代理真实 API 应 200（围栏+认证通过）');
    const apiParsed = JSON.parse(api.body);
    assert.ok(apiParsed.result && apiParsed.result.ok === true, 'workspace/create 业务应成功：' + api.body.slice(0, 200));

    // 旧点号端点应已 404（验证新版端点规范生效）
    const legacy = await getJson(pport, '/api/workspace.create', 'POST', envelope.replace('workspace/create', 'workspace.create'));
    console.log('    POST 代理 /api/workspace.create（旧点号）→ ' + legacy.status + '（新 dsh 应为 404，由扩展回退逻辑兼容）');

    // session/create：provider 关键路径（与扩展 createPayload 同形）
    const createEnv = JSON.stringify({
      type: 'client-request',
      rpcId: 'e2e-sc-' + crypto.randomBytes(3).toString('hex'),
      method: 'session/create',
      payload: { args: { request: { cwd: os.homedir() } } }
    });
    const sc = await getJson(pport, '/api/session/create', 'POST', createEnv);
    console.log('    POST 代理 /api/session/create → ' + sc.status);
    console.log('    ↳ ' + sc.body.slice(0, 400));
    assert.strictEqual(sc.status, 200, '经代理 session/create 应 200');
    const scParsed = JSON.parse(sc.body);
    assert.ok(scParsed.result && scParsed.result.ok === true && scParsed.result.value && scParsed.result.value.sessionId, 'session/create 应返回 sessionId：' + sc.body.slice(0, 200));
    const newSid = scParsed.result.value.sessionId;

    // session/page：provider 历史轮询路径（fetchSessionHistory 的两步游标探测）
    const pageCall = (seq) => JSON.stringify({
      type: 'client-request',
      rpcId: 'e2e-pg-' + crypto.randomBytes(3).toString('hex'),
      method: 'session/page',
      payload: { args: { request: { address: { kind: 'session', sessionId: newSid }, throughSeq: seq, maxMessages: 100 } } }
    });
    let cursor = -1;
    const probe = await getJson(pport, '/api/session/page', 'POST', pageCall(Number.MAX_SAFE_INTEGER));
    const pm = /past cursor (-?\d+)/.exec(probe.body);
    if (pm) cursor = parseInt(pm[1], 10);
    console.log('    POST 代理 /api/session/page 探测 → 游标 ' + cursor);
    assert.ok(cursor >= 0, '应从错误信息解析出游标');
    const pg = await getJson(pport, '/api/session/page', 'POST', pageCall(cursor));
    assert.strictEqual(pg.status, 200, '经代理 session/page 应 200');
    const pgParsed = JSON.parse(pg.body);
    assert.ok(pgParsed.result && pgParsed.result.ok === true && Array.isArray(pgParsed.result.value.records), 'session/page 应返回 records：' + pg.body.slice(0, 200));
    console.log('    POST 代理 /api/session/page → ok（records=' + pgParsed.result.value.records.length + '，hasMore=' + pgParsed.result.value.hasMore + '）');

    console.log('[5] 真实重启场景（与扩展「重启 dsh web」同路径）');
    const tokenBeforeRestart = proxy.token();
    // 杀掉 E2E 自己拉起的实例，释放端口（Windows taskkill / POSIX SIGKILL）
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killedOwnChild = true;
    } else if (child.pid && !killedOwnChild) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      killedOwnChild = true;
    }
    for (let i = 0; i < 20; i++) { await sleep(500); if (await portFree(PORT)) break; }
    assert.ok(await portFree(PORT), '端口应已释放');
    // 走生产函数重启（内部等待「认证链接打印」这一完全启动信号）
    const restartStart = Date.now();
    const restartOk = await ext.__internals.startDshAndWaitReady(DSH_URL);
    const restartMs = Date.now() - restartStart;
    assert.ok(restartOk, 'startDshAndWaitReady 应成功');
    console.log('    重启就绪耗时 ' + restartMs + 'ms');
    assert.notStrictEqual(proxy.token(), tokenBeforeRestart, '应捕获到新进程的令牌');
    assert.ok(proxy.hasCookieForBase(), '重启后 Cookie 应就绪');
    let selfStatus = 0;
    for (let i = 0; i < 15; i++) {
      selfStatus = await proxy.probeSelf(2500);
      if (selfStatus === 200) break;
      await sleep(400);
    }
    assert.strictEqual(selfStatus, 200, '重启后代理自检应为 200（无半就绪窗口）');
    console.log('    代理自检 → 200 ✓');

    console.log('\n端到端验证全部通过 ✓（测试实例即将清理）');
  } catch (e) {
    failed = e;
  } finally {
    // 清理测试实例进程树（先清理再退出，确保 finally 一定执行）。
    // [5] 之后端口由扩展函数拉起的新实例持有：按端口找 PID 兜底清理。
    let killed = false;
    if (process.platform === 'win32' && child.pid && !killedOwnChild) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killed = true;
    } else if (child.pid && !killedOwnChild) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      killed = true;
    }
    if (!killed) {
      // 按端口清理 [5] 阶段扩展函数拉起的实例（跨平台：Windows netstat+taskkill；
      // POSIX 用 fuser/lsof，不依赖 netstat（Linux 常无该命令））。
      const execSync = require('child_process').execSync;
      if (process.platform !== 'win32') {
        try { execSync('fuser -k ' + PORT + '/tcp 2>/dev/null || true'); } catch { /* noop */ }
        try { execSync('lsof -ti:' + PORT + ' 2>/dev/null | xargs -r kill -9 2>/dev/null || true'); } catch { /* noop */ }
      } else {
        const net = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
        const pids = new Set();
        for (const line of net.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[0] === 'TCP' && parts[1] === '127.0.0.1:' + PORT && parts[3] === 'LISTENING' && parts[4]) {
            pids.add(parts[4]);
          }
        }
        for (const pid of pids) {
          try { spawn('taskkill', ['/pid', pid, '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
        }
      }
    }
    await sleep(800);
  }
  if (failed) throw failed;
}

const guard = setTimeout(() => {
  console.error('整体超时（300s），强制退出。');
  process.exit(3);
}, 300000);
guard.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().then(async () => {
  // 关闭代理（不信任优雅退出，超时兜底）
  try {
    const { ensureAuthProxy } = ext.__internals;
    // authProxy 为模块内部单例，进程退出即可释放；此处仅为语义完整。
    void ensureAuthProxy;
  } catch { /* noop */ }
  process.exit(0);
}, (e) => {
  console.error('验证失败：', e && e.message ? e.message : e);
  process.exit(1);
});
