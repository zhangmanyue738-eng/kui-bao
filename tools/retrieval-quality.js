/**
 * retrieval-quality.js — 检索质量量化：区分度 + 盘面特征命中率
 *
 * 为什么要这个脚本：DOMAIN_TERMS 里混进了「命宫/官禄/财帛/夫妻/田宅/武曲/破军/
 * 七杀/禄存」这类**具体的宫位名与星曜**，它们同时是盘面特征，却被
 * `!domainTerms.has(t)` 从特征词池里剔除，只拿到 min(dHits,3)*0.5 的封顶领域加权。
 * 怀疑紫微侧最有区分度的信号被降格成了背景噪声。
 *
 * 但「改了会显著改变检索分布」——所以必须先量化，改完用同一脚本复测对比，
 * 不能凭感觉改。
 *
 * 两个指标：
 *  ① 区分度：不同命盘检索结果的平均两两 Jaccard 相似度。**越低越好**。
 *     原设计用领域词封顶，就是为了防止不同命盘检索结果雷同。
 *  ② 特征命中率：检索到的条文里，真正命中盘面特征词（星曜/宫位/日主/调候组合）
 *     的比例。**越高越好**。领域词是通用概念（事业/财富），命中的话没区分度。
 *
 * 用法：node tools/retrieval-quality.js
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { buildChart } = require(path.join(ROOT, 'src', 'chart.js'));
const { slimChart } = require(path.join(ROOT, 'src', 'interpret.js'));

// LEGACY=1 时加载改动前的版本做对比。注意：**从 git 提取真实旧版**，
// 不在脚本里复刻旧逻辑——复刻一份去对比等于没对比（检索词归零就是这么藏过去的）。
//
// 这里自动提取而不是要求手工执行 `git show ... > tmp`：手工步骤会失忆，
// 隔几天回来跑对比，要么临时文件早被删了报 MODULE_NOT_FOUND，
// 要么留着一份过期的副本却以为在对比最新版。自动提取保证每次都是干净的。
// 用 LEGACY_REF 指定基准（默认 HEAD，即「当前已提交的版本」）。
const LEGACY_TMP = path.join(ROOT, 'src', '.retrieve-legacy.tmp.js');
function resolveRetrievePath() {
  if (!process.env.LEGACY) return path.join(ROOT, 'src', 'retrieve.js');
  const ref = process.env.LEGACY_REF || 'HEAD';
  try {
    const src = execFileSync('git', ['show', `${ref}:src/retrieve.js`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.writeFileSync(LEGACY_TMP, src);
    return LEGACY_TMP;
  } catch (e) {
    console.error(`❌ 无法从 git 提取 ${ref}:src/retrieve.js`);
    console.error(`   ${String(e.stderr || e.message).trim().split('\n')[0]}`);
    console.error('   提示：LEGACY_REF=<commit|branch> node tools/retrieval-quality.js');
    process.exit(2);
  }
}
const RETRIEVE_PATH = resolveRetrievePath();
// 临时文件用完即删，否则会残留一份「看起来像源码」的副本在 src/ 下
process.on('exit', () => { try { fs.unlinkSync(LEGACY_TMP); } catch {} });
const { retrieveBalanced, extractQueryTerms } = require(RETRIEVE_PATH);

// 覆盖不同日主、男女、有/无时辰、不同地域，避免样本同质
const CASES = [
  { name: '深圳2000-08-16男14时', input: { dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳' } },
  { name: '杭州1995-06-15女08时', input: { dateStr: '1995-6-15', hour: 8, gender: '女', city: '杭州' } },
  { name: '北京1988-07-01女10时', input: { dateStr: '1988-7-1', hour: 10, gender: '女', city: '北京' } },
  { name: '成都1979-03-21男03时', input: { dateStr: '1979-3-21', hour: 3, gender: '男', city: '成都' } },
  { name: '哈尔滨2001-12-05女20时', input: { dateStr: '2001-12-5', hour: 20, gender: '女', city: '哈尔滨' } },
  { name: '西安1966-09-09男时辰未知', input: { dateStr: '1966-9-9', hour: null, gender: '男', city: '西安' } },
  { name: '佳木斯2000-08-16男23时', input: { dateStr: '2000-8-16', hour: 23, gender: '男', city: '佳木斯' } },
  { name: '喀什1990-11-11女17时', input: { dateStr: '1990-11-11', hour: 17, gender: '女', city: '喀什' } },
];

const DOMAINS = ['career', 'wealth', 'marriage'];

/** 星曜名（用于判断特征命中，与 retrieve 的 starName 同逻辑） */
function starName(s) {
  if (!s) return null;
  if (typeof s === 'string') return s.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim() || null;
  return s.name || null;
}

