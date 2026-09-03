/**
 * badcase.js — badcase 归因分析
 *
 * 位置：P1-3 只解决了「badcase 翻得出来」（归档 + 检索），这一层解决
 * 「翻出来之后看得出规律」。攒 badcase 的全部价值都在这一步。
 *
 * 但这个工具的输出是**线索，不是结论**，有三条硬约束：
 *
 *  ① **小样本不判**：n 太小时 bad 率毫无意义（1/1=100%、0/1=0%）。
 *     一律给 Wilson 95% 置信区间，并设最小样本阈值（默认 5），
 *     低于阈值只列出、不判定。
 *
 *  ② **判定用区间下界，不点估计**：只有「该组 bad 率的 Wilson **下界**
 *     仍高于全局 bad 率」才算可疑——即使按最保守的估计也比平均差。
 *
 *  ③ **多重比较必须说清楚**：分的组越多，纯随机数据里也必然有组
 *     碰巧「看起来显著」。分组数 K 在 α=0.05 下**期望就有 K×0.05 个假阳性**。
 *     这个数字会直接打在报告里，别让人把噪声当信号。
 *
 * 刻意**不自动生成校正规则**：那会让排盘层之外的东西反过来污染解读，
 * 而「排盘零幻觉」是项目铁律。这里只做人工复核的**优先级排序**。
 *
 * 用法：
 *   node src/badcase.js              # 归因报告
 *   node src/badcase.js --min 8      # 调最小样本阈值
 *   node src/badcase.js --json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FEEDBACK_FILE = path.join(ROOT, 'data', 'feedback.jsonl');
const SESSIONS_FILE = path.join(ROOT, 'data', 'sessions.jsonl');

// ────────────────────────────── 统计工具 ──────────────────────────────

/**
 * Wilson score 区间（95%）。
 * 为什么不用正态近似：小样本下正态近似会给出 [0,0] 或越界到负数/大于 1 的区间，
 * 看起来「非常确定」其实完全不可靠。Wilson 在 n=1 时给出的是很宽的区间，正确表达「什么都不知道」。
 */
function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (center - spread) / denom), hi: Math.min(1, (center + spread) / denom) };
}

// ────────────────────────────── 归因快照 ──────────────────────────────

/**
 * 从归档记录里抽「归因所需的最小快照」。
 * 写进 feedback 里，这样归档被删了、口径变了，这条评价仍然可归因。
 * 刻意不存整份 chart：太大（每条几 KB），而归因只需要下面这些维度。
 */
function buildAttribution(s) {
  if (!s) return null;
  const idx = s.index || {};
  const meta = s.meta || {};
  const cm = (s.chart && s.chart.meta) || {};
  return {
    dayMaster: idx.dayMaster || null,
    dayMasterWx: idx.dayMasterWx || null,
    hourMissing: !!idx.hourMissing,
    mingZhu: idx.mingZhu || null,
    mingGongStars: idx.mingGongStars || [],
    fiveElementsClass: idx.fiveElementsClass || null,
    ziweiSkipped: !!idx.ziweiSkipped,
    // 领域 × 方向 × 判定：这三类是合成层的直接产物，最可能是系统性偏差的来源
    domains: (idx.domains || []).map(d => ({
      domain: d.domain, direction: d.direction, verdict: d.verdict, confidence: d.confidence,
    })),
    passages: meta.passages || [],
    model: meta.model || null,
    degraded: !!meta.degraded,
    sectStamp: s.sectStamp || cm.sectStamp || null,
  };
}

// ────────────────────────────── 特征展开 ──────────────────────────────

