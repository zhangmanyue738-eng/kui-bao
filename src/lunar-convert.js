/**
 * lunar-convert.js — 农历输入 → 公历转换层（2026-09-03）
 *
 * 背景：很多人只知道自己的农历生日。前端选「农历」时把 { year, month, day, leap }
 * 交给本模块换成公历 dateStr，之后走原有全链路（preflight 澄清闸 / chart / synthesize /
 * interpret / 归档）——闰月、夏令时、子时三道拦截全部基于转换后的公历自动生效，零改动复用。
 *
 * 铁律对应：排盘零幻觉。农历↔公历换算是确定性计算（lunar-javascript），LLM 不介入。
 *
 * 实测踩过的库行为（改这个文件前先读）：
 *   1. **小月三十静默进位**：Lunar.fromYmd(2001, 12, 30) 不抛错，返回 2002-02-11（正月初一）——
 *      用户选了不存在的「三十」会被悄悄换算成次日，日期就错了。必须做 round-trip 校验：
 *      转成公历后再转回农历，与输入逐项比对，不一致即「该农历日期不存在」。
 *   2. 闰月不存在时库抛 `wrong lunar year ...`（如 2000 年没有闰五月）——包一层友好文案，
 *      并在转换前先用 LunarYear.getLeapMonth() 主动判一次，错误信息能直接展示给用户。
 *   3. 闰月在库中用负数月表示（-8 = 闰八月）；LunarYear.fromYear(y).getLeapMonth()
 *      返回 0 表示该年无闰月。
 */

const { Lunar, LunarYear } = require('lunar-javascript');

const LUNAR_YEAR_MIN = 1900;
const LUNAR_YEAR_MAX = 2100;

const MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '冬月', '腊月'];
const DAY_NAMES = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];

/** 该农历年闰几月（0 = 无闰月） */
function getLeapMonth(year) {
  return LunarYear.fromYear(year).getLeapMonth();
}

/** 某农历年某月（闰月传负数）有几天（29 或 30） */
function getMonthDays(year, month) {
  const ly = LunarYear.fromYear(year);
  const m = ly.getMonth(month);
  if (!m) throw new Error(`${year} 年没有${month < 0 ? '闰' : ''}${MONTH_NAMES[Math.abs(month) - 1]}`);
  return m.getDayCount();
}

/** 农历输入的可读标签：农历1995年闰八月初三 */
function lunarLabel({ year, month, day, leap }) {
  return `农历${year}年${leap ? '闰' : ''}${MONTH_NAMES[month - 1]}${DAY_NAMES[day - 1]}`;
}

/**
 * 农历 → 公历。输入非法时抛中文错误（可直接展示给用户）。
 * @param lunar { year, month(1-12), day(1-30), leap: boolean }
 * @returns { dateStr: 'YYYY-M-D', lunarLabel, lunar: 原输入 }
 */
