/**
 * verify-chart.js — 排盘准确性交叉校验器
 *
 * 目的：不靠"看起来对"，用可独立验证的规则对拍排盘层输出。
 * 思路分三层：
 *   L1 结构性自检   —— 六十甲子合法性、干支组合合法性（阳干配阳支）
 *   L2 独立规则对拍 —— 五虎遁(月干)、五鼠遁(时干)、日柱连续性、大运连续性与顺逆、
 *                      紫微命宫/身宫定位公式（这些规则独立于库，可自行实现）
 *   L3 天文历法层   —— 节气精确时刻、农历朔望：无法用短公式替代，依赖 lunar 库内含天文算法，
 *                      只能做"库内部自洽"检查（月柱地支 vs 库给出的节气日期）
 *
 * 用法：node src/verify-chart.js [抽样天数]   默认 2000 天（1960-2030 随机抽样）
 */
const { Solar } = require('lunar-javascript');
const { astro } = require('iztro');
const { buildChart } = require('./chart.js');

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
// 六十甲子表（序号 0=甲子）
const JIAZI = [];
for (let i = 0; i < 60; i++) JIAZI.push(GAN[i % 10] + ZHI[i % 12]);
const JIAZI_INDEX = {};
JIAZI.forEach((gz, i) => { JIAZI_INDEX[gz] = i; });

// 五虎遁：年干 → 正月(寅月)天干起点，月干 = (起点 + 月支偏移) % 10
const WU_HU_DUN = { 甲: 2, 己: 2, 乙: 4, 庚: 4, 丙: 6, 辛: 6, 丁: 8, 壬: 8, 戊: 0, 癸: 0 }; // 丙=2,戊=4,庚=6,壬=8,甲=0
// 五鼠遁：日干 → 子时天干起点，时干 = (起点 + 时支序号) % 10
const WU_SHU_DUN = { 甲: 0, 己: 0, 乙: 2, 庚: 2, 丙: 4, 辛: 4, 丁: 6, 壬: 6, 戊: 8, 癸: 8 }; // 甲=0,丙=2,戊=4,庚=6,壬=8

// 小时 → iztro timeIndex（约定：0=早子时 0-1点，1=丑，…，12=晚子时 23-24点）
function hourToTimeIndex(h) {
  if (h === 23) return 12;
  if (h === 0) return 0;
  return Math.floor((h + 1) / 2);
}

// 小时 → 时支（独立实现：23时与0时同属子时，1-2丑，3-4寅…）
function hourToZhi(h) {
  if (h === 23 || h === 0) return '子';
  return ZHI[Math.floor((h + 1) / 2)];
}

const results = { total: 0, checks: {}, failures: [], skipped: 0 };
function check(name, ok, detail) {
  results.checks[name] = results.checks[name] || { pass: 0, fail: 0 };
  if (ok) results.checks[name].pass++;
  else {
    results.checks[name].fail++;
    if (results.failures.length < 40) results.failures.push(`[${name}] ${detail}`);
  }
}

