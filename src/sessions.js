/**
 * sessions.js — 本地会话归档与检索
 *
 * 为什么存在：本项目的价值最终要靠「真实反馈回校」来兑现——
 * 某句话说准了、某句离谱了、用户后来补充了真实人生事实，这些只有归档下来才能复盘。
 * 没有检索能力的归档等于没归档：攒了一堆 badcase 却找不出来，等于白攒。
 *
 * 存储选型：**JSONL + 内存索引**，不用 sqlite。理由：
 *   1. 项目已有 kb.jsonl / feedback.jsonl，同一范式，不引入第二种存储心智
 *   2. 零依赖（node:sqlite 虽可用但每次启动抛 ExperimentalWarning，且 API 仍标实验性）
 *   3. 自用规模（千级会话、约 20MB）内存扫描足够快，SQL 的收益体现不出来
 *   4. 数据可直接 grep / git diff / 文本编辑器修复，出问题时可救
 *
 * 文件格式：data/sessions.jsonl，一行一条，字段见 buildRecord()
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'sessions.jsonl');
const TMP = FILE + '.tmp';

// 允许 PATCH 的字段白名单——避免把排盘结果、报告正文这些事实性内容改坏
const EDITABLE = ['note', 'rating', 'comment', 'facts'];

// 进程内串行锁：update/delete 是「读全量→改→整体重写」，并发会互相覆盖
let writing = false;
const queue = [];
function withLock(fn) {
  if (!writing) {
    writing = true;
    try { return fn(); } finally {
      writing = false;
      while (queue.length) queue.shift()();
    }
  }
  return new Promise(resolve => queue.push(() => resolve(withLock(fn))));
}

// =====================================================================
// 读写
// =====================================================================

/** 读取全部记录；坏行不丢弃，随 bad 数组返回（静默吞掉坏数据是最坏的结果） */
function readAll() {
  if (!fs.existsSync(FILE)) return { records: [], bad: [] };
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(l => l.trim());
  const records = [], bad = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const o = JSON.parse(lines[i]);
      if (o && o.id) records.push(o);
      else bad.push({ line: i + 1, reason: '无 id 字段' });
    } catch (e) {
      bad.push({ line: i + 1, reason: e.message.slice(0, 80) });
    }
  }
  return { records, bad };
}

/** 原子写：先写临时文件再 rename，避免写到一半崩掉留下半个文件 */
function writeAll(records) {
  const body = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(TMP, body, 'utf8');
  fs.renameSync(TMP, FILE);
}

function append(record) {
  fs.appendFileSync(FILE, JSON.stringify(record) + '\n', 'utf8');
}

function newId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `S${stamp}-${rand}`;
}

// =====================================================================
// 索引：把检索要用的字段在入库时抽平，避免每次查询都重算排盘
// =====================================================================
function buildIndex(chart, synthesis) {
  const b = chart && chart.bazi;
  const z = chart && chart.ziwei;
  return {
    dayMaster: b ? b.dayMaster.gan : null,
    dayMasterWx: b ? b.dayMaster.wuxing : null,
    pillars: b ? b.pillars : null,
    hourMissing: b ? !!b.hourPillarMissing : null,
    mingStar: z && !z.skipped ? (z.soul || null) : null,
    body: z && !z.skipped ? (z.body || null) : null,
    fiveElementsClass: z && !z.skipped ? (z.fiveElementsClass || null) : null,
    ziweiSkipped: !!(z && z.skipped),
    // 领域结论摘要：复盘时最常按「哪个领域说了什么、给的可信度对不对」来找
    domains: (synthesis && synthesis.results || []).map(r => ({
      domain: r.domain, direction: r.direction, verdict: r.verdict, confidence: r.confidence,
    })),
  };
}

/**
 * 归档一次解读
 * @param payload { input, chart, synthesis, report, model, usage, rag, degraded, passages, preflightWarnings }
 * @returns 完整记录
 */
