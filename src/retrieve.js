/**
 * retrieve.js — 知识库检索（关键词打分版，MVP 无 embedding）
 * 检索策略：排盘特征（星曜/宫位/十神/五行）作 query 词，领域词加权，古籍优先。
 */
const fs = require('fs');
const path = require('path');

const KB_PATH = path.join(__dirname, '..', 'data', 'kb.jsonl');
let KB = null;

function loadKB() {
  if (KB) return KB;
  KB = fs.readFileSync(KB_PATH, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return KB;
}

// 领域 → 加权检索词（八字侧与紫微侧并重）
const DOMAIN_TERMS = {
  career: ['官禄', '事业', '官星', '化权', '命宫', '三方', '杀破狼', '机月同梁', '格局',
    '正官', '七杀', '食伤', '印', '用神', '身强', '身弱', '仕途'],
  wealth: ['财帛', '财星', '财', '田宅', '化禄', '禄存', '富',
    '正财', '偏财', '比劫', '夺财', '资产'],
  marriage: ['夫妻', '婚姻', '配偶', '早婚', '迟婚', '破军', '武曲', '桃花',
    '日支', '夫妻宫', '财官', '六亲'],
  health: ['疾厄', '疾病', '健康', '体质', '五行', '偏枯', '调候', '寒暖'],
  annual: ['大限', '流年', '四化', '化忌', '化禄', '行限', '太岁', '大运', '小运', '岁运'],
};

// 十神 → 概念词（扩检）
const TEN_GOD_EXPAND = {
  正官: ['官星', '官禄'], 七杀: ['七杀', '杀'], 正财: ['财星', '财'], 偏财: ['财星', '财'],
  正印: ['印'], 偏印: ['印'], 比肩: ['比劫'], 劫财: ['比劫'], 食神: ['食伤'], 伤官: ['食伤'],
};

/**
 * 取星曜名：兼容 {name} 对象与 "天府[庙](禄)" 字符串两种形态。
 *
 * 踩过的坑：slimChart 为省 token 把星曜压成字符串（带庙旺/四化后缀），
 * 而这里原本按 s.name 取 —— 字符串没有 .name，于是紫微侧 44 个检索词静默归零，
 * 只剩命主/身主/五行局 3 个词在撑，直接表现为 RAG 降级与紫微侧检索质量低。
 * 不报错、不掉异常，只有把词打出来才看得见。
 */
function starName(s) {
  if (!s) return null;
  if (typeof s === 'string') {
    return s.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim() || null;
  }
  return s.name || null;
}

/** 取四化：对象读 siHua 字段，字符串从 "(禄)" 里剥 */
function starSiHua(s) {
  if (!s) return null;
  if (typeof s === 'string') {
    const m = s.match(/\(([^)]+)\)/);
    return m ? m[1] : null;
  }
  return s.siHua || null;
}

/** 从 slimChart 提取检索词 */
function extractQueryTerms(chart, domains) {
  const terms = new Set();
  const b = chart.bazi;
  // 八字天干（年/日/时干，用于流年断语、六亲等条目匹配）
  terms.add(b.dayMaster.gan); terms.add(b.dayMaster.wuxing);
  if (b.pillars.year) terms.add(b.pillars.year[0]);
  if (b.pillars.hour) terms.add(b.pillars.hour[0]);
  // 调候组合词：日干 + 月令（精确命中《穷通宝鉴》「X日干生于Y月」条目）
  if (b.pillars.month) {
    const monthZhi = b.pillars.month[1];
    terms.add(b.dayMaster.gan + '日干');
    terms.add(b.dayMaster.gan + '日干生于' + monthZhi + '月'); // 整句匹配，避免跨日干误命中
  }
  // 日支（夫妻宫位，婚姻领域相关）
  if (b.pillars.day) terms.add(b.pillars.day[1]);
  // 十神 → 概念
  const tenGods = Object.values(b.tenGods || {}).flat();
  for (const tg of tenGods) for (const w of (TEN_GOD_EXPAND[tg] || [])) terms.add(w);
  // 五行偏枯
  for (const [wx, n] of Object.entries(b.fiveElementsCount || {})) {
    if (n === 0 || n >= 4) terms.add(wx);
  }
  // 紫微星曜与宫位（兼容完整 chart 与 slimChart 两种结构）
  const zw = chart.ziwei;
  if (zw && !zw.skipped) {
    // slimChart 里 keyPalaces 用 palace 键、星曜是字符串（"天府[庙](禄)"）；
    // 完整 chart 里用 name 键、星曜是对象 {name, siHua}。两种形态都要能吃。
    const palaces = zw.palaces || Object.values(zw.keyPalaces || {}).filter(Boolean);
    for (const p of palaces) {
      const pname = p.name || p.palace;
      if (pname) terms.add(pname);
      for (const s of (p.majorStars || [])) {
        const n = starName(s);
        if (n) terms.add(n);
        const si = starSiHua(s);
        if (si) terms.add('化' + si);
      }
      for (const s of (p.minorStars || [])) {
        const n = starName(s);
        if (n) terms.add(n);
      }
    }
    // 用语义化字段名；命主/身主同样是可检索的盘面特征（KB 里有按星曜立论的条文）
    for (const k of ['mingZhu', 'shenZhu', 'fiveElementsClass']) if (zw[k]) terms.add(zw[k]);
  }
  // 领域词单独返回：只作轻度加权，不能淹没盘面特征
  const domainTerms = new Set();
  for (const d of domains) for (const t of (DOMAIN_TERMS[d] || [])) domainTerms.add(t);
  const featureTerms = [...terms].filter(t => t && t.length >= 1 && !domainTerms.has(t));
  return { featureTerms, domainTerms: [...domainTerms] };
}