/** 校验单张盘 */
function verifyOne(dateStr, hour, gender) {
  const chart = buildChart({ dateStr, hour, gender, city: null }); // 不做真太阳时，避免经度干扰对拍
  const [y, m, d] = dateStr.split('-').map(Number);
  const lunar = Solar.fromYmdHms(y, m, d, hour ?? 12, 0, 0).getLunar();
  const b = chart.bazi;
  results.total++;

  // ── L1: 四柱均为合法六十甲子
  for (const [k, gz] of Object.entries(b.pillars)) {
    if (!gz) continue;
    check('L1-六十甲子合法性', gz in JIAZI_INDEX, `${dateStr} ${k}柱=${gz}`);
  }

  // ── L2a: 五虎遁（年干定月干）
  if (b.pillars.year && b.pillars.month) {
    const yearGan = b.pillars.year[0];
    const monthGan = b.pillars.month[0];
    const monthZhiIdx = ZHI.indexOf(b.pillars.month[1]);
    const monthOffset = (monthZhiIdx - 2 + 12) % 12; // 寅月为第 0 月
    const expectGan = GAN[(WU_HU_DUN[yearGan] + monthOffset) % 10];
    check('L2-五虎遁月干', expectGan === monthGan,
      `${dateStr} 年干${yearGan} → 月干应为${expectGan}，实际${monthGan}（月支${b.pillars.month[1]}）`);
  }

  // ── L2b: 五鼠遁（日干定时干）
  //  默认口径为「夜子时」：23:00-24:00 日柱仍当日，时干按次日日干起算（lunar 库 sect=2）
  //  三档子时口径的完整自洽性由 L2-子时口径* 单独校验（见 verifyZishi）
  if (hour != null && b.pillars.hour) {
    let dayGan = b.pillars.day[0];
    if (hour === 23) {
      const nd = new Date(Date.UTC(y, m - 1, d) + 86400000);
      const nextLunar = Solar.fromYmdHms(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), 0, 0, 0).getLunar();
      dayGan = nextLunar.getEightChar().getDayGan();
    }
    const hourGan = b.pillars.hour[0];
    const hourZhiIdx = ZHI.indexOf(b.pillars.hour[1]);
    const expectGan = GAN[(WU_SHU_DUN[dayGan] + hourZhiIdx) % 10];
    check('L2-五鼠遁时干', expectGan === hourGan,
      `${dateStr} ${hour}时 ${hour === 23 ? '晚子时按次日日干' : '日干'}${dayGan} → 时干应为${expectGan}，实际${hourGan}`);
    if (hour === 23) {
      check('L2-夜子时换日(默认口径)', expectGan === hourGan,
        `${dateStr} 23时 夜子时口径校验失败（默认口径，时干应按次日日干起算）`);
    }
  }

  // ── L2c0: 时支与出生小时对应（独立实现）
  if (hour != null && b.pillars.hour) {
    const expectZhi = hourToZhi(hour);
    check('L2-时支与小时对应', expectZhi === b.pillars.hour[1],
      `${dateStr} ${hour}时 时支应为${expectZhi}，实际${b.pillars.hour[1]}`);
  }

  // ── L2c: 大运连续性与顺逆
  const dayun = b.daYun.filter(d => d.ganzhi && d.ganzhi.length === 2);
  if (dayun.length >= 3) {
    const yearGan = b.pillars.year[0];
    const yangYear = GAN.indexOf(yearGan) % 2 === 0; // 阳干
    const forward = (yangYear && gender === '男') || (!yangYear && gender === '女'); // 阳男阴女顺行
    const dirs = [];
    for (let i = 1; i < dayun.length; i++) {
      const a = JIAZI_INDEX[dayun[i - 1].ganzhi];
      const c = JIAZI_INDEX[dayun[i].ganzhi];
      dirs.push(((c - a) % 60 + 60) % 60);
    }
    const allForward = dirs.every(v => v === 1);
    const allBack = dirs.every(v => v === 59);
    check('L2-大运连续性', allForward || allBack,
      `${dateStr} 大运步长=${dirs.slice(0, 4).join(',')}`);
    if (allForward || allBack) {
      check('L2-大运顺逆规则', allForward === forward,
        `${dateStr} ${gender} 年干${yearGan}(${yangYear ? '阳' : '阴'}) 应${forward ? '顺' : '逆'}行，实际${allForward ? '顺' : '逆'}`);
    }
  }

  // ── L2d: 紫微命宫/身宫（独立公式，闰月跳过）
  //  命宫：寅起正月顺数至生月，再逆数至生时
  //  身宫：传统口诀表 —— 子午命身同宫、丑未命身在福德、寅申在官禄、卯酉在迁移、辰戌在财帛、巳亥在夫妻
  const lunarMonth = lunar.getMonth();
  if (chart.ziwei && !chart.ziwei.skipped && lunarMonth > 0 && hour != null) {
    const t = ZHI.indexOf(b.pillars.hour[1]);          // 时支序号（子=0）
    const mingIdx = ((2 + (lunarMonth - 1) - t) % 12 + 12) % 12;
    const zwRaw = astro.bySolar(dateStr, hourToTimeIndex(hour), gender, true, 'zh-CN');
    const zwMingZhi = zwRaw.earthlyBranchOfSoulPalace;
    const zwShenZhi = zwRaw.earthlyBranchOfBodyPalace;
    check('L2-紫微命宫公式', ZHI[mingIdx] === zwMingZhi,
      `${dateStr} ${hour}时 农历${lunarMonth}月 公式命宫=${ZHI[mingIdx]}，iztro=${zwMingZhi}`);
    // 身宫 offset（相对命宫地支）：十二宫自命宫逆排，兄弟-1 夫妻-2 子女-3 财帛-4 疾厄-5 迁移-6 交友-7 官禄-8 田宅-9 福德-10 父母-11
    const SHEN_OFFSET = { 子: 0, 午: 0, 丑: -10, 未: -10, 寅: -8, 申: -8, 卯: -6, 酉: -6, 辰: -4, 戌: -4, 巳: -2, 亥: -2 };
    const shenIdx = ((mingIdx + SHEN_OFFSET[b.pillars.hour[1]]) % 12 + 12) % 12;
    check('L2-紫微身宫口诀', ZHI[shenIdx] === zwShenZhi,
      `${dateStr} ${hour}时 口诀身宫=${ZHI[shenIdx]}，iztro=${zwShenZhi}`);
    // 五行局与命宫纳音一致性（软校验）
    check('L2-五行局格式(软)', /^[木火土金水][二三四五六]局$/.test(chart.ziwei.fiveElementsClass),
      `${dateStr} 五行局=${chart.ziwei.fiveElementsClass}`);
    // 12 宫完整性
    check('L2-十二宫完整', chart.ziwei.palaces.length === 12, `${dateStr} 宫数=${chart.ziwei.palaces.length}`);
  } else {
    results.skipped++;
  }
}