function saveSession(payload = {}) {
  const { input = {}, chart = {}, synthesis = null, report = '', model = '', usage = null,
    rag = false, degraded = false, passages = [], preflightWarnings = [] } = payload;
  const record = {
    id: newId(),
    ts: new Date().toISOString(),
    input: {
      dateStr: input.dateStr ?? null, hour: input.hour ?? null,
      gender: input.gender ?? null, city: input.city ?? null,
      domains: input.domains || [], rectified: !!input.rectified,
    },
    sect: (chart.meta && chart.meta.sect) || null,
    sectStamp: chart.meta ? chart.meta.sectStamp : null,
    trueSolar: (chart.meta && chart.meta.trueSolar) || null,
    preflightWarnings,
    index: buildIndex(chart, synthesis),
    // 完整排盘 JSON 也存下来：复盘时能直接看当时的盘，不必重排（口径可能已变）
    chart,
    // 互证合成结论也存：不存的话打开历史档案就没有「双术一致/单术/冲突」那段，
    // 而那段正是判断这份 badcase 值不值得改规则的依据。
    synthesis,
    report,
    meta: { model, usage, rag, degraded, passages },
    note: '',
    rating: null,      // 'good' | 'bad' | null
    comment: '',       // 反馈文字
    facts: '',         // 用户补充的真实人生事实（校正取证的关键数据）
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  append(record);
  return record;
}

// =====================================================================
// 检索
// =====================================================================

/** 一条记录的可检索文本（全文搜索用） */
function searchableText(r) {
  const parts = [
    r.note, r.comment, r.facts, r.sectStamp,
    r.input && r.input.city,
    r.index && r.index.pillars && Object.values(r.index.pillars).join(' '),
    r.index && r.index.dayMaster,
    r.index && r.index.mingStar,
    r.report,
  ];
  return parts.filter(Boolean).join('\n').toLowerCase();
}

function inRange(ts, from, to) {
  if (!ts) return false;
  if (from && ts < from) return false;
  if (to && ts > to) return false;
  return true;
}

/**
 * 列表 + 检索
 * @param filter { q, rating, dayMaster, mingStar, from, to, limit, offset }
 *   q 全文（备注/反馈/事实/城市/四柱/命宫主星/报告正文）
 *   from/to ISO 日期或日期时间字符串
 * @returns { total, items, bad }
 *   items 是不含 report 正文与完整 chart 的摘要（列表页不需要，省流量）
 */
function listSessions(filter = {}) {
  const { q, rating, dayMaster, mingStar, from, to } = filter;
  const limit = Math.min(Number(filter.limit) || 50, 500);
  const offset = Number(filter.offset) || 0;
  const { records, bad } = readAll();

  // 新的在前
  let hits = records.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  if (q) {
    const needle = String(q).trim().toLowerCase();
    hits = hits.filter(r => searchableText(r).includes(needle));
  }
  if (rating) hits = hits.filter(r => r.rating === rating);
  if (dayMaster) hits = hits.filter(r => r.index && r.index.dayMaster === dayMaster);
  if (mingStar) hits = hits.filter(r => r.index && r.index.mingStar === mingStar);
  if (from || to) hits = hits.filter(r => inRange(r.ts, from, to));

  const total = hits.length;
  const items = hits.slice(offset, offset + limit).map(slim);
  return { total, items, bad };
}

/** 列表摘要：去掉大字段（report 正文、完整 chart） */
function slim(r) {
  return {
    id: r.id, ts: r.ts,
    input: r.input, sectStamp: r.sectStamp,
    index: r.index,
    note: r.note, rating: r.rating, facts: r.facts, hasChart: !!r.chart,
    model: r.meta && r.meta.model,
    degraded: r.meta && r.meta.degraded,
    reportLen: (r.report || '').length,
    preview: (r.report || '').replace(/\s+/g, ' ').slice(0, 100),
  };
}

function getSession(id) {
  const { records } = readAll();
  return records.find(r => r.id === id) || null;
}

/**
 * 更新白名单字段
 * @returns 更新后的记录；id 不存在返回 null
 */
function updateSession(id, patch = {}) {
  return withLock(() => {
    const { records } = readAll();
    const i = records.findIndex(r => r.id === id);
    if (i < 0) return null;
    for (const k of EDITABLE) {
      if (patch[k] !== undefined) records[i][k] = patch[k];
    }
    if (patch.rating !== undefined) records[i].ratedAt = new Date().toISOString();
    writeAll(records);
    return records[i];
  });
}

function removeSession(id) {
  return withLock(() => {
    const { records } = readAll();
    const next = records.filter(r => r.id !== id);
    if (next.length === records.length) return false;
    writeAll(next);
    return true;
  });
}

/** 归档概览（前端面板顶部的小结 + doctor 体检用） */
function stats() {
  const { records, bad } = readAll();
  const byRating = { good: 0, bad: 0, unrated: 0 };
  for (const r of records) {
    if (r.rating === 'good') byRating.good++;
    else if (r.rating === 'bad') byRating.bad++;
    else byRating.unrated++;
  }
  let bytes = 0;
  try { bytes = fs.statSync(FILE).size; } catch { /* 文件不存在 */ }
  return {
    total: records.length,
    badLines: bad.length,
    byRating,
    // 「有真实事实反馈」的条数——这才是能真正拿来校正规则的样本量
    withFacts: records.filter(r => (r.facts || '').trim()).length,
    bytes,
    newest: records.length ? records[records.length - 1].ts : null,
    oldest: records.length ? records[0].ts : null,
  };
}

module.exports = {
  saveSession, listSessions, getSession, updateSession, removeSession, stats,
  readAll, buildIndex, searchableText, FILE, EDITABLE,
};

// ---------- CLI 自测 ----------
if (require.main === module) {
  const { buildChart } = require('./chart.js');
  const { synthesize } = require('./synthesize.js');

  console.log('── 会话归档自测\n');
  const before = stats();
  console.log(`   当前归档：${before.total} 条（good ${before.byRating.good} / bad ${before.byRating.bad} / 未评 ${before.byRating.unrated}）`);

  // 造两条真实盘（走完整排盘 + 合成，不走 LLM——归档层不该依赖网络）
  const mk = (dateStr, hour, gender, city) => {
    const chart = buildChart({ dateStr, hour, gender, city });
    const synthesis = synthesize(chart, ['career', 'wealth', 'marriage']);
    return saveSession({
      input: { dateStr, hour, gender, city, domains: ['career', 'wealth', 'marriage'] },
      chart, synthesis,
      report: `【测试报告】${city}${dateStr} ${hour}时 · 日主${chart.bazi.dayMaster.gan}`,
      model: 'test-model', usage: { total_tokens: 1 }, rag: false, degraded: false,
      passages: [], preflightWarnings: [],
    });
  };
  const a = mk('2000-8-16', 14, '男', '深圳');
  const b = mk('1995-6-15', null, '女', '杭州');
  console.log(`   写入 2 条：${a.id} / ${b.id}`);

  // 索引是否抽对
  console.log(`\n── 索引抽取`);
  console.log(`   A: 日主=${a.index.dayMaster}(${a.index.dayMasterWx}) 命宫主星=${a.index.mingStar} 四柱=${JSON.stringify(a.index.pillars)}`);
  console.log(`   B: 日主=${b.index.dayMaster} 时辰未知=${b.index.hourMissing} 紫微跳过=${b.index.ziweiSkipped}`);
  console.log(`   领域摘要 A: ${a.index.domains.map(d => `${d.domain}:${d.direction}/${d.confidence}`).join(' ')}`);

  // 检索
  console.log(`\n── 检索`);
  const r1 = listSessions({ q: '深圳' });
  console.log(`   全文"深圳" → ${r1.total} 条`);
  const r2 = listSessions({ dayMaster: a.index.dayMaster });
  console.log(`   日主=${a.index.dayMaster} → ${r2.total} 条`);
  const r3 = listSessions({ mingStar: a.index.mingStar });
  console.log(`   命宫主星=${a.index.mingStar} → ${r3.total} 条`);

  // 更新（含白名单校验）
  console.log(`\n── 更新与白名单`);
  updateSession(a.id, { rating: 'good', note: '张某某 · 初测', facts: '2019 年确实转行' });
  const a2 = getSession(a.id);
  console.log(`   rating=${a2.rating} note="${a2.note}" ratedAt=${a2.ratedAt ? '已记录' : '缺失'}`);
  updateSession(a.id, { report: '试图篡改报告正文' });
  const a3 = getSession(a.id);
  console.log(`   白名单外字段是否被挡：${a3.report === a2.report ? '✓ 已挡住' : '✗ 被改了'}`);

  // 统计
  const s2 = stats();
  console.log(`\n── 统计`);
  console.log(`   total=${s2.total} withFacts=${s2.withFacts} badLines=${s2.badLines} bytes=${s2.bytes}`);

  // 清理测试数据
  const removedA = removeSession(a.id), removedB = removeSession(b.id);
  console.log(`\n── 清理：删除 A=${removedA} B=${removedB}，剩余 ${stats().total} 条（应回到 ${before.total}）`);
}
