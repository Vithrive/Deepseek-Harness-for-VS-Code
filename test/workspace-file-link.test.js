'use strict';
/**
 * 工作区文件链接（面板内点击 DSH 对话里的文件/文件夹链接 → 在 VS Code 资源管理器中
 * 定位并打开）回归测试。运行：node test/workspace-file-link.test.js
 *
 * 覆盖三处最容易出错的接缝：
 *  1) 内置插件 dsh-vscode-file-links 的文件齐全、包声明正确、语法真实通过；
 *  2) 面板 HTML 的内联中继脚本语法真实通过 + 握手/转发协议齐全（模板字面量转义前车之鉴）；
 *  3) 宿主侧路径解析与 dsh-reveal-path 消息处理（命中 / 越界 / 不存在 / 行号后缀 / 开关）。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const Module = require('module');

const ACTION_KEY = 'dshPanel.workspaceFileLinkAction';
// ── vscode 桩：存在性判断用真实文件系统，其余为可观测的假实现 ──
const executed = [];
const openedExternal = [];
const statusMessages = [];
let configValues = {};

function fileUri(p) {
  const fsPath = path.resolve(p);
  return {
    scheme: 'file',
    fsPath: fsPath,
    path: fsPath.replace(/\\/g, '/'),
    toString: () => 'file://' + fsPath.replace(/\\/g, '/')
  };
}

const vscodeStub = {
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    file: fileUri,
    joinPath: (base, ...segments) => fileUri(path.resolve(base.fsPath, ...segments)),
    parse: (u) => ({ toString: () => u })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (k, d) => (Object.prototype.hasOwnProperty.call(configValues, k) ? configValues[k] : d)
    }),
    fs: {
      stat: async (uri) => {
        const st = await fs.promises.stat(uri.fsPath);
        return { type: st.isDirectory() ? vscodeStub.FileType.Directory : vscodeStub.FileType.File };
      }
    },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} })
  },
  env: { remoteName: undefined, openExternal: (uri) => { openedExternal.push(uri.toString()); } },
  window: {
    activeTextEditor: null,
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    showWarningMessage: () => {},
    setStatusBarMessage: (text) => { statusMessages.push(text); return { dispose() {} }; },
    registerWebviewViewProvider: () => ({ dispose() {} }),
    createWebviewPanel: () => ({ dispose() {} })
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (...args) => { executed.push(args); }
  },
  ViewColumn: { One: 1 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}
const REPO = path.resolve(__dirname, '..');

// ── [1] 内置插件文件 ───────────────────────────────────────────────
console.log('[1] 插件文件齐全且语法通过');
const files = I.fileLinkPluginFiles();
ok(I.FILE_LINK_PLUGIN_NAME === 'dsh-vscode-file-links', '插件名常量正确');
ok(!!files['package.json'] && !!files['cordis.patch.yml'] && !!files['lib/index.js'] && !!files['lib/client.js'], '四个文件齐全');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-filelink-'));
for (const rel of Object.keys(files)) {
  const dest = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, files[rel], 'utf8');
}
for (const js of ['lib/index.js', 'lib/client.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(tmp, js)], { encoding: 'utf8' });
  ok(r.status === 0, js + ' 语法通过' + (r.status !== 0 ? '：' + (r.stderr || '').slice(0, 300) : ''));
}
const pluginPkg = JSON.parse(files['package.json']);
ok(pluginPkg.name === I.FILE_LINK_PLUGIN_NAME, 'package.json name 与目录/包名一致');
ok(/^\d+\.\d+\.\d+$/.test(pluginPkg.version) && pluginPkg.version === I.fileLinkPluginVersion(), '版本号可解析且与扩展读取到的一致');
ok(pluginPkg.dsh && pluginPkg.dsh.client && pluginPkg.dsh.client.platform === 'web', 'dsh.client.platform=web（DSH 才会加载客户端半边）');
ok(pluginPkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle.patch 指向 cordis.patch.yml');
ok(/-\s*insert:/.test(files['cordis.patch.yml']) && files['cordis.patch.yml'].includes("name: '" + I.FILE_LINK_PLUGIN_NAME + "'"), 'cordis.patch.yml 注册行与包名一致');
ok(files['lib/index.js'].includes("export const name = '" + I.FILE_LINK_PLUGIN_NAME + "'"), '宿主半边导出的 name 与包名一致');

console.log('[2] 客户端半边的关键防线');
const client = files['lib/client.js'];
ok(!client.includes('_1ypvv_') && client.includes("FILE_LINK_CLASS = 'fileLink'"), '按 CSS Modules 局部名 fileLink 匹配（不绑定版本哈希）');
ok(client.includes("closest('button')"), '点击目标向上找 button（图标/文字子节点同样命中）');
ok(client.includes("getAttribute('title')"), '路径取自 title（DSH 的 MarkdownFileLink 写入目标路径）');
ok(client.includes('event.stopPropagation()'), '接管时阻断 React 委托 handler（避免 DSH 侧重复打开）');
ok(client.includes('replaying') && client.includes('button.click()'), '宿主不能处理时回放原始点击（不会点了没反应）');
ok(client.includes('event.metaKey || event.ctrlKey || event.shiftKey || event.altKey'), '修饰键点击不接管（可强制走 DSH 行为）');
ok(client.includes("data.type === 'ack'") && client.includes('data.fileLinks === false'), '只在宿主 ack 后接管');
ok(client.includes("data.type === 'reveal-result'") && client.includes('data.ok !== true'), '按回执决定是否回放');
ok(client.includes('HELLO_MAX_TRIES') && client.includes("type: 'hello'"), '握手重试（插件先于/后于面板就绪都能连上）');
ok(client.includes('window.parent !== window'), '独立浏览器里不介入（parent===self 时不打招呼）');
ok(!client.includes('127.0.0.1') && !client.includes('localhost'), '客户端半边没有硬编码宿主地址（只认父级消息）');

// ── [3] 面板 HTML 与内联中继脚本 ─────────────────────────────────
console.log('[3] 面板 HTML 内联脚本');
const html = I.buildIframeHtml('http://127.0.0.1:3080', 1, 'revealAndOpen');
ok(html.includes('name="dsh-vscode-host"'), 'iframe 带宿主身份标记 name="dsh-vscode-host"');
const scriptMatch = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html);
ok(scriptMatch !== null, '能提取到内联脚本');
const scriptPath = path.join(tmp, 'iframe-relay.js');
fs.writeFileSync(scriptPath, scriptMatch[1], 'utf8');
const check = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
ok(check.status === 0, '内联中继脚本语法真实通过（模板转义前车之鉴）' + (check.status !== 0 ? '：' + (check.stderr || '').slice(0, 300) : ''));
const script = scriptMatch[1];
ok(script.includes('var fileLinkMode = "revealAndOpen"'), '模式字符串正确注入（JSON 字面量）');
ok(script.includes('var FRAME_ORIGIN = "http://127.0.0.1:3080"'), '目标 origin 精确注入（postMessage 不写通配）');
ok(script.includes('event.origin !== FRAME_ORIGIN') && script.includes('event.source === frameWindow()'), '只接受自己 iframe 且 origin 相符的插件消息');
ok(script.includes("type: 'dsh-reveal-path'") && script.includes("data.type === 'dsh-reveal-result'") && script.includes("type: 'reveal-result'"), 'reveal 请求/回执双向转发');
ok(script.includes('ackFrame') && script.includes("addEventListener('load'"), 'iframe 加载后重新握手（刷新/重启 dsh web 后仍生效）');
ok(script.includes("data.type === 'dsh-open-link'") && script.includes("data.type === 'insert-selection'"), '既有中继（外链、发送选中内容）未被破坏');
ok(script.includes('/^https?:\\/\\//i'), '既有外链正则的反斜杠转义仍然正确');

const scriptOff = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(I.buildIframeHtml('http://127.0.0.1:3080', 1, 'off'))[1];
ok(scriptOff.includes('var fileLinkMode = "off"'), 'off 模式注入 off');
ok(scriptOff.includes("if (fileLinkMode === 'off') return;"), 'off 模式不给握手回执（插件保持惰性）');
ok(I.buildIframeHtml('http://127.0.0.1:3080', 1, 'nonsense').includes('var fileLinkMode = "off"'), '非法模式值收敛为 off（不误接管）');
ok(I.buildIframeHtml('http://127.0.0.1:3080', 1, undefined).includes('var fileLinkMode = "off"'), '未传模式时收敛为 off（老调用点不误接管）');
let threw = false;
try { I.buildIframeHtml('file:///etc/passwd', 1, 'revealAndOpen'); } catch (e) { threw = true; }
ok(threw, '非 http/https 显示地址仍被拒绝');
ok(I.jsonForScript('a</script><b>') === '"a\\u003c/script\\u003e\\u003cb\\u003e"', 'jsonForScript 转义 < > &（防脚本提前闭合）');

// ── [4] 宿主侧路径解析 ───────────────────────────────────────────
console.log('[4] 工作区路径解析');
const outsideProbe = path.join(os.tmpdir(), 'dsh-outside-probe.txt');
fs.writeFileSync(outsideProbe, 'x');
vscodeStub.workspace.workspaceFolders = [{ uri: fileUri(REPO) }];
(async function run() {
  const hit = await I.resolveWorkspaceTarget('extension.js');
  ok(hit !== null && hit.kind === 'file' && hit.uri.fsPath === path.join(REPO, 'extension.js'), '相对路径命中（工作区根 + 相对路径）');
  const dot = await I.resolveWorkspaceTarget('./dsh-plugins/dsh-vscode-file-links/package.json');
  ok(dot !== null && dot.kind === 'file', './ 前缀相对路径命中');
  const abs = await I.resolveWorkspaceTarget(path.join(REPO, 'package.json'));
  ok(abs !== null && abs.kind === 'file', '工作区内绝对路径命中');
  const dir = await I.resolveWorkspaceTarget('dsh-plugins');
  ok(dir !== null && dir.kind === 'folder', '文件夹命中（kind=folder）');
  const winStyle = await I.resolveWorkspaceTarget(path.join(REPO, 'extension.js').replace(/\//g, '\\'));
  ok(winStyle !== null && winStyle.kind === 'file', '反斜杠写法（模型/工具常见）同样命中');
  const lineSuffix = await I.resolveWorkspaceTarget('extension.js:120');
  ok(lineSuffix !== null && lineSuffix.kind === 'file', '带行号后缀 :120 回退命中');
  ok((await I.resolveWorkspaceTarget('extension.js#L120')) !== null, '带 #L120 后缀回退命中');
  ok((await I.resolveWorkspaceTarget('no/such/file.xyz')) === null, '不存在 → null（插件会回放到 DSH 侧边栏）');
  const escapeRel = path.relative(REPO, outsideProbe);
  ok(escapeRel.startsWith('..'), '（前置检查）探针文件确实在工作区之外');
  ok((await I.resolveWorkspaceTarget(escapeRel)) === null, '../ 越界即使文件真实存在也不接管（前提：须在工作区内）');
  ok((await I.resolveWorkspaceTarget(outsideProbe)) === null, '工作区外的绝对路径同样不接管');
  ok((await I.resolveWorkspaceTarget('')) === null, '空路径 → null');
  ok((await I.resolveWorkspaceTarget('https://example.com/a.ts')) === null, 'URL 不会被误当本地路径');
  ok((await I.resolveWorkspaceTarget('   ')) === null, '纯空白 → null');
  vscodeStub.workspace.workspaceFolders = [];
  ok((await I.resolveWorkspaceTarget('extension.js')) === null, '没有打开工作区时 → null');
  vscodeStub.workspace.workspaceFolders = [{ uri: fileUri(path.join(REPO, 'media')) }, { uri: fileUri(REPO) }];
  ok((await I.resolveWorkspaceTarget('extension.js')) !== null, '多工作区：逐个根尝试直到命中');
  vscodeStub.workspace.workspaceFolders = [{ uri: fileUri(REPO) }];

  // ── [5] dsh-reveal-path 消息处理 ─────────────────────────────
  console.log('[5] reveal 消息处理与回执');
  const received = [];
  const webview = { postMessage: (m) => received.push(m) };
  configValues[ACTION_KEY] = 'revealAndOpen';
  executed.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk1', path: 'extension.js' }, webview);
  await new Promise((r) => setTimeout(r, 150));
  ok(executed.length === 2 && executed[0][0] === 'revealInExplorer' && executed[1][0] === 'vscode.open', '命中时先定位再打开（revealInExplorer + vscode.open）');
  ok(executed[1][2] && executed[1][2].preview === false, '打开文件用非预览标签页（preview:false）');
  ok(received.length === 1 && received[0].type === 'dsh-reveal-result' && received[0].ok === true && received[0].token === 'tk1', '命中回执 ok=true 且带 token');

  configValues[ACTION_KEY] = 'revealOnly';
  executed.length = 0; received.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk2', path: 'dsh-plugins' }, webview);
  await new Promise((r) => setTimeout(r, 150));
  ok(executed.length === 1 && executed[0][0] === 'revealInExplorer', 'revealOnly：只定位，不开编辑器');
  ok(received[0] && received[0].ok === true, 'revealOnly 同样回执成功');

  configValues[ACTION_KEY] = 'revealAndOpen';
  executed.length = 0; received.length = 0; statusMessages.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk3', path: 'no/such/file.xyz' }, webview);
  await new Promise((r) => setTimeout(r, 150));
  ok(executed.length === 0 && received.length === 1 && received[0].ok === false, '未命中：不执行命令并回执 ok=false（触发插件回放）');
  ok(statusMessages.length === 1 && statusMessages[0].includes('工作区'), '未命中时给出状态栏提示（不弹窗打断）');

  configValues[ACTION_KEY] = 'off';
  executed.length = 0; received.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk4', path: 'extension.js' }, webview);
  await new Promise((r) => setTimeout(r, 150));
  ok(executed.length === 0 && received[0] && received[0].ok === false, 'off：彻底不接管，回执失败让 DSH 保持原行为');

  configValues[ACTION_KEY] = 'revealAndOpen';
  openedExternal.length = 0;
  I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://example.com/x' }, webview);
  ok(openedExternal.length === 1 && openedExternal[0] === 'https://example.com/x', '既有外链行为不受影响');
  I.handleWebviewMessage({ type: 'dsh-open-link', url: 'javascript:alert(1)' }, webview);
  ok(openedExternal.length === 1, '非 http(s) 外链仍被拒绝');
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk5', path: 12345 }, webview);
  await new Promise((r) => setTimeout(r, 150));
  ok(received[received.length - 1].ok === false, '非字符串路径（异常消息）安全拒绝');

  console.log('[6] 既有内置插件未被破坏');
  const clip = I.clipboardPluginFiles();
  ok(!!clip['lib/client.js'] && clip['lib/client.js'].includes(I.CLIPBOARD_PLUGIN_NAME), 'dsh-webview-clipboard 生成逻辑保持可用');
  ok(I.fileLinkAction() === 'revealAndOpen', '默认行为 = 资源管理器定位 + 打开');
  configValues[ACTION_KEY] = 'bogus';
  ok(I.fileLinkAction() === 'revealAndOpen', '非法配置值收敛为默认（不静默失效）');

  // ── [7] 插件落盘安装（对着临时 profile，不碰真实 DSH 目录）─────
  console.log('[7] 内置插件落盘安装（幂等）');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'));
  const first = await I.ensureFileLinkPlugin(profileDir);
  ok(first === true, '首次安装返回「有变化」（提示用户重启 dsh web）');
  const installedDir = path.join(profileDir, 'node_modules', I.FILE_LINK_PLUGIN_NAME);
  const installedPkg = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'));
  ok(installedPkg.version === I.fileLinkPluginVersion(), '落盘版本与扩展内置版本一致');
  ok(fs.existsSync(path.join(installedDir, 'lib', 'client.js')) && fs.existsSync(path.join(installedDir, 'cordis.patch.yml')), '客户端半边与 bundle patch 都已落盘');
  const profilePkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  ok(profilePkg.dsh.profile.bundles.includes(I.FILE_LINK_PLUGIN_NAME), '已登记到 profile 的 dsh.profile.bundles（DSH 才会加载）');
  ok(!profilePkg.dependencies || !profilePkg.dependencies[I.FILE_LINK_PLUGIN_NAME], '不写入 dependencies（npm 上没有该包，避免 pnpm 解析失败）');
  ok((await I.ensureFileLinkPlugin(profileDir)) === false, '重复安装幂等（版本一致时不再写盘/不再提示重启）');
  fs.rmSync(profileDir, { recursive: true, force: true });

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outsideProbe, { force: true });
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
