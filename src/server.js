/**
 * server.js — 本地 Web 服务（node:http，零额外依赖）
 * GET  /                → public/index.html
 * POST /api/interpret   → { dateStr, hour, gender, city, domains } → 排盘 + LLM 解读
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildChart, CITY_LONGITUDE } = require('./chart.js');
const { synthesize } = require('./synthesize.js');
const { interpret } = require('./interpret.js');
const rect = require('./rectify.js');
const { checkPreflight, applyConfirmations } = require('./preflight.js');
const sessions = require('./sessions.js');
const { buildDocx, suggestName } = require('./report.js');
const { buildAttribution } = require('./badcase.js');
const lunarConvert = require('./lunar-convert.js');

/**
 * 农历输入统一入口：传了 lunar（{year,month,day,leap}）就在服务端确定性转成公历 dateStr，
 * 之后走原有全链路——闰月/夏令时/子时三道澄清闸基于转换后的公历自动生效，零改动复用。
 * 返回 { dateStr, lunarLabel, lunarInput }；没传 lunar 返回 { dateStr: 原值 }。
 */
function resolveDateInput({ dateStr, lunar }) {
  if (lunar && lunar.year) {
    if (dateStr) throw new Error('公历与农历只能二选一，请勿同时提交');
    const r = lunarConvert.lunarToSolar(lunar);
    return { dateStr: r.dateStr, lunarLabel: r.lunarLabel, lunarInput: r.lunar };
  }
  return { dateStr };
}

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
  // 安全网：单个请求出错不该把整个服务带崩（本机自用服务，重启一次要手动来一遍）
  try { await route(req, res); } catch (e) {
    console.error(`[500] ${req.method} ${req.url}`, e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    } else {
      try { res.end(); } catch { /* 已经断开了 */ }
    }
  }
});

