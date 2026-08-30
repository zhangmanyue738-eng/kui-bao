/**
 * server.js — 本地 Web 服务（node:http，零额外依赖）
 * GET  /                → public/index.html
 * POST /api/interpret   → { dateStr, hour, gender, city, domains } → 排盘 + LLM 解读
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildChart } = require('./chart.js');
const { synthesize } = require('./synthesize.js');
const { interpret } = require('./interpret.js');
const rect = require('./rectify.js');

// 定盘会话（内存态，自用规模足够；重启即失效）
const rectifySessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
function putSession(id, s) {
  rectifySessions.set(id, { s, ts: Date.now() });
  for (const [k, v] of rectifySessions) if (Date.now() - v.ts > SESSION_TTL) rectifySessions.delete(k);
}

const PORT = process.env.PORT || 3766;
const PUBLIC = path.join(__dirname, '..', 'public');

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'POST' && req.url === '/api/feedback') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { input, report, rating, comment, facts } = JSON.parse(body);
        if (!['good', 'bad'].includes(rating)) throw new Error('rating 必须是 good 或 bad');
        // facts：用户补充的真实人生事实（哪年发生了什么），是后续校正取证规则的关键数据
        const record = {
          ts: new Date().toISOString(), input, rating,
          comment: (comment || '').slice(0, 2000),
          facts: (facts || '').slice(0, 2000),
          report: (report || '').slice(0, 20000),
        };
        fs.appendFileSync(path.join(__dirname, '..', 'data', 'feedback.jsonl'), JSON.stringify(record) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 定盘：开始（返回第一个问题）
  if (req.method === 'POST' && req.url === '/api/rectify/start') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { dateStr, gender, city, knownHour, mode } = JSON.parse(body);
        if (!dateStr) throw new Error('缺少出生日期');
        const session = rect.createSession({
          dateStr, gender: gender === '女' ? '女' : '男', city,
          knownHour: knownHour ?? null, mode: mode || (knownHour != null ? 'refine' : 'full'),
        });
        const id = 'R' + Date.now() + Math.random().toString(36).slice(2, 6);
        putSession(id, session);
        const q = rect.nextQuestion(session);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          sessionId: id, candidates: session.candidates.length,
          question: q, posterior: rect.posteriorView(session), done: session.done,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 定盘：回答（推进或结束）
  if (req.method === 'POST' && req.url === '/api/rectify/answer') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { sessionId, question, answer } = JSON.parse(body);
        const rec = rectifySessions.get(sessionId);
        if (!rec) throw new Error('定盘会话已过期，请重新开始');
        rect.answerQuestion(rec.s, question, answer);
        const q = rect.nextQuestion(rec.s);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          done: rec.s.done, result: rec.s.result, question: q,
          posterior: rect.posteriorView(rec.s), asked: rec.s.asked.length,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/interpret') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { dateStr, hour, gender, city, domains } = JSON.parse(body);
        if (!dateStr) throw new Error('缺少出生日期');
        const chart = buildChart({ dateStr, hour: hour ?? null, gender: gender === '女' ? '女' : '男', city });
        const domainList = Array.isArray(domains) && domains.length ? domains : ['career', 'wealth', 'marriage'];
        const synthesis = synthesize(chart, domainList);
        const r = await interpret({ chart, domains: domainList, synthesis });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...r, chart, synthesis }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`命理顾问 MVP 已启动: http://127.0.0.1:${PORT}`);
});
