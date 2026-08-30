/**
 * rectify.js — 定盘（出生时辰校准）
 *
 * 原理：时辰对紫微盘是全局性的（命宫 = 寅起正月顺数生月、逆数生时），
 * 时辰一变十二宫整体重排，大限流年随之全变；八字侧只多换一个时柱，区分度低。
 * 因此以紫微为主要区分依据，八字作辅助。
 *
 * 流程：
 *   1. 生成候选时辰（full: 12 个；refine: 给定时辰 ± 邻时辰）
 *   2. 对每个候选，预计算过去 N 年 × 6 个主题维度的「事件活跃度」
 *   3. 选题：挑信息增益最大（能把候选劈得最均匀）的「年份 + 主题」提问
 *   4. 回答后贝叶斯更新后验；收敛（最大后验 ≥ 阈值）或问满上限即停
 *
 * 诚实边界：这只是概率收敛，不是百分百确定。似然参数为经验初值，
 * 需用真实反馈数据校准（见 docs/rectification-notes.md）。
 */
const { astro } = require('iztro');
const { Solar } = require('lunar-javascript');

// ───────── 主题维度 → 紫微宫位 ─────────
const DIM_PALACE = {
  career: '官禄',
  relationship: '夫妻',
  wealth: '财帛',
  home: '田宅',
  education: '父母',
  health: '疾厄',
};
// 十二宫 → 人生主题（用于大限定盘题，区分度最高的提问方式）
const PALACE_TOPIC = {
  命宫: { key: 'self', label: '自身的整体转折（身份、方向、重大决定）' },
  兄弟: { key: 'sibling', label: '同辈、合伙或朋友关系' },
  夫妻: { key: 'relationship', label: '感情与婚姻' },
  子女: { key: 'children', label: '子女、晚辈，或自己投入创作的事' },
  财帛: { key: 'wealth', label: '收入与财务' },
  疾厄: { key: 'health', label: '健康或身体状态' },
  迁移: { key: 'move', label: '外出、迁居、环境变动' },
  仆役: { key: 'social', label: '人际关系、同事下属' },
  官禄: { key: 'career', label: '事业与工作' },
  田宅: { key: 'home', label: '家庭、家宅、房产' },
  福德: { key: 'spirit', label: '内心状态、兴趣、精神追求' },
  父母: { key: 'parent', label: '长辈、学业、文书资质' },
};
const DIM_TEXT = {
  career: '事业或工作方向上有过一次比较明显的变动（换工作、转行、职责大变、创业）',
  relationship: '感情或婚姻关系上有过重要变化（确定关系、结婚、分手、长期异地）',
  wealth: '财务状况有过明显起伏（大额收入或支出、投资、明显的财务压力）',
  home: '家里或居住环境有过变动（搬家、装修、购房、家中有大事）',
  education: '学业、进修、考证或文书资质上有重要节点，或长辈健康有变故',
  health: '你自己或家人的健康方面出现过需要留意的情况',
};
const DIM_LABEL = { career: '事业', relationship: '感情', wealth: '财务', home: '家宅', education: '学业/长辈', health: '健康' };

// ───────── 可调参数（需用真实反馈校准） ─────────
const PARAMS = {
  likelihoodHit: 0.72,      // 候选预测「有」且用户答「有」的似然
  likelihoodMiss: 0.28,     // 预测与回答不一致时的似然
  unsureLikelihood: 0.5,    // 「记不清」：不提供信息
  activeThreshold: 0.5,     // 活跃度 ≥ 此值判为「该年该主题有事件」
  // 大限主题题（12 选 1）：命中基线仅 1/12，故命中/未命中的似然差距要大
  likelihoodTopicHit: 0.50,
  likelihoodTopicMiss: 0.045, // (1 - 0.50) / 11
  stopPosterior: 0.55,      // 最大后验 ≥ 此值即收敛
  maxQuestions: 5,
  minAge: 14,               // 只问 14 岁以后（太小无自主事件记忆）
  weight: {                  // 活跃度构成
    decadal: 0.35,          // 大限走到该宫（十年当令）
    yearly: 0.45,           // 流年宫 = 该宫（当年直接引动，最强）
    mutagenLu: 0.30,        // 流年化禄/权落该宫
    mutagenJi: 0.35,        // 流年化忌落该宫（忌主变动/阻滞）
    yearlySha: 0.20,        // 流年煞曜落该宫
  },
};

