'use strict';
/**
 * Remote 模式判定回归测试（Issue #13）：
 * - WSL Remote 必须放行受管认证代理（宿主与 dsh 同机回环，前提与本地等价）；
 * - SSH / Dev Container 等真远程仍不启用代理；
 * - 非回环地址一律不启用。
 * 运行：node test/remote-mode.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const state = { remoteName: undefined, url: 'http://127.0.0.1:3080' };
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'dshPanel.url') return state.url;
        if (k === 'dshPanel.port') return 3080;
        if (k === 'dshPanel.host') return '127.0.0.1';
        return d;
      }
    }),
    workspaceFolders: []
  },
  env: {
    get remoteName() { return state.remoteName; }
  },
  window: {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const { isLocalLoopbackTarget, ensureAuthProxy, probeDirectIndexStatus } = ext.__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

async function main() {
  console.log('[1] isLocalLoopbackTarget：回环 + 各 remoteName');
  state.url = 'http://127.0.0.1:3080';
  state.remoteName = undefined;
  ok(isLocalLoopbackTarget() === true, '本地（无 remoteName）→ 启用');
  state.remoteName = 'wsl';
  ok(isLocalLoopbackTarget() === true, 'WSL Remote → 启用（Issue #13 修复点）');
  state.remoteName = 'ssh-remote';
  ok(isLocalLoopbackTarget() === false, 'SSH Remote → 不启用');
  state.remoteName = 'dev-container';
  ok(isLocalLoopbackTarget() === false, 'Dev Container → 不启用');
  state.remoteName = 'attached-container';
  ok(isLocalLoopbackTarget() === false, 'Attached Container → 不启用');

  console.log('[2] isLocalLoopbackTarget：localhost / IPv6 / 非回环');
  state.remoteName = undefined;
  state.url = 'http://localhost:3080';
  ok(isLocalLoopbackTarget() === true, 'localhost 回环 → 启用');
  state.url = 'http://[::1]:3080';
  ok(isLocalLoopbackTarget() === true, 'IPv6 回环 → 启用');
  state.remoteName = 'wsl';
  ok(isLocalLoopbackTarget() === true, 'WSL + localhost → 启用');
  state.url = 'https://dsh.example.com';
  ok(isLocalLoopbackTarget() === false, '非回环域名 → 不启用');
  state.url = 'http://192.168.1.10:3080';
  ok(isLocalLoopbackTarget() === false, '非回环私网地址 → 不启用');

  console.log('[3] ensureAuthProxy：WSL 建代理 / 真远程返回 null');
  state.remoteName = 'wsl';
  state.url = 'http://127.0.0.1:3080';
  const proxy = await ensureAuthProxy();
  ok(!!proxy && typeof proxy.port === 'function' && proxy.port() > 0, 'WSL → 代理已创建并监听随机端口');
  ok(proxy.baseUrl().startsWith('http://127.0.0.1:'), '代理仅绑定 127.0.0.1（本机回环）');
  state.remoteName = 'ssh-remote';
  const none = await ensureAuthProxy();
  ok(none === null, 'SSH Remote → 不创建代理（返回 null）');
  state.remoteName = 'wsl';
  const again = await ensureAuthProxy();
  ok(again === proxy, 'WSL 再次调用复用同一代理实例（并发/重复调用安全）');

  console.log('[4] probeDirectIndexStatus：无服务时安全返回 0');
  state.remoteName = 'ssh-remote';
  state.url = 'http://127.0.0.1:1'; // 必然无监听
  const st = await probeDirectIndexStatus(1500);
  ok(st === 0, '上游不可达 → 0（不抛错，供 remote 兜底判定使用）');

  await proxy.close().catch(() => {});
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
