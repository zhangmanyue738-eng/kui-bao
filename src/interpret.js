/**
 * interpret.js — 解读层（RAG 版）
 * 调用 DeepSeek API；检索知识库条文注入 prompt；后置校验出处，违规重生成一次，
 * 仍违规则降级为无 RAG 模式（保证绝不引用知识库外的书名）。
 */
const fs = require('fs');
const path = require('path');
const { retrieveBalanced } = require('./retrieve.js');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
}

// ───────── 公共铁律（两版共用） ─────────
const COMMON_RULES = `【铁律】
1. 禁止自行排盘或推算。干支、星曜、宫位、四化——一律只引用排盘 JSON 中的原值。
   你写出的每一个命理事实，都必须能在输入 JSON 中找到对应字段。
2. 每条论断必须给【盘面依据】，引用排盘 JSON 原值。
3. 禁止输出知识库/条文列表中不存在的格局名词与书名。
4. 结论方向必须与「互证合成结果」一致（见下方）：
   - verdict=consistent → 按共同方向陈述
   - verdict=single-method → 结论里标注「此结论基于八字/紫微单术」
   - verdict=conditional → 必须写成条件式结论（若…则…），不得简化为单向断言
   - direction=neutral（双术均无信号）→ 写「此领域盘面呈现平稳倾向」，不得编造起伏
   - 末行【置信度】照抄合成结果给出的档位，不得自行调级
5. 结论措辞要克制：官星旺就说"官星旺"，不得自行推成"必成大器"。

【固定结构】
一、命盘速览（3-5句，只复述排盘事实：日主、身强身弱、喜用神、命主与命宫主星、生年四化，不解读）
   注意术语：mingZhu＝命主（按命宫地支查表），mingGongStars＝命宫里坐的主星，两者不是一回事，不要混用
   大运顺逆以 JSON 的 daYunDirection 为准（顺/逆），**不要自行按年干阴阳推算**
二、各领域解读（每领域 2-4 条论断，每条论断严格用五行格式：
    【结论】一句话
    【盘面依据】八字：…；紫微：…（引用排盘 JSON 原值）
    【知识出处】[KB-编号]《书名》篇名（只能来自条文列表）
    【置信度】高（双术一致）/ 中（单术）/ 条件式 / 平稳（双中性）
    ——注意：五行格式是硬性要求，不得合并、不得改为列表式）
三、总结与行动建议（宜 / 缓 / 避 三栏，建议必须日常可执行，禁止建议购买吉祥物、改运服务）

【句式纪律】
允许：「命理上呈现……倾向」「利于……」「需在……方向多投入」「盘面显示……的特质倾向」
禁止：「你一定……」「必将……」「肯定会……」「不可能……」「命中注定」及一切绝对断言。
禁止渲染焦虑：不得使用「大凶」「血光」「破财之灾」等恐吓性词汇；不利信号表述为「需留意」「宜谨慎」「多经营」。

【领域红线】
- 健康：只谈五行倾向对应的日常养护方向（作息、饮食、运动），禁止提及任何疾病名称。
- 婚姻：不利信号表述为「需要更多经营与沟通」，禁止「克夫克妻」「婚姻不顺」类断语。
- 财帛：禁止具体投资标的与买卖时点建议，只谈方向性描述。
- 流年：只允许**全年方向性**结论（依据 = 年干十神 + 流年四化落宫，盘面依据里给了什么只能说什么）。
  禁止任何逐月/月度/逐日拆分——月度当前**无计算、无条文**（知识库流月 0 条），
  输出月度档位即属无据编造。待流月干支接入计算层且知识库补条文后才可开放。

【特殊状态】
- 若 JSON 标注 hourPillarMissing=true：开头声明「出生时辰待定，以下解读基于年、月、日三柱，精度有限」，禁止引用时柱字段。
- 若 ziwei.skipped=true：只写八字单术解读，并提示补充出生时间可提升精度。

【结尾】每次输出必须原样附上，不得改写：
—— 以上内容为传统文化/娱乐参考，不构成医疗、投资、婚姻等重大决策建议。`;

