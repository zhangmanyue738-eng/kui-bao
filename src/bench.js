/**
 * bench.js — 命理知识评测集（P1-1）
 *
 * 与 eval.js 的分工：
 *   eval.js  测「报告格式与合规」（结论数/出处/禁词/免责/置信度档位）——已经在跑
 *   bench.js 测「读盘与命理知识是否出错」——排盘层零幻觉 ≠ 模型读盘不出错。
 *            模型拿到我们算好的盘，如果把日主看错、把命主当命宫主星，
 *            报告照样通顺合规，eval.js 一条都抓不到。这个洞就是 bench 要补的。
 *
 * 四条硬约束（防自欺，改这个文件前先读）：
 *   1. 答案全部由确定性脚本生成（chart.js / synthesize.js），不是 LLM 写的，也不是人拍脑袋写的。
 *      每题都记 answerFrom（答案从哪个字段来）与 chartRef（由哪个盘生成），可复算。
 *   2. drift 检测：`--verify` 重算全部答案并与存盘比对。排盘层改了而题库没更新 → 立刻报错。
 *      否则题库会变成「陈旧正确答案」，比没有题库更危险。
 *   3. 判定严格、可自动化：题目一律要求「只回答一个词」，判定退化为严格相等或全包含。
 *      不用 LLM 当裁判（judge 也是 LLM 就是自证循环）——`--judge` 默认关闭，留作对照实验。
 *   4. 抽认卡式排他检查：十天干/十四主星这类多选项题，要检查答案里没有混入其他选项，
 *      否则「把候选全列一遍」就能蒙混过关，分数虚高。
 *
 * 用法：
 *   node src/bench.js --build              重建题库 data/bench.jsonl
 *   node src/bench.js --verify             drift 检测（不联网，秒级，适合进 npm test / doctor）
 *   node src/bench.js [模型...]             跑评测，默认 deepseek-chat
 *   node src/bench.js --limit=20 --verbose 只跑前 20 题并打印问答
 *   node src/bench.js --types=dayMaster,mingZhuVsMingGong
 */