/**
 * 收集盘面特征词，**按区分度分两类**：
 *   stars —— 星曜（含命主/身主）：不同盘落星不同，命中它有真实区分度
 *   labels —— 宫位名（命宫/财帛/官禄…）：每个盘都有，命中它几乎不含信息量
 *
 * 踩过的坑：一开始把两者混成一个「命中率」，结果星曜权重上去后
 * 挤掉了一些含宫位名的条文，总命中率反而下降，看起来像劣化——
 * 其实是这个指标把「命中命宫」和「命中天府」等权看待了，指标本身有缺陷。
 */
function featureWords(slim) {
  const stars = new Set(), labels = new Set();
  const zw = slim.ziwei;
  if (zw && !zw.skipped) {
    const palaces = zw.palaces || Object.values(zw.keyPalaces || {}).filter(Boolean);
    for (const p of palaces) {
      const pn = p.name || p.palace;
      if (pn) labels.add(pn);
      for (const s of (p.majorStars || [])) { const n = starName(s); if (n) stars.add(n); }
      for (const s of (p.minorStars || [])) { const n = starName(s); if (n) stars.add(n); }
    }
    if (zw.mingZhu) stars.add(zw.mingZhu);
    if (zw.shenZhu) stars.add(zw.shenZhu);
    if (zw.fiveElementsClass) labels.add(zw.fiveElementsClass);
  }
  const b = slim.bazi;
  const bazi = new Set();
  const dm = b.dayMaster;
  if (dm) {
    // 「丙火」是知识库里日主的标准写法（596 条中命中 54 条），有真实区分度。
    // 单字「丙」「火」不收——它们遍地都是，和宫位名一样没有区分度。
    if (dm.gan && dm.wuxing) bazi.add(dm.gan + dm.wuxing);
    // 调候组合：全库唯一精确命中，是八字侧最强的特征词
    if (b.pillars && b.pillars.month) bazi.add(dm.gan + '日干生于' + b.pillars.month[1] + '月');
  }
  return { stars, labels, bazi };
}

/**
 * 统计命中。**分母必须是「进入判定的词」，不是「全部词」** ——
 * 踩过的坑：最初这里 `w.length >= 2 && ...` 只在分子侧过滤，
 * 分母仍用 words.size，于是单字词（天干「丙」/五行「火」）被踢出分子却留在分母，
 * 八字侧覆盖率被结构性锁死在 1/3 = 33.3%，8 个样本数值一模一样。
 * 看起来像「八字侧只有 33%」，实际是指标坏了，真实命中远好于此。
 */
function countHits(words, texts) {
  const eligible = new Set([...words].filter(w => w.length >= 2));
  const hit = new Set();
  let n = 0;
  for (const t of texts) {
    for (const w of eligible) {
      if (t.includes(w)) { hit.add(w); n++; }
    }
  }
  return { hit, n, base: eligible.size };
}

console.log('══════ 检索质量量化 ══════\n');

