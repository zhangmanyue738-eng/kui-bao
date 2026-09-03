/**
 * badcase-selftest.js — badcase 归因逻辑自检（合成数据）
 *
 * 为什么需要这个：
 *   analyze() 里的 suspicious 判定（n≥阈值 且 Wilson **下界** > 全局基线）
 *   在真实样本攒够之前**根本跑不到**——几十条 feedback 才可能触发，
 *   而现在只有个位数。不注入合成数据，这条分支就是一段「从没执行过的代码」，
 *   等真数据攒够了才发现它算错了，代价太大。
 *
 *   同理，下面这几件事也只能在合成数据上验证：
 *     · 「点估计高于基线、但下界不够」的组**不该**被判定 —— 这正是用下界而非点估计的意义
 *     · 多重比较期望假阳性数
 *     · 孤儿 / 坏行 / 条文段的独立统计
 *
 * 用法：node tools/badcase-selftest.js [--verbose]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze, featureKeys, wilson } = require('../src/badcase.js');

const VERBOSE = process.argv.includes('--verbose');
const TMP = path.join(os.tmpdir(), `badcase-fixture-${process.pid}.jsonl`);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
}
const near = (a, b, eps = 0.005) => Math.abs(a - b) < eps;

// ─────────────────────────── 构造 fixture ───────────────────────────
// 设计目标（总数 48，bad 17 → 基线 ≈35.4%）：
//   组 A「日主=甲 / career=conflict」n=12  bad=11  → 91.7%，下界 64.6% >> 基线  → 应 flagged
//   组 C「日主=乙 / career=single-method」n=6 bad=4 → 66.7%，下界 30.0% <  基线  → **不应** flagged
//      ↑ 组 C 是关键用例：点估计 66.7% 几乎是基线 35.4% 的两倍，看起来「很可疑」，
//        但 n=6 时这个估计的置信区间是 [30%, 86%]，下界够不着基线。
//        用点估计就会误判，用下界才守得住。
//   其余 30 条「career=consistent」bad=2 → 把基线压在 35% 附近
function mk(n, { dayMaster, verdict, bad, passages = [] }) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const isBad = i < bad;
    rows.push({
      ts: new Date().toISOString(),
      rating: isBad ? 'bad' : 'good',
      sessionId: `S-FIX-${i}`,
      attribution: {
        dayMaster, dayMasterWx: null, hourMissing: false, mingZhu: null,
        mingGongStars: [], fiveElementsClass: null, ziweiSkipped: false,
        domains: [{ domain: 'career', direction: 'unfavorable', verdict, confidence: 'medium' }],
        passages, model: null, degraded: false, sectStamp: null,
      },
    });
  }
  return rows;
}

function buildFixture() {
  const rows = [
    ...mk(12, { dayMaster: '甲', verdict: 'conflict', bad: 11, passages: ['KB-TEST-1'] }),
    ...mk(6, { dayMaster: '乙', verdict: 'single-method', bad: 4 }),
    ...mk(30, { dayMaster: null, verdict: 'consistent', bad: 2 }),
    // 单样本组：用来验证「最小样本阈值」确实拦得住噪声
    // （没有它的话所有组 n 都 ≥5，min=1 与 min=5 的分组数完全相同，那条断言就形同虚设）
    ...mk(1, { dayMaster: '癸', verdict: 'consistent', bad: 1 }),
  ];
  // 孤儿：有 sessionId 但没有 attribution（历史反馈的典型形态）
  rows.push({ ts: 'x', rating: 'bad', sessionId: 'S-ORPHAN-1', comment: '归档已删' });
  rows.push({ ts: 'x', rating: 'good', sessionId: 'S-ORPHAN-2' });
  return rows;
}

function writeFixture(rows, { brokenLines = 0 } = {}) {
  const parts = rows.map(r => JSON.stringify(r));
  for (let i = 0; i < brokenLines; i++) parts.push('{ 这不是合法 JSON');
  fs.writeFileSync(TMP, parts.join('\n') + '\n');
}

// ─────────────────────────── 检查 ───────────────────────────
console.log('══════ badcase 归因自检（合成数据）══════\n');

// ① Wilson 区间本身的性质
console.log('── ① Wilson 区间 ──');
{
  const w01 = wilson(0, 1);
  check('wilson(0,1) 上界远大于 0（0/1 不等于 0% 风险）', w01.hi > 0.5, `hi=${w01.hi.toFixed(3)}`);
  check('wilson(0,1) 区间不越界', w01.lo >= 0 && w01.hi <= 1);
  const w11 = wilson(1, 1);
  check('wilson(1,1) 下界远小于 1（1/1 不等于 100%）', w11.lo < 0.3, `lo=${w11.lo.toFixed(3)}`);
  // n=1000、p=0.5 时理论半宽 = 1.96*sqrt(0.25/1000) = 3.10%，总宽 6.19%。
  // （断言别写成「总宽 < 6%」——那是把半宽和总宽搞混了，代码是对的、断言是错的。）
  const wBig = wilson(500, 1000);
  check('大样本下区间收窄（半宽 ≈3.1%）', near((wBig.hi - wBig.lo) / 2, 0.031, 0.002),
    `半宽=${((wBig.hi - wBig.lo) / 2).toFixed(4)}，理论 0.0310`);
  check('大样本区间以 0.5 为中心', near((wBig.hi + wBig.lo) / 2, 0.5, 0.002));
  const wN0 = wilson(0, 0);
  check('n=0 不抛错且给出最宽区间', wN0.lo === 0 && wN0.hi === 1);
}

// ② 主分组判定
console.log('\n── ② 可疑组判定（核心分支）──');
let r;
{
  writeFixture(buildFixture());
  r = analyze({ min: 5, file: TMP });

  check('总数 51（49 条带快照 + 2 条孤儿）', r.total === 51, `实际 ${r.total}`);
  check('已评分 51', r.rated === 51, `实际 ${r.rated}`);
  check('孤儿识别为 2', r.orphans === 2, `实际 ${r.orphans}`);
  check('带快照 49', r.withAttribution === 49, `实际 ${r.withAttribution}`);
  // 判定基线只按带快照的 49 条算（18/49），不按全量 51 条（19/51）——分子分母必须同源。
  // bad 明细：组 A 11 + 组 C 4 + consistent 2 + 单样本癸 1 = 18；再加孤儿里的 1 条 = 19
  check('判定基线 = 带快照集合的 18/49 ≈36.7%', near(r.baseline.p, 18 / 49),
    `实际 ${(r.baseline.p * 100).toFixed(1)}%`);
  check('全量基线 19/51 ≈37.3%（含孤儿，仅供展示）', near(r.baselineAll.p, 19 / 51),
    `实际 ${(r.baselineAll.p * 100).toFixed(1)}%`);
  check('两个基线确实不同（证明孤儿没混进判定）', !near(r.baseline.p, r.baselineAll.p));

  const key = k => r.judged.find(g => g.key === k);
  const flaggedKeys = r.flagged.map(g => g.key);

  const A = key('日主=甲');
  check('组 A（日主=甲 n=12 bad=11）存在且达阈值', !!A, '未找到');
  if (A) {
    check('  组 A 点估计 91.7%', near(A.rate, 11 / 12), `实际 ${(A.rate * 100).toFixed(1)}%`);
    check('  组 A 被判定可疑', A.suspicious && flaggedKeys.includes('日主=甲'), `suspicious=${A.suspicious}`);
    check('  组 A 下界 ≈64.6% 且高于基线', A.lo > r.baseline.p, `lo=${(A.lo * 100).toFixed(1)}%`);
  }

  const C = key('日主=乙');
  check('组 C（日主=乙 n=6 bad=4）存在且达阈值', !!C, '未找到');
  if (C) {
    check('  组 C 点估计 66.7%，**高于**基线（按点估计会被判可疑）',
      C.rate > r.baseline.p, `点估计 ${(C.rate * 100).toFixed(1)}% vs 基线 ${(r.baseline.p * 100).toFixed(1)}%`);
    check('  组 C **未**被判定（下界够不着基线）', !C.suspicious,
      `lo=${(C.lo * 100).toFixed(1)}% vs 基线 ${(r.baseline.p * 100).toFixed(1)}% —— 判定逻辑没守住`);
    check('  组 C 下界 < 基线（这才是它不被判的原因）', C.lo < r.baseline.p);
  }

  const conf = key('领域判定=career/conflict');
  check('领域判定=career/conflict 同样被 flagged', conf && conf.suspicious, '未找到或未判定');

  // 对照组：consistent 组 bad 率极低，不应被判
  const cons = key('领域判定=career/consistent');
  check('领域判定=career/consistent 未被 flagged（bad 率低于基线）', cons && !cons.suspicious);
}

// ③ 多重比较
console.log('\n── ③ 多重比较提醒 ──');
{
  const expect = +(r.judgedCount * 0.05).toFixed(1);
  check('期望假阳性数 = 判定组数 × 0.05', near(r.expectedFalsePositives, expect, 0.051),
    `报告值 ${r.expectedFalsePositives} vs 期望 ${expect}`);
  check('假阳性期望值随组数增长（K 越大越该警惕）', r.expectedFalsePositives > 0,
    `judgedCount=${r.judgedCount}`);
  console.log(`     当前：${r.judgedCount} 个判定组 → 纯随机时期望 ${r.expectedFalsePositives} 个假阳性`);
}

// ④ 条文段独立统计
console.log('\n── ④ 条文段（独立于盘面分组）──');
{
  const P = r.passage;
  check('条文段存在', !!P);
  check('条文被引用 1 种（KB-TEST-1）', P.all.length === 1, `实际 ${P.all.length}`);
  const t = P.judged.find(g => g.key === '引用条文=KB-TEST-1');
  check('KB-TEST-1 达阈值并被统计', !!t, '未找到');
  if (t) {
    check('  n=12 bad=11', t.n === 12 && t.bad === 11, `n=${t.n} bad=${t.bad}`);
    check('  被 flagged（这条条文有问题信号）', t.suspicious);
  }
  check('条文键未混入主分组（主分组里查不到条文键）',
    !r.judged.some(g => g.key.startsWith('引用条文')), '条文键混进了主分组');
  check('主分组不含条文维度 → 多重比较的 K 不被撑大',
    r.groupCount < 20, `groupCount=${r.groupCount}`);
}

// ⑤ 阈值行为
console.log('\n── ⑤ 最小样本阈值 ──');
{
  const r2 = analyze({ min: 100, file: TMP });
  check('阈值提到 100 后没有任何组被判定', r2.judgedCount === 0 && r2.flagged.length === 0,
    `judged=${r2.judgedCount} flagged=${r2.flagged.length}`);
  const r3 = analyze({ min: 1, file: TMP });
  check('阈值降到 1 后判定组数变多', r3.judgedCount >= r.judgedCount,
    `min=1 → ${r3.judgedCount} 组，min=5 → ${r.judgedCount} 组`);
  check('  min=1 时 n=1 的组会进判定（正是要防的噪声）', r3.judgedCount > r.judgedCount);
}

// ⑥ 坏行与空文件
console.log('\n── ⑥ 健壮性 ──');
{
  writeFixture(buildFixture(), { brokenLines: 2 });
  const r4 = analyze({ file: TMP });
  check('坏行被计数且不中断解析', r4.badLines === 2, `badLines=${r4.badLines}`);
  check('坏行不影响正常行统计', r4.rated === 51, `rated=${r4.rated}`);

  fs.writeFileSync(TMP, '');
  const r5 = analyze({ file: TMP });
  check('空文件：总数 0 且不抛错', r5.total === 0 && r5.rated === 0);
  check('空文件：基线 p=0 且区间最宽', r5.baseline.p === 0 && r5.baseline.hi === 1);

  fs.writeFileSync(TMP, '[]\n');
  const r6 = analyze({ file: TMP });
  check('合法 JSON 但无 rating 字段 → 计入未评、不进分组', r6.rated === 0 && r6.unrated === 1,
    `rated=${r6.rated} unrated=${r6.unrated}`);
}

// ⑦ featureKeys 的 core/passage 拆分
console.log('\n── ⑦ featureKeys 拆分 ──');
{
  const fk = featureKeys({
    dayMaster: '丙', dayMasterWx: '火', hourMissing: true, mingZhu: '巨门',
    mingGongStars: ['天府', '文昌'], fiveElementsClass: '火六局',
    domains: [{ domain: 'career', direction: 'up', verdict: 'conflict', confidence: 'medium' }],
    passages: ['KB-1', 'KB-2'], model: 'm', degraded: false, ziweiSkipped: false,
  });
  check('core 含时辰缺失标记', fk.core.includes('时辰=缺失'));
  check('core 含两颗命宫主星（各自成键）',
    fk.core.includes('命宫主星=天府') && fk.core.includes('命宫主星=文昌'));
  check('core 含领域三元组',
    fk.core.includes('领域方向=career/up') && fk.core.includes('领域判定=career/conflict')
    && fk.core.includes('领域置信度=career/medium'));
  check('passage 独立成数组且不含 core 键',
    fk.passage.length === 2 && fk.passage.every(k => k.startsWith('引用条文=')));
  check('core 里没有条文键', !fk.core.some(k => k.startsWith('引用条文')));
  check('空 attribution → 两个空数组', JSON.stringify(featureKeys(null)) === '{"core":[],"passage":[]}');
}

// ─────────────────────────── 收尾 ───────────────────────────
try { fs.unlinkSync(TMP); } catch {}

if (VERBOSE) {
  console.log('\n── 附：合成数据下的完整报告 ──');
  writeFixture(buildFixture());
  const { report } = require('../src/badcase.js');
  console.log(report(analyze({ file: TMP }), 5));
  try { fs.unlinkSync(TMP); } catch {}
}

console.log(`\n══════ 自检结果：通过 ${pass} / 失败 ${fail} ══════`);
process.exit(fail ? 1 : 0);