/** 读取请求体（带大小上限，防止恶意/异常大 body 打满内存） */
function readBody(req, maxBytes = 2e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > maxBytes) { req.destroy(); reject(new Error('请求体过大')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const json = (res, status, obj) => {
  // 先序列化再写头：序列化抛异常时不至于二次写头把进程带崩（踩过）
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
};

async function route(req, res) {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ── 城市经度表：前端下拉的唯一数据来源（避免前后端各存一份而脱节）
  if (req.method === 'GET' && req.url === '/api/cities') {
    const cities = Object.entries(CITY_LONGITUDE)
      .sort((a, b) => a[1] - b[1])   // 按经度从西到东，顺带方便肉眼核对
      .map(([name, lon]) => ({ name, lon }));
    return json(res, 200, { count: cities.length, cities });
  }

  // ── 农历年历：某农历年闰几月 + 每月天数，供前端动态渲染月/日下拉
  if (req.method === 'GET' && /^\/api\/lunar\/year\/\d+$/.test(req.url)) {
    try {
      const year = Number(req.url.split('/').pop());
      const leapMonth = lunarConvert.getLeapMonth(year);
      const months = [];
      for (let m = 1; m <= 12; m++) {
        months.push({ month: m, leap: false, days: lunarConvert.getMonthDays(year, m) });
        if (leapMonth === m) months.push({ month: m, leap: true, days: lunarConvert.getMonthDays(year, -m) });
      }
      return json(res, 200, { year, leapMonth, months });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/feedback') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { input, report, rating, comment, facts, sessionId } = JSON.parse(body);
        if (!['good', 'bad'].includes(rating)) throw new Error('rating 必须是 good 或 bad');

        // 归因快照：把「这条评价是在什么盘、什么判定下产生的」当场固化下来。
        // 踩过的坑：feedback 原本只存 sessionId 一个指针，而归档是**可删除**的
        // （前端有「删除档案」按钮）——实测 3/3 条反馈指向的归档已不存在，
        // 拿不到日主/命宫/判定/引用条文，这条 badcase 就彻底无法归因了。
        // 只存生辰也不行：口径可能已经变了，重排出来的盘跟当时不是一回事。
        // 多花几百字节换「归档没了也能归因」，对攒 badcase 这个目的完全值得。
        let attribution = null;
        if (sessionId) {
          const s = sessions.getSession(sessionId);
          if (s) attribution = buildAttribution(s);
        }

        // facts：用户补充的真实人生事实（哪年发生了什么），是后续校正取证规则的关键数据
        const record = {
          ts: new Date().toISOString(), input, rating, sessionId: sessionId || null,
          comment: (comment || '').slice(0, 2000),
          facts: (facts || '').slice(0, 2000),
          report: (report || '').slice(0, 20000),
          attribution,
        };
        // feedback.jsonl 是不可变审计流水（只追加、永不改写）；
        // 同时把结构化结论回写到会话档案，便于按评分/事实检索——两套数据各有用途。
        fs.appendFileSync(path.join(__dirname, '..', 'data', 'feedback.jsonl'), JSON.stringify(record) + '\n');
        let linked = false;
        if (sessionId) {
          const rec = sessions.updateSession(sessionId, {
            rating,
            comment: (comment || '').slice(0, 2000),
            facts: (facts || '').slice(0, 2000),
          });
          linked = !!rec;
        }
        return json(res, 200, { ok: true, linked });
      } catch (e) {
        return json(res, 400, { error: e.message });
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
        const { dateStr, gender, city, knownHour, mode, lunar } = JSON.parse(body);
        const resolved = resolveDateInput({ dateStr, lunar });
        if (!resolved.dateStr) throw new Error('缺少出生日期');
        const session = rect.createSession({
          dateStr: resolved.dateStr, gender: gender === '女' ? '女' : '男', city,
          knownHour: knownHour ?? null, mode: mode || (knownHour != null ? 'refine' : 'full'),
        });
        const id = 'R' + Date.now() + Math.random().toString(36).slice(2, 6);
        putSession(id, session);
        const q = rect.nextQuestion(session);
        const posterior = rect.posteriorView(session);
        return json(res, 200, {
          sessionId: id, candidates: session.candidates.length,
          question: q, posterior, done: session.done,
        });
      } catch (e) {
        return json(res, 400, { error: e.message });
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
        const posterior = rect.posteriorView(rec.s);
        return json(res, 200, {
          done: rec.s.done, result: rec.s.result, question: q,
          posterior, asked: rec.s.asked.length,
        });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // ── 澄清闸：排盘前体检（前端可先调，拿到需要确认的问题清单）
  if (req.method === 'POST' && req.url === '/api/preflight') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        if (!input.dateStr) throw new Error('缺少出生日期');
        // 先算完再写头：反过来的话，checkPreflight 一旦抛异常就会走到 catch 二次写头，
        // 触发 ERR_HTTP_HEADERS_SENT 并把整个进程带崩（踩过一次）
        const payload = JSON.stringify(checkPreflight(input));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(payload);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ═══════════ 会话归档与检索 ═══════════
  // 归档是「真实反馈回校」的地基：没有检索能力，攒下来的 badcase 找不出来，等于白攒。
  // 路由：GET/POST /api/sessions，GET/PATCH/DELETE /api/sessions/:id
  if (req.url === '/api/sessions' || req.url.startsWith('/api/sessions?') || req.url.startsWith('/api/sessions/')) {
    const [pathname, queryString] = req.url.split('?');
    const params = new URLSearchParams(queryString || '');
    const id = pathname.startsWith('/api/sessions/') ? decodeURIComponent(pathname.slice('/api/sessions/'.length)) : '';

    try {
      // ── 概览（供面板顶部小结与 doctor 用）
      if (req.method === 'GET' && !id && params.get('action') === 'stats') {
        return json(res, 200, { ok: true, ...sessions.stats() });
      }

      // ── 列表 / 检索（q 全文、rating、dayMaster、mingStar、from/to、limit/offset）
      if (req.method === 'GET' && !id) {
        return json(res, 200, { ok: true, ...sessions.listSessions({
          q: params.get('q') || '',
          rating: params.get('rating') || '',
          dayMaster: params.get('dayMaster') || '',
          mingStar: params.get('mingStar') || '',
          mingGongStar: params.get('mingGongStar') || '',
          from: params.get('from') || '',
          to: params.get('to') || '',
          limit: params.get('limit') || 50,
          offset: params.get('offset') || 0,
        }) });
      }

      // ── 详情
      if (req.method === 'GET' && id) {
        const rec = sessions.getSession(id);
        return rec ? json(res, 200, { ok: true, session: rec })
                   : json(res, 404, { error: '会话不存在或已删除' });
      }

      // ── 手动归档（前端「保存到历史」；interpret 成功后已自动归档，这里用于补存/另存）
      if (req.method === 'POST' && !id) {
        const body = JSON.parse(await readBody(req));
        const rec = sessions.saveSession(body);
        return json(res, 200, { ok: true, id: rec.id, session: rec });
      }

      // ── 更新白名单字段（note / rating / comment / facts）
      if (req.method === 'PATCH' && id) {
        const patch = JSON.parse(await readBody(req));
        const bad = Object.keys(patch).filter(k => !sessions.EDITABLE.includes(k));
        if (bad.length) return json(res, 400, { error: `不允许修改字段：${bad.join('、')}。可改：${sessions.EDITABLE.join('、')}` });
        const rec = sessions.updateSession(id, patch);
        return rec ? json(res, 200, { ok: true, session: rec })
                   : json(res, 404, { error: '会话不存在或已删除' });
      }

      // ── 删除
      if (req.method === 'DELETE' && id) {
        return sessions.removeSession(id)
          ? json(res, 200, { ok: true })
          : json(res, 404, { error: '会话不存在或已删除' });
      }
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/interpret') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { dateStr: rawDateStr, hour, gender, city, domains, confirm, force, rectified, lunar } = JSON.parse(body);
        const { dateStr, lunarLabel, lunarInput } = resolveDateInput({ dateStr: rawDateStr, lunar });
        const inputRectified = rectified;
        if (!dateStr) throw new Error('缺少出生日期');

        // 澄清闸：合并用户确认 → 体检 → 仍有未确认的阻断项则 422，不出报告
        // （农历输入已在 resolveDateInput 转成公历，闰月/夏令时/子时拦截自动生效）
        const merged = applyConfirmations({ dateStr, hour, gender, city }, confirm);
        const pre = checkPreflight(merged);
        if (!pre.ok && !force) {
          res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            needConfirm: true,
            lunarLabel,
            message: '有几项会影响排盘结果的设置需要你确认后才能出报告。',
            blocking: pre.blocking, warnings: pre.warnings, facts: pre.facts,
          }));
        }

        const chart = buildChart({
          dateStr, hour: hour ?? null, gender: gender === '女' ? '女' : '男',
          city: merged.city, sect: merged.sect, dstMode: merged.dstMode,
        });
        const domainList = Array.isArray(domains) && domains.length ? domains : ['career', 'wealth', 'marriage'];
        const synthesis = synthesize(chart, domainList);
        const r = await interpret({ chart, domains: domainList, synthesis });

        // 自动归档：读盘的人后来给的反馈（准/不准、真实事实）才是校正规则的原料，
        // 不入库就永远只能凭印象复盘。合规拦截（无报告）的不归档，免得污染样本。
        let sessionId = null;
        if (!r.complianceFailed && r.report) {
          try {
            sessionId = sessions.saveSession({
              input: { dateStr, hour: hour ?? null, gender: gender === '女' ? '女' : '男',
                city: merged.city, domains: domainList, rectified: !!inputRectified,
                lunarInput, lunarLabel },
              chart, synthesis, report: r.report,
              model: r.model, usage: r.usage, rag: r.rag, degraded: r.degraded,
              passages: r.passages, preflightWarnings: pre.warnings,
            }).id;
          } catch (e) {
            // 归档失败不该让解读白跑一场：记日志继续返回报告
            console.error('[归档失败]', e.message);
          }
        }

        return json(res, 200, { ...r, chart, synthesis, sessionId,
          sectStamp: chart.meta.sectStamp, preflightWarnings: pre.warnings,
          lunarLabel, lunarInput });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── 报告导出（P1-2）：POST /api/report/export
  // 两种入参：① 传 sessionId，从归档里取（历史报告也能导出）
  //          ② 传 report + meta，导出刚生成但还没归档的
  // PDF 不走这条路：二进制 PDF 必须嵌入中文字体，改由前端 window.print() 走系统打印。
  if (req.method === 'POST' && req.url === '/api/report/export') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { sessionId, report, meta, format } = JSON.parse(body || '{}');
        if (format && format !== 'docx') {
          return json(res, 400, { error: `暂不支持导出 ${format}；PDF 请用前端「打印 / 存为 PDF」` });
        }

        let text = report;
        let m = meta || {};
        if (sessionId) {
          const s = sessions.getSession(sessionId);
          if (!s) return json(res, 404, { error: '归档记录不存在' });
          text = s.report;
          m = { dateStr: s.input && s.input.dateStr, hour: s.input && s.input.hour,
            gender: s.input && s.input.gender, city: s.input && s.input.city,
            trueSolar: s.chart && s.chart.meta && s.chart.meta.trueSolar,
            sectStamp: s.chart && s.chart.meta && s.chart.meta.sectStamp };
        }

        const buf = buildDocx({ report: text, meta: m });
        const fname = encodeURIComponent(suggestName(m)) + '.docx';
        // 中文文件名必须给 filename*（RFC 5987），否则各浏览器编码不一致会变乱码
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Length': buf.length,
          'Content-Disposition': `attachment; filename="report.docx"; filename*=UTF-8''${fname}`,
        });
        res.end(buf);
      } catch (e) {
        // 头可能已经写出去了，这里不能再 writeHead，否则 ERR_HTTP_HEADERS_SENT 带崩进程
        if (!res.headersSent) return json(res, 400, { error: e.message });
        console.error('[导出失败]', e);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

// 兜底：异步回调里逃逸的异常（上面 try/catch 覆盖不到的地方）不该静默杀进程
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`命理顾问 MVP 已启动: http://127.0.0.1:${PORT}`);
});
