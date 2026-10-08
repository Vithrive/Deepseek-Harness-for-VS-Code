'use strict';
/**
 * Copilot 桥接「回答回写」回归测试：DSH 会话事件 → 回写给 Copilot 的正文。
 * 运行：node test/dsh-stream-events.test.js
 *
 * 背景（线上故障）：DSH 0.2.x 起**不再发 `assistant/chunk`**，助手正文改为
 * 每个 step 一条 `assistant/message`（正文在 `data.message.content` 的 text 块里）。
 * 旧实现只认 `assistant/chunk` 的 text-delta，于是「任务已提交、DSH 里也跑完了，
 * Copilot 侧却一个字都收不到」。这里把两代协议的回写语义钉住：
 *   - 新协议 assistant/message → 只回写 text 块（reasoning / tool-call 不外发）；
 *   - 旧协议 assistant/chunk  → text-delta 增量；历史回放里只有 block-end 整块；
 *   - 游标推进去重、turn/end 结束判定、异常结束原因透出。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), workspaceFolders: [] },
  env: {}, window: {}, commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

/** 收集回写文本的假 progress。 */
function collector() {
  const texts = [];
  return { texts, report: (part) => { texts.push(part && part.value !== undefined ? part.value : String(part)); } };
}

console.log('[1] dshEventText：新协议 assistant/message');
{
  const ev = {
    type: 'assistant/message',
    seq: 10,
    data: {
      turn: 1, step: 3,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '内部思考，不应外发' },
          { type: 'text', text: '第一段。' },
          { type: 'tool-call', id: 'call_1', name: 'read' },
          { type: 'text', text: '第二段。' }
        ]
      }
    }
  };
  const piece = I.dshEventText(ev, false);
  ok(piece && piece.kind === 'message' && piece.text === '第一段。第二段。', '只拼接 text 块（reasoning / tool-call 不外发）');
  ok(!piece.text.includes('内部思考'), '推理内容不会泄漏到 Copilot 回答里');

  const onlyTools = { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'reasoning', text: 'x' }, { type: 'tool-call', id: 'c' }] } } };
  ok(I.dshEventText(onlyTools, false) === null, '只有 reasoning/tool-call 的 step 不回写任何内容');
  ok(I.dshEventText({ type: 'assistant/message', seq: 12 }, false) === null, '缺 content 的事件安全返回 null');
  ok(I.dshEventText({ type: 'assistant/message', seq: 13, data: { message: { content: [{ type: 'text', text: '' }] } } }, false) === null, '空文本不产生空回写');
}

console.log('[2] dshEventText：旧协议 assistant/chunk（向后兼容）');
{
  ok(I.dshEventText({ type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'abc' } } }, false).kind === 'delta', 'text-delta → 增量回写');
  ok(I.dshEventText({ type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'reasoning-delta', text: 'x' } } }, false) === null, 'reasoning-delta 不回写');
  const block = { type: 'assistant/chunk', seq: 3, data: { chunk: { type: 'block-end', block: { text: '整块文本' } } } };
  ok(I.dshEventText(block, false).text === '整块文本', 'block-end 整块文本（历史回放里只有它）');
  ok(I.dshEventText(block, true) === null, '已经流过增量时不再重发整块（不重复）');
  ok(I.dshEventText(null, false) === null && I.dshEventText(undefined, false) === null, '空事件不抛错');
}

console.log('[3] applyDshEvents：真实 DSH 0.2.x 回合（本次故障场景）');
{
  const progress = collector();
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一下' }, { type: 'tool-call', id: 'c1', name: 'read' }] } } },
    { seq: 4, type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    { seq: 5, type: 'tool/result', data: { toolCallId: 'c1' } },
    { seq: 6, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 7, type: 'step/start', data: { turn: 1, step: 2 } },
    { seq: 8, type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: '整理' }, { type: 'text', text: '结论：文件共 3 个。' }] } } },
    { seq: 9, type: 'step/end', data: { turn: 1, step: 2 } },
    { seq: 10, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ];
  const res = I.applyDshEvents(events, { lastSeq: 0, started: false, emitted: false }, progress);
  ok(progress.texts.length === 1 && progress.texts[0] === '结论：文件共 3 个。', '回写出助手正文（旧实现这里一个字都没有 → 本次故障）');
  ok(res.ended === true && res.endReason && res.endReason.kind === 'completed', 'turn/end 正常结束并带回 reason');
  ok(res.lastSeq === 10 && res.emitted === true, '游标推进到最新、emitted 置位');

  // 同一批事件再喂一次：不应重复回写（轮询里每次都会重读尾部）
  const again = I.applyDshEvents(events, res, progress);
  ok(progress.texts.length === 1, '重复喂同一批事件不重复回写（按 seq 去重）');
  ok(again.ended === false, '已消费过的事件不会再触发结束');
}

console.log('[4] applyDshEvents：多段正文、分隔与跨轮次');
{
  const progress = collector();
  const events = [
    { seq: 1, type: 'turn/start', data: {} },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先看目录。' }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '再读文件。' }] } } },
    { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } }
  ];
  I.applyDshEvents(events, {}, progress);
  ok(progress.texts.length === 2 && progress.texts[0] === '先看目录。' && progress.texts[1] === '\n\n再读文件。',
    '多条助手消息之间补空行（不粘连）');
}

console.log('[5] applyDshEvents：旧协议流式与历史回放语义');
{
  const live = collector();
  I.applyDshEvents([
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '你' } } },
    { seq: 3, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '好' } } },
    { seq: 4, type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { text: '你好' } } } }
  ], {}, live);
  ok(live.texts.join('') === '你好', '旧协议实时：只回写增量，block-end 不重复追加');

  const replay = collector();
  I.applyDshEvents([
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { text: '完整回答' } } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } }
  ], {}, replay);
  ok(replay.texts.join('') === '完整回答', '旧协议历史回放：没有增量时用整块文本');
}

console.log('[6] applyDshEvents：异常与边界');
{
  const progress = collector();
  const res = I.applyDshEvents([
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Upstream request failed' } } } }
  ], {}, progress);
  ok(res.ended === true && res.endReason.kind === 'error', '异常结束的 reason 透出给调用方（由调用方告警）');
  const empty = I.applyDshEvents(null, {}, progress);
  ok(empty.ended === false && empty.lastSeq === 0, '空/异常事件列表安全');
  const noSeq = I.applyDshEvents([{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } }], {}, progress);
  ok(noSeq.lastSeq === 0 && progress.texts.length === 0, '缺 seq 的事件被忽略（不推进游标、不回写）');
  const filtered = I.applyDshEvents([
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '只发新的' }] } } }
  ], { lastSeq: 4, started: false, emitted: false }, progress);
  ok(filtered.lastSeq === 5 && progress.texts.length === 1, '游标之后的事件才回写');
}

console.log('\n全部通过：' + passed + ' 项断言 ✓');
process.exit(0);
