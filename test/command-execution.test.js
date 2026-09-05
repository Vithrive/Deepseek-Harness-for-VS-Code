'use strict';
/**
 * 命令执行安全测试（采纳 PR #12 的注入用例设计 + 平台差异化执行路径回归）。
 * 运行：node test/command-execution.test.js
 *
 * 覆盖：
 *  - runCommandOk：真实命令成功 / 未知命令失败 / 元字符注入拒绝
 *  - runCommandOutput：POSIX 走无 shell execFile（PR #12 第二层防御）、
 *    Windows 走净化后的 shell 引号路径；两条路径都拒绝元字符注入
 *  - 输出不被拼接破坏（数组参数直达进程）
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), workspaceFolders: [] },
  env: { remoteName: undefined },
  window: {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const { runCommandOk, runCommandOutput } = require(path.join(__dirname, '..', 'extension.js')).__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

async function main() {
  console.log('[1] runCommandOk：真实命令 / 未知命令 / 注入拒绝');
  {
    const okRun = await runCommandOk(process.execPath, ['-v'], 15000);
    ok(okRun === true, 'node -v 退出码 0 → true');
    const badRun = await runCommandOk('definitely-not-a-real-command-xyz', ['--version'], 15000);
    ok(badRun === false, '未知命令 → false');
  }

  console.log('[2] runCommandOk：元字符注入全部拒绝（PR #12 用例）');
  {
    const injections = [
      'dsh; touch /tmp/pwned',
      'dsh & calc',
      'dsh && ls',
      'dsh || ls',
      'dsh | cat /etc/passwd',
      'dsh$(touch /tmp/pwned)',
      'dsh`touch /tmp/pwned`',
      'dsh\ntouch /tmp/pwned',
      'dsh>out.txt',
      'dsh<in.txt'
    ];
    let rejected = 0;
    for (const bad of injections) {
      const r = await runCommandOk(bad, ['--version'], 15000);
      if (r === false) rejected += 1;
    }
    ok(rejected === injections.length, '10 种注入形态全部拒绝（' + rejected + '/' + injections.length + '）');
  }

  console.log('[3] runCommandOutput：数组参数直达进程，输出正确');
  {
    const out = await runCommandOutput(process.execPath, ['-e', 'console.log(6*7)'], 15000);
    ok(String(out).trim() === '42', '跨平台输出 42（实际 ' + JSON.stringify(String(out).trim()) + '）');
  }

  console.log('[4] runCommandOutput：元字符注入拒绝');
  {
    let rejected = 0;
    const bads = ['dsh; pwned', 'dsh & pwned', 'dsh|pwned', 'dsh`pwned`'];
    for (const bad of bads) {
      let failed = false;
      try { await runCommandOutput(bad, ['--version']); } catch (e) { failed = true; }
      if (failed) rejected += 1;
    }
    ok(rejected === bads.length, '元字符命令全部拒绝执行（' + rejected + '/' + bads.length + '）');
  }
}

main().then(() => {
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
}, (e) => {
  console.error(e);
  process.exit(1);
});