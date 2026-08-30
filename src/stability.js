/**
 * stability.js — 输出稳定性测试
 * 同一生辰重复跑 N 次，检查：
 *   1. 各领域「结论方向 + 置信度档位」是否一致（合成层本应确定性，LLM 措辞可变但结论档位不应变）
 *   2. 报告中是否出现禁止词（任何一次都不允许）
 *   3. 出处引用是否每次都合法
 * 用法：node src/stability.js [次数] [模型]   默认 3 次 / deepseek-chat
 */
const { buildChart } = require('./chart.js');
const { synthesize } = require('./synthesize.js');
const { interpret, slimChart, validateOutput } = require('./interpret.js');
const { retrieveBalanced } = require('./retrieve.js');

const FORBIDDEN = ['必将', '肯定会', '命中注定', '大凶', '血光', '破财之灾', '克夫', '克妻', '牢狱'];

const CASES = [
  { name: 'C1-标准', dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳', domains: ['career', 'wealth', 'marriage'] },
  { name: 'C2-女命', dateStr: '1995-6-15', hour: 8, gender: '女', city: '杭州', domains: ['career', 'marriage'] },
];

/**
 * 提取置信度档位分布（各档位出现次数）
 * 稳定性定义：档位「种类」每次必须一致
 * （模型措辞与论断条数允许浮动，但结论档位不得自行调级）
 */
function confidenceProfile(report) {
  const counts = {};
  for (const m of report.matchAll(/【置信度】\s*([高中]|条件式|平稳)/g)) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}
const profileKey = p => Object.keys(p).sort().join('+');
const profileStr = p => Object.entries(p).map(([k, v]) => `${k}×${v}`).join(' ');

async function main() {
  const n = Number(process.argv[2] || 3);
  const model = process.argv[3] || 'deepseek-chat';
  console.log(`稳定性测试：${CASES.length} 个命盘 × ${n} 次（模型 ${model}）\n`);

  let totalRuns = 0, failedCite = 0, forbiddenHits = 0, inconsistent = 0;
  for (const c of CASES) {
    const chart = buildChart({ dateStr: c.dateStr, hour: c.hour, gender: c.gender, city: c.city });
    const synthesis = synthesize(chart, c.domains);
    const passages = retrieveBalanced(slimChart(chart), c.domains, 10);
    const profiles = [];
    for (let i = 0; i < n; i++) {
      const r = await interpret({ chart, domains: c.domains, synthesis, model });
      totalRuns++;
      const prof = confidenceProfile(r.report);
      profiles.push(prof);
      if (r.rag) {
        const problems = validateOutput(r.report, passages, synthesis);
        if (problems.length) { failedCite++; console.log(`  ⚠️ ${c.name} 第${i + 1}次 出处违规: ${problems[0]}`); }
      }
      const hit = FORBIDDEN.filter(w => r.report.includes(w));
      if (hit.length) { forbiddenHits++; console.log(`  ⚠️ ${c.name} 第${i + 1}次 命中禁止词: ${hit.join(',')}`); }
      process.stdout.write(`  ${c.name} 第${i + 1}/${n} 次完成（${r.usage?.total_tokens ?? '-'} tokens）\n`);
    }
    const kinds = new Set(profiles.map(profileKey));
    if (kinds.size > 1) {
      inconsistent++;
      console.log(`  ❌ ${c.name} 结论档位不一致：${profiles.map(p => '[' + profileStr(p) + ']').join(' vs ')}`);
    } else {
      console.log(`  ✅ ${c.name} 档位种类 ${n} 次一致（${[...kinds][0]}）：${profiles.map(profileStr).join(' / ')}`);
    }
  }

  console.log('\n======== 稳定性汇总 ========');
  console.log(`总运行 ${totalRuns} 次 | 结论档位不一致 ${inconsistent}/${CASES.length} 个命盘 | 出处违规 ${failedCite} 次 | 禁止词命中 ${forbiddenHits} 次`);
  const ok = inconsistent === 0 && failedCite === 0 && forbiddenHits === 0;
  console.log(ok ? '✅ 稳定性通过（结论档位可复现、出处合法、无禁止词）' : '❌ 存在不稳定或不合规输出');
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
