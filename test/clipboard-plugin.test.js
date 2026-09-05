'use strict';
/**
 * 内置剪贴板兼容插件（dsh-webview-clipboard，PR #11）生成文件测试。
 * 运行：node test/clipboard-plugin.test.js
 * 重点：client.js 由模板字面量生成，正则转义一旦写错会让所有平台的
 * DSH 页面加载失败——这里对生成结果做真实语法检查（node --check）。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
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
const ext = require(path.join(__dirname, '..', 'extension.js'));
const { clipboardPluginFiles, CLIPBOARD_PLUGIN_NAME } = ext.__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const files = clipboardPluginFiles();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clip-'));
for (const rel of Object.keys(files)) {
  const dest = path.join(base, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, files[rel], 'utf8');
}

console.log('[1] 文件齐全');
ok(files['package.json'] && files['lib/index.js'] && files['lib/client.js'] && files['cordis.patch.yml'], '四个文件齐全');
ok(files['lib/client.js'].includes(CLIPBOARD_PLUGIN_NAME), 'client.js 带插件 id');

console.log('[2] package.json 可解析且声明正确');
const pkg = JSON.parse(files['package.json']);
ok(pkg.name === CLIPBOARD_PLUGIN_NAME, 'name 正确');
ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', 'client.platform=web');
ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle.patch 指向 cordis.patch.yml（与真实插件惯例一致的字符串形式）');

console.log('[3] 生成 JS 语法真实校验（node --check）');
for (const js of ['lib/index.js', 'lib/client.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(base, js)], { encoding: 'utf8' });
  ok(r.status === 0, js + ' 语法通过' + (r.status !== 0 ? '：' + (r.stderr || '').slice(0, 300) : ''));
}

console.log('[4] 正则转义未被模板字面量折叠（作者标注的前车之鉴）');
ok(files['lib/client.js'].includes('/Electron\\//'), 'Electron 正则保留反斜杠转义（/Electron\\/ 匹配 "Electron/"）');

console.log('[5] 激活门与安全阀存在');
ok(files['lib/client.js'].includes('inIframe()') && files['lib/client.js'].includes('isMac()') && files['lib/client.js'].includes('inElectron()'), '三重激活门（iframe+macOS+Electron）');
ok(files['lib/client.js'].includes('defaultPrevented'), '尊重 DSH 已处理的按键');
ok(files['lib/client.js'].includes('229'), 'IME 组合中不干预');

console.log('[6] 作用域收敛（PR #14）：仅剪贴板三键，不再模拟编辑键');
ok(files['lib/client.js'].includes("cmd = 'paste'") && files['lib/client.js'].includes("cmd = 'copy'") && files['lib/client.js'].includes("cmd = 'cut'"), '⌘C/⌘V/⌘X 经 execCommand 处理');
ok(!files['lib/client.js'].includes('selectAll'), '⌘A 不再拦截（原生可用）');
ok(!files['lib/client.js'].includes("'redo'"), '撤销/重做不再拦截');
ok(!files['lib/client.js'].includes('setSelectionRange'), '不再手动模拟光标（contentEditable 下 el.value 会崩）');
ok(!files['lib/client.js'].includes('el.value'), '不再读取 el.value（contentEditable 无此属性）');

console.log('[6b] cordis.patch.yml 结构');
ok(/-\s*insert:/.test(files['cordis.patch.yml']), 'insert 行存在');
ok(files['cordis.patch.yml'].includes("name: '" + CLIPBOARD_PLUGIN_NAME + "'"), 'name 与包名一致');

fs.rmSync(base, { recursive: true, force: true });
console.log('\n全部通过：' + passed + ' 项断言 ✓');
process.exit(0);
