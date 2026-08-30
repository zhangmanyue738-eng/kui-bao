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

// 领域 → 加权检索词
const DOMAIN_TERMS = {
  career: ['官禄', '事业', '官星', '化权', '命宫', '三方', '杀破狼', '机月同梁', '格局'],
  wealth: ['财帛', '财星', '财', '田宅', '化禄', '禄存', '富'],
  marriage: ['夫妻', '婚姻', '配偶', '早婚', '迟婚', '破军', '武曲', '桃花'],
  health: ['疾厄', '疾病', '健康', '体质', '五行'],
  annual: ['大限', '流年', '四化', '化忌', '化禄', '行限'],
};

// 十神 → 概念词（扩检）
const TEN_GOD_EXPAND = {
  正官: ['官星', '官禄'], 七杀: ['七杀', '杀'], 正财: ['财星', '财'], 偏财: ['财星', '财'],
  正印: ['印'], 偏印: ['印'], 比肩: ['比劫'], 劫财: ['比劫'], 食神: ['食伤'], 伤官: ['食伤'],
};

/** 从 slimChart 提取检索词 */
function extractQueryTerms(chart, domains) {
  const terms = new Set();
  const b = chart.bazi;
  // 四柱天干地支、日主
  for (const p of Object.values(b.pillars)) if (p) for (const ch of p) terms.add(ch);
  terms.add(b.dayMaster.gan); terms.add(b.dayMaster.wuxing);
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
    const palaces = zw.palaces || Object.values(zw.keyPalaces || {}).filter(Boolean);
    for (const p of palaces) {
      if (p.name) terms.add(p.name);
      for (const s of (p.majorStars || [])) {
        terms.add(s.name);
        if (s.siHua) terms.add('化' + s.siHua);
      }
      for (const s of (p.minorStars || [])) terms.add(s.name);
    }
    for (const k of ['soul', 'body', 'fiveElementsClass']) if (zw[k]) terms.add(zw[k]);
  }
  // 领域词
  for (const d of domains) for (const t of (DOMAIN_TERMS[d] || [])) terms.add(t);
  return [...terms].filter(t => t && t.length >= 1);
}

/**
 * 检索：返回 top-k 条文 { id, source, text }
 * 打分 = 词条命中数 + 领域词加权 + 古籍微弱优先
 */
function retrieve(chart, domains, k = 10) {
  const kb = loadKB();
  const terms = extractQueryTerms(chart, domains);
  const domainTerms = new Set(domains.flatMap(d => DOMAIN_TERMS[d] || []));
  const scored = kb.map(e => {
    let score = 0;
    for (const t of terms) {
      if (!t) continue;
      let idx = 0, hits = 0;
      while ((idx = e.text.indexOf(t, idx)) !== -1) { hits++; idx += t.length; if (hits > 5) break; }
      score += hits;
    }
    for (const t of domainTerms) if (e.text.includes(t)) score += 2;
    if (e.source.startsWith('《')) score += 0.5; // 古籍优先
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  const seen = new Set();
  for (const { e, score } of scored) {
    if (score <= 0 || picked.length >= k) break;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    picked.push(e);
  }
  return picked;
}

module.exports = { retrieve, loadKB };
