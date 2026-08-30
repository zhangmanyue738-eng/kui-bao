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
