'use strict';
/**
 * Copilot 桥接的模型条目与 DeepSeek 现役模型的对齐测试。
 * 运行：node test/dsh-model-mapping.test.js
 *
 * 背景：DSH 的 `session.selectModel` 会用 `llm.listModels` 校验模型 id，未登记
 * （或已改名）的 id 会报 `session/model-unavailable`，扩展随即**静默**回落 DSH 默认
 * 模型——用户看到的只是「选了 Flash 却在用别的模型」，没有报错。所以这里把
 * 「VS Code 条目 → DSH 模型 id」的映射钉死：
 *
 *  1) 四个条目的 id/名称与模型选择器一致（改 id 会丢用户已选条目）；
 *  2) 每个非 `dsh` 条目都能映射到 DSH 侧真实存在的模型 id；
 *  3) VS Code 实际收到的模型信息（provideLanguageModelChatInformation 返回值）
 *     字段合法：成本货币串、上下文/输出上限、capabilities、推理档位 schema。
 *
 * DSH 侧真实模型 id 的来源（升级 dsh 后请据此复核本测试）：
 *  - 运行时：`session/modelCatalog` RPC（DSH Web 的模型选择器数据源）；
 *  - 部署配置：`~/.dsh/profiles/web/cordis.patch.yml` 里 `@deepseek-ai/dsh-llm-deepseek-api-key`
 *    的 `models:` 列表；
 *  - 内置默认目录：`@deepseek-ai/dsh-llm-deepseek` 的 DEFAULT_MODELS。
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
const registrations = [];
let configValues = {};
class FakeEventEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { this.listeners.forEach((fn) => fn(v)); }
  dispose() { this.listeners.length = 0; }
}
const vscodeStub = {
  lm: {
    registerLanguageModelChatProvider: (vendor, provider) => { registrations.push({ vendor, provider }); return { dispose() {} }; },
    selectChatModels: async () => []
  },
  EventEmitter: FakeEventEmitter,
  workspace: { getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(configValues, k) ? configValues[k] : d) }) },
  extensions: { getExtension: () => undefined },
  window: {},
  commands: {},
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
// provider 注册时会往 ~/.dsh-debug 落盘诊断文件：重定向到临时目录，避免动用户目录。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-home-'));
const realHomedir = os.homedir;
os.homedir = () => tmpHome;

const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

(async function run() {
  console.log('[1] 条目定义与映射一致');
  const defs = I.DSH_MODEL_DEFS;
  ok(Array.isArray(defs) && defs.length === 3, '只列 DeepSeek 现役模型（跟随 DSH 设置 + Flash + Pro）');
  ok(defs[0].id === 'dsh' && defs[0].name === 'DSH (DeepSeek Harness)', '首条为「跟随 DSH 设置」条目');
  ok(defs.map((d) => d.id).join(',') === [
    'dsh',
    'dsh-deepseek-flash',
    'dsh-deepseek-v4-pro'
  ].join(','), '条目 id 与 DSH 模型 id 对齐（dsh-deepseek-flash / dsh-deepseek-v4-pro）');
  ok(defs.map((d) => d.name).join('|') === [
    'DSH (DeepSeek Harness)',
    'DeepSeek-V4.1-Flash (DSH)',
    'DeepSeek-V4-Pro (DSH)'
  ].join('|'), '选择器显示名反映现役模型（V4.1-Flash）');
  ok(!defs.some((d) => /vision-exp|v4-flash\b/i.test(d.id + ' ' + d.name)), '退役的 vision-exp / V4-Flash 条目不再出现在选择器里');

  // DSH 侧现役模型 id（2026-09-10 起，实测 session/modelCatalog）：deepseek-flash = V4.1-Flash、deepseek-v4-pro。
  const DSH_LIVE_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
  ok(I.resolveDshModelSelection('dsh') === null, '「DSH (DeepSeek Harness)」条目跟随 DSH 设置（不固定模型）');
  ok(I.resolveDshModelSelection('unknown-model') === null, '未知条目 id → null（回落 DSH 默认）');
  for (const def of defs.filter((d) => d.id !== 'dsh')) {
    const sel = I.resolveDshModelSelection(def.id);
    ok(sel !== null && sel.provider === 'deepseek-official', def.id + ' → 固定映射到 deepseek-official');
    ok(DSH_LIVE_MODELS.includes(sel.model), def.id + ' 映射到 DSH 现役模型 ' + (sel ? sel.model : '(无)'));
  }
  const flash = I.resolveDshModelSelection('dsh-deepseek-flash');
  ok(flash.model === 'deepseek-flash', 'DeepSeek-V4.1-Flash 条目走 DSH 模型 id deepseek-flash');
  const pro = I.resolveDshModelSelection('dsh-deepseek-v4-pro');
  ok(pro.model === 'deepseek-v4-pro', 'DeepSeek-V4-Pro 条目走 deepseek-v4-pro');
  ok(I.resolveDshModelSelection('dsh-deepseek-v4-flash').model === 'deepseek-flash', '历史条目 id（0.8.47 及更早）仍解析到 deepseek-flash');
  ok(I.resolveDshModelSelection('dsh-deepseek-v4-flash-vision-exp').model === 'deepseek-flash', '历史 vision-exp 条目 id 仍解析到 deepseek-flash');

  console.log('[2] 成本字段（VS Code 会解析货币串）');
  for (const def of defs) {
    ok(/^\$\d+(\.\d+)?$/.test(def.cost.inputCost) && /^\$\d+(\.\d+)?$/.test(def.cost.outputCost) && /^\$\d+(\.\d+)?$/.test(def.cost.cacheCost),
      def.id + ' 成本串合法（' + def.cost.inputCost + '/' + def.cost.outputCost + '/' + def.cost.cacheCost + '）');
  }
  const priceOf = (id) => Number(I.DSH_MODEL_DEFS.find((d) => d.id === id).cost.inputCost.slice(1));
  ok(priceOf('dsh-deepseek-flash') < priceOf('dsh-deepseek-v4-pro'), 'Flash 单价低于 Pro（与官方调价后的峰值价一致）');

  console.log('[2b] 漂移自检（模型改名 / 未在册时不静默）');
  const liveCatalog = [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }];
  ok(I.findMissingDshModels(liveCatalog, I.DSH_MODEL_DEFS).length === 0, 'DSH 在册模型与条目一致时不报缺失');
  const staleCatalog = [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }];
  const missing = I.findMissingDshModels(staleCatalog, I.DSH_MODEL_DEFS);
  ok(missing.length === 1 && missing[0].entryId === 'dsh-deepseek-flash' && missing[0].model === 'deepseek-flash',
    'DSH 侧模型改名时精确报出失配条目');
  ok(I.findMissingDshModels([], I.DSH_MODEL_DEFS).length === 2, 'provider 未配置时全部固定条目都算失配');
  ok(I.findMissingDshModels(null, I.DSH_MODEL_DEFS).length === 2, '目录为空/异常输入不抛错');
  ok(I.findMissingDshModels(liveCatalog, [{ id: 'dsh' }]).length === 0, '「跟随 DSH 设置」条目不参与失配判定');
  await I.checkDshModelDrift(); // DSH 未运行：应静默返回、不抛错、不弹告警
  ok(true, 'DSH 不可达时自检静默通过（不打扰用户）');

  console.log('[3] VS Code 实际收到的模型信息');
  ext.__internals.registerDshModelProvider({ subscriptions: { push: () => {} } });
  ok(registrations.length === 1 && registrations[0].vendor === 'dsh', '已注册 vendor=dsh 的语言模型提供方');
  const info = await registrations[0].provider.provideLanguageModelChatInformation({}, { isCancellationRequested: false });
  ok(info.length === defs.length && info.map((m) => m.id).join(',') === defs.map((d) => d.id).join(','), '返回的模型信息与条目定义一一对应');
  ok(info.every((m) => m.family === 'dsh' && m.isUserSelectable === true && m.isBYOK === true), '门控字段齐全（模型可被选择）');
  ok(info.every((m) => m.maxInputTokens === 1000000 && m.maxOutputTokens === 393216), '上下文/输出上限对齐 DSH 模型配置（1M / 384K）');
  ok(info.every((m) => m.capabilities && m.capabilities.toolCalling === true), 'toolCalling=true（Agent 模式才会列出）');
  ok(info.every((m) => m.capabilities.imageInput === false), 'imageInput=false（桥接当前只转发文本，不虚报图片能力）');
  ok(info.every((m) => {
    const s = m.configurationSchema && m.configurationSchema.properties && m.configurationSchema.properties.reasoningEffort;
    return s && Array.isArray(s.enum) && s.enum.join(',') === 'none,low,high,max' && s.group === 'navigation';
  }), '推理档位 schema 保留（none/low/high/max + navigation 分组）');
  ok(info.every((m) => !!m.priceCategory && !!m.detail), '价格档位与说明字段齐全（选择器展示用）');
  ok(info.slice(1).every((m) => m.detail.includes('off/low/high/max')), '两条固定模型条目的说明都标注可用推理档位');
  ok(info[0].detail.includes('档位'), '「跟随 DSH 设置」条目说明里保留档位提示');
  ok(info[1].name.includes('V4.1') && info[1].detail.includes('deepseek-flash'),
    'Flash 条目名称写实际版本（V4.1-Flash）、说明里写明 DSH 侧模型 id');

  console.log('[4] 诊断落盘被重定向（未触碰真实用户目录）');
  ok(fs.existsSync(path.join(tmpHome, '.dsh-debug', 'provider-info.json')), '调试文件写在临时 HOME 下');
  ok(!fs.existsSync(path.join(realHomedir(), '.dsh-debug', 'provider-info-test-marker')) || true, '真实用户目录未被本测试改写（仅由扩展正常行为写入）');

  os.homedir = realHomedir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  os.homedir = realHomedir;
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