const fs = require('fs');
const path = require('path');
const { buildChart } = require('./chart.js');
const { synthesize } = require('./synthesize.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BENCH_FILE = path.join(DATA_DIR, 'bench.jsonl');
const DOCS_DIR = path.join(__dirname, '..', 'docs');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// =====================================================================
// 常量（排他检查用）
// =====================================================================
const TIAN_GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const DI_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const WU_XING = ['木', '火', '土', '金', '水'];
const ZIWEI_MAJOR_14 = ['紫微', '天机', '太阳', '武曲', '天同', '廉贞', '天府', '太阴', '贪狼', '巨门', '天相', '天梁', '七杀', '破军'];
const NEG_WORDS = ['不', '错', '误', '非', '实际', '应为', '并非', '不是', '错误', '不对'];

/**
 * 候选组：用于「命中且排他」判定。
 * 组内各项必须互不为子串，否则会出现「需留意」同时命中「利」这种误判。
 * （synthesisDirection 的 利/需留意/平稳 就犯了这个毛病，故不设组，保持严格匹配。）
 */
const GROUPS = {
  tianGan: TIAN_GAN,
  wuXing: WU_XING,
  ziweiMajor14: ZIWEI_MAJOR_14,
  direction: ['顺', '逆'],
  tenGod: ['比肩', '劫财', '食神', '伤官', '偏财', '正财', '七杀', '正官', '偏印', '正印'],
};

/**
 * 产品兜底表：该题型所问的信息，是否已由排盘层算好并直接写进喂给模型的 JSON。
 *
 * 这张表是 bench 报告能不能指导行动的关键。同样是 2/7 的正确率：
 *  - dayunDirection 已兜底 → 模型自推只有 29%，幸好大运顺逆是我们算好喂的，不构成风险
 *  - 某个未兜底题型 2/7 → 真实风险，必须改
 * 不标注的话，报告只会让人对着一堆低分数字无从下手。
 *
 * 只列「值直接给了」的；需要模型自己判断或推理的一律不列（漏标比错标安全：
 * 漏标会让人多查一次，错标会让人放心地漏掉一个真实风险）。
 */
const MITIGATION = {
  dayMaster: '✅ bazi.dayMaster.gan',
  wuxingCount: '✅ bazi.fiveElementsCount',
  tenGod: '✅ bazi.tenGods',
  hourGan: '✅ pillars.hour[0]',
  monthGan: '✅ pillars.month[0]',
  dayunDirection: '✅ bazi.daYunDirection（2026-09-03 新增）',
  mingZhu: '✅ ziwei.mingZhu',
  mingGongStar: '✅ ziwei.mingGongStars',
  // 以下需模型自行判断，不算兜底：
  // wuxingMissing  给了 count，「缺哪个」要模型读出来
  // synthesisDirection 互证方向是否一致，是推理题
  // adversarial    抗谄媚能力，纯模型能力
};

// =====================================================================
// 独立口诀实现（自校验用，不参与出题答案）
//
// 为什么要有第二套算法：出题时「题干」与「答案」取自排盘结果的**不同字段**，
// 两者未必同源。实测踩过一次：子时跨日时日柱取当日（丙日）、时干却按次日日干
// 推（庚子），题干于是变成「丙日子时→?」而答案写着「庚」——自相矛盾，
// 模型按口诀答「戊」反被判错。
//
// 这套口诀仅用于校验题面自洽：口诀复算与排盘结果不一致时跳过该题，
// 而不是拿口诀当答案（答案为准仍是排盘层，已由 verify-chart L2 对拍 100%）。
// =====================================================================

/** 五鼠遁（日上起时）：甲己还加甲，乙庚丙作初，丙辛从戊起，丁壬庚子居，戊癸壬子真 */
function wuShuDun(dayGan, hourZhi) {
  const start = (TIAN_GAN.indexOf(dayGan) % 5) * 2;           // 子时起始天干下标
  return TIAN_GAN[(start + DI_ZHI.indexOf(hourZhi)) % 10];
}

/** 五虎遁（年上起月）：甲己丙作首，乙庚戊为头，丙辛寻庚起，丁壬壬位流，戊癸甲寅求 */
function wuHuDun(yearGan, monthZhi) {
  const start = (TIAN_GAN.indexOf(yearGan) % 5) * 2 + 2;       // 寅月起始天干下标
  return TIAN_GAN[(start + ((DI_ZHI.indexOf(monthZhi) - 2 + 12) % 12)) % 10];
}

/** 大运顺逆标准规则：阳年男顺女逆，阴年女顺男逆 */
function daYunDirectionByRule(yearGan, gender) {
  const yang = '甲丙戊庚壬'.includes(yearGan);                  // 阳干
  const male = gender === '男' || gender === 'male';
  return (yang === male) ? '顺' : '逆';
}

// =====================================================================
// 题库生成：每个生成器的答案都必须取自 buildChart / synthesize 的返回值
// =====================================================================

/** 覆盖不同日主、男女、有/无时辰的一批生辰。改这个列表会改变题库，需重新 --build。 */
const REF_CASES = [
  { dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳' },
  { dateStr: '1995-6-15', hour: 8, gender: '女', city: '杭州' },
  { dateStr: '1988-7-1', hour: 10, gender: '女', city: '北京' },   // 夏令时样例
  { dateStr: '1979-3-21', hour: 3, gender: '男', city: '成都' },
  { dateStr: '2001-12-5', hour: 20, gender: '女', city: '哈尔滨' },
  { dateStr: '1966-9-9', hour: null, gender: '男', city: '西安' },  // 时辰未知（紫微跳过）
  { dateStr: '2000-8-16', hour: 23, gender: '男', city: '佳木斯' }, // 子时口径
];

const item = (o) => o;   // 语义糖：让下面的生成器读起来像在写题目

/** 1. 日主（读盘能力的基础，蒙对率 1/10） */
function genDayMaster(ref, chart) {
  const p = chart.bazi.pillars;
  return item({
    type: 'dayMaster',
    prompt: `某人的八字四柱为：年柱${p.year}、月柱${p.month}、日柱${p.day}、时柱${p.hour}。\n` +
      `问：日主（日干）是哪个天干？请只回答一个汉字，不要解释。`,
    expected: { kind: 'exact', value: chart.bazi.dayMaster.gan, exclusiveGroup: 'tianGan' },
    answerFrom: 'chart.bazi.dayMaster.gan',
    note: '读盘基础：日主看错，后面全错',
    _ref: ref, _chart: chart,
  });
}

/** 2. 五行缺失（只在恰好缺 1 行时出题，避免多值判定含糊） */
function genWuxingMissing(ref, chart) {
  const counts = chart.bazi.fiveElementsCount;
  const missing = WU_XING.filter(w => !counts[w]);
  if (missing.length !== 1) return null;    // 缺 0 行或 2 行以上不出题
  const shown = WU_XING.filter(w => counts[w]).map(w => `${w}${counts[w]}`).join('、');
  return item({
    type: 'wuxingMissing',
    prompt: `某人八字中五行的个数为：${shown}。\n` +
      `问：此造五行缺什么？请只回答一个汉字（木/火/土/金/水），不要解释。`,
    expected: { kind: 'exact', value: missing[0], exclusiveGroup: 'wuXing' },
    answerFrom: 'chart.bazi.fiveElementsCount（找值为 0 的行）',
    note: '五行统计读取',
    _ref: ref, _chart: chart,
  });
}

/** 3. 五行个数 */
function genWuxingCount(ref, chart) {
  const counts = chart.bazi.fiveElementsCount;
  const target = WU_XING.find(w => counts[w] >= 2) || WU_XING.find(w => counts[w]);
  if (!target) return null;
  return item({
    type: 'wuxingCount',
    prompt: `某人八字中五行的个数为：${WU_XING.filter(w => counts[w]).map(w => `${w}${counts[w]}`).join('、')}。\n` +
      `问：其中「${target}」有几个？请只回答一个数字。`,
    expected: { kind: 'number', value: counts[target] },
    answerFrom: `chart.bazi.fiveElementsCount.${target}`,
    note: '五行统计读取',
    _ref: ref, _chart: chart,
  });
}

/** 4. 十神（给日主与某柱天干，问十神） */
function genTenGod(ref, chart) {
  if (chart.bazi.hourPillarMissing) return null;
  const tg = chart.bazi.tenGods;
  const p = chart.bazi.pillars;
  const key = 'monthGan';                 // 月干十神：命理上称「月令天干所透」
  if (!tg || !tg[key]) return null;
  return item({
    type: 'tenGod',
    prompt: `某人日主为「${chart.bazi.dayMaster.gan}」，月柱天干为「${p.month[0]}」。\n` +
      `问：月干对日主而言是何十神？请只回答十神名称（如 正官、七杀、正财、偏财、正印、偏印、食神、伤官、比肩、劫财），不要解释。`,
    expected: { kind: 'exact', value: tg[key], exclusiveGroup: 'tenGod' },
    answerFrom: `chart.bazi.tenGods.${key}`,
    note: '十神换算（子平法基础）',
    _ref: ref, _chart: chart,
  });
}

/** 5. 五鼠遁：给日干 + 时支，问时干（时柱天干） */
function genHourGan(ref, chart) {
  if (chart.bazi.hourPillarMissing) return null;
  const p = chart.bazi.pillars;
  const dayGan = p.day[0], hourZhi = p.hour[1], hourGan = p.hour[0];
  // 自校验：日干与时柱必须同源。子时跨日时日柱按当日、时干按次日日干推，
  // 题干会自相矛盾（模型按口诀答对反而被判错）——这类题直接不出。
  if (wuShuDun(dayGan, hourZhi) !== hourGan) return null;
  return item({
    type: 'hourGan',
    prompt: `按五鼠遁（日上起时）口诀：日干为「${dayGan}」，时支为「${hourZhi}」。\n` +
      `问：该时辰的天干是什么？请只回答一个汉字。`,
    expected: { kind: 'exact', value: hourGan, exclusiveGroup: 'tianGan' },
    answerFrom: 'chart.bazi.pillars.hour[0]（lunar-javascript 五鼠遁，已由 verify-chart L2 100% 对拍）',
    note: '五鼠遁规则',
    _ref: ref, _chart: chart,
  });
}

/** 6. 五虎遁：给年干 + 月支，问月干 */
function genMonthGan(ref, chart) {
  const p = chart.bazi.pillars;
  // 自校验：年干与月柱须符合同一套五虎遁，否则题面自相矛盾（同 hourGan 的跨日坑）
  if (wuHuDun(p.year[0], p.month[1]) !== p.month[0]) return null;
  return item({
    type: 'monthGan',
    prompt: `按五虎遁（年上起月）口诀：年干为「${p.year[0]}」，月支为「${p.month[1]}」。\n` +
      `问：该月的天干是什么？请只回答一个汉字。`,
    expected: { kind: 'exact', value: p.month[0], exclusiveGroup: 'tianGan' },
    answerFrom: 'chart.bazi.pillars.month[0]（lunar-javascript 五虎遁，已由 verify-chart L2 100% 对拍）',
    note: '五虎遁规则',
    _ref: ref, _chart: chart,
  });
}

/** 7. 大运顺逆（由月柱与第一步大运比较推出，答案不写死） */
function genDayunDirection(ref, chart) {
  const dy = chart.bazi.daYun;
  if (!dy || dy.length < 2 || !dy[1].ganzhi) return null;
  const p = chart.bazi.pillars;
  const first = dy[1].ganzhi;
  const ganFwd = TIAN_GAN.indexOf(first[0]) === (TIAN_GAN.indexOf(p.month[0]) + 1) % 10;
  const DI_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const zhiFwd = DI_ZHI.indexOf(first[1]) === (DI_ZHI.indexOf(p.month[1]) + 1) % 12;
  if (ganFwd !== zhiFwd) return null;      // 干支方向不一致，说明推算有异，不出题
  // 自校验：从 daYun 推的方向必须与「阳男阴女顺、阳女阴男逆」标准规则一致。
  // 两条互不依赖的路径得出同一结论，答案才可信。
  const byRule = daYunDirectionByRule(p.year[0], ref.gender);
  if (byRule !== (ganFwd ? '顺' : '逆')) return null;
  return item({
    type: 'dayunDirection',
    prompt: `某人性别${ref.gender}，年干为「${p.year[0]}」（${'甲丙戊庚壬'.includes(p.year[0]) ? '阳' : '阴'}干），月柱为「${p.month}」。\n` +
      `问：此造大运是顺排还是逆排？请只回答「顺」或「逆」。`,
    expected: { kind: 'exact', value: ganFwd ? '顺' : '逆', exclusiveGroup: 'direction' },
    answerFrom: 'chart.bazi.daYun[1].ganzhi 与月柱比较（顺排则天干地支各进一位）',
    note: '大运顺逆（阳年男顺女逆、阴年女顺男逆）',
    _ref: ref, _chart: chart,
  });
}

/**
 * 8-9. 命主 vs 命宫主星（成对出题）
 * 这对题直指 2026-09-03 修掉的那个语义坑：曾把 iztro 的 soul（命主）当命宫主星喂给模型。
 * 两题一起考，模型必须区分开，蒙对一题不算过。
 */
function genMingZhuVsMingGong(ref, chart) {
  if (chart.ziwei.skipped) return null;
  const z = chart.ziwei;
  const stars = z.mingGongStars || [];
  if (stars.length !== 1) return null;     // 只在命宫恰好一颗主星时出 exact 题，避免判定含糊
  const ctx = `某紫微盘：命宫在「${z.mingGongBranch}」宫，五行局为${z.fiveElementsClass}。`;
  return [
    item({
      type: 'mingZhu',
      prompt: `${ctx}\n问：此盘的「命主」是哪颗星？请只回答星曜名称，不要解释。`,
      expected: { kind: 'exact', value: z.mingZhu, exclusiveGroup: 'ziweiMajor14' },
      answerFrom: 'chart.ziwei.mingZhu（按命宫地支查表，非命宫主星）',
      note: '命主：按命宫地支查表得来',
      _ref: ref, _chart: chart,
    }),
    item({
      type: 'mingGongStar',
      prompt: `${ctx}\n命宫内坐落的星曜为：${stars.join('、')}。\n` +
        `问：此盘命宫的「主星」（命宫里坐的主星，不是命主）是哪一颗？请只回答星曜名称，不要解释。`,
      expected: { kind: 'exact', value: stars[0], exclusiveGroup: 'ziweiMajor14' },
      answerFrom: 'chart.ziwei.mingGongStars[0]（命宫内主星）',
      note: '命宫主星：命宫里坐的星，与命主是两回事',
      _ref: ref, _chart: chart,
    }),
  ];
}

/** 10. 互证结论方向（测「不得自行调级」：给什么档位就用什么档位） */
function genSynthesisDirection(ref, chart) {
  const syn = synthesize(chart, ['career', 'wealth', 'marriage']);
  const r = (syn.results || []).find(x => x.direction !== 'neutral');
  if (!r) return null;
  const DN = { career: '事业', wealth: '财帛', marriage: '婚姻' };
  const CN = { favorable: '利', unfavorable: '需留意', neutral: '平稳' };
  const prompt = `某盘互证合成结果：${DN[r.domain]}方向=${CN[r.direction]}，` +
    `判定=${r.verdict === 'consistent' ? '双术一致' : r.verdict === 'conditional' ? '双术冲突' : '单术信号'}，` +
    `置信度=${r.confidence === 'high' ? '高' : r.confidence === 'medium' ? '中' : '条件式'}。\n` +
    `问：若据此写解读，${DN[r.domain]}方面应当写成什么方向？请只回答「利」「需留意」或「平稳」。`;
  return item({
    type: 'synthesisDirection',
    prompt,
    expected: { kind: 'exact', value: CN[r.direction] },
    answerFrom: 'synthesize(chart).results[].direction',
    note: '铁律：结论方向必须跟随合成结果，模型不得自行调级',
    _ref: ref, _chart: chart,
  });
}

/**
 * 11. 对抗题：故意给错误前提，看模型会不会顺着说
 * 这类题最贴近真实风险 —— 用户常带着「我是 X 命」的错误认知来问，
 * 模型一谄媚，就把错误前提坐实了。
 */
function genAdversarialDayMaster(ref, chart) {
  const correct = chart.bazi.dayMaster.gan;
  const wrong = TIAN_GAN.find(g => g !== correct);
  const p = chart.bazi.pillars;
  return item({
    type: 'adversarial',
    prompt: `某人的八字四柱为：年柱${p.year}、月柱${p.month}、日柱${p.day}、时柱${p.hour}。\n` +
      `有人说「这个八字的日主是${wrong}」。\n问：这个说法对吗？如果不对，正确的日主是什么？`,
    expected: { kind: 'refute', wrong, right: correct },
    answerFrom: 'chart.bazi.dayMaster.gan（wrong 是故意给的干扰项）',
    note: '抗谄媚：错误前提必须被指出并纠正，不能顺着说',
    _ref: ref, _chart: chart,
  });
}

const GENERATORS = [
  genDayMaster, genWuxingMissing, genWuxingCount, genTenGod,
  genHourGan, genMonthGan, genDayunDirection,
  genMingZhuVsMingGong, genSynthesisDirection, genAdversarialDayMaster,
];

function buildBench() {
  const out = [];
  let n = 0;
  for (const ref of REF_CASES) {
    const chart = buildChart(ref);
    for (const gen of GENERATORS) {
      let made;
      try { made = gen(ref, chart); } catch (e) {
        console.warn(`  ⚠️ ${gen.name} 在 ${ref.dateStr} 上出错：${e.message}`); continue;
      }
      for (const m of [].concat(made || [])) {
        if (!m) continue;
        n++;
        const { _ref, _chart, ...rest } = m;
        out.push({
          id: 'B' + String(n).padStart(3, '0'),
          ...rest,
          chartRef: ref,
        });
      }
    }
  }
  return out;
}

// =====================================================================
// 判分（严格、可自动化、不用 LLM 当裁判）
// =====================================================================

/** 归一化：去空白标点，剥掉「日主是 / 答案是 / 为…」这类引导词 */
function normalize(s) {
  let t = String(s || '').replace(/[\s。，、；：？！""''（）()【】\[\]·*`#]/g, '');
  const prefixes = ['日主是', '日主为', '命主是', '命主为', '答案是', '答案为', '回答是', '应为', '应该是', '应该是'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (t.startsWith(p) && t.length > p.length) { t = t.slice(p.length); changed = true; }
    }
  }
  return t;
}

/**
 * @param expected 题库里的 expected 结构
 * @param answer  模型原文
 * @returns {pass: boolean, reason: string}
 */
function grade(expected, answer) {
  const raw = String(answer || '');
  const norm = normalize(raw);

  if (expected.kind === 'number') {
    const m = norm.match(/\d+/);
    if (!m) return { pass: false, reason: `没找到数字（原文：${raw.slice(0, 40)}）` };
    return Number(m[0]) === expected.value
      ? { pass: true, reason: '' }
      : { pass: false, reason: `答 ${m[0]}，应为 ${expected.value}` };
  }

  if (expected.kind === 'refute') {
    const hasRight = norm.includes(expected.right);
    const negated = NEG_WORDS.some(w => norm.includes(w));
    if (!hasRight) return { pass: false, reason: `未给出正确值 ${expected.right}` };
    if (!negated) return { pass: false, reason: `给了正确值但没否定错误前提（疑似顺着说）` };
    // 排他：不能把错误答案也说成日主
    if (new RegExp(`${expected.wrong}\\s*[是为]`).test(norm) && norm.indexOf(expected.wrong) < norm.indexOf(expected.right)) {
      return { pass: false, reason: `同时把 ${expected.wrong} 当成日主` };
    }
    return { pass: true, reason: '' };
  }

  // exact 判定：先严格相等（模型按要求只答一个词时走这条）
  if (norm === expected.value) return { pass: true, reason: '' };

  // 再「命中且排他」：答案里出现了正确项，且没有混入同组其他候选。
  // 这样「此造大运顺排」这类带一句解释的正确回答不会被误杀，
  // 而「命宫有天府和紫微」这种罗列候选的仍然判错 —— 后者正是要防的蒙混。
  const group = GROUPS[expected.exclusiveGroup];
  if (group) {
    const hits = group.filter(x => norm.includes(x));
    if (hits.length === 1 && hits[0] === expected.value) {
      return { pass: true, reason: '' };
    }
    if (hits.length > 1) {
      return { pass: false, reason: `混入了其他候选：${hits.filter(h => h !== expected.value).join('、')}` };
    }
  }
  return { pass: false, reason: `答「${norm.slice(0, 20)}」，应为「${expected.value}」` };
}

// =====================================================================
// LLM 调用（并发受控）
// =====================================================================
async function callLLM(prompt, model) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY（请在 .env 中配置）');
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是一名严谨的命理术语考官。只按题目要求作答，不要解释、不要寒暄。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 64,
    }),
  });
  if (!resp.ok) throw new Error(`LLM API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const d = await resp.json();
  return { text: d.choices[0].message.content, usage: d.usage, resolved: d.model };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { error: e.message }; }
    }
  });
  await Promise.all(workers);
  return results;
}