function lunarToSolar(lunar) {
  if (!lunar || typeof lunar !== 'object') throw new Error('农历输入缺失');
  const { year, month, day, leap } = lunar;
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || y < LUNAR_YEAR_MIN || y > LUNAR_YEAR_MAX) {
    throw new Error(`农历年份须在 ${LUNAR_YEAR_MIN}-${LUNAR_YEAR_MAX} 之间`);
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('农历月份须在正月至腊月之间');
  if (!Number.isInteger(d) || d < 1 || d > 30) throw new Error('农历日须在初一到三十之间');

  // 闰月存在性：先主动判一次，给用户能看懂的错误（库的报错是英文）
  if (leap && getLeapMonth(y) !== m) {
    const lm = getLeapMonth(y);
    throw new Error(lm === 0
      ? `${y} 年没有闰月，请去掉「闰」或核对年份`
      : `${y} 年闰的是${MONTH_NAMES[lm - 1]}，不是闰${MONTH_NAMES[m - 1]}`);
  }

  let solar;
  try {
    solar = Lunar.fromYmd(y, leap ? -m : m, d).getSolar();
  } catch (e) {
    // 库对「闰月不存在」等抛英文错；日数超界（如小月三十）部分场景静默进位，靠下面 round-trip 抓
    throw new Error(`农历${y}年${leap ? '闰' : ''}${MONTH_NAMES[m - 1]}${DAY_NAMES[d - 1]}不存在或不在支持范围内，请核对`);
  }

  // round-trip 校验：抓「小月三十静默进位」——库会把不存在的三十换算成下月初一而不报错
  const back = solar.getLunar();
  if (back.getYear() !== y || back.getMonth() !== (leap ? -m : m) || back.getDay() !== d) {
    const days = getMonthDays(y, leap ? -m : m);
    throw new Error(`${y} 年${leap ? '闰' : ''}${MONTH_NAMES[m - 1]}只有 ${days} 天（没有${DAY_NAMES[d - 1]}），请核对农历日期`);
  }

  return {
    dateStr: `${solar.getYear()}-${solar.getMonth()}-${solar.getDay()}`,
    lunarLabel: lunarLabel({ year: y, month: m, day: d, leap: !!leap }),
    lunar: { year: y, month: m, day: d, leap: !!leap },
  };
}

module.exports = { lunarToSolar, getLeapMonth, getMonthDays, lunarLabel, MONTH_NAMES, DAY_NAMES, LUNAR_YEAR_MIN, LUNAR_YEAR_MAX };

// ---------- CLI 自测 ----------
if (require.main === module) {
  const cases = [
    { label: '普通日期（农历2000年七月十六）', in: { year: 2000, month: 7, day: 16, leap: false } },
    { label: '闰月（农历1995年闰八月初三）', in: { year: 1995, month: 8, day: 3, leap: true } },
    { label: '大月三十（农历2001年腊月三十=除夕，2002-02-11）', in: { year: 2001, month: 12, day: 30, leap: false } },
    { label: '无闰月却选闰（2000 闰七月）', in: { year: 2000, month: 7, day: 5, leap: true },
      expectError: true },
    { label: '闰错月（2004 闰二月，选闰三月）', in: { year: 2004, month: 3, day: 5, leap: true },
      expectError: true },
    { label: '小月三十（2000 腊月只有廿九，2001-01-24 春节）', in: { year: 2000, month: 12, day: 30, leap: false },
      expectError: true },
    { label: '年份超界（1800）', in: { year: 1800, month: 1, day: 1, leap: false }, expectError: true },
  ];
  let fail = 0;
  for (const c of cases) {
    try {
      const r = lunarToSolar(c.in);
      if (c.expectError) { console.log(`❌ ${c.label}：应报错却成功 → ${r.dateStr}`); fail++; continue; }
      // round-trip 复核
      const back = Lunar.fromYmd(r.lunar.year, r.lunar.leap ? -r.lunar.month : r.lunar.month, r.lunar.day);
      const rt = back.getSolar().toYmd() === require('lunar-javascript').Solar.fromYmdHms(
        ...r.dateStr.split('-').map((n, i) => i === 0 ? n : n), 12, 0, 0).toYmd();
      console.log(`${rt ? '✅' : '⚠️'} ${c.label} → ${r.dateStr}（${r.lunarLabel}）`);
    } catch (e) {
      if (c.expectError) console.log(`✅ ${c.label}：正确报错 → ${e.message}`);
      else { console.log(`❌ ${c.label}：意外报错 → ${e.message}`); fail++; }
    }
  }
  // 已知对照：公历 2000-8-16 = 农历七月十七（README 基准盘），则七月十六 = 2000-08-15
  const t = lunarToSolar({ year: 2000, month: 7, day: 16, leap: false });
  console.log(t.dateStr === '2000-8-15' ? '✅ 基准对照通过：农历2000年七月十六 = 2000-8-15（次日即 README 基准盘 2000-8-16）'
    : `❌ 基准对照失败：得到 ${t.dateStr}，应为 2000-8-15`);
  process.exit(fail || t.dateStr !== '2000-8-15' ? 1 : 0);
}