/**
 * 一条反馈 → 若干「特征键」，分两类返回。
 *
 * 为什么拆开（踩过才知道）：
 *   core    = 盘面与判定属性（日主/命宫/领域方向…）——**因**，决定了解读会怎么说。
 *   passage = 本次引用的条文（KB-xxx）——**果**，是模型这次选择了说什么。
 *
 * 混在一张表里会出两个问题：
 *   ① 因果倒置：条文本身是输出，拿输出当输入去归因，等于问「他错在哪 → 因为他引用了这条」，
 *      这条推论不能指导任何改动。
 *   ② 撑爆多重比较：每份报告引 10 条条文 → 每条 feedback 就多贡献 10 个组，
 *      K 一大，K×0.05 的假阳性期望就虚高，主分组的提醒就失真了。
 *
 * 拆开后各自成立：core 看「哪类盘/哪类判定更容易错」，passage 看「哪条条文被引用时更容易错」
 * ——后者是**条文质量**信号（错引、争议条文），是另一个问题域，单独统计。
 */
function featureKeys(a) {
  if (!a) return { core: [], passage: [] };
  const core = [];
  const passage = [];
  const add = (dim, val) => { if (val !== null && val !== undefined && val !== '') core.push(`${dim}=${val}`); };

  add('日主', a.dayMaster);
  add('日主五行', a.dayMasterWx);
  add('时辰', a.hourMissing ? '缺失' : '已知');
  add('命主', a.mingZhu);
  for (const st of (a.mingGongStars || [])) add('命宫主星', st);
  add('五行局', a.fiveElementsClass);
  add('模型', a.model);
  add('降级', a.degraded ? '是' : '否');

  for (const d of (a.domains || [])) {
    add('领域方向', `${d.domain}/${d.direction}`);
    add('领域判定', `${d.domain}/${d.verdict}`);
    add('领域置信度', `${d.domain}/${d.confidence}`);
  }
  for (const p of (a.passages || [])) passage.push(`引用条文=${p}`);

  return { core, passage };
}

// ────────────────────────────── 主分析 ──────────────────────────────

function readJSONL(file) {
  if (!fs.existsSync(file)) return { rows: [], bad: 0 };
  const rows = []; let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad };
}

/**
 * @param opts.min  最小样本阈值，低于此值只列不判
 * @param opts.file 可注入的 feedback 文件——**为自检而存在**。
 *   suspicious 判定分支在真实样本攒够之前根本跑不到（几十条 feedback 才可能触发），
 *   而这条分支正是整个工具的核心产出。不注入合成数据，它就会一直是一段「从没执行过的代码」，
 *   等真数据攒够了才发现有 bug，代价太大。见 tools/badcase-selftest.js。
 */
function analyze({ min = 5, file = FEEDBACK_FILE } = {}) {
  const { rows: fb, bad: badLines } = readJSONL(file);
  const rated = fb.filter(f => f.rating === 'good' || f.rating === 'bad');
  const withAttr = rated.filter(f => f.attribution);
  const orphans = rated.filter(f => f.sessionId && !f.attribution);

  const totalBad = rated.filter(f => f.rating === 'bad').length;

  // 判定基线只算「带快照」的样本，不混进孤儿。
  // 踩过的坑（同一类错误在本项目出现过两次）：分子分母必须同源。
  // 分组是在 withAttr 这个集合里做的，若基线用全量 rated，孤儿反馈就只进基线的分子分母、
  // 不进任何分组 —— 孤儿里 bad 偏多会把基线抬高，于是所有组都更难被判定，
  // 工具静默地变得「什么都不报」。两个基线都算：base 用于判定，baseAll 仅作展示。
  const attrBad = withAttr.filter(f => f.rating === 'bad').length;
  const base = wilson(attrBad, withAttr.length);
  const baseAll = wilson(totalBad, rated.length);

  // 分组统计（core 与 passage 分开：见 featureKeys 的注释）
  const summarize = (pick) => {
    const groups = new Map();
    for (const f of rated) {
      for (const k of pick(featureKeys(f.attribution))) {
        if (!groups.has(k)) groups.set(k, { key: k, n: 0, bad: 0 });
        const g = groups.get(k);
        g.n++;
        if (f.rating === 'bad') g.bad++;
      }
    }
    const all = [...groups.values()].map(g => {
      const w = wilson(g.bad, g.n);
      return {
        ...g,
        rate: w.p,
        lo: w.lo,
        hi: w.hi,
        // 可疑 = 即使按下界（最保守估计）也高于全局 bad 率，且样本够
        suspicious: g.n >= min && w.lo > base.p,
        // 证据量：偏离基线的幅度 × 样本量，用于人工复核排序
        lift: base.p > 0 ? (w.p / base.p) : (w.p > 0 ? Infinity : 1),
      };
    }).sort((a, b) => (b.lift * Math.log(b.n + 1)) - (a.lift * Math.log(a.n + 1)));

    return {
      all,
      judged: all.filter(g => g.n >= min),
      flagged: all.filter(g => g.suspicious),
      underMin: all.filter(g => g.n < min),
    };
  };

  const core = summarize(fk => fk.core);
  const passage = summarize(fk => fk.passage);

  const all = core.all;
  const judged = core.judged;
  const flagged = core.flagged;
  const underMin = core.underMin;

  return {
    total: fb.length, rated: rated.length, bad: totalBad,
    good: rated.length - totalBad, unrated: fb.length - rated.length,
    withAttribution: withAttr.length, orphans: orphans.length, badLines,
    baseline: base, baselineAll: baseAll,
    groupCount: all.length, judgedCount: judged.length, underMinCount: underMin.length,
    // 多重比较：K 个组在 α=0.05 下，纯随机时期望的假阳性个数
    expectedFalsePositives: +(judged.length * 0.05).toFixed(1),
    flagged, judged, underMin, passage,
  };
}

