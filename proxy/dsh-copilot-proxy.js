#!/usr/bin/env node
/**
 * dsh-copilot-proxy — 本地 OpenAI 兼容代理（零依赖）
 * 用途：截获 VS Code Copilot 发往自定义模型的完整 messages 列表，
 *       供 DeepSeek Harness (/dsh) 读取，实现 Copilot <-> DSH 共享同一份消息列表。
 *
 * 用法:
 *   node dsh-copilot-proxy.js [--port 3050] [--https-port 3051] [--upstream https://api.deepseek.com]
 * 环境变量:
 *   DSH_PROXY_PORT / DSH_PROXY_HTTPS_PORT / DSH_PROXY_UPSTREAM
 *   DEEPSEEK_API_KEY（请求未带 Authorization 时兜底）
 * 内部接口:
 *   GET /__dsh/health          -> { ok, upstream, entries, uptime }
 *   GET /__dsh/recent?limit=20 -> { ok, items: [{ ts, model, messages: [{role,text,tool_calls}] }] }
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && i < process.argv.length - 1) return process.argv[i + 1];
  return fallback;
}
const HOST = '127.0.0.1';
const PORT = parseInt(arg('port', process.env.DSH_PROXY_PORT || '3050'), 10);
const HTTPS_PORT = parseInt(arg('https-port', process.env.DSH_PROXY_HTTPS_PORT || '0'), 10);
const UPSTREAM = String(arg('upstream', process.env.DSH_PROXY_UPSTREAM || 'https://api.deepseek.com')).replace(/\/+$/, '');
const ROUTES_FILE = path.join(__dirname, 'routes.json');
let ROUTES = {};
try {
  if (fs.existsSync(ROUTES_FILE)) {
    ROUTES = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')) || {};
  }
} catch (e) {
  log('routes.json 解析失败:', e.message);
}
const MAX_ENTRIES = 500;
const MAX_MSG_TEXT = 50000;
const MAX_BODY = 20 * 1024 * 1024;
const RECENT_TTL_MS = 24 * 60 * 60 * 1000;

const recent = []; // { ts, model, messages }
const startedAt = Date.now();

function log(...a) { console.log(new Date().toISOString(), '[dsh-proxy]', ...a); }

function contentOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => {
      if (!p) return '';
      if (typeof p === 'string') return p;
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'output_text' && typeof p.text === 'string') return p.text;
      if (p.type === 'image_url') return '[图片]';
      if (p.type === 'tool_use' || p.type === 'function') return '[工具调用]';
      if (p.type === 'tool_result' && typeof p.content === 'string') return '[工具结果] ' + p.content.slice(0, 500);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof m.text === 'string') return m.text;
  return '';
}

function slim(m) {
  if (!m || typeof m !== 'object') return null;
  const out = { role: typeof m.role === 'string' ? m.role : 'unknown' };
  const t = String(contentOf(m)).slice(0, MAX_MSG_TEXT);
  if (t) out.text = t;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((tc) => (tc && tc.function ? tc.function.name : '')).filter(Boolean);
  }
  if (typeof m.tool_call_id === 'string') out.tool_call_id = m.tool_call_id;
  return out;
}

function isTitleRequest(payload) {
  try {
    const last = [...payload.messages].reverse().find((m) => m && m.role === 'user');
    const t = typeof last.content === 'string' ? last.content : (last && last.content ? JSON.stringify(last.content) : '');
    return /brief title|ultra-compact titles|conversation title/i.test(t);
  } catch (_) { return false; }
}

function record(bodyStr, statusCode) {
  try {
    if (!bodyStr || statusCode >= 400) return;
    let payload;
    try { payload = JSON.parse(bodyStr); } catch (_) { return; }
    if (!payload || !Array.isArray(payload.messages)) return;
    if (isTitleRequest(payload)) return; // 标题生成请求不是对话内容，不记录
    const messages = payload.messages.map(slim).filter(Boolean);
    if (messages.length === 0) return;
    recent.push({ ts: Date.now(), model: payload.model || '', messages });
    if (recent.length > MAX_ENTRIES) recent.shift();
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    log('已记录请求', payload.model || '?', '(' + messages.length + ' 条消息)', lastUser && lastUser.text ? '最后用户消息: ' + String(lastUser.text).slice(0, 50).replace(/\n/g, ' ') : '');
  } catch (e) { /* 记录失败不影响转发 */ }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function handleInternal(req, res, pathname, searchParams) {
  if (pathname === '/__dsh/health') {
    json(res, 200, { ok: true, upstream: UPSTREAM, routes: Object.keys(ROUTES).length, entries: recent.length, uptime: Math.round((Date.now() - startedAt) / 1000) });
    return true;
  }
  if (pathname === '/__dsh/shutdown' && req.method === 'POST') {
    json(res, 200, { ok: true, bye: true });
    setTimeout(() => process.exit(0), 100);
    return true;
  }
  if (pathname === '/__dsh/recent') {
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10) || 50, 200);
    const now = Date.now();
    const items = recent.filter((e) => now - e.ts < RECENT_TTL_MS).slice(-limit).reverse()
      .map((e) => ({ ts: e.ts, model: e.model, messages: e.messages }));
    json(res, 200, { ok: true, items });
    return true;
  }
  return false;
}