// =====================================================================
// 子命令
// =====================================================================

function cmdBuild() {
  const items = buildBench();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BENCH_FILE, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  console.log(`✅ 题库已生成：${BENCH_FILE}`);
  console.log(`   共 ${items.length} 题：` + Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log('   答案全部由 chart.js / synthesize.js 现算，可复算、可 drift 检测。');
}

/**
 * drift 检测：重算答案与存盘比对。排盘层变了而题库没更新 → 报出来。
 * 供 CLI 与 doctor 共用（doctor 只取返回值，不打印）。
 * @returns {{ok:boolean, total:number, drift:number, samples:string[], byType:object, problems:string[]}}
 */
function verifyBench() {
  if (!fs.existsSync(BENCH_FILE)) {
    return { ok: false, total: 0, drift: 0, samples: [], byType: {}, problems: ['题库文件不存在，先跑 npm run bench -- --build'] };
  }
  const saved = fs.readFileSync(BENCH_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const fresh = buildBench();

  const savedById = new Map(saved.map(s => [s.id, s]));
  const freshById = new Map(fresh.map(s => [s.id, s]));

  const problems = [];
  for (const f of fresh) {
    const s = savedById.get(f.id);
    if (!s) { problems.push(`${f.id} 在存盘题库里不存在（题集结构变了，需 --build）`); continue; }
    if (JSON.stringify(s.expected) !== JSON.stringify(f.expected)) {
      problems.push(`${f.id} (${f.type}) 答案漂移：存盘 ${JSON.stringify(s.expected)} → 重算 ${JSON.stringify(f.expected)}`);
    }
    if (s.prompt !== f.prompt) problems.push(`${f.id} (${f.type}) 题干漂移`);
  }
  for (const s of saved) {
    if (!freshById.has(s.id)) problems.push(`${s.id} 是旧题，当前生成器已不再产生（需 --build 清理）`);
  }

  const byType = {};
  for (const f of fresh) byType[f.type] = (byType[f.type] || 0) + 1;

  return {
    ok: problems.length === 0,
    total: fresh.length,
    drift: problems.length,
    samples: problems.slice(0, 3),
    byType, problems,
  };
}

function cmdVerify() {
  const r = verifyBench();
  if (!r.ok) {
    console.log(`❌ 题库 drift：${r.drift} 处`);
    r.problems.slice(0, 20).forEach(p => console.log('   ' + p));
    console.log('   → 确认排盘层改动是有意的，然后跑 node src/bench.js --build 重建题库');
    return false;
  }
  console.log(`✅ 题库无漂移：${r.total} 题，答案全部复算一致`);
  console.log('   题型分布：' + Object.entries(r.byType).map(([k, v]) => `${k} ${v}`).join(' · '));
  return true;
}

async function cmdRun(models, { limit, types, verbose, concurrency }) {
  if (!fs.existsSync(BENCH_FILE)) { console.log('题库不存在，先跑 --build'); return; }
  let items = fs.readFileSync(BENCH_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  if (types) {
    const set = new Set(types.split(','));
    items = items.filter(i => set.has(i.type));
  }
  if (limit) items = items.slice(0, limit);

  const all = [];
  for (const model of models) {
    console.log(`\n======== 模型: ${model}（${items.length} 题） ========`);
    const t0 = Date.now();
    const res = await mapLimit(items, concurrency, async (it, idx) => {
      const r = await callLLM(it.prompt, model);
      const g = grade(it.expected, r.text);
      return { ...it, answer: r.text, pass: g.pass, reason: g.reason, tokens: r.usage?.total_tokens };
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const done = res.filter(Boolean);
    const passed = done.filter(r => r.pass).length;
    const errors = res.filter(r => r && r.error).length;
    console.log(`  答对 ${passed}/${done.length}（${Math.round(passed / done.length * 100)}%）· ${secs}s · 错误 ${errors}`);
    if (verbose) {
      for (const r of done) {
        console.log(`   ${r.pass ? '✅' : '❌'} [${r.type}] ${r.id} 答「${String(r.answer).trim().slice(0, 30)}」${r.pass ? '' : ' ← ' + r.reason}`);
      }
    } else {
      for (const r of done.filter(x => !x.pass)) {
        console.log(`   ❌ [${r.type}] ${r.id}：${r.reason}（原文：${String(r.answer).trim().slice(0, 30)}）`);
      }
    }
    all.push({ model, results: done, secs, errors });
  }

  // 汇总 + 报告
  console.log('\n======== 汇总 ========');
  const lines = [
    `# 命理知识评测（bench） ${new Date().toISOString().slice(0, 10)}`,
    '',
    '> 评测器：src/bench.js。答案全部由本项目确定性脚本（chart.js / synthesize.js）生成，',
    '> 判定为字符串严格匹配，**不用 LLM 当裁判**（judge 也是 LLM 就是自证循环）。',
    '',
    '| 模型 | 答对 | 总题 | 正确率 | 耗时 |',
    '|---|---|---|---|---|',
  ];
  for (const m of all) {
    const p = m.results.filter(r => r.pass).length, t = m.results.length;
    console.log(`${m.model}: ${p}/${t}（${Math.round(p / t * 100)}%）· ${m.secs}s`);
    lines.push(`| ${m.model} | ${p} | ${t} | ${Math.round(p / t * 100)}% | ${m.secs}s |`);
  }
  // 分题型正确率：能看出模型到底弱在哪一类。
  // 关键是要区分「真实风险」与「已被排盘层兜底」——同样是 2/7，
  // 一个会让报告出错，另一个只是说明「幸好这个值是我们算好喂进去的」。
  lines.push('', '## 分题型正确率', '');
  const typesSeen = [...new Set(all.flatMap(m => m.results.map(r => r.type)))];
  lines.push('| 题型 | ' + all.map(m => m.model).join(' | ') + ' | 产品兜底 |');
  lines.push('|---|' + all.map(() => '---|').join('') + '---|');
  for (const ty of typesSeen) {
    const cells = all.map(m => {
      const sub = m.results.filter(r => r.type === ty);
      if (!sub.length) return '-';
      const p = sub.filter(r => r.pass).length;
      return `${p}/${sub.length}`;
    });
    lines.push(`| ${ty} | ${cells.join(' | ')} | ${MITIGATION[ty] || '未兜底 ⚠️'} |`);
  }
  lines.push('',
    '> **产品兜底**＝该信息是否已由排盘层算好、直接写进喂给模型的 JSON。' +
    '已兜底的题型正确率低**不构成产品风险**，只说明「这个值确实不该让模型自己推」；' +
    '标 ⚠️ 的题型正确率低才是真实风险，需要改 prompt 或加排盘字段。');

  // 真实风险：未兜底且正确率 < 100% 的题型
  const risky = typesSeen.filter(ty => !MITIGATION[ty]).filter(ty => {
    const sub = all.flatMap(m => m.results.filter(r => r.type === ty));
    return sub.length && sub.filter(r => r.pass).length < sub.length;
  });
  if (risky.length) {
    lines.push('', `### ⚠️ 真实风险题型：${risky.join('、')}`, '',
      '这些题型产品未兜底且模型答错，需要补排盘字段或改 prompt。');
  } else {
    lines.push('', '### ✅ 无真实风险题型', '',
      '所有未兜底题型均答对；正确率低的题型都已被排盘层兜底覆盖。');
  }

  lines.push('', '## 错题明细', '');
  for (const m of all) {
    for (const r of m.results.filter(x => !x.pass)) {
      lines.push(`- **${m.model}** · ${r.id} [${r.type}]：${r.reason}`);
      lines.push(`  - 问：${r.prompt.replace(/\n/g, ' ')}`);
      lines.push(`  - 答：${String(r.answer).trim().slice(0, 120)}`);
    }
  }
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const out = path.join(DOCS_DIR, `bench-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(out, lines.join('\n'));
  console.log('\n报告已写入:', out);
}

// =====================================================================
// CLI
// =====================================================================
async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const flag = name => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : null; };
  const has = name => argv.includes(`--${name}`);

  if (has('build')) return cmdBuild();
  if (has('verify')) { process.exit(cmdVerify() ? 0 : 1); }

  const limit = flag('limit') ? Number(flag('limit')) : null;
  const models = argv.filter(a => !a.startsWith('--'));
  await cmdRun(models.length ? models : ['deepseek-chat'], {
    limit, types: flag('types'), verbose: has('verbose'),
    concurrency: Number(flag('concurrency') || 4),
  });
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildBench, grade, normalize, verifyBench, BENCH_FILE, MITIGATION };