const SYSTEM_PROMPT_RAG = `你是一名严谨的命理解读撰稿人。你的全部工作对象是【系统提供的排盘 JSON 与知识库条文】，你本人不掌握、也不得推算任何命理数据。

${COMMON_RULES}

【本版本铁律补充（有知识库）】
5. 每条论断的【知识出处】格式：[KB-编号]《书名》篇名。编号与书名只能来自下方"知识库检索条文"列表。
6. 条文列表是为你检索好的相关内容——多数论断应能从中找到对应条文，请优先引用；
   只有确实无条文可引的论断才可省略【知识出处】行，并在结论后标注（盘面通则）。
   一稿里标（盘面通则）的论断不应超过一半。
7. 条文原意不得歪曲：引条文要和论断方向一致，不得断章取义。`;

const SYSTEM_PROMPT_MVP = `你是一名严谨的命理解读撰稿人。你的全部工作对象是【系统提供的排盘 JSON】，你本人不掌握、也不得推算任何命理数据。

${COMMON_RULES}

【本版本铁律补充（无知识库）】
5. 禁止引用任何书名或古籍条文（不得出现《渊海子平》《紫微斗数全书》等书名），依据只能来自盘面。
6. 找不到依据的论断直接删掉。`;

const DOMAIN_NAMES = { career: '事业', wealth: '财帛', marriage: '婚姻', health: '健康', annual: '流年' };

/** 从完整排盘 JSON 裁剪出 LLM 需要的部分（省 token，去掉冗余） */
function slimChart(chart) {
  const bazi = {
    pillars: chart.bazi.pillars, hourPillarMissing: chart.bazi.hourPillarMissing,
    dayMaster: chart.bazi.dayMaster, fiveElementsCount: chart.bazi.fiveElementsCount,
    tenGods: chart.bazi.tenGods, naYin: chart.bazi.naYin,
    daYun: chart.bazi.daYun.slice(1, 6),
    // 大运顺逆由排盘层给死：bench 实测模型自推的正确率只有 2/7（29%，低于瞎猜），
    // 它有「一律答逆」的强先验。给了这个字段，模型就不必（也不该）自己去推。
    daYunDirection: chart.bazi.daYunDirection || null,
  };
  let ziwei;
  if (chart.ziwei.skipped) {
    ziwei = { skipped: true, reason: chart.ziwei.reason };
  } else {
    ziwei = {
      // 术语必须与数据一致：mingZhu（命主）是按命宫地支查表得来的星，跟命宫里坐哪颗星无关；
      // mingGongStars 才是命宫内主星。以前把 iztro 的 soul 直接叫「命宫主星」喂进来，
      // 模型于是拿命主星去讲命宫特质 —— 静默的系统性误读，肉眼看报告看不出来。
      mingZhu: chart.ziwei.mingZhu,
      shenZhu: chart.ziwei.shenZhu,
      mingGongBranch: chart.ziwei.mingGongBranch,
      mingGongStars: chart.ziwei.mingGongStars,
      fiveElementsClass: chart.ziwei.fiveElementsClass,
      keyPalaces: Object.fromEntries(Object.entries(chart.ziwei.keyPalaces).map(([k, p]) => [k, p && {
        palace: p.name,
        majorStars: p.majorStars.map(s => s.name + (s.magnitude ? `[${s.magnitude}]` : '') + (s.siHua ? `(${s.siHua})` : '')),
        minorStars: p.minorStars.map(s => s.name + (s.siHua ? `(${s.siHua})` : '')),
      }])),
    };
  }
  return { meta: { dateStr: chart.meta.dateStr, gender: chart.meta.gender, city: chart.meta.city,
    trueSolar: chart.meta.trueSolar, sect: chart.meta.sect, sectStamp: chart.meta.sectStamp }, bazi, ziwei };
}

// 合规禁词表（渲染焦虑 / 绝对断言 / 宿命论）
const FORBIDDEN_WORDS = ['必将', '肯定会', '命中注定', '大凶', '血光', '破财之灾', '克夫', '克妻',
  '牢狱', '一定会', '不可能不', '注定要', '在劫难逃', '凶多吉少'];
