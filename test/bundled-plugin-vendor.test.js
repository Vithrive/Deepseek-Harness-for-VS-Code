'use strict';
/**
 * 内置配套插件的 vendored 安装与「被 dsh plugin 清理后自动修复」测试（v1.1.3，Issue #31）。
 * 运行：node test/bundled-plugin-vendor.test.js
 *
 * 背景：扩展把三个配套插件直接写进 profile 的 node_modules，但 pnpm（dsh plugin
 * add/install 的底层）会把不在 dependencies 里的包当 extraneous 移到
 * node_modules/.ignored，dsh 启动时静默跳过这些 bundle——文件链接跳转、剪贴板中继、
 * window.open 重定向全部悄悄失效。
 *
 * 修复：同时写 profile/vendor/<name> 副本，并在 profile package.json 里声明
 * `"<name>": "file:./vendor/<name>"`，pnpm 会把它们当正常依赖保留；扩展在每次
 * 面板准备时仍会检查 node_modules/vendor 两侧，缺失就重建（自愈）。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩 ──
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), workspaceFolders: [] },
  env: {},
  window: { showWarningMessage: () => {}, showInformationMessage: () => {} },
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

const PLUGINS = [
  {
    name: I.CLIPBOARD_PLUGIN_NAME,
    version: () => I.clipboardPluginVersion(),
    files: () => I.clipboardPluginFiles(),
    ensure: (dir) => I.ensureClipboardPlugin(dir)
  },
  {
    name: I.FILE_LINK_PLUGIN_NAME,
    version: () => I.fileLinkPluginVersion(),
    files: () => I.fileLinkPluginFiles(),
    ensure: (dir) => I.ensureFileLinkPlugin(dir)
  },
  {
    name: I.OPEN_EXTERNAL_PLUGIN_NAME,
    version: () => I.openExternalPluginVersion(),
    files: () => I.openExternalPluginFiles(),
    ensure: (dir) => I.ensureOpenExternalPlugin(dir)
  }
];

(async function run() {
  for (const plugin of PLUGINS) {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vendor-'));
    try {
      console.log('[' + plugin.name + ']');
      const installedDir = path.join(profileDir, 'node_modules', plugin.name);
      const vendoredDir = path.join(profileDir, 'vendor', plugin.name);
      ok((await plugin.ensure(profileDir)) === true, '首次安装返回「有变化」');
      ok(JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')).version === plugin.version(), 'node_modules 副本版本正确');
      ok(fs.existsSync(path.join(vendoredDir, 'package.json')), 'vendor 副本已落盘');
      ok(fs.readFileSync(path.join(vendoredDir, 'lib', 'client.js'), 'utf8') === plugin.files()['lib/client.js'], 'vendor 副本内容与扩展内置一致');
      const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
      ok(pkg.dependencies && pkg.dependencies[plugin.name] === 'file:./vendor/' + plugin.name, 'profile dependencies 声明为 file:./vendor/<name>');
      ok(pkg.dsh.profile.bundles.includes(plugin.name), '仍登记在 dsh.profile.bundles');
      ok((await plugin.ensure(profileDir)) === false, '重复调用幂等（无变化不提示重启）');

      // 模拟 `dsh plugin add` 把 node_modules 副本移走（pnpm extraneous 清理）
      fs.rmSync(installedDir, { recursive: true, force: true });
      ok((await plugin.ensure(profileDir)) === true, 'node_modules 被清理后自动重建');
      ok(fs.existsSync(path.join(installedDir, 'package.json')), '重建后 node_modules 副本恢复');

      // 极端：vendor 也被清掉（例如用户手动删 profile）→ 从扩展内置文件重建
      fs.rmSync(installedDir, { recursive: true, force: true });
      fs.rmSync(vendoredDir, { recursive: true, force: true });
      ok((await plugin.ensure(profileDir)) === true, 'vendor 与 node_modules 全缺失时能重建');
      ok(fs.existsSync(path.join(vendoredDir, 'lib', 'client.js')) && fs.existsSync(path.join(installedDir, 'lib', 'client.js')), '两侧副本均恢复');
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

void assert;