/**
 * 检索：返回 top-k 条文 { id, source, tradition, license, text }
 * 打分 = 词条命中数 + 领域词加权 + 古籍微弱优先
 * @param {object} opts.publicOnly - true 时只返回公版古籍条目（对外发布模式）
 */
function retrieve(chart, domains, k = 10, opts = {}) {
  const kb = loadKB();
  let pool = opts.publicOnly ? kb.filter(e => e.license === 'public_domain') : kb;
  if (opts.tradition) pool = pool.filter(e => e.tradition === opts.tradition);
  const { featureTerms, domainTerms } = extractQueryTerms(chart, domains);
  const scored = pool.map(e => {
    let score = 0;
    // 盘面特征词（星曜/十神/宫位/日干月令）：主要信号，逐次命中累加
    // 按词长加权：单字（如"辛""申"）噪声大 → 低权重；组合词（如"辛日干生于戌月"）→ 高权重
    const weight = t => (t.length >= 4 ? 3 : t.length === 2 ? 1 : t.length === 3 ? 1.5 : 0.2);
    for (const t of featureTerms) {
      let idx = 0, hits = 0;
      while ((idx = e.text.indexOf(t, idx)) !== -1) { hits++; idx += t.length; if (hits > 5) break; }
      score += hits * weight(t);
    }
    // 领域词：仅轻度加权并封顶（避免不同命盘检索结果雷同）
    let dHits = 0;
    for (const t of domainTerms) if (e.text.includes(t)) dHits++;
    score += Math.min(dHits, 3) * 0.5;
    if (e.license === 'public_domain') score += 1.5; // 古籍优先（公版原文优先于现代整理）
    // 按长度归一化：避免长文本靠堆词取胜（古籍原文通常短而精）
    const density = score / Math.sqrt(Math.max(e.text.length, 60) / 200);
    return { e, score: density };
  });
  scored.sort((a, b) => b.score - a.score);
  const taken = [];
  const seen = new Set();
  const srcCount = {};
  const MAX_PER_SRC = 2; // 同一出处最多取 2 条，保证条文多样性
  for (const { e, score } of scored) {
    if (score <= 0 || taken.length >= k) break;
    if (seen.has(e.id)) continue;
    // 出处归并键：书名 + 主题（如「穷通宝鉴·调候」「渊海子平·格局」）
    const key = e.source.replace(/[·》].*$/, '') + '|' + (e.source.match(/调候|格局|断语|断法|十二宫|四化|星论/) || [''])[0];
    if ((srcCount[key] || 0) >= MAX_PER_SRC) continue;
    srcCount[key] = (srcCount[key] || 0) + 1;
    seen.add(e.id);
    taken.push(e);
  }
  return taken;
}

/**
 * 双术配额检索：保证八字与紫微两侧都有条文进入 prompt
 * （纯打分检索会被条目数多的一侧淹没，违背「双术互证」本意）
 */
function retrieveBalanced(chart, domains, k = 10, opts = {}) {
  const hasZiwei = chart.ziwei && !chart.ziwei.skipped;
  if (!hasZiwei) return retrieve(chart, domains, k, { ...opts, tradition: 'bazi' });
  const half = Math.ceil(k / 2);
  const bazi = retrieve(chart, domains, half, { ...opts, tradition: 'bazi' });
  const ziwei = retrieve(chart, domains, k - half, { ...opts, tradition: 'ziwei' });
  return [...bazi, ...ziwei];
}

// 导出 extractQueryTerms 供回归脚本直连真实逻辑校验：
// 复刻一份逻辑去测等于没测 —— 星曜词归零就是这么藏过去的。
module.exports = { retrieve, retrieveBalanced, loadKB, extractQueryTerms };
