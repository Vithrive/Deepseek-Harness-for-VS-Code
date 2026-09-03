'use strict';
/** 配置输入净化测试（PR #12 安全审计的回归用例）。运行：node test/config-sanitize.test.js */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const settings = {};
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), workspaceFolders: [] },
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
const { getHost, getPort, getDshCommand, sanitizeCommand } = require(path.join(__dirname, '..', 'extension.js')).__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}
function caseOf(setter, actual, want, name) {
  setter();
  const got = typeof actual === 'function' ? actual() : actual;
  assert.deepStrictEqual(got, want, name + '（实际 ' + JSON.stringify(got) + '）');
  ok(true, name);
}

console.log('[1] dshPanel.port（number 型声明但原始值直通）');
caseOf(() => { settings['dshPanel.port'] = '3080 && calc'; }, () => getPort(), 3080, '字符串注入 → 回退 3080');
caseOf(() => { settings['dshPanel.port'] = '4000'; }, () => getPort(), 4000, '纯数字字符串仍可用');
caseOf(() => { settings['dshPanel.port'] = 99999; }, () => getPort(), 3080, '越界端口 → 回退 3080');
caseOf(() => { settings['dshPanel.port'] = -1; }, () => getPort(), 3080, '负端口 → 回退 3080');
caseOf(() => { settings['dshPanel.port'] = 3000.9; }, () => getPort(), 3000, '小数 → 取整');

console.log('[2] dshPanel.host（字符串型设置）');
caseOf(() => { settings['dshPanel.host'] = '127.0.0.1 & calc'; }, () => getHost(), '127.0.0.1', 'shell 元字符 → 回退 127.0.0.1');
caseOf(() => { settings['dshPanel.host'] = 'my-dsh.local'; }, () => getHost(), 'my-dsh.local', '合法域名保留');
caseOf(() => { settings['dshPanel.host'] = '::1'; }, () => getHost(), '::1', 'IPv6 字面量保留');

console.log('[3] dshPanel.dshCommand（字符串型命令路径）');
caseOf(() => { settings['dshPanel.dshCommand'] = 'dsh & calc'; }, () => getDshCommand(), 'dsh', '元字符注入 → 回退 dsh');
caseOf(() => { settings['dshPanel.dshCommand'] = 'C:\my tools\dsh.cmd'; }, () => getDshCommand(), 'C:\my tools\dsh.cmd', '带空格的合法路径保留（启动前自动加引号）');
ok(sanitizeCommand('dsh\r malicious') === null, '回车/换行拒绝');
ok(sanitizeCommand('dsh`id`') === null, '反引号拒绝');
ok(sanitizeCommand('dsh|calc') === null, '管道拒绝');
ok(sanitizeCommand('dsh>nul') === null, '重定向拒绝');

console.log('\n全部通过：' + passed + ' 项断言 ✓');
process.exit(0);
