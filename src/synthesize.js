/**
 * synthesize.js — 互证合成模块
 * 按 docs/cross-validation-rules.md 实现：
 * 1. 简化喜用神（扶抑法 + 月令加权，确定性）
 * 2. 五大领域八字/紫微信号提取（方向 + 强度 + 证据链）
 * 3. S1-S3 合成规则（一致→高 / 单术→中 / 冲突→条件式 / 双中性→平稳）
 *
 * 程序只输出方向 + 强度 + 证据，措辞交给解读层。
 */

// ───────── 五行生克表 ─────────
const SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' }; // 我生
const KE = { 木: '土', 火: '金', 土: '水', 金: '木', 水: '火' };     // 我克
const keWoMap = {}; // 克我者：官杀五行
for (const [k, v] of Object.entries(KE)) keWoMap[v] = k;
const shengWoMap = {}; // 生我者：印五行
for (const [k, v] of Object.entries(SHENG)) shengWoMap[v] = k;

// 十神分组 → 该组的代表五行（相对日主）
const GOD_GROUP_ELEMENT = (dm) => ({
  bijie: dm,                    // 比劫 = 同我
  yin: shengWoMap[dm],          // 印 = 生我
  shishang: SHENG[dm],          // 食伤 = 我生
  cai: KE[dm],                  // 财 = 我克
  guansha: keWoMap[dm],         // 官杀 = 克我
});
const GOD_GROUPS = {
  正官: 'guansha', 七杀: 'guansha', 正财: 'cai', 偏财: 'cai', 正印: 'yin', 偏印: 'yin',
  比肩: 'bijie', 劫财: 'bijie', 食神: 'shishang', 伤官: 'shishang',
};

// ───────── 简化喜用神（扶抑法 + 月令加权） ─────────
function favorableElements(bazi) {
  const dm = bazi.dayMaster.wuxing;
  const wu = { ...bazi.fiveElementsCount };
  // 月令加权：月支五行 +1（月令司令，权重最大）
  const monthZhiWx = bazi.pillarsWuxing[1].zhiWx;
  wu[monthZhiWx] = (wu[monthZhiWx] || 0) + 1;
  const ge = GOD_GROUP_ELEMENT(dm);
  const support = (wu[ge.bijie] || 0) + (wu[ge.yin] || 0);
  const total = Object.values(wu).reduce((a, b) => a + b, 0);
  const strong = support / total >= 0.5;
  const favorable = strong ? [ge.shishang, ge.cai, ge.guansha] : [ge.bijie, ge.yin];
  const unfavorable = strong ? [ge.bijie, ge.yin] : [ge.shishang, ge.cai, ge.guansha];
  return { strong, favorable, unfavorable, evidence: `日主${dm}，同党(比劫${ge.bijie}+印${ge.yin})合计${support}/${total}${strong ? ' ≥' : ' <'}50% 判身${strong ? '强' : '弱'}，喜用${favorable.join('/')}` };
}

// 十神组在盘中的喜忌
function groupFavor(fe, group, dm) {
  const el = GOD_GROUP_ELEMENT(dm)[group];
  if (fe.favorable.includes(el)) return 'favorable';
  if (fe.unfavorable.includes(el)) return 'unfavorable';
  return 'neutral';
}

// 收集十神（天干 + 地支藏干展平）
function collectGods(bazi) {
  const gods = [];
  for (const [k, v] of Object.entries(bazi.tenGods)) {
    if (!v) continue;
    if (typeof v === 'string') gods.push({ pos: k, god: v });
    else if (Array.isArray(v)) v.forEach((g, i) => gods.push({ pos: `${k}#${i}`, god: g }));
  }
  return gods;
}

// 六冲
const CHONG_PAIRS = new Set(['子午', '午子', '丑未', '未丑', '寅申', '申寅', '卯酉', '酉卯', '辰戌', '戌辰', '巳亥', '亥巳']);

// ───────── 紫微常量 ─────────
const MAG_W = { 庙: 1.0, 旺: 0.8, 得: 0.6, 利: 0.5, 平: 0.4, 不: 0.3, 陷: 0.2 };
const SHA = ['擎羊', '陀罗', '火星', '铃星', '地空', '地劫'];
const JI_FU = ['左辅', '右弼', '天魁', '天钺', '禄存', '天马', '文昌', '文曲'];

function palaceStars(p) { return p ? [...p.majorStars, ...p.minorStars] : []; }