const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
/** 时辰序号(0=子) → 代表小时 */
const TIME_INDEX_TO_HOUR = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
const HOUR_TO_TIME_INDEX = h => (h === 23 ? 12 : h === 0 ? 0 : Math.floor((h + 1) / 2));

/** 某盘在某年的各主题活跃度 */
function yearProfile(astrolabe) {
  const profile = {};
  for (const dim of Object.keys(DIM_PALACE)) profile[dim] = 0;
  return profile;
}

function buildProfileForYear(astrolabe, year, starPalaceMap) {
  const h = astrolabe.horoscope(`${year}-06-01`);
  const daXianPalace = h.decadal.palaceNames[h.decadal.index];
  const liuNianPalace = h.yearly.palaceNames[h.yearly.index];
  // 流年四化落宫（通过本命星所在宫查得）
  const mutagenPalaces = { lu: [], quan: [], ke: [], ji: [] };
  for (const starName of (h.yearly.mutagen || [])) {
    const p = starPalaceMap[starName];
    if (!p) continue;
    const idx = (h.yearly.mutagen || []).indexOf(starName);
    const siHua = ['禄', '权', '科', '忌'][idx];
    if (siHua === '禄') mutagenPalaces.lu.push(p);
    else if (siHua === '权') mutagenPalaces.quan.push(p);
    else if (siHua === '科') mutagenPalaces.ke.push(p);
    else if (siHua === '忌') mutagenPalaces.ji.push(p);
  }
  // 流年煞曜落宫
  const shaPalaces = [];
  h.yearly.stars.forEach((stars, i) => {
    for (const s of stars) if (s.type === 'tough') shaPalaces.push(h.yearly.palaceNames[i]);
  });

  const w = PARAMS.weight;
  const profile = {};
  for (const [dim, palace] of Object.entries(DIM_PALACE)) {
    let score = 0;
    if (daXianPalace === palace) score += w.decadal;
    if (liuNianPalace === palace) score += w.yearly;
    score += mutagenPalaces.lu.filter(p => p === palace).length * w.mutagenLu;
    score += mutagenPalaces.quan.filter(p => p === palace).length * w.mutagenLu;
    score += mutagenPalaces.ji.filter(p => p === palace).length * w.mutagenJi;
    score += shaPalaces.filter(p => p === palace).length * w.yearlySha;
    profile[dim] = Math.min(1, +score.toFixed(3));
  }
  return profile;
}

/** 本命星名 → 宫位 */
function starPalaceMapOf(astrolabe) {
  const map = {};
  for (const p of astrolabe.palaces) {
    for (const s of [...p.majorStars, ...p.minorStars]) map[s.name] = p.name;
  }
  return map;
}

/** 为一个时辰候选项生成多年 profile */
/**
 * 大限宫序列：命宫由时辰决定，不同时辰的大限顺序完全不同 —— 定盘最强的区分器
 * 返回 [{ startAge, endAge, startYear, endYear, palace, topicKey, topicLabel }]
 */
function decadalTimeline(astrolabe, birthYear) {
  const spanMap = { 水二局: 2, 木三局: 3, 金四局: 4, 土五局: 5, 火六局: 6 };
  const span = spanMap[astrolabe.fiveElementsClass] || 5;
  const mingIdx = astrolabe.palaces.findIndex(p => p.name === '命宫');
  const out = [];
  for (let i = 0; i < 12; i++) {
    const palace = astrolabe.palaces[(mingIdx + i) % 12].name;
    const startAge = i * span;
    const endAge = startAge + span - 1;
    const t = PALACE_TOPIC[palace] || { key: palace, label: palace };
    out.push({
      startAge, endAge, startYear: birthYear + startAge, endYear: birthYear + endAge,
      palace, topicKey: t.key, topicLabel: t.label,
    });
  }
  return out;
}