const runs = [];
for (const c of CASES) {
  const chart = buildChart({
    ...c.input,
    sect: { zishi: 'midnight', leap: 'normal', school: 'zi_ping' },
    confirmed: { city: true, dst: true, zishi: true, lunar: true },
  });
  const slim = slimChart(chart);
  const { featureTerms, domainTerms } = extractQueryTerms(slim, DOMAINS);
  const passages = retrieveBalanced(slim, DOMAINS, 10);
  const { stars, labels, bazi } = featureWords(slim);
  const texts = passages.map(p => p.text);

  const sh = countHits(stars, texts);
  const lh = countHits(labels, texts);
  const bh = countHits(bazi, texts);

  // 真正被领域词挡下的：在特征池里找不到、且命盘上真实存在的特征词。
  // 注意要查 featureTerms（已经过 starTerms 放行逻辑），不能只看 domainTerms。
  const featSet = new Set(featureTerms);
  const blockedStars = [...stars].filter(w => !featSet.has(w));

  runs.push({
    name: c.name,
    ids: passages.map(p => p.id),
    starRatio: sh.base ? sh.hit.size / sh.base : null,
    // 命中强度：平均每条检索条文命中几个星曜。覆盖率用 Set 会丢掉这个信息——
    // 实测出现过「覆盖率不变、命中次数 9→16」的情况，改善恰恰在强度上。
    starDensity: passages.length ? sh.n / passages.length : null,
    labelRatio: lh.base ? lh.hit.size / lh.base : null,
    baziRatio: bh.base ? bh.hit.size / bh.base : null,
    blockedStars,
    featTerms: featureTerms.length,
    domTerms: domainTerms.length,
    nPassages: passages.length,
    nStars: stars.size,
  });

  const pct = r => (r === null ? '  - ' : String(Math.round(r * 100)).padStart(3) + '%');
  console.log(`── ${c.name}`);
  console.log(`   检索 ${passages.length} 条 | 特征池 ${featureTerms.length} 词 | 领域词 ${domainTerms.length}`);
  console.log(`   星曜：覆盖 ${sh.hit.size}/${sh.base} = ${pct(runs.at(-1).starRatio)}` +
    ` | 命中强度 ${runs.at(-1).starDensity.toFixed(2)} 星/条 ← 关键` +
    ` | 宫位名 ${lh.hit.size}/${lh.base} = ${pct(runs.at(-1).labelRatio)}（参考）` +
    ` | 八字侧 ${bh.hit.size}/${bh.base} = ${pct(runs.at(-1).baziRatio)}（参考）`);
  if (blockedStars.length) console.log(`   ⚠️ 星曜被领域词挡下：${blockedStars.join(' ')}`);
}

// 区分度：两两 Jaccard
let sum = 0, n = 0, maxSim = 0, maxPair = '';
for (let i = 0; i < runs.length; i++) {
  for (let j = i + 1; j < runs.length; j++) {
    const A = new Set(runs[i].ids), B = new Set(runs[j].ids);
    const inter = [...A].filter(x => B.has(x)).length;
    const union = new Set([...A, ...B]).size;
    const sim = union ? inter / union : 0;
    sum += sim; n++;
    if (sim > maxSim) { maxSim = sim; maxPair = `${runs[i].name} × ${runs[j].name}`; }
  }
}
const avgSim = sum / n;
const mean = key => {
  const v = runs.map(r => r[key]).filter(x => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const avgStar = mean('starRatio');
const avgDensity = mean('starDensity');
const avgLabel = mean('labelRatio');
const avgBazi = mean('baziRatio');
const allBlocked = [...new Set(runs.flatMap(r => r.blockedStars))];

console.log('\n══════ 汇总 ══════');
console.log(`区分度（两两 Jaccard 平均）：${avgSim.toFixed(3)}  ← 越低越好`);
console.log(`  最相似的一对：${maxPair} = ${maxSim.toFixed(3)}`);
console.log(`星曜覆盖率（越高越好）：${(avgStar * 100).toFixed(1)}%`);
console.log(`星曜命中强度（越高越好）：${avgDensity.toFixed(2)} 星/条  ← 关键指标`);
console.log(`宫位名覆盖率（参考）：${(avgLabel * 100).toFixed(1)}%`);
console.log(`八字段覆盖率（参考）：${(avgBazi * 100).toFixed(1)}%`);
console.log(`星曜被领域词挡下：${allBlocked.length ? '⚠️ ' + allBlocked.join(' ') : '无 ✅'}`);
console.log('\n判据：区分度↓ 且 命中强度↑ = 净改善（覆盖率可能微调，因 top-10 位置有限）。');
console.log('对比：LEGACY=1 node tools/retrieval-quality.js   （基准默认 HEAD，LEGACY_REF 可指定）');
if (process.env.LEGACY) console.log(`注：本轮基准为 ${process.env.LEGACY_REF || 'HEAD'} 版 retrieve.js（自动从 git 提取）`);
