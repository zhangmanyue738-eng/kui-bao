/**
 * rag-check.js — 排查 RAG 降级根因：retrieve.js 到底从 slimChart 里提取到了哪些检索词。
 *
 * 背景：eval 里 deepseek-chat 出现 RAG 降级 1 次（此前 0 次），同期刚把检索词
 * 从 soul/body 改成 mingZhu/shenZhu。不能靠「取值相同所以等价」的推理下结论，
 * 必须实测：slimChart（真正喂给 retrieve 的结构）里到底有没有这些键、星曜词是否取到。
 *
 * 用法：node tools/rag-check.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { buildChart } = require(path.join(ROOT, 'src', 'chart.js'));
const { slimChart } = require(path.join(ROOT, 'src', 'interpret.js'));
// 直接调真实函数，不在这里复刻一份逻辑（复刻 = 测了个寂寞，bug 就是这么藏过去的）
const { extractQueryTerms } = require(path.join(ROOT, 'src', 'retrieve.js'));

const CASES = [
  { name: '佳木斯 2000-08-16 23:00', input: { dateStr: '2000-8-16', hour: 23, gender: 'male', city: '佳木斯' } },
  { name: '深圳 1988-07-01 10:00', input: { dateStr: '1988-7-1', hour: 10, gender: 'female', city: '深圳' } },
  { name: '杭州 1995-03-20 08:00', input: { dateStr: '1995-3-20', hour: 8, gender: 'female', city: '杭州' } },
  { name: '西安 1966-09-09 时辰未知', input: { dateStr: '1966-9-9', hour: null, gender: 'male', city: '西安' } },
];

/**
 * 列出盘面里「应该进检索词池」的紫微星曜名（去重）。
 * 判据不能用条目数：terms 是 Set，星曜重复出现会去重，条目数只是上界。
 * 正确判据是逐个名字核验 —— 缺任何一个都说明链路断了。
 */
function expectedZiweiNames(zw) {
  const names = new Set();
  if (!zw || zw.skipped) return names;
  const palaces = zw.palaces || Object.values(zw.keyPalaces || {}).filter(Boolean);
  const strip = s => (typeof s === 'string'
    ? s.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim()
    : (s && s.name));
  for (const p of palaces) {
    const pn = p.name || p.palace;
    if (pn) names.add(pn);
    for (const s of (p.majorStars || [])) { const n = strip(s); if (n) names.add(n); }
    for (const s of (p.minorStars || [])) { const n = strip(s); if (n) names.add(n); }
  }
  for (const k of ['mingZhu', 'shenZhu', 'fiveElementsClass']) if (zw[k]) names.add(zw[k]);
  return names;
}

let problems = 0;
for (const c of CASES) {
  const chart = buildChart({
    ...c.input,
    sect: { zishi: 'midnight', leap: 'normal', school: 'zi_ping' },
    confirmed: { city: true, dst: true, zishi: true, lunar: true },
  });
  const slim = slimChart(chart);
  const zwFull = chart.ziwei;
  const zwSlim = slim.ziwei;

  console.log(`\n───── ${c.name} ─────`);
  // 真实调用：这是唯一能证明「检索链路没断」的方式
  const { featureTerms, domainTerms } = extractQueryTerms(slim, ['career', 'wealth', 'marriage']);
  console.log(`  真实 featureTerms 共 ${featureTerms.length} 个`);
  console.log(`  → [${featureTerms.join(' ')}]`);

  if (zwSlim.skipped) {
    console.log('  紫微跳过（时辰未知），八字单术路径');
  } else {
    console.log(`  命主=${zwSlim.mingZhu} 身主=${zwSlim.shenZhu} 命宫主星=${JSON.stringify(zwSlim.mingGongStars)} 五行局=${zwSlim.fiveElementsClass}`);
    const expect = expectedZiweiNames(zwSlim);
    const featSet = new Set(featureTerms);
    const domSet = new Set(domainTerms);
    const missing = [...expect].filter(n => !featSet.has(n));
    // 被领域词挡掉的（如「禄存」在 wealth 词表里）属设计内：走轻度加权而非特征累加
    const byDomain = missing.filter(n => domSet.has(n));
    const realMissing = missing.filter(n => !domSet.has(n));
    console.log(`  应进池 ${expect.size} 个星曜/宫位名 → 实进 ${expect.size - missing.length} 个`);
    if (byDomain.length) console.log(`  · 被领域词挡下（设计内，走加权）：${byDomain.join(' ')}`);
    if (realMissing.length) {
      console.log(`  ❌ 真正丢失：${realMissing.join(' ')}`);
      problems++;
    } else {
      console.log('  ✅ 紫微星曜/宫位检索词全部进池');
    }
  }

  // 八字侧健全性：日主与调候组合词必须在
  const b = slim.bazi;
  const mustHave = [b.dayMaster.gan, b.dayMaster.wuxing];
  if (b.pillars.month) mustHave.push(b.dayMaster.gan + '日干生于' + b.pillars.month[1] + '月');
  const miss = mustHave.filter(t => !featureTerms.includes(t));
  if (miss.length) { console.log(`  ❌ 八字侧缺词: ${miss.join(' ')}`); problems++; }
  else console.log(`  ✅ 八字侧关键词齐全（日主 ${b.dayMaster.gan}、调候组合词）`);
}

console.log(`\n===== ${problems === 0 ? '未发现裁剪层丢词' : `发现 ${problems} 处星曜检索词丢失 —— 这是 RAG 降级的真实根因候选`} =====`);
process.exit(0);