// 置信度档位归一化
const CONF_KIND = { high: '高', medium: '中', conditional: '条件式' };

/** 后置校验：出处引用必须都在所给条文集合内 */
function validateCitations(report, passages) {
  const idSet = new Set(passages.map(p => p.id));
  const srcText = passages.map(p => p.source + p.text).join('\n');
  const problems = [];
  for (const m of report.matchAll(/\[KB-\d{3}\]/g)) {
    const id = m[0].slice(1, -1); // 去掉方括号再比对
    if (!idSet.has(id)) problems.push(`引用了未提供的条文 ${m[0]}`);
  }
  for (const m of report.matchAll(/《([^》]{2,20})》/g)) {
    if (!srcText.includes(m[1])) problems.push(`引用了知识库外的书名《${m[1]}》`);
  }
  return problems;
}

/**
 * 完整输出校验（三类硬门禁）：
 *   1 出处：引用必须在所给条文内
 *   2 合规：不得出现焦虑/宿命禁词
 *   3 互证：置信度档位种类必须与合成结果一致，不得自行调级
 */
function validateOutput(report, passages, synthesis) {
  const problems = [];
  if (passages.length) problems.push(...validateCitations(report, passages));

  const hit = FORBIDDEN_WORDS.filter(w => report.includes(w));
  if (hit.length) problems.push(`使用了禁止词：${hit.join('、')}`);

  if (synthesis && synthesis.results && synthesis.results.length) {
    const expected = new Set(synthesis.results.map(r => CONF_KIND[r.confidence]).filter(Boolean));
    const actual = new Set();
    for (const m of report.matchAll(/【置信度】\s*([高中]|条件式|平稳)/g)) actual.add(m[1]);
    for (const k of expected) if (!actual.has(k)) problems.push(`缺少合成结果要求的置信度档位「${k}」`);
    for (const k of actual) if (!expected.has(k)) problems.push(`出现了合成结果中不存在的置信度档位「${k}」（不得自行调级）`);
  }
  return problems;
}