// ────────────────────────────── 报告 ──────────────────────────────

const pct = v => (v * 100).toFixed(1) + '%';
const ranged = g => `${pct(g.rate)} [${pct(g.lo)}–${pct(g.hi)}]`;

// 终端里中文/全角字符占 2 列，而 padEnd 按「字符数」补空格 —— 混排时列会错位
// （键里既有「日主=甲」也有「领域方向=career/unfavorable」，宽度差一倍多）。
const CJK = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const dispWidth = s => [...s].reduce((w, ch) => w + (CJK.test(ch) ? 2 : 1), 0);
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - dispWidth(s)));

function report(r, min) {
  const L = [];
  L.push('══════ badcase 归因分析 ══════\n');
  L.push(`反馈总数 ${r.total} 条 | 已评分 ${r.rated}（准 ${r.good} / 不准 ${r.bad}）| 未评 ${r.unrated}`);
  L.push(`不准率（全量）${pct(r.baselineAll.p)}  ·  不准率（可归因 ${r.withAttribution} 条，判定用此值）${pct(r.baseline.p)}`);
  L.push(`  判定基线 95% 区间 ${pct(r.baseline.lo)}–${pct(r.baseline.hi)}`);
  if (r.badLines) L.push(`⚠️ feedback.jsonl 有 ${r.badLines} 行解析失败`);

  if (r.orphans) {
    L.push('');
    L.push(`⚠️ ${r.orphans} 条反馈缺少归因快照（多为归档已被删除），这些样本无法参与分组分析。`);
    L.push('   上面两个不准率的差就来自它们：孤儿只计入全量统计，不进分组判定。');
    L.push('   （判定必须分子分母同源 —— 否则孤儿会把基线抬高，让所有组都更难被判定。）');
    L.push('   修法见 server.js 的 buildAttribution：新反馈会自带快照，历史孤儿无法回填。');
  }

  if (r.rated < 5) {
    L.push('');
    L.push('── 结论 ──');
    L.push(`已评分样本仅 ${r.rated} 条，**任何分组结论都是噪声**。这个工具现在只能验证链路，不能产出命理结论。`);
    L.push('先攒数据：多用几次 → 在报告下方点「有帮助 / 不准」→ 尤其要填「补充真实情况」。');
  }

  L.push('');
  L.push(`── 盘面/判定分组（共 ${r.groupCount} 个维度取值，其中 ${r.judgedCount} 个样本数 ≥${min}）──`);
  if (!r.groupCount) {
    L.push('   暂无可分组的样本（所有反馈都缺归因快照）。先产生几条带快照的新反馈。');
  } else if (!r.judged.length) {
    L.push('   没有任一组的样本数达到阈值，全部只列不判：');
  }
  const rows = (r.judged.length ? r.judged : r.underMin).slice(0, 25);
  const w = Math.max(12, ...rows.map(g => dispWidth(g.key)));
  for (const g of rows) {
    const mark = g.suspicious ? '⚠️ ' : '   ';
    const note = g.n < min ? `（n=${g.n} < ${min}，不判定）` : '';
    L.push(`${mark}${padTo(g.key, w)} n=${String(g.n).padStart(3)} 不准 ${ranged(g)}${note}`);
  }

  if (r.judged.length) {
    L.push('');
    L.push('── 可疑组（下界仍高于全局不准率）──');
    if (!r.flagged.length) {
      L.push('   无。按当前数据，没有哪一类盘面/判定的不准率显著高于平均。');
    } else {
      for (const g of r.flagged) L.push(`   ⚠️ ${g.key}  n=${g.n} 不准 ${ranged(g)}  ·  为基线的 ${g.lift.toFixed(1)} 倍`);
    }
    L.push('');
    L.push(`⚠️ 多重比较提醒：共检验 ${r.judgedCount} 组，即使数据完全随机，`);
    L.push(`   在 α=0.05 下也期望出现约 ${r.expectedFalsePositives} 个「显著」组。`);
    L.push('   以上只是**人工复核的优先级排序**，不是结论，更不要据此自动改规则。');
  }

  if (r.underMin.length) {
    L.push('');
    L.push(`── 样本不足（${r.underMin.length} 组 n<${min}，仅记录不判定）──`);
    L.push(`   ${r.underMin.slice(0, 15).map(g => `${g.key}(${g.n})`).join(' · ')}`);
  }

  // 条文单独一段：它是**输出**侧维度，用途是挑出可疑的知识条目，
  // 不是解释「为什么会错」。混进上面的分组表会造成因果倒置（见 featureKeys 注释）。
  const P = r.passage;
  if (P && P.all.length) {
    L.push('');
    L.push(`── 条文质量信号（引用条文 × 不准率；${P.all.length} 条被引用过，${P.judged.length} 条 n≥${min}）──`);
    L.push('   用途：挑出「被引就容易被判不准」的知识条目（错引/争议/适用范围偏）。');
    L.push('   注意：这是输出侧维度，不能反过来解释「为什么会错」。');
    if (!P.judged.length) {
      L.push(`   尚无条文达到 n≥${min}。RAG 每次引 top-10，而知识库有近 600 条，`);
      L.push('   要让单条条文累积到 5 次引用，需要相当可观的样本量——这是预期内的。');
    } else {
      const prows = P.judged.slice(0, 10);
      const pw = Math.max(12, ...prows.map(g => dispWidth(g.key)));
      for (const g of prows) {
        const mark = g.suspicious ? '⚠️ ' : '   ';
        L.push(`${mark}${padTo(g.key, pw)} n=${String(g.n).padStart(3)} 不准 ${ranged(g)}`);
      }
      if (P.flagged.length) {
        L.push(`   ⚠️ 其中 ${P.flagged.length} 条下界仍高于全局不准率，建议人工复核条文内容。`);
      }
    }
  }

  return L.join('\n');
}

// ────────────────────────────── CLI ──────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const min = Number((argv.find(a => a.startsWith('--min=')) || '').split('=')[1]) || 5;
  const asJson = argv.includes('--json');
  const r = analyze({ min });
  // 刻意不因「发现可疑组」而退出非 0：可疑组只是人工复核的优先级排序，
  // 不是系统缺陷。让 doctor 因它报警，会逼人去处理噪声。
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else console.log(report(r, min));
}

module.exports = { analyze, buildAttribution, featureKeys, wilson, report, FEEDBACK_FILE };