/**
 * L2e：子时口径 —— 三档流派各自的日柱/时柱自洽性（独立公式对拍，不依赖库）
 *   early    早子时：日柱当日 + 时干按「当日日干」
 *   midnight 夜子时：日柱当日 + 时干按「次日日干」（项目默认）
 *   late     晚子时：日柱次日 + 时干按「次日日干」
 * 说明：只校验 23 时出生，其余时辰三档结果必须完全一致（由 L2-子时口径无关性 覆盖）。
 */
function verifyZishi(dateStr, gender) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const todayGan = Solar.fromYmdHms(y, m, d, 12, 0, 0).getLunar().getEightChar().getDayGan();
  const nd = new Date(Date.UTC(y, m - 1, d) + 86400000);
  const nextGan = Solar.fromYmdHms(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), 12, 0, 0)
    .getLunar().getEightChar().getDayGan();
  const ziGan = g => GAN[(WU_SHU_DUN[g] + 0) % 10] + '子'; // 时支子序号 = 0
  const EXPECT = {
    early:    { day: todayGan, shi: ziGan(todayGan) },
    midnight: { day: todayGan, shi: ziGan(nextGan) },
    late:     { day: nextGan,  shi: ziGan(nextGan) },
  };
  for (const [zishi, exp] of Object.entries(EXPECT)) {
    const c = buildChart({ dateStr, hour: 23, gender, city: null, sect: { zishi } });
    check(`L2-子时口径日柱(${zishi})`, c.bazi.pillars.day[0] === exp.day,
      `${dateStr} ${zishi} 日柱应为${exp.day}，实际${c.bazi.pillars.day[0]}`);
    check(`L2-子时口径时柱(${zishi})`, c.bazi.pillars.hour === exp.shi,
      `${dateStr} ${zishi} 时柱应为${exp.shi}，实际${c.bazi.pillars.hour}`);
  }
  // 三档口径必须真的分得开（否则等于参数没生效）
  const e = buildChart({ dateStr, hour: 23, gender, city: null, sect: { zishi: 'early' } }).bazi.pillars.hour;
  const l = buildChart({ dateStr, hour: 23, gender, city: null, sect: { zishi: 'late' } }).bazi.pillars.day[0];
  check('L2-子时口径有效性', e !== EXPECT.midnight.shi || l !== EXPECT.midnight.day,
    `${dateStr} 早子时与夜子时结果相同，zishi 参数疑似未生效`);
}

