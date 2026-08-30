/**
 * eval.js — 模型实测评测器（待办 4）
 * 固定测试集 + 自动化质检，对比候选模型。
 * 质检维度：五行格式完整性 / 出处合法性 / 禁止词表 / 免责声明 /
 *          置信度与合成结果一致性 / RAG 降级 / 延迟 / tokens
 * 用法：node src/eval.js [模型名1 模型名2 ...]（默认 deepseek-chat deepseek-reasoner）
 */
const fs = require('fs');
const path = require('path');
const { buildChart } = require('./chart.js');
const { synthesize } = require('./synthesize.js');
const { interpret, validateCitations } = require('./interpret.js');
const { retrieve } = require('./retrieve.js');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ───────── 测试集：覆盖三种典型场景 ─────────
const CASES = [
  { name: 'C1-标准生辰', dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳', domains: ['career', 'wealth', 'marriage'] },
  { name: 'C2-女命流年', dateStr: '1995-6-15', hour: 8, gender: '女', city: '杭州', domains: ['career', 'marriage', 'annual'] },
  { name: 'C3-时辰未知', dateStr: '1988-11-2', hour: null, gender: '男', city: '成都', domains: ['career', 'health'] },
];

const FORBIDDEN = ['必将', '肯定会', '命中注定', '大凶', '血光', '破财之灾', '克夫', '克妻', '牢狱', '一定会', '不可能不'];
const DISCLAIMER = '传统文化/娱乐参考';
const CONF_LABEL = { high: '高（双术一致）', medium: '中（单术）', conditional: '条件式', neutral: '平稳' };

/** 自动质检：返回 {checks: {name: pass}, problems: []} */
function audit(report, chart, domains, synthesis, passages) {
  const checks = {};
  // 1. 五行格式：每领域至少 1 组【结论】+【盘面依据】+【置信度】
  const nConclusion = (report.match(/【结论】/g) || []).length;
  const nBasis = (report.match(/【盘面依据】/g) || []).length;
  const nConf = (report.match(/【置信度】/g) || []).length;
  checks['格式:结论数≥领域数'] = nConclusion >= domains.length;
  checks['格式:依据数=结论数'] = nBasis === nConclusion;
  checks['格式:置信度数=结论数'] = nConf === nConclusion;
  // 2. 出处合法性
  const slim = { bazi: chart.bazi, ziwei: chart.ziwei, meta: chart.meta };
  const citeProblems = passages.length ? validateCitations(report, passages) : [];
  checks['出处:零伪造引用'] = citeProblems.length === 0;
  // 3. 禁止词
  const hitForbidden = FORBIDDEN.filter(w => report.includes(w));
  checks['纪律:禁止词零命中'] = hitForbidden.length === 0;
  // 4. 免责声明
  checks['合规:免责声明'] = report.includes(DISCLAIMER);
  // 5. 置信度与合成一致：每个领域的置信度档位词都应出现在报告中
  let confMatch = true;
  for (const r of (synthesis?.results || [])) {
    const label = CONF_LABEL[r.confidence] || r.confidence;
    const head = label.split('（')[0]; // 高 / 中 / 条件式 / 平稳
    if (!report.includes(head)) confMatch = false;
  }
  checks['互证:置信度档位齐全'] = confMatch;
  // 6. 时辰未知声明
  if (chart.bazi.hourPillarMissing) {
    checks['降级:时辰待定声明'] = report.includes('时辰待定') || report.includes('时辰未定');
  }
  const problems = [];
  if (hitForbidden.length) problems.push('禁止词: ' + hitForbidden.join(','));
  if (citeProblems.length) problems.push('出处违规: ' + citeProblems.slice(0, 3).join('；'));
  return { checks, problems };
}

async function runCase(model, c) {
  const chart = buildChart({ dateStr: c.dateStr, hour: c.hour, gender: c.gender, city: c.city });
  const synthesis = synthesize(chart, c.domains);
  const t0 = Date.now();
  const r = await interpret({ chart, domains: c.domains, synthesis, model });
  const latency = ((Date.now() - t0) / 1000).toFixed(1);
  // 复算检索条文（interpret 内部做了一遍，这里为审计取同集合）
  const { slimChart } = require('./interpret.js');
  const passages = retrieve(slimChart(chart), c.domains, 10);
  const { checks, problems } = audit(r.report, chart, c.domains, synthesis, r.rag ? passages : []);
  const passCount = Object.values(checks).filter(Boolean).length;
  return {
    model, case: c.name, latency, tokens: r.usage?.total_tokens ?? '-',
    rag: r.rag, degraded: !!r.degraded,
    score: `${passCount}/${Object.keys(checks).length}`,
    checks, problems, report: r.report,
  };
}

async function main() {
  loadEnv();
  const models = process.argv.slice(2).length ? process.argv.slice(2) : ['deepseek-chat', 'deepseek-reasoner'];
  const all = [];
  for (const model of models) {
    console.log(`\n======== 模型: ${model} ========`);
    for (const c of CASES) {
      process.stdout.write(`运行 ${c.name} ... `);
      try {
        const r = await runCase(model, c);
        all.push(r);
        const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
        console.log(`${r.score} | ${r.latency}s | ${r.tokens} tokens${failed.length ? ' | 失败项: ' + failed.join(', ') : ' | 全部通过'}`);
        if (r.problems.length) console.log('   问题:', r.problems.join(' | '));
      } catch (e) {
        console.log('出错:', e.message.slice(0, 150));
        all.push({ model, case: c.name, error: e.message.slice(0, 200), score: 'ERR', checks: {}, problems: [e.message], latency: '-', tokens: '-', rag: '-', degraded: '-', report: '' });
      }
    }
  }

  // 汇总
  console.log('\n======== 汇总 ========');
  const byModel = {};
  for (const r of all) {
    byModel[r.model] = byModel[r.model] || { pass: 0, total: 0, latency: [], tokens: [], degraded: 0, errors: 0 };
    const m = byModel[r.model];
    if (r.error) { m.errors++; continue; }
    const [p, t] = r.score.split('/').map(Number);
    m.pass += p; m.total += t;
    m.latency.push(parseFloat(r.latency));
    if (r.rag === false) m.degraded++;
    if (typeof r.tokens === 'number') m.tokens.push(r.tokens);
  }
  for (const [model, m] of Object.entries(byModel)) {
    const avgLat = m.latency.length ? (m.latency.reduce((a, b) => a + b, 0) / m.latency.length).toFixed(1) : '-';
    const avgTok = m.tokens.length ? Math.round(m.tokens.reduce((a, b) => a + b, 0) / m.tokens.length) : '-';
    console.log(`${model}: 质检通过率 ${m.pass}/${m.total} (${Math.round(m.pass / m.total * 100)}%) | 平均延迟 ${avgLat}s | 平均 tokens ${avgTok} | RAG降级 ${m.degraded} 次 | 错误 ${m.errors}`);
  }

  // 写报告
  const outDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const lines = [
    `# 模型实测报告（${new Date().toISOString().slice(0, 10)}）`,
    '',
    '> 评测器：src/eval.js（自动化质检，非 MingLi-Bench 官方集；MingLi-Bench 对接待知识库扩充后进行）',
    '> 测试集：3 个场景（标准生辰 / 女命含流年 / 时辰未知降级）',
    '',
    '| 模型 | 质检通过率 | 平均延迟 | 平均tokens | RAG降级 |',
    '|---|---|---|---|---|',
  ];
  for (const [model, m] of Object.entries(byModel)) {
    const avgLat = m.latency.length ? (m.latency.reduce((a, b) => a + b, 0) / m.latency.length).toFixed(1) + 's' : '-';
    const avgTok = m.tokens.length ? Math.round(m.tokens.reduce((a, b) => a + b, 0) / m.tokens.length) : '-';
    lines.push(`| ${model} | ${m.pass}/${m.total}（${Math.round(m.pass / m.total * 100)}%） | ${avgLat} | ${avgTok} | ${m.degraded} 次 |`);
  }
  lines.push('', '## 分项明细', '');
  for (const r of all) {
    lines.push(`### ${r.model} · ${r.case}（${r.score}，${r.latency}s，${r.tokens} tokens）`);
    if (r.error) { lines.push(`- 出错：${r.error}`); continue; }
    lines.push('| 检查项 | 结果 |', '|---|---|');
    for (const [k, v] of Object.entries(r.checks)) lines.push(`| ${k} | ${v ? '✅' : '❌'} |`);
    if (r.problems.length) lines.push(`- 问题：${r.problems.join('；')}`);
    lines.push('', '<details><summary>报告全文</summary>', '', r.report, '', '</details>', '');
  }
  const outPath = path.join(outDir, `model-eval-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('\n报告已写入:', outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