/** 紫微单宫信号（通用） */
function ziweiPalaceSignal(palace, extra = {}) {
  if (!palace) return { direction: 'neutral', strength: 0, evidence: [] };
  const stars = palaceStars(palace);
  const majors = palace.majorStars;
  const siHuaList = stars.filter(s => s.siHua).map(s => `${s.name}化${s.siHua}`);
  const shaList = stars.filter(s => SHA.includes(s.name)).map(s => s.name);
  const jifuList = stars.filter(s => JI_FU.includes(s.name)).map(s => s.name);
  const mags = majors.map(s => MAG_W[s.magnitude] || 0.4);
  const avgMag = mags.length ? mags.reduce((a, b) => a + b, 0) / mags.length : 0;

  const evidence = [];
  if (majors.length) evidence.push(`主星：${majors.map(s => s.name + (s.magnitude ? `[${s.magnitude}]` : '') + (s.siHua ? `(${s.siHua})` : '')).join(' ')}`);
  if (siHuaList.length) evidence.push(`四化：${siHuaList.join('、')}`);
  if (shaList.length) evidence.push(`煞曜：${shaList.join('、')}`);
  if (jifuList.length) evidence.push(`吉辅：${jifuList.join('、')}`);

  let direction = 'neutral', strength = 0;
  const hasJi = siHuaList.some(s => s.endsWith('忌'));
  const hasLuQuan = siHuaList.some(s => s.endsWith('禄') || s.endsWith('权'));
  const hasKe = siHuaList.some(s => s.endsWith('科'));

  if (hasJi) { direction = 'unfavorable'; strength = shaList.length >= 2 ? 0.9 : 0.8; }
  else if (hasLuQuan) { direction = 'favorable'; strength = 0.9; }
  else if (majors.length === 0) { direction = 'neutral'; strength = 0.3; evidence.push('无主星'); }
  else if (avgMag >= 0.7 && shaList.length <= 1) { direction = 'favorable'; strength = 0.8; }
  else if (avgMag <= 0.3 || shaList.length >= 2) { direction = 'unfavorable'; strength = 0.6; }
  else if (hasKe) { direction = 'favorable'; strength = 0.6; }
  else { direction = 'neutral'; strength = 0.4; }

  if (extra.label) evidence.unshift(extra.label);
  return { direction, strength, evidence };
}

// ───────── 各领域信号提取 ─────────
function baziCareerSignal(bazi, fe, hourMissing) {
  const gods = collectGods(bazi);
  const dm = bazi.dayMaster.wuxing;
  const guansha = gods.filter(g => GOD_GROUPS[g.god] === 'guansha');
  const shishang = gods.filter(g => GOD_GROUPS[g.god] === 'shishang');
  const evidence = [];
  if (guansha.length) {
    const dir = groupFavor(fe, 'guansha', dm);
    evidence.push(`官杀（${guansha.map(g => g.god).join('/')}）为${dir === 'favorable' ? '喜用' : dir === 'unfavorable' ? '忌神' : '中性'}`);
    if (dir !== 'neutral') return { direction: dir, strength: dir === 'favorable' ? 0.8 : 0.6, evidence, conditions: currentLuck(bazi) };
  }
  if (shishang.length) {
    const dir = groupFavor(fe, 'shishang', dm);
    evidence.push(`食伤（${shishang.map(g => g.god).join('/')}）为${dir === 'favorable' ? '喜用' : dir === 'unfavorable' ? '忌神' : '中性'}`);
    if (dir !== 'neutral') return { direction: dir, strength: 0.7, evidence, conditions: currentLuck(bazi) };
  }
  return { direction: 'neutral', strength: 0.2, evidence: evidence.length ? evidence : ['官杀食伤均不显'], conditions: [] };
}

function currentLuck(bazi) {
  // 当前大运（2026 年落在哪个大运区间）
  const y = new Date().getFullYear();
  const dy = bazi.daYun.find(d => y >= d.startYear && y <= d.endYear && d.ganzhi);
  return dy ? [`当前大运 ${dy.ganzhi}（${dy.startAge}-${dy.endAge}岁，${dy.startYear}-${dy.endYear}年）`] : [];
}