async function callLLM(systemPrompt, userMsg, modelOverride) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = modelOverride || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.3,
      max_tokens: 2500,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`LLM API ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  return { report: data.choices[0].message.content, usage: data.usage, model: data.model };
}

const CONF_LABEL = { high: '高（双术一致）', medium: '中（单术）', conditional: '条件式（双术冲突）' };
const VERDICT_CN = { consistent: '双术一致', 'single-method': '单术信号', conditional: '双术冲突' };
const DIR_CN = { favorable: '利', unfavorable: '需留意', neutral: '平稳' };

function synthesisBlock(synthesis) {
  if (!synthesis || !synthesis.results) return '';
  const lines = synthesis.results.map(r => {
    let l = `- ${DOMAIN_NAMES[r.domain]}：方向=${DIR_CN[r.direction] || r.direction}，合成判定=${VERDICT_CN[r.verdict] || r.verdict}，置信度=${CONF_LABEL[r.confidence] || r.confidence}`;
    if (r.note) l += `（${r.note}）`;
    const ev = [];
    if (r.baziSignal && r.baziSignal.evidence.length) ev.push('八字证据：' + r.baziSignal.evidence.join('；'));
    if (r.ziweiSignal && r.ziweiSignal.evidence.length) ev.push('紫微证据：' + r.ziweiSignal.evidence.join('；'));
    if (ev.length) l += '\n    ' + ev.join('\n    ');
    if (r.conditions && r.conditions.length) l += '\n    条件变量：' + r.conditions.join('；');
    return l;
  });
  let block = '互证合成结果（每领域的结论方向、置信度档位必须严格与此一致）：\n' + lines.join('\n') +
    `\n喜用神参考：${synthesis.favorableElements ? synthesis.favorableElements.evidence : ''}`;
  // 从格/调候告警：命中时必须在报告「命盘速览」后用一句话向用户明示，不得隐去
  const warns = synthesis.warnings || (synthesis.favorableElements && synthesis.favorableElements.warnings) || [];
  if (warns.length) {
    block += '\n\n⚠️ 盘面特殊情况（必须在「命盘速览」之后用一句话告知用户，不得隐去）：\n' +
      warns.map(w => '  - ' + w).join('\n');
  }
  return block;
}

async function interpret({ chart, domains, synthesis, model: modelOverride }) {
  loadEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY（请在 .env 中配置）');
  const domainList = Array.isArray(domains) && domains.length ? domains : ['career', 'wealth', 'marriage'];
  const domainText = domainList.map(d => DOMAIN_NAMES[d] || d).join('、');
  const slim = slimChart(chart);

  // RAG 检索。KB_PUBLIC_ONLY=1 → 只用公版古籍条目（对外发布模式，剔除现代整理与讲义内容）
  const publicOnly = process.env.KB_PUBLIC_ONLY === '1';
  const passages = retrieveBalanced(slim, domainList, 10, { publicOnly });
  const passageBlock = passages.length
    ? '知识库检索条文（引用只能出自以下列表）：\n' +
      passages.map(p => `[${p.id}] ${p.source}：${p.text}`).join('\n\n')
    : '';

  const userMsg = [
    `出生信息：${chart.meta.dateStr} ${chart.meta.inputHour != null ? chart.meta.inputHour + '时' : '时辰未知'} ${chart.meta.gender}性 ${chart.meta.city || '未提供城市'}`,
    `排盘口径：${chart.meta.sectStamp || '未指定'}`,
    `想了解的领域：${domainText}`,
    '',
    '排盘 JSON（唯一可信数据源）：',
    JSON.stringify(slim, null, 1),
    '',
    synthesisBlock(synthesis),
    '',
    passageBlock,
  ].filter(Boolean).join('\n');

  // 最多三轮：RAG 版 → 带违规提醒重生成 → 无 RAG 降级版（每轮都过三类硬门禁）
  const attempts = passages.length ? [
    { prompt: SYSTEM_PROMPT_RAG, msg: userMsg, rag: true },
    { prompt: SYSTEM_PROMPT_RAG, msg: userMsg + '\n\n【上一稿未通过校验，必须修正】', rag: true },
    { prompt: SYSTEM_PROMPT_MVP, msg: userMsg.split('知识库检索条文')[0], rag: false },
  ] : [
    { prompt: SYSTEM_PROMPT_MVP, msg: userMsg, rag: false },
    { prompt: SYSTEM_PROMPT_MVP, msg: userMsg + '\n\n【上一稿未通过校验，必须修正】', rag: false },
  ];

  let lastProblems = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const msg = i > 0 ? a.msg + lastProblems.join('；') + '。' : a.msg;
    const r = await callLLM(a.prompt, msg, modelOverride);
    const problems = validateOutput(r.report, a.rag ? passages : [], synthesis);
    if (problems.length === 0) {
      return { ...r, rag: a.rag, degraded: a.rag === false && passages.length > 0,
        passages: a.rag ? passages.map(p => p.id) : [] };
    }
    lastProblems = problems;
  }
  // 三轮都没通过 → 不返回报告，交由调用方提示重试（宁可不给，也不输出违规内容）
  return {
    report: '', rag: false, degraded: true, complianceFailed: true,
    problems: lastProblems, passages: [], usage: {}, model: 'compliance-blocked',
  };
}

module.exports = { interpret, slimChart, SYSTEM_PROMPT_RAG, SYSTEM_PROMPT_MVP, validateCitations, validateOutput, FORBIDDEN_WORDS };

if (require.main === module) {
  const { buildChart } = require('./chart.js');
  const [dateStr, hourArg, gender, city, domains] = process.argv.slice(2);
  const hour = hourArg === '-' || hourArg == null ? null : Number(hourArg);
  (async () => {
    const chart = buildChart({ dateStr, hour, gender: gender || '男', city });
    const r = await interpret({ chart, domains: (domains || 'career,wealth,marriage').split(',') });
    console.log(`── 模型: ${r.model} | tokens: ${r.usage.total_tokens} | RAG: ${r.rag}${r.degraded ? '(降级)' : ''} | 条文: ${r.passages.join(',') || '无'} ──\n`);
    console.log(r.report);
  })();
}
