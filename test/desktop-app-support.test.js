'use strict';
/**
 * 官网 Windows 桌面版支持（方案 A）的回归测试。
 * 运行：node test/desktop-app-support.test.js
 *
 * 背景：官网下载的 Windows 桌面版是 Electron 应用，dsh runtime 内嵌在 app.asar 里，
 * `dsh` 不在 PATH、用户通常也没有 npm。扩展原先只探测 PATH 上的 `dsh` 与 npx 缓存，
 * 于是把「已装桌面版」误判为「未安装」，面板停在错误页。
 *
 * 修复：把桌面版自带 CLI
 *   <安装目录>\resources\runtime\cli\bin\dsh.cmd
 * 作为第三种启动来源（优先级：PATH dsh → 桌面版 CLI → npx）。它用应用自带的
 * Electron 以 Node 模式跑 `dsh web`（仍是 web profile），因此：
 *   - 不需要 PATH / npm / Node；
 *   - 仍会打印 `dsh web: http://127.0.0.1:<port>/?token=…`，受管认证代理照旧生效；
 *   - 配套插件装入 ~/.dsh/profiles/web，与扩展的既有逻辑一致。
 *
 * 本测试覆盖：安装目录定位（注册表 InstallLocation 解析 + 默认目录）、
 * 启动方式优先级、含空格路径的 cmd.exe 引号处理，以及源码级接线回归。
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

// ── vscode 桩（extension.js 顶层 require('vscode')）──
const configValues = {};
const vscodeStub = {
  lm: { registerLanguageModelChatProvider: () => ({ dispose() {} }), selectChatModels: async () => [] },
  workspace: { getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(configValues, k) ? configValues[k] : d) }) },
  window: {},
  commands: {},
  extensions: { getExtension: () => undefined },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
// 防御：若被测代码读 homedir 落盘，重定向到临时目录，别动用户目录。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-home-'));
const realHomedir = os.homedir;
os.homedir = () => tmpHome;

const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

(async function run() {
  console.log('[1] pickDesktopCli：安装目录定位');
  {
    const exists = (p) => p.toLowerCase().endsWith('deepseek harness\\resources\\runtime\\cli\\bin\\dsh.cmd');
    const found = I.pickDesktopCli(['C:\\other\\DeepSeek Harness'], (p) => p === 'C:\\other\\DeepSeek Harness\\' + 'resources\\runtime\\cli\\bin\\dsh.cmd');
    ok(found && found.installDir === 'C:\\other\\DeepSeek Harness', '目录下有内置 CLI 时命中');
    ok(found && found.cmd.endsWith('resources\\runtime\\cli\\bin\\dsh.cmd'), 'CLI 路径为 <安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd');
    ok(exists('X:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'), '（自检）exists 匹配器可用');

    // 第一个目录没有 CLI，第二个有 → 命中第二个
    const probed = [];
    const found2 = I.pickDesktopCli(['C:\\a', 'C:\\b'], (p) => { probed.push(p); return p.startsWith('C:\\b\\'); });
    ok(found2 && found2.installDir === 'C:\\b', '跳过没有内置 CLI 的目录');
    ok(probed.length === 2, '按顺序探测候选目录直到命中');

    // 空/非法条目被忽略
    const found3 = I.pickDesktopCli([null, '', '   ', undefined, 'C:\\c'], (p) => p.startsWith('C:\\c\\'));
    ok(found3 && found3.installDir === 'C:\\c', '忽略空/非法候选目录');

    // 大小写去重：只探测一次
    probed.length = 0;
    I.pickDesktopCli(['C:\\X\\DeepSeek Harness', 'c:\\x\\deepseek harness'], (p) => { probed.push(p); return false; });
    ok(probed.length === 1, '大小写不同的重复目录只探测一次');

    ok(I.pickDesktopCli([], () => true) === null, '无候选目录返回 null');
    ok(I.pickDesktopCli(['C:\\nope'], () => false) === null, '候选目录均无 CLI 时返回 null');
  }

  console.log('[2] parseRegInstallLocations：注册表输出解析');
  {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e',
      '    DisplayName    REG_SZ    DeepSeek Harness 0.2.0-rc.2',
      '    DisplayVersion    REG_SZ    0.2.0-rc.2',
      '    InstallLocation    REG_SZ    V:\\Users\\admin\\AppData\\Local\\Programs\\DeepSeek Harness',
      '    UninstallString    REG_SZ    "V:\\...\\Uninstall DeepSeek Harness.exe" /currentuser',
      '    EstimatedSize    REG_DWORD    0x3a1b',
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}',
      '    InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\\DeepSeek Harness',
      ''
    ].join('\r\n');
    const dirs = I.parseRegInstallLocations(stdout);
    ok(dirs.length === 2, '解析出两条 InstallLocation');
    ok(dirs[0] === 'V:\\Users\\admin\\AppData\\Local\\Programs\\DeepSeek Harness', 'REG_SZ 路径完整保留空格');
    ok(dirs[1] === '%ProgramFiles%\\DeepSeek Harness', 'REG_EXPAND_SZ 也能解析');
    ok(I.parseRegInstallLocations('').length === 0, '空输出返回空数组');
    ok(I.parseRegInstallLocations(null).length === 0, 'null 输出返回空数组');
  }

  // ── Issue #29：自定义安装目录（E:\DSH）时 /f … /d 输出不含 InstallLocation ──
  const CUSTOM_SUBKEY = 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e';
  // 真实复现输出：只有 4 行——子键 + DisplayName/DisplayVersion + End of search。
  const CUSTOM_SEARCH_OUT = [
    '',
    CUSTOM_SUBKEY,
    '    DisplayName    REG_SZ    DeepSeek Harness 0.2.1-rc.5',
    '    DisplayVersion    REG_SZ    0.2.1-rc.5',
    '',
    'End of search: 1 match(es) found.',
    ''
  ].join('\r\n');
  const CUSTOM_SUBKEY_OUT = [
    '',
    CUSTOM_SUBKEY,
    '    DisplayName    REG_SZ    DeepSeek Harness 0.2.1-rc.5',
    '    InstallLocation    REG_SZ    E:\\DSH',
    '    DisplayIcon    REG_SZ    E:\\DSH\\DeepSeek Harness.exe,0',
    '    UninstallString    REG_SZ    "E:\\DSH\\Uninstall DeepSeek Harness.exe" /currentuser',
    ''
  ].join('\r\n');

  console.log('[2b] Issue #29：/f … /d 输出不含 InstallLocation（旧解析漏掉自定义目录）');
  {
    ok(I.parseRegInstallLocations(CUSTOM_SEARCH_OUT).length === 0, '复现：自定义目录下旧解析拿不到安装目录');
    const keys = I.parseRegKeyPaths(CUSTOM_SEARCH_OUT);
    ok(keys.length === 1 && keys[0] === CUSTOM_SUBKEY, 'parseRegKeyPaths 取出命中的卸载项子键');
    ok(I.parseRegKeyPaths('').length === 0 && I.parseRegKeyPaths(null).length === 0, '空/null 输出返回空数组');
    const dirs = I.parseRegSubkeyDirs(CUSTOM_SUBKEY_OUT);
    ok(dirs.includes('E:\\DSH'), '逐个子键读取后可拿到 InstallLocation = E:\\DSH');
    ok(dirs.filter((d) => d === 'E:\\DSH').length === 3, 'InstallLocation / DisplayIcon / UninstallString 三条路径都归一到安装目录');
  }

  console.log('[2c] 子键值解析的边界（DisplayIcon / UninstallString / 引号 / 环境变量）');
  {
    ok(I.parseRegSubkeyDirs('    InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\\DeepSeek Harness').includes('%ProgramFiles%\\DeepSeek Harness'), 'REG_EXPAND_SZ 原样返回，由 expandRegEnv 展开');
    ok(I.parseRegSubkeyDirs('    DisplayIcon    REG_SZ    "D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe",0').includes('D:\\Apps\\DeepSeek Harness'), 'DisplayIcon 去引号/图标序号后取父目录');
    ok(I.parseRegSubkeyDirs('    UninstallString    REG_SZ    "D:\\Apps\\DeepSeek Harness\\Uninstall DeepSeek Harness.exe" /currentuser /S').includes('D:\\Apps\\DeepSeek Harness'), 'UninstallString 从带参数的可执行文件路径取父目录');
    ok(I.parseRegSubkeyDirs('').length === 0 && I.parseRegSubkeyDirs(null).length === 0, '空/null 输出返回空数组');
    ok(I.expandRegEnv('%ProgramFiles%\\DeepSeek Harness', { ProgramFiles: 'C:\\Program Files' }) === 'C:\\Program Files\\DeepSeek Harness', 'expandRegEnv 展开 %ProgramFiles%');
    ok(I.expandRegEnv('%UNKNOWN%\\x', {}) === '%UNKNOWN%\\x', '未知变量保持原样');
    ok(I.windowsDirname('E:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd') === 'E:\\DSH\\resources\\runtime\\cli\\bin', 'windowsDirname 跨平台可用');
    ok(I.windowsDirname('E:\\DSH\\DeepSeek Harness.exe') === 'E:\\DSH', 'windowsDirname 从可执行文件路径取父目录');
  }

  console.log('[3] shellCommandText：含空格路径的 cmd.exe 引号');
  {
    // 造一个「父目录带空格 + 文件存在」的真实路径
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh cli '));
    const file = path.join(dir, 'dsh.cmd');
    fs.writeFileSync(file, '@echo off\r\n', 'utf8');
    try {
      if (process.platform === 'win32') {
        ok(I.shellCommandText(file) === '"' + file + '"', 'win32：存在且含空格 → 整体加引号');
      } else {
        ok(I.shellCommandText(file) === file, 'POSIX：不加引号（shell:false 数组传参）');
      }
      const missing = path.join(dir, 'missing.cmd');
      ok(I.shellCommandText(missing) === missing, '不存在的路径不加引号（保留旧的多 token 前缀行为）');
      ok(I.shellCommandText('dsh.cmd') === 'dsh.cmd', '无空格命令原样返回');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('[4] resolveDshInvocation：启动方式优先级');
  {
    const desktop = { cmd: 'C:\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd', installDir: 'C:\\Programs\\DeepSeek Harness' };
    const calls = [];
    const probeOf = (okSet) => async (cmd, args) => {
      calls.push([cmd, args]);
      return okSet(cmd, args);
    };

    // 4.1 PATH 上的 dsh 可用 → 直接命中，不探测桌面版
    calls.length = 0;
    const r1 = await I.resolveDshInvocation({
      probe: probeOf((cmd) => cmd === 'dsh'),
      desktop
    });
    ok(r1 && r1.kind === 'command' && r1.cmd === 'dsh', 'PATH dsh 可用时优先用它');
    ok(r1 && Array.isArray(r1.prefix) && r1.prefix.length === 0, '命令行调用无附加前缀');
    ok(!calls.some(([cmd]) => cmd === desktop.cmd), 'PATH dsh 命中后不再探测桌面版');

    // 4.2 PATH 无 dsh、桌面版可用 → 用桌面版内置 CLI
    calls.length = 0;
    const r2 = await I.resolveDshInvocation({
      probe: probeOf((cmd) => cmd === desktop.cmd),
      desktop
    });
    ok(r2 && r2.kind === 'desktop', 'PATH 无 dsh 时回退到桌面版内置 CLI');
    ok(r2 && r2.cmd === desktop.cmd, '返回桌面版 CLI 完整路径');
    ok(r2 && r2.installDir === desktop.installDir, '保留安装目录（便于日志/诊断）');
    ok(calls.some(([cmd, args]) => cmd === desktop.cmd && args.length === 1 && args[0] === '--version'), '用 --version 探测桌面版 CLI 是否可运行');
    ok(!calls.some(([cmd]) => cmd === 'npx'), '桌面版命中后不再探测 npx');

    // 4.3 桌面版存在但 CLI 跑不起来 → 继续回落 npx
    const r3 = await I.resolveDshInvocation({
      probe: probeOf((cmd) => cmd === 'npx'),
      desktop
    });
    ok(r3 && r3.kind === 'npx' && r3.cmd === 'npx', '桌面版 CLI 不可运行时回落 npx');
    ok(r3 && Array.isArray(r3.prefix) && r3.prefix.join(' ') === '--yes @deepseek-ai/dsh', 'npx 前缀保持原样');

    // 4.4 全都没有 → null（进入安装提示流程）
    const r4 = await I.resolveDshInvocation({ probe: probeOf(() => false), desktop: null });
    ok(r4 === null, '三者皆不可用时返回 null');

    // 4.5 未发现桌面版时不对任何桌面路径起进程
    calls.length = 0;
    await I.resolveDshInvocation({ probe: probeOf(() => false), desktop: null });
    ok(calls.length === 2, '无桌面版时只探测 dsh 与 npx');
  }

  console.log('[5] 源码级接线回归');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    ok(/const cmdText = shellCommandText\(inv\.cmd\);/.test(src), 'startDsh 经 shellCommandText 处理含空格 CLI 路径');
    ok(/id: 'desktop'|kind: 'desktop'/.test(src), 'resolveDshInvocation 标记桌面版启动方式');
    ok(/const inv = dshInvocation \|\| \{ cmd: process\.platform === 'win32' \? 'dsh\.cmd' : 'dsh', prefix: \[\] \};/.test(src), 'tryDshPluginAdd 复用已解析的启动方式');
    ok(/spawn\(shellCommandText\(inv\.cmd\), \[\.\.\.inv\.prefix, 'plugin', '--profile', 'web', 'add', plugin\]/.test(src), '插件安装走已解析 CLI 并保留 web profile');
    ok(/DESKTOP_CLI_REL = path\.join\('resources', 'runtime', 'cli', 'bin', 'dsh\.cmd'\)/.test(src), '桌面版 CLI 相对路径常量固定');
    ok(/InstallLocation/.test(src), '从注册表 InstallLocation 定位安装目录');
    ok(/parseRegKeyPaths/.test(src), 'Issue #29 修复：先取命中子键再逐条读取（parseRegKeyPaths）');
    ok(/reg', \['query', quoteArg\(subkey\)\]/.test(src), '对每个卸载项子键执行 reg query <子键> 读取全部值');
    ok(/parseRegSubkeyDirs/.test(src), '子键值解析覆盖 InstallLocation / DisplayIcon / UninstallString');
    ok(/官网 Windows 桌面版/.test(src), '错误页文案提到桌面版安装途径');
  }

  console.log('[7] probeDesktopDshCli 注入测试：自定义安装目录 E:\\DSH 可被识别');
  {
    const cliRel = 'resources\\runtime\\cli\\bin\\dsh.cmd';
    const customCli = 'E:\\DSH\\' + cliRel;
    const calls = [];
    const run = async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd !== 'reg') throw new Error('unexpected command: ' + cmd);
      const joined = args.join(' ');
      if (args.includes('/s')) {
        // /f … /d 搜索：仅 HKCU 有命中项，且命中输出里没有 InstallLocation（Issue #29 的原始证据）
        if (args[1] === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall') return CUSTOM_SEARCH_OUT;
        throw new Error('no match');
      }
      // 逐个子键读取：返回包含 InstallLocation 的完整值列表
      return CUSTOM_SUBKEY_OUT;
    };
    const exists = (p) => p.toLowerCase() === customCli.toLowerCase();
    const found = await I.probeDesktopDshCli({ run, exists, env: {}, force: true });
    ok(found && found.installDir === 'E:\\DSH', '自定义目录 E:\\DSH 的桌面版被识别（旧逻辑会漏掉）');
    ok(found && found.cmd.endsWith(cliRel), '返回内置 CLI 完整路径');
    const detailCalls = calls.filter(([, args]) => !args.includes('/s'));
    ok(detailCalls.length >= 1, '对命中的卸载项子键执行了逐条 reg query');
    ok(detailCalls.some(([, args]) => args.join(' ').includes(CUSTOM_SUBKEY)), '逐条查询的正是 /f … /d 命中的子键');

    // 子键路径含空格时作为 cmd.exe 参数必须加引号
    const spacedSubkey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeepSeek Harness';
    const spacedCalls = [];
    const runSpaced = async (cmd, args) => {
      spacedCalls.push(args);
      if (args.includes('/s')) return ['', spacedSubkey, '    DisplayName    REG_SZ    DeepSeek Harness', ''].join('\r\n');
      return CUSTOM_SUBKEY_OUT;
    };
    await I.probeDesktopDshCli({ run: runSpaced, exists: () => false, env: {}, force: true });
    ok(spacedCalls.some((args) => args[1] === '"' + spacedSubkey + '"'), '含空格的子键路径整体加引号');

    // 只有 DisplayIcon / UninstallString（InstallLocation 被清理）也能反推目录
    const iconOnly = [
      '',
      CUSTOM_SUBKEY,
      '    DisplayName    REG_SZ    DeepSeek Harness 0.2.1-rc.5',
      '    DisplayIcon    REG_SZ    E:\\DSH\\DeepSeek Harness.exe,0',
      '    UninstallString    REG_SZ    "E:\\DSH\\Uninstall DeepSeek Harness.exe" /currentuser',
      ''
    ].join('\r\n');
    const runIcon = async (cmd, args) => {
      if (args.includes('/s')) return CUSTOM_SEARCH_OUT;
      return iconOnly;
    };
    const foundIcon = await I.probeDesktopDshCli({ run: runIcon, exists, env: {}, force: true });
    ok(foundIcon && foundIcon.installDir === 'E:\\DSH', 'InstallLocation 缺失时用 DisplayIcon/UninstallString 反推目录');

    // 默认安装目录（路径含产品名）仍走旧解析，且不会多打逐条查询
    const DEFAULT_SEARCH = [
      '',
      CUSTOM_SUBKEY,
      '    DisplayName    REG_SZ    DeepSeek Harness',
      '    InstallLocation    REG_SZ    V:\\Apps\\DeepSeek Harness',
      ''
    ].join('\r\n');
    const defaultCalls = [];
    const runDefault = async (cmd, args) => {
      defaultCalls.push(args);
      if (args.includes('/s')) return DEFAULT_SEARCH;
      return DEFAULT_SEARCH;
    };
    const defaultCli = 'V:\\Apps\\DeepSeek Harness\\' + cliRel;
    const foundDefault = await I.probeDesktopDshCli({
      run: runDefault,
      exists: (p) => p.toLowerCase() === defaultCli.toLowerCase(),
      env: {},
      force: true
    });
    ok(foundDefault && foundDefault.installDir === 'V:\\Apps\\DeepSeek Harness', '默认安装路径仍按旧解析直接命中');
    ok(defaultCalls.filter((args) => !args.includes('/s')).length >= 1, '默认路径同样会逐条读取（兼容 InstallLocation 被过滤的安装器）');

    // REG_EXPAND_SZ 的环境变量展开后能命中
    const runExpand = async (cmd, args) => {
      if (args.includes('/s')) {
        return ['', CUSTOM_SUBKEY, '    DisplayName    REG_SZ    DeepSeek Harness', ''].join('\r\n');
      }
      return ['', CUSTOM_SUBKEY, '    InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\\DeepSeek Harness', ''].join('\r\n');
    };
    const pfCli = 'C:\\PF\\DeepSeek Harness\\' + cliRel;
    const foundExpand = await I.probeDesktopDshCli({
      run: runExpand,
      exists: (p) => p.toLowerCase() === pfCli.toLowerCase(),
      env: { ProgramFiles: 'C:\\PF' },
      force: true
    });
    ok(foundExpand && foundExpand.installDir === 'C:\\PF\\DeepSeek Harness', 'REG_EXPAND_SZ 的 %ProgramFiles% 展开后命中');
  }

  console.log('[8] 本机真实探测（信息性，不做硬断言）');
  {
    const found = await I.probeDesktopDshCli();
    if (found) {
      ok(fs.existsSync(found.cmd), '本机检测到桌面版，且内置 CLI 路径存在');
      console.log('    桌面版安装目录：' + found.installDir);
    } else {
      ok(true, '本机未安装桌面版（跳过真实路径断言）');
    }
  }

  console.log('\n通过 ' + passed + ' 项断言');
  os.homedir = realHomedir;
})().catch((e) => {
  os.homedir = realHomedir;
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
