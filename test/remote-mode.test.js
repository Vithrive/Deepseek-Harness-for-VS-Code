'use strict';
/**
 * Remote 模式判定回归测试（Issue #13 / #24）：
 * - `isLocalLoopbackTarget()` 只看 dshPanel.url 是否回环（extensionKind=workspace 下
 *   本地 / WSL / Remote-SSH / Dev Containers 的扩展宿主都与 dsh 同机）；
 * - `needsPortForwarding()` 区分「WSL（客户端可直达宿主回环）」与「真远程（必须
 *   经 asExternalUri 转发代理端口）」；
 * - 真远程默认启用受管认证代理（remote 模式），非回环目标一律不启用；
 * - `dshPanel.remoteAuthProxy=false` 时不建代理（共享服务器安全开关）。
 * 运行：node test/remote-mode.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const state = { remoteName: undefined, url: 'http://127.0.0.1:3080', allowRemoteProxy: true, externalUrl: null, throwOnExternal: false };
const externalCalls = [];
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'dshPanel.url') return state.url;
        if (k === 'dshPanel.port') return 3080;
        if (k === 'dshPanel.host') return '127.0.0.1';
        if (k === 'dshPanel.remoteAuthProxy') return state.allowRemoteProxy;
        return d;
      }
    }),
    workspaceFolders: []
  },
  env: {
    get remoteName() { return state.remoteName; },
    async asExternalUri(uri) {
      const input = uri.toString();
      externalCalls.push(input);
      if (state.throwOnExternal) throw new Error('asExternalUri 不可用');
      const out = state.externalUrl || 'http://127.0.0.1:41000/';
      return { toString: () => out };
    }
  },
  window: {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const {
  isLocalLoopbackTarget, needsPortForwarding, toClientUrl, authProxyWanted, ensureAuthProxy,
  resolvePanelTarget, probeDirectIndexStatus
} = ext.__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

async function main() {
  console.log('[1] isLocalLoopbackTarget：只看 URL 是否回环（Issue #24 修复点）');
  state.url = 'http://127.0.0.1:3080';
  state.remoteName = undefined;
  ok(isLocalLoopbackTarget() === true, '本地（无 remoteName）→ true');
  state.remoteName = 'wsl';
  ok(isLocalLoopbackTarget() === true, 'WSL Remote → true（Issue #13 行为保持）');
  state.remoteName = 'ssh-remote';
  ok(isLocalLoopbackTarget() === true, 'SSH Remote + 回环 url → true（Issue #24：宿主与 dsh 同机）');
  state.remoteName = 'dev-container';
  ok(isLocalLoopbackTarget() === true, 'Dev Container + 回环 url → true');
  state.remoteName = 'attached-container';
  ok(isLocalLoopbackTarget() === true, 'Attached Container + 回环 url → true');

  console.log('[2] isLocalLoopbackTarget：localhost / IPv6 / 非回环');
  state.remoteName = 'ssh-remote';
  state.url = 'http://localhost:3080';
  ok(isLocalLoopbackTarget() === true, 'localhost 回环 → true');
  state.url = 'http://[::1]:3080';
  ok(isLocalLoopbackTarget() === true, 'IPv6 回环 → true');
  state.url = 'https://dsh.example.com';
  ok(isLocalLoopbackTarget() === false, '非回环域名 → false');
  state.url = 'http://192.168.1.10:3080';
  ok(isLocalLoopbackTarget() === false, '非回环私网地址 → false');
  state.url = 'http://127.0.0.1:3080';

  console.log('[3] needsPortForwarding：WSL 不转发，真远程必须转发');
  state.remoteName = undefined;
  ok(needsPortForwarding() === false, '本地 → false');
  state.remoteName = 'wsl';
  ok(needsPortForwarding() === false, 'WSL → false（客户端可直达宿主回环）');
  for (const name of ['ssh-remote', 'dev-container', 'attached-container', 'tunnel']) {
    state.remoteName = name;
    ok(needsPortForwarding() === true, name + ' → true');
  }

  console.log('[4] toClientUrl：真远程经 asExternalUri 转发，本地/WSL 原样');
  state.remoteName = 'wsl';
  externalCalls.length = 0;
  ok((await toClientUrl('http://127.0.0.1:5000/')) === 'http://127.0.0.1:5000/', 'WSL → 原样返回');
  ok(externalCalls.length === 0, 'WSL → 不调用 asExternalUri');
  state.remoteName = 'ssh-remote';
  state.externalUrl = 'http://127.0.0.1:41000/';
  externalCalls.length = 0;
  ok((await toClientUrl('http://127.0.0.1:5000/')) === 'http://127.0.0.1:41000/', 'SSH Remote → 返回转发后的客户端地址');
  ok(externalCalls[0] === 'http://127.0.0.1:5000/', 'asExternalUri 收到宿主地址');
  state.throwOnExternal = true;
  ok((await toClientUrl('http://127.0.0.1:5000/')) === 'http://127.0.0.1:5000/', 'asExternalUri 抛错 → 退回原地址（不炸面板）');
  state.throwOnExternal = false;

  console.log('[5] authProxyWanted / ensureAuthProxy：远程默认启用，可配置关闭');
  state.remoteName = 'ssh-remote';
  state.allowRemoteProxy = true;
  state.url = 'http://127.0.0.1:31119'; // 无服务也可建代理（只监听，不连上游）
  ok(authProxyWanted() === true, 'SSH Remote + 回环 url + 默认配置 → 想要代理');
  const proxy = await ensureAuthProxy();
  ok(!!proxy && typeof proxy.port === 'function' && proxy.port() > 0, 'SSH Remote → 代理已创建（remote 模式）');
  ok(proxy.remoteMode() === true, 'SSH Remote 代理标记 remoteMode');
  ok(proxy.baseUrl().startsWith('http://127.0.0.1:'), '代理仍只绑定 127.0.0.1（不对外监听）');
  ok(proxy.status().clientAuthorities.length === 0, '尚未转发时不登记任何客户端 authority');

  console.log('[5b] resolvePanelTarget：转发失败 → 返回可读错误而不是白屏');
  state.throwOnExternal = true;
  const failedTarget = await resolvePanelTarget(false);
  ok(failedTarget && failedTarget.forwardFailed === true, 'asExternalUri 失败时返回 forwardFailed');
  ok(typeof failedTarget.reason === 'string' && /端口转发失败/.test(failedTarget.reason), 'reason 说明端口转发失败');
  state.throwOnExternal = false;

  state.allowRemoteProxy = false;
  ok(authProxyWanted() === false, 'remoteAuthProxy=false → 不想要代理');
  ok((await ensureAuthProxy()) === null, 'remoteAuthProxy=false → 返回 null（复用旧实例也被释放）');
  state.allowRemoteProxy = true;

  state.remoteName = 'wsl';
  const wslProxy = await ensureAuthProxy();
  ok(!!wslProxy && wslProxy.remoteMode() === false, 'WSL → 新建本地模式代理（远程实例已释放）');
  ok(wslProxy !== proxy, '模式切换会重建代理');

  state.url = 'https://dsh.example.com';
  ok(authProxyWanted() === false, '非回环目标 → 不想要代理');
  ok((await ensureAuthProxy()) === null, '非回环目标 → 返回 null');

  console.log('[6] probeDirectIndexStatus：无服务时安全返回 0');
  state.remoteName = 'ssh-remote';
  state.url = 'http://127.0.0.1:1'; // 必然无监听
  const st = await probeDirectIndexStatus(1500);
  ok(st === 0, '上游不可达 → 0（不抛错，供 remote 兜底判定使用）');

  await Promise.race([wslProxy.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