function baziWealthSignal(bazi, fe) {
  const gods = collectGods(bazi);
  const dm = bazi.dayMaster.wuxing;
  const cai = gods.filter(g => GOD_GROUPS[g.god] === 'cai');
  const bijie = gods.filter(g => GOD_GROUPS[g.god] === 'bijie');
  const evidence = [];
  if (!cai.length) return { direction: 'neutral', strength: 0.3, evidence: ['财星不现'], conditions: [] };
  const dir = groupFavor(fe, 'cai', dm);
  evidence.push(`财星（${cai.map(g => g.god).join('/')}）为${dir === 'favorable' ? '喜用' : dir === 'unfavorable' ? '忌神' : '中性'}`);
  if (dir === 'unfavorable') return { direction: 'unfavorable', strength: 0.6, evidence, conditions: [] };
  if (dir === 'favorable' && fe.strong && bijie.length >= 3) {
    evidence.push(`比劫偏重（${bijie.length}见），有夺财倾向`);
    return { direction: 'unfavorable', strength: 0.5, evidence, conditions: [] };
  }
  if (dir === 'favorable') return { direction: 'favorable', strength: 0.8, evidence, conditions: [] };
  return { direction: 'neutral', strength: 0.3, evidence, conditions: [] };
}

function baziMarriageSignal(bazi, fe, gender) {
  const dm = bazi.dayMaster.wuxing;
  const dayZhiGods = (bazi.tenGods.dayZhi || []).map(g => GOD_GROUPS[g] ? g : g);
  const evidence = [`日支藏${(bazi.tenGods.dayZhi || []).join('/') || '无十神'}`];
  let dir = null, strength = 0;
  // 日支十神喜忌（日支=夫妻宫位）
  const dayGroup = (bazi.tenGods.dayZhi || []).map(g => GOD_GROUPS[g]).find(Boolean);
  if (dayGroup) {
    const d = groupFavor(fe, dayGroup, dm);
    if (d === 'favorable') { dir = 'favorable'; strength = 0.6; }
    else if (d === 'unfavorable') { dir = 'unfavorable'; strength = 0.5; }
  }
  // 日支六冲检查
  const dayZhi = bazi.pillars.day[1];
  const others = [bazi.pillars.year[1], bazi.pillars.month[1], bazi.pillars.hour && bazi.pillars.hour[1]].filter(Boolean);
  const chong = others.find(z => CHONG_PAIRS.has(dayZhi + z));
  if (chong) { evidence.push(`日支${dayZhi}逢冲（与${chong}六冲）`); dir = 'unfavorable'; strength = Math.max(strength, 0.6); }
  // 夫妻星（男财/女官）
  const spouseGroup = gender === '男' ? 'cai' : 'guansha';
  const gods = collectGods(bazi);
  const spouse = gods.filter(g => GOD_GROUPS[g.god] === spouseGroup);
  if (spouse.length) {
    const sd = groupFavor(fe, spouseGroup, dm);
    evidence.push(`夫妻星（${gender === '男' ? '财' : '官'}：${spouse.map(g => g.god).join('/')}）为${sd === 'favorable' ? '喜用' : sd === 'unfavorable' ? '忌神' : '中性'}`);
    if (sd === 'favorable' && dir !== 'unfavorable') { dir = 'favorable'; strength = Math.max(strength, 0.8); }
    else if (sd === 'unfavorable') { dir = 'unfavorable'; strength = Math.max(strength, 0.6); }
  } else {
    evidence.push('夫妻星不现，以日支为凭');
  }
  return { direction: dir || 'neutral', strength: dir ? strength : 0.3, evidence, conditions: [] };
}

function baziHealthSignal(bazi) {
  const evidence = [];
  let bad = false;
  for (const [wx, n] of Object.entries(bazi.fiveElementsCount)) {
    if (n === 0) { evidence.push(`五行缺${wx}`); bad = true; }
    else if (n >= 4) { evidence.push(`五行${wx}偏重（${n}见）`); bad = true; }
  }
  const dm = bazi.dayMaster.wuxing;
  if ((bazi.fiveElementsCount[dm] || 0) === 0 && !bazi.pillars.day[0]) { /* unreachable guard */ }
  // 日主失令无根的粗判：日主五行同党 <= 1
  const fe = favorableElements(bazi);
  if (!fe.strong && (bazi.fiveElementsCount[dm] || 0) === 0 && (bazi.fiveElementsCount[shengWoMap[dm]] || 0) <= 1) {
    evidence.push(`日主${dm}无根偏弱`); bad = true;
  }
  return { direction: bad ? 'unfavorable' : 'neutral', strength: bad ? 0.5 : 0.2, evidence: evidence.length ? evidence : ['五行分布无明显偏枯'], conditions: [] };
}