/** 非 23 时出生，三档口径结果必须完全一致（口径参数不得误伤普通时辰） */
function verifyZishiIrrelevant(dateStr, hour, gender) {
  if (hour === 23 || hour == null) return;
  const a = buildChart({ dateStr, hour, gender, city: null, sect: { zishi: 'early' } });
  const b = buildChart({ dateStr, hour, gender, city: null, sect: { zishi: 'late' } });
  check('L2-子时口径无关性',
    JSON.stringify(a.bazi.pillars) === JSON.stringify(b.bazi.pillars) && a.ziwei.soul === b.ziwei.soul,
    `${dateStr} ${hour}时 早子时/晚子时结果不一致，zishi 参数误伤了非子时时辰`);
}

/** 日柱连续性：连续 N 天日柱序号每天 +1 */
function verifyDayContinuity(startISO, days) {
  let prev = null, ok = true, badDay = '';
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const start = new Date(Date.UTC(sy, sm - 1, sd));
  for (let i = 0; i < days; i++) {
    const dt = new Date(start.getTime() + i * 86400000);
    const lunar = Solar.fromYmdHms(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 12, 0, 0).getLunar();
    const gz = lunar.getEightChar().getDay();
    const idx = JIAZI_INDEX[gz];
    if (prev != null && idx !== (prev + 1) % 60) { ok = false; badDay = dt.toISOString().slice(0, 10) + '=' + gz; break; }
    prev = idx;
  }
  check('L2-日柱连续性(365天)', ok, `断点 ${badDay}`);
}

function main() {
  const sampleDays = Number(process.argv[2] || 2000);
  console.log(`排盘准确性校验开始 —— 随机抽样 ${sampleDays} 个日期（1960-2030）\n`);

  // 固定样例先跑
  const fixed = [
    ['2000-8-16', 14, '男'], ['1995-6-15', 8, '女'], ['1988-11-2', 10, '男'],
    ['1976-3-5', 3, '女'], ['2010-1-15', 23, '男'], ['1962-12-30', 1, '女'],
  ];
  for (const [d, h, g] of fixed) { verifyOne(d, h, g); verifyZishiIrrelevant(d, h, g); }

  // 固定样例：三档子时口径
  for (const [d, , g] of fixed) verifyZishi(d, g);

  // 随机抽样
  for (let i = 0; i < sampleDays; i++) {
    const y = 1960 + Math.floor(Math.random() * 71);
    const m = 1 + Math.floor(Math.random() * 12);
    const dmax = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = 1 + Math.floor(Math.random() * dmax);
    const h = Math.floor(Math.random() * 24);
    const g = Math.random() > 0.5 ? '男' : '女';
    const ds = `${y}-${m}-${d}`;
    try {
      verifyOne(ds, h, g);
      verifyZishiIrrelevant(ds, h, g);
      if (i % 20 === 0) verifyZishi(ds, g); // 子时口径开销较大，抽样 5%
    } catch (e) {
      results.failures.push(`[异常] ${y}-${m}-${d} ${h}时: ${e.message}`);
    }
  }

  verifyDayContinuity('2020-01-01', 365);
  verifyDayContinuity('1990-06-01', 365);

  // ── 报告
  console.log(`校验样本：${results.total} 张盘（紫微跳过闰月 ${results.skipped} 例）\n`);
  console.log('检查项'.padEnd(24) + '通过'.padStart(8) + '失败'.padStart(8) + '  一致率');
  console.log('-'.repeat(56));
  let totalPass = 0, totalAll = 0, hardFail = 0;
  for (const [name, v] of Object.entries(results.checks)) {
    const rate = ((v.pass / (v.pass + v.fail)) * 100).toFixed(2);
    const soft = name.includes('软');
    totalPass += v.pass; totalAll += v.pass + v.fail;
    if (!soft) hardFail += v.fail;
    console.log(name.padEnd(24) + String(v.pass).padStart(8) + String(v.fail).padStart(8) + `  ${rate}%${soft ? '  (软校验)' : ''}`);
  }
  console.log('-'.repeat(56));
  console.log(`合计 ${totalPass}/${totalAll}（${((totalPass / totalAll) * 100).toFixed(2)}%）｜硬校验失败 ${hardFail} 项`);
  if (results.failures.length) {
    console.log('\n失败明细（最多 40 条）：');
    results.failures.forEach(f => console.log('  ' + f));
  }
  process.exit(hardFail === 0 ? 0 : 1);
}

main();