/** 某候选在指定年龄所处的大限段（超过一轮后循环） */
function decadalAtAge(candidate, age) {
  const spanMap = { 水二局: 2, 木三局: 3, 金四局: 4, 土五局: 5, 火六局: 6 };
  const span = spanMap[candidate.astrolabe.fiveElementsClass] || 5;
  const total = 12 * span;
  const seg = Math.floor(((age % total) + total) % total / span);
  return candidate.decadal[seg] || candidate.decadal[0];
}

function candidateProfiles(dateStr, timeIndex, gender, years) {
  const a = astro.bySolar(dateStr, timeIndex, gender, true, 'zh-CN');
  const map = starPalaceMapOf(a);
  const profiles = {};
  for (const y of years) profiles[y] = buildProfileForYear(a, y, map);
  return {
    timeIndex, hour: TIME_INDEX_TO_HOUR[timeIndex] ?? 23, astrolabe: a, profiles,
    decadal: decadalTimeline(a, Number(dateStr.split('-')[0])),
  };
}

/**
 * 创建定盘会话
 * @param {object} opt { dateStr, gender, city, knownHour, mode }
 *   mode='full'   —— 时辰完全未知（12 候选）
 *   mode='refine' —— 已知大致时辰，做微调校准（取 ±1 时辰共 3 候选）
 */
