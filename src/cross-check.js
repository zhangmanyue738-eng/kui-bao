/**
 * cross-check.js — 跨实现对拍（Node lunar-javascript × Python lunar-python）
 * 两个独立实现算同一批日期的四柱/纳音/大运，逐字段比对。
 * 价值：能抓出「调用层理解错误」「版本差异」「子时/换日处理差异」等单侧自检发现不了的问题。
 * 用法：node src/cross-check.js [样本数]   默认 1000
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { Solar } = require('lunar-javascript');

const PY = '/Users/yanqiu/.workbuddy/binaries/python/envs/default/bin/python';

// 固定种子的伪随机（LCG），保证两侧样本可复现
function makeItems(n) {
  let seed = 20260830;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const items = [];
  for (let i = 0; i < n; i++) {
    const y = 1950 + Math.floor(rnd() * 76);
    const m = 1 + Math.floor(rnd() * 12);
    const dmax = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = 1 + Math.floor(rnd() * dmax);
    const h = Math.floor(rnd() * 24);
    const g = rnd() > 0.5 ? '男' : '女';
    items.push({ key: `${y}-${m}-${d}-${h}-${g}`, y, m, d, h, g });
  }
  return items;
}

function nodeSide(items) {
  return items.map(it => {
    const ec = Solar.fromYmdHms(it.y, it.m, it.d, it.h, 0, 0).getLunar().getEightChar();
    const yun = ec.getYun(it.g === '男' ? 1 : 0);
    return {
      key: it.key,
      year: ec.getYear(), month: ec.getMonth(), day: ec.getDay(), hour: ec.getTime(),
      dayGan: ec.getDayGan(),
      naYin: [ec.getYearNaYin(), ec.getMonthNaYin(), ec.getDayNaYin(), ec.getTimeNaYin()],
      dayun: yun.getDaYun().slice(0, 6).map(dy => dy.getGanZhi()),
      startYear: yun.getStartYear(),
    };
  });
}

function main() {
  const n = Number(process.argv[2] || 1000);
  const items = makeItems(n);
  console.log(`跨实现对拍：${n} 个样本（lunar-javascript × lunar-python）\n`);

  const nodeRes = nodeSide(items);
  let pyRes;
  try {
    const out = execFileSync(PY, [path.join(__dirname, 'cross_check_bazi.py')], {
      input: JSON.stringify(items), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    });
    pyRes = JSON.parse(out);
  } catch (e) {
    console.error('Python 侧执行失败:', (e.stderr || e.message).slice(0, 500));
    process.exit(1);
  }

  const pyMap = {};
  for (const r of pyRes) pyMap[r.key] = r;

  const fields = ['year', 'month', 'day', 'hour', 'dayGan'];
  const stats = {};
  for (const f of fields) stats[f] = { pass: 0, fail: 0 };
  stats['naYin'] = { pass: 0, fail: 0 };
  stats['dayun'] = { pass: 0, fail: 0 };
  stats['startYear'] = { pass: 0, fail: 0 };
  const failures = [];

  for (const nr of nodeRes) {
    const pr = pyMap[nr.key];
    if (!pr) { failures.push(`${nr.key}: Python 侧无结果`); continue; }
    for (const f of fields) {
      if (nr[f] === pr[f]) stats[f].pass++;
      else {
        stats[f].fail++;
        if (failures.length < 30) failures.push(`${nr.key} ${f}: node=${nr[f]} python=${pr[f]}`);
      }
    }
    const naOk = JSON.stringify(nr.naYin) === JSON.stringify(pr.naYin);
    naOk ? stats.naYin.pass++ : (stats.naYin.fail++, failures.length < 30 && failures.push(`${nr.key} naYin: ${nr.naYin} vs ${pr.naYin}`));
    const dyOk = JSON.stringify(nr.dayun.filter(Boolean)) === JSON.stringify(pr.dayun.filter(Boolean));
    dyOk ? stats.dayun.pass++ : (stats.dayun.fail++, failures.length < 30 && failures.push(`${nr.key} dayun: ${nr.dayun.join(',')} vs ${pr.dayun.join(',')}`));
    if (nr.startYear === pr.startYear) stats.startYear.pass++;
    else { stats.startYear.fail++; failures.length < 30 && failures.push(`${nr.key} startYear: ${nr.startYear} vs ${pr.startYear}`); }
  }

  console.log('字段'.padEnd(14) + '一致'.padStart(8) + '不一致'.padStart(8) + '  一致率');
  console.log('-'.repeat(46));
  let tp = 0, ta = 0;
  for (const [f, v] of Object.entries(stats)) {
    const rate = ((v.pass / (v.pass + v.fail)) * 100).toFixed(2);
    tp += v.pass; ta += v.pass + v.fail;
    console.log(f.padEnd(14) + String(v.pass).padStart(8) + String(v.fail).padStart(8) + `  ${rate}%`);
  }
  console.log('-'.repeat(46));
  console.log(`合计 ${tp}/${ta}（${((tp / ta) * 100).toFixed(2)}%）`);
  if (failures.length) {
    console.log('\n不一致明细：');
    failures.forEach(f => console.log('  ' + f));
  } else {
    console.log('\n✅ 两个独立实现结果完全一致');
  }
  process.exit(failures.length ? 1 : 0);
}

main();