function baziAnnualSignal(bazi, fe) {
  // 2026 流年丙午（立春后）——MVP 固定当年，后续改为参数
  const year = new Date().getFullYear();
  const ganzhi = bazi.daYun.length ? annualGanzhi(year) : null;
  const evidence = [];
  if (!ganzhi) return { direction: 'neutral', strength: 0.2, evidence: ['流年未排'], conditions: [] };
  // 流年天干十神（相对日主）——lunar 未直接给，用日主推
  const dmGan = bazi.dayMaster.gan;
  const dmWx = bazi.dayMaster.wuxing;
  const flowGanWx = ganzhiGanWx(ganzhi);
  const group = flowGroupOf(dmWx, flowGanWx);
  const dir = groupFavor(fe, group, dmWx);
  evidence.push(`流年${ganzhi}，流年干五行属${flowGanWx}，十神属${group === 'bijie' ? '比劫' : group === 'yin' ? '印星' : group === 'shishang' ? '食伤' : group === 'cai' ? '财星' : '官杀'}`);
  const conditions = currentLuck(bazi);
  if (dir === 'favorable') return { direction: 'favorable', strength: 0.7, evidence, conditions };
  if (dir === 'unfavorable') return { direction: 'unfavorable', strength: 0.7, evidence, conditions };
  return { direction: 'neutral', strength: 0.3, evidence, conditions };
}