function forward(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
  req.on('error', () => { try { res.writeHead(502); res.end('proxy read error'); } catch (_) {} });
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const bodyStr = bodyBuf.length ? bodyBuf.toString('utf8') : '';
    // 多上游路由：按请求 body 的 model 名选择上游（缺省用默认上游）
    let upstream = UPSTREAM;
    try {
      const parsed = bodyStr ? JSON.parse(bodyStr) : null;
      if (parsed && parsed.model && ROUTES && ROUTES[parsed.model]) {
        upstream = String(ROUTES[parsed.model]).replace(/\/+$/, '');
      }
    } catch (_) { /* 无法解析则用默认上游 */ }
    const headers = {};
    for (const k of Object.keys(req.headers)) {
      if (['host', 'content-length', 'connection', 'accept-encoding'].includes(k.toLowerCase())) continue;
      headers[k] = req.headers[k];
    }
    if (!headers['authorization'] && process.env.DEEPSEEK_API_KEY) {
      headers['authorization'] = 'Bearer ' + process.env.DEEPSEEK_API_KEY;
    }
    if (bodyStr) headers['content-length'] = Buffer.byteLength(bodyStr);
    let target;
    try {
      target = new URL(upstream + req.url);
    } catch (e) {
      try { res.writeHead(502); res.end('bad upstream url'); } catch (_) {}
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const upReq = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers
    }, (upRes) => {
      try {
        const respHeaders = {};
        for (const k of Object.keys(upRes.headers)) {
          if (['content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
          respHeaders[k] = upRes.headers[k];
        }
        res.writeHead(upRes.statusCode || 502, respHeaders);
      } catch (_) { return; }
      upRes.pipe(res);
      upRes.on('error', () => { try { res.destroy(); } catch (_) {} });
      if (req.method === 'POST') record(bodyStr, upRes.statusCode);
    });
    upReq.on('error', (e) => {
      log('上游错误:', e.message);
      try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('upstream error: ' + e.message); } catch (_) {}
    });
    if (bodyStr) upReq.end(bodyStr); else upReq.end();
  });
}

function handle(u, req, res) {
  if (handleInternal(req, res, u.pathname, u.searchParams)) return;
  forward(req, res);
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); } catch (_) { res.writeHead(400); res.end(); return; }
  handle(u, req, res);
});
server.listen(PORT, HOST, () => {
  log('HTTP  监听 http://' + HOST + ':' + PORT + ' -> ' + UPSTREAM);
});

// HTTPS 备用（当 VS Code 拒绝 http 自定义端点时使用，需信任自签名证书）
if (HTTPS_PORT > 0) {
  const certFile = path.join(__dirname, 'cert.pem');
  const keyFile = path.join(__dirname, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const tlsServer = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
      let u;
      try { u = new URL(req.url, 'https://127.0.0.1'); } catch (_) { res.writeHead(400); res.end(); return; }
      handle(u, req, res);
    });
    tlsServer.listen(HTTPS_PORT, HOST, () => log('HTTPS 监听 https://' + HOST + ':' + HTTPS_PORT + '（自签名证书，需信任）'));
  } else {
    log('未找到 cert.pem/key.pem，跳过 HTTPS');
  }
}