function createSession({ dateStr, gender = '男', city, knownHour = null, mode = 'full' }) {
  const birthYear = Number(dateStr.split('-')[0]);
  const thisYear = new Date().getFullYear();
  const startYear = Math.max(birthYear + PARAMS.minAge, thisYear - 45); // 最多回溯 45 年
  const years = [];
  for (let y = startYear; y <= thisYear; y++) years.push(y);

  let timeIndexes;
  if (mode === 'refine' && knownHour != null) {
    const base = HOUR_TO_TIME_INDEX(knownHour);
    timeIndexes = [base - 1, base, base + 1].map(i => ((i % 12) + 12) % 12);
    timeIndexes = [...new Set(timeIndexes)];
  } else {
    timeIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    // 晚子时(23-24点)与早子时(0-1点)在紫微同盘，合并为 12 个候选即可
  }

  const candidates = timeIndexes.map(ti => {
    const c = candidateProfiles(dateStr, ti, gender, years);
    c.posterior = 1 / timeIndexes.length;
    return c;
  });

  return {
    dateStr, gender, city, mode, knownHour, years, candidates,
    asked: [], history: [], done: false, result: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 选题：信息增益最大（候选集合中「预测为有」的比例最接近 0.5）
 */
function nextQuestion(session) {
  if (session.done) return null;
  if (session.asked.length >= PARAMS.maxQuestions) return null;
  const active = session.candidates.filter(c => c.posterior > 0.01);
  if (active.length <= 1) return null;

  let best = null;

  // ── 题型 A：年龄段主题（区分度最高，优先问）
  //    关键：不能按「第几段大限」问（各时辰的宫名序列相同），
  //    必须按「某几岁」问 —— 五行局不同导致步长不同，同一年龄各时辰走的是不同的宫
  const thisYear = new Date().getFullYear();
  const nowAge = thisYear - Number(session.dateStr.split('-')[0]);
  const minAskAge = Math.max(PARAMS.minAge, nowAge - 40);
  for (let ageStart = minAskAge; ageStart + 4 <= nowAge; ageStart += 5) {
    const ageEnd = ageStart + 4;
    const key = `decadal:${ageStart}-${ageEnd}`;
    if (session.asked.some(q => q.key === key)) continue;
    const probeAge = ageStart + 2; // 取区间中点
    const dist = {};
    for (const c of active) {
      const t = decadalAtAge(c, probeAge).topicKey;
      dist[t] = (dist[t] || 0) + c.posterior;
    }
    const H = -Object.values(dist).reduce((s, p) => s + p * Math.log2(p), 0);
    const maxH = Math.log2(Object.keys(dist).length || 1);
    const gain = maxH > 0 ? H / maxH : 0;
    if (!best || gain > best.gain) {
      best = {
        type: 'decadal', key, ageStart, ageEnd, probeAge, gain,
        options: Object.entries(dist).map(([k, v]) => ({ key: k, posterior: +v.toFixed(3) })),
        predictedByCandidate: active.map(c => ({ hour: c.hour, topic: decadalAtAge(c, probeAge).topicKey })),
      };
    }
  }

  // ── 题型 B：流年强信号（大限题问完或区分度不足时补充）
  for (const year of session.years) {
    for (const dim of Object.keys(DIM_PALACE)) {
      const key = `${year}:${dim}`;
      if (session.asked.some(q => q.key === key)) continue;
      let pYes = 0, total = 0;
      for (const c of active) {
        if ((c.profiles[year]?.[dim] ?? 0) >= PARAMS.activeThreshold) pYes += c.posterior;
        total += c.posterior;
      }
      const p = total ? pYes / total : 0;
      // 信息增益 ∝ 熵本身：候选预测越分裂（p→0.5）问了越有用；
      // 所有候选预测一致时（p=0 或 1）熵为 0 → 问了毫无信息，不得选
      const H = p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
      const gain = H * 0.6; // 大限题优先：流年题增益打折
      if (!best || gain > best.gain) {
        best = { type: 'yearly', key, year, dim, gain, pYes: +p.toFixed(3), split: { yes: +p.toFixed(2), no: +(1 - p).toFixed(2) } };
      }
    }
  }

  if (!best || best.gain < 0.05) return null;
  if (best.type === 'decadal') {
    const birthYear = Number(session.dateStr.split('-')[0]);
    best.text = `你 ${best.ageStart}–${best.ageEnd} 岁（约 ${birthYear + best.ageStart}–${birthYear + best.ageEnd} 年）这段时期，生活重心或主要经历集中在哪个方面？`;
    best.topicOptions = Object.values(PALACE_TOPIC).map(t => ({ key: t.key, label: t.label }));
  } else {
    best.text = `${best.year} 年前后，你在${DIM_TEXT[best.dim]}吗？`;
    best.dimLabel = DIM_LABEL[best.dim];
  }
  return best;
}

/**
 * 回答并贝叶斯更新
 * @param {'yes'|'no'|'unsure'} answer
 */
function answerQuestion(session, question, answer) {
  const { likelihoodHit: hit, likelihoodMiss: miss, unsureLikelihood: uns } = PARAMS;
  let norm = 0;
  for (const c of session.candidates) {
    let like;
    if (question.type === 'decadal') {
      // 12 选 1：命中本就只有 1/12，故命中给很强的提升，未命中严厉惩罚
      const predictedKey = decadalAtAge(c, question.probeAge).topicKey;
      if (answer === 'unsure') like = uns;
      else if (answer === predictedKey) like = PARAMS.likelihoodTopicHit;
      else like = PARAMS.likelihoodTopicMiss;
    } else {
      const predicted = (c.profiles[question.year]?.[question.dim] ?? 0) >= PARAMS.activeThreshold;
      if (answer === 'unsure') like = uns;
      else if (answer === 'yes') like = predicted ? hit : miss;
      else like = predicted ? miss : hit;
    }
    c.posterior = c.posterior * like;
    norm += c.posterior;
  }
  if (norm > 0) for (const c of session.candidates) c.posterior /= norm;

  session.asked.push({ ...question, answer });
  session.history.push({ year: question.year, dim: question.dim, answer });

  // 收敛判定
  const sorted = [...session.candidates].sort((a, b) => b.posterior - a.posterior);
  const top = sorted[0];
  if (top.posterior >= PARAMS.stopPosterior || session.asked.length >= PARAMS.maxQuestions) {
    session.done = true;
    const p = +top.posterior.toFixed(3);
    // 置信度分级：低于 0.4 视为未定出（常见于年龄太小、可问区间不足的情况）
    const level = p >= 0.55 ? 'high' : p >= 0.4 ? 'medium' : 'low';
    session.result = {
      timeIndex: top.timeIndex,
      hour: top.hour,
      posterior: p,
      level,
      runnerUp: sorted[1] ? { hour: sorted[1].hour, posterior: +sorted[1].posterior.toFixed(3) } : null,
      questionsUsed: session.asked.length,
      note: level === 'low'
        ? '定盘未收敛（可询问的人生区间不足，或经历与盘面吻合度低）。建议按「时辰未知」处理，结论仅供参考。'
        : level === 'medium'
          ? '定盘结果有一定把握，但非确定。解读会按此���辰展开，请结合实际情况判断。'
          : '定盘收敛良好，可信度较高。',
    };
  }
  return session;
}

/** 后验分布（供前端展示进度） */
function posteriorView(session) {
  return session.candidates
    .map(c => ({ hour: c.hour, label: `${c.hour}时(${ZHI[c.timeIndex]}时)`, posterior: +c.posterior.toFixed(3) }))
    .sort((a, b) => b.posterior - a.posterior);
}

const rect = module.exports = {
  createSession, nextQuestion, answerQuestion, posteriorView,
  DIM_PALACE, DIM_LABEL, PARAMS, HOUR_TO_TIME_INDEX, decadalAtAge, PALACE_TOPIC,
};

// ───────── CLI 自测 ─────────
if (require.main === module) {
  const dateStr = process.argv[2] || '2000-8-16';
  const gender = process.argv[3] || '男';
  const simulateHour = Number(process.argv[4] || 14); // 模拟"真实时辰"，用于验证能否收敛到它
  console.log(`定盘自测：${dateStr} ${gender}（模拟真实时辰 ${simulateHour} 时）\n`);
  const t0 = Date.now();
  const session = createSession({ dateStr, gender, city: null });
  console.log(`候选 ${session.candidates.length} 个，年份范围 ${session.years[0]}-${session.years[session.years.length - 1]}（${session.years.length} 年），构建耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // 模拟用户：按"真实时辰"的盘作答（加 15% 噪声模拟记忆偏差）
  const truth = candidateProfiles(dateStr, HOUR_TO_TIME_INDEX(simulateHour), gender, session.years);
  let q;
  let step = 0;
  while ((q = nextQuestion(session)) !== null && step < PARAMS.maxQuestions) {
    step++;
    let ans, truthStr;
    if (q.type === 'decadal') {
      const truthKey = rect.decadalAtAge(truth, q.probeAge).topicKey;
      ans = Math.random() < 0.15 ? 'unsure' : truthKey; // 模拟 15% 记不清
      truthStr = (PALACE_TOPIC[(rect.decadalAtAge(truth, q.probeAge).palace)] || {}).label || truthKey;
    } else {
      const truthActive = (truth.profiles[q.year]?.[q.dim] ?? 0) >= PARAMS.activeThreshold;
      ans = Math.random() < 0.15 ? 'unsure' : (truthActive ? 'yes' : 'no');
      truthStr = truthActive ? '有' : '无';
    }
    answerQuestion(session, q, ans);
    const gainStr = q.type === 'decadal' ? `区分度 ${(q.gain * 100).toFixed(0)}%` : `区分度 ${q.split.yes}/${q.split.no}`;
    const ansStr = q.type === 'decadal'
      ? ((PALACE_TOPIC[Object.keys(PALACE_TOPIC).find(k => PALACE_TOPIC[k].key === ans)] || {}).label || ans)
      : ans;
    console.log(`Q${step}[${q.type === 'decadal' ? '大限' : '流年'}]: ${q.text}`);
    console.log(`     回答=${ansStr} | ${gainStr} | 后验: ${posteriorView(session).slice(0, 3).map(p => p.label + ' ' + (p.posterior * 100).toFixed(0) + '%').join('  ')}`);
  }
  console.log('\n定盘结果:', JSON.stringify(session.result));
  console.log('命中真实时辰:', session.result && Math.abs(session.result.hour - simulateHour) <= 1 ? '✅ 是（±1时辰内）' : '❌ 否');
}