// 流年干支计算（MVP：标准年干支公式，立春边界误差 <1 天可接受，2 月 4 日后生效）
function annualGanzhi(year) {
  const GAN = '甲乙丙丁戊己庚辛壬癸', ZHI = '子丑寅卯辰巳午未申酉戌亥';
  const gan = GAN[(year - 4) % 10], zhi = ZHI[(year - 4) % 12];
  return gan + zhi;
}
function ganzhiGanWx(gz) { return { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' }[gz[0]]; }
function flowGroupOf(dmWx, flowWx) {
  const ge = GOD_GROUP_ELEMENT(dmWx);
  for (const [g, el] of Object.entries(ge)) if (el === flowWx) return g;
  return 'bijie';
}

// ───────── 紫微各领域 ─────────
function ziweiCareerSignal(zw) {
  const s = ziweiPalaceSignal(zw.keyPalaces.guanLu, { label: '官禄宫' });
  // 命宫三方辅助：命宫主星气质仅记录，不定方向
  return s;
}
function ziweiWealthSignal(zw) {
  const s = ziweiPalaceSignal(zw.keyPalaces.caiBo, { label: '财帛宫' });
  const tianZhai = ziweiPalaceSignal(zw.keyPalaces.tianZhai, { label: '田宅宫(辅助)' });
  // 田宅为辅助信号：仅微调强度
  if (s.direction !== 'neutral' && tianZhai.direction === s.direction) s.strength = Math.min(1, s.strength + 0.1);
  if (s.direction === 'neutral' && tianZhai.direction !== 'neutral') return { ...tianZhai, strength: tianZhai.strength * 0.6, conditions: [] };
  return s;
}
function ziweiMarriageSignal(zw) {
  return ziweiPalaceSignal(zw.keyPalaces.fuQi, { label: '夫妻宫' });
}
function ziweiHealthSignal(zw) {
  const s = ziweiPalaceSignal(zw.keyPalaces.jiE, { label: '疾厄宫' });
  // 健康领域措辞红线：不给强信号
  if (s.direction === 'unfavorable') s.strength = Math.min(s.strength, 0.5);
  return s;
}
function ziweiAnnualSignal(zw) {
  return { direction: 'neutral', strength: 0, evidence: ['流曜/流四化未排（MVP），紫微侧流年信号暂缺'], conditions: [] };
}

// ───────── 合成 ─────────
function synthesizePair(domain, baziS, zwS) {
  const r = { domain, baziSignal: baziS, ziweiSignal: zwS, conditions: [] };
  if (zwS.strength === 0 && zwS.direction === 'neutral' && zwS.evidence[0] && zwS.evidence[0].includes('未排')) {
    // 紫微侧缺数据 → 单术路径
    if (baziS.direction === 'neutral') return { ...r, verdict: 'single-method', confidence: 'medium', direction: 'neutral', note: '双术均无明显信号' };
    return { ...r, verdict: 'single-method', confidence: 'medium', direction: baziS.direction, note: '仅八字有信号' };
  }
  if (baziS.direction !== 'neutral' && zwS.direction !== 'neutral') {
    if (baziS.direction === zwS.direction) {
      const strength = Math.min(1, ((baziS.strength + zwS.strength) / 2) * 1.1);
      return { ...r, verdict: 'consistent', confidence: 'high', direction: baziS.direction, strength };
    }
    const primary = baziS.strength >= zwS.strength ? '八字' : '紫微';
    const secondary = primary === '八字' ? '紫微' : '八字';
    const pS = primary === '八字' ? baziS : zwS;
    const sS = primary === '八字' ? zwS : baziS;
    return {
      ...r, verdict: 'conditional', confidence: 'conditional', direction: pS.direction,
      note: `主信号来自${primary}，${secondary}提示相反倾向`,
      conditions: [...(sS.conditions || []), '引动判据：流年干支转为' + (sS.direction === 'favorable' ? '喜用' : '忌神') + '类十神时倾向切换'],
    };
  }
  const has = baziS.direction !== 'neutral' ? baziS : (zwS.direction !== 'neutral' ? zwS : null);
  if (has) return { ...r, verdict: 'single-method', confidence: 'medium', direction: has.direction, note: '仅单术有信号' };
  return { ...r, verdict: 'consistent', confidence: 'medium', direction: 'neutral', note: '双术均无明显信号，此领域平稳' };
}

/** 主入口：返回 SynthesisResult[] */
function synthesize(chart, domains) {
  const bazi = chart.bazi;
  const zw = chart.ziwei;
  const fe = favorableElements(bazi);
  const hourMissing = bazi.hourPillarMissing;
  const gender = chart.meta.gender;

  const baziGetters = {
    career: () => baziCareerSignal(bazi, fe, hourMissing),
    wealth: () => baziWealthSignal(bazi, fe),
    marriage: () => baziMarriageSignal(bazi, fe, gender),
    health: () => baziHealthSignal(bazi),
    annual: () => baziAnnualSignal(bazi, fe),
  };
  const zwGetters = {
    career: () => zw && !zw.skipped ? ziweiCareerSignal(zw) : { direction: 'neutral', strength: 0, evidence: ['紫微未排（时辰未定）'], conditions: [] },
    wealth: () => zw && !zw.skipped ? ziweiWealthSignal(zw) : { direction: 'neutral', strength: 0, evidence: ['紫微未排（时辰未定）'], conditions: [] },
    marriage: () => zw && !zw.skipped ? ziweiMarriageSignal(zw) : { direction: 'neutral', strength: 0, evidence: ['紫微未排（时辰未定）'], conditions: [] },
    health: () => zw && !zw.skipped ? ziweiHealthSignal(zw) : { direction: 'neutral', strength: 0, evidence: ['紫微未排（时辰未定）'], conditions: [] },
    annual: () => zw && !zw.skipped ? ziweiAnnualSignal(zw) : { direction: 'neutral', strength: 0, evidence: ['紫微未排（时辰未定）'], conditions: [] },
  };

  const results = domains.map(d => {
    const baziS = baziGetters[d] ? baziGetters[d]() : { direction: 'neutral', strength: 0.2, evidence: [], conditions: [] };
    const zwS = zwGetters[d] ? zwGetters[d]() : { direction: 'neutral', strength: 0, evidence: [], conditions: [] };
    return synthesizePair(d, baziS, zwS);
  });
  return { favorableElements: fe, results };
}

module.exports = { synthesize, favorableElements };

if (require.main === module) {
  const { buildChart } = require('./chart.js');
  const [dateStr, hourArg, gender, city, domains] = process.argv.slice(2);
  const hour = hourArg === '-' || hourArg == null ? null : Number(hourArg);
  const chart = buildChart({ dateStr, hour, gender: gender || '男', city });
  const r = synthesize(chart, (domains || 'career,wealth,marriage,health,annual').split(','));
  console.log('喜用神:', JSON.stringify(r.favorableElements, null, 1));
  for (const res of r.results) {
    console.log(`\n【${res.domain}】verdict=${res.verdict} confidence=${res.confidence} direction=${res.direction} ${res.note || ''}`);
    console.log('  八字:', res.baziSignal.direction, res.baziSignal.strength, '|', res.baziSignal.evidence.join('；'));
    console.log('  紫微:', res.ziweiSignal.direction, res.ziweiSignal.strength, '|', res.ziweiSignal.evidence.join('；'));
    if (res.conditions.length) console.log('  条件:', res.conditions.join('；'));
  }
}
