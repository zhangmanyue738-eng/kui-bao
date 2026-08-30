/**
 * chart.js — 双排盘模块（MVP 直线跑通阶段）
 * 八字：lunar-javascript | 紫微：iztro
 * 输出统一 JSON，字段清单见 docs/cross-validation-rules.md 第一节
 *
 * 用法：
 *   node src/chart.js 2000-8-16 14 男 深圳
 *   node src/chart.js 2000-8-16 - 男 深圳   （时辰未知）
 */
const { Solar, LunarUtil } = require('lunar-javascript');
const { astro } = require('iztro');

// ---------- 常用城市经度表（真太阳时换算用，可按需补充） ----------
const CITY_LONGITUDE = {
  北京: 116.4, 上海: 121.5, 广州: 113.3, 深圳: 114.06, 杭州: 120.2,
  成都: 104.1, 重庆: 106.5, 武汉: 114.3, 西安: 108.9, 南京: 118.8,
  苏州: 120.6, 天津: 117.2, 长沙: 113.0, 郑州: 113.6, 青岛: 120.4,
  厦门: 118.1, 福州: 119.3, 沈阳: 123.4, 哈尔滨: 126.6, 乌鲁木齐: 87.6,
  拉萨: 91.1, 昆明: 102.7, 贵阳: 106.7, 兰州: 103.8, 海口: 110.3,
  香港: 114.17, 澳门: 113.55, 台北: 121.5,
};

/**
 * 真太阳时校正（平太阳时版；MVP 不含均时差，误差 ±4 分钟内一般不改时辰，
 * 边界时辰（xx:50~xx:10 换算后仍在临界）会打 boundaryRisk 标记）
 * 含 1986-1991 大陆夏令时扣回 1 小时
 */
function trueSolarAdjust(dateStr, hour, city) {
  const lon = CITY_LONGITUDE[city];
  if (lon == null) return { hour, adjusted: false, boundaryRisk: false, note: `未知城市[${city}]，未做真太阳时校正` };
  // 夏令时：1986-05-04 ~ 1991-09-15（简化取整区间）
  const d = new Date(dateStr);
  const y = d.getFullYear();
  let dstNote = '';
  if ((y === 1986 && d >= new Date('1986-05-04') && d < new Date('1986-09-15')) ||
      (y > 1986 && y < 1991) || (y === 1991 && d < new Date('1991-09-15'))) {
    hour -= 1; dstNote = '（夏令时已扣回1小时）';
    if (hour < 0) hour += 24;
  }
  const offsetMin = Math.round((lon - 120) * 4); // 经度差 → 分钟
  let trueHour = hour + offsetMin / 60;
  let trueH = Math.floor(trueHour);
  const minutePart = trueHour - trueH;
  if (trueH < 0) trueH += 24;
  if (trueH > 23) trueH -= 24;
  // 边界风险：换算后落在时辰交界 ±10 分钟内
  const boundaryRisk = Math.abs(minutePart * 60 - 0) < 10 || Math.abs(minutePart * 60 - 60) < 10 ||
                       (minutePart * 60 > 50) || (minutePart * 60 < 10);
  return {
    hour: trueH,
    adjusted: true,
    boundaryRisk,
    note: `经度${lon}，校正 ${offsetMin >= 0 ? '+' : ''}${offsetMin} 分钟${dstNote}`,
  };
}

/** 小时 → iztro timeIndex（0=早子,1=丑,...,11=亥,12=晚子） */
function hourToTimeIndex(h) {
  if (h === 23) return 12;
  if (h === 0) return 0;
  return Math.floor((h + 1) / 2);
}

// ---------- 内置干支五行映射（标准对照，确定性数据） ----------
const GAN_WUXING = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
const ZHI_WUXING = { 子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火', 午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水' };
const ganWx = g => (g ? GAN_WUXING[g] : null);
const zhiWx = z => (z ? ZHI_WUXING[z] : null);

// ---------- 八字 ----------
function buildBazi(dateStr, hourOrNull, gender) {
  const solar = Solar.fromYmdHms(...dateStr.split('-').map(Number), hourOrNull ?? 12, 0, 0);
  const lunar = solar.getLunar();
  const ec = lunar.getEightChar();
  const gan = [ec.getYearGan(), ec.getMonthGan(), ec.getDayGan(), hourOrNull != null ? ec.getTimeGan() : null];
  const zhi = [ec.getYearZhi(), ec.getMonthZhi(), ec.getDayZhi(), hourOrNull != null ? ec.getTimeZhi() : null];

  const fiveElementsCount = {};
  for (const g of gan) if (g) fiveElementsCount[ganWx(g)] = (fiveElementsCount[ganWx(g)] || 0) + 1;
  for (const z of zhi) if (z) fiveElementsCount[zhiWx(z)] = (fiveElementsCount[zhiWx(z)] || 0) + 1;

  // 大运（性别：男1女0 顺逆由年干阴阳决定，lunar 库内部处理）
  let daYun = [];
  try {
    const yun = ec.getYun(gender === '男' ? 1 : 0);
    daYun = yun.getDaYun().slice(0, 9).map(dy => ({
      ganzhi: dy.getGanZhi(), startAge: dy.getStartAge(), endAge: dy.getEndAge(),
      startYear: dy.getStartYear(), endYear: dy.getEndYear(),
    }));
  } catch (e) { daYun = []; }

  return {
    pillars: {
      year: `${gan[0]}${zhi[0]}`, month: `${gan[1]}${zhi[1]}`,
      day: `${gan[2]}${zhi[2]}`, hour: hourOrNull != null ? `${gan[3]}${zhi[3]}` : null,
    },
    hourPillarMissing: hourOrNull == null,
    dayMaster: { gan: gan[2], wuxing: ganWx(gan[2]) },
    pillarsWuxing: gan.map((g, i) => ({ pillar: ['year','month','day','hour'][i], gan: g, ganWx: ganWx(g), zhi: zhi[i], zhiWx: zhiWx(zhi[i]) })),
    fiveElementsCount,
    tenGods: hourOrNull != null ? {
      yearGan: ec.getYearShiShenGan(), monthGan: ec.getMonthShiShenGan(), hourGan: ec.getTimeShiShenGan(),
      yearZhi: ec.getYearShiShenZhi(), monthZhi: ec.getMonthShiShenZhi(), dayZhi: ec.getDayShiShenZhi(), hourZhi: ec.getTimeShiShenZhi(),
    } : {
      yearGan: ec.getYearShiShenGan(), monthGan: ec.getMonthShiShenGan(),
      yearZhi: ec.getYearShiShenZhi(), monthZhi: ec.getMonthShiShenZhi(), dayZhi: ec.getDayShiShenZhi(),
    },
    naYin: [ec.getYearNaYin(), ec.getMonthNaYin(), ec.getDayNaYin(), hourOrNull != null ? ec.getTimeNaYin() : null],
    daYun,
  };
}

// ---------- 紫微 ----------
function buildZiwei(dateStr, hour, gender) {
  const t = hourToTimeIndex(hour);
  const ast = astro.bySolar(dateStr, t, gender, true, 'zh-CN');
  const palaces = ast.palaces.map(p => ({
    name: p.name,
    isBodyPalace: !!p.isBodyPalace,
    majorStars: p.majorStars.map(s => ({ name: s.name, magnitude: s.brightness || '', siHua: s.mutagen || '' })),
    minorStars: p.minorStars.map(s => ({ name: s.name, siHua: s.mutagen || '' })),
    adjectiveStars: p.adjectiveStars.map(s => s.name),
  }));
  const byName = {};
  for (const p of palaces) byName[p.name] = p;
  // 兼容 iztro「官禄」与习惯称呼「官禄宫」两种命名
  const pick = n => byName[n] || byName[n.replace(/宫$/, '')];
  return {
    soul: ast.soul, body: ast.body,
    fiveElementsClass: ast.fiveElementsClass,
    palaces, byName,
    keyPalaces: {
      ming: pick('命宫'), shen: palaces.find(p => p.isBodyPalace),
      guanLu: pick('官禄宫'), caiBo: pick('财帛宫'),
      fuQi: pick('夫妻宫'), jiE: pick('疾厄宫'), tianZhai: pick('田宅宫'),
    },
  };
}

// ---------- 统一入口 ----------
function buildChart(input) {
  // input: { dateStr: '2000-8-16', hour: number|null, gender: '男'|'女', city: string }
  const { dateStr, hour, gender, city } = input;
  let effectiveHour = hour;
  let trueSolar = null;

  if (hour != null && city) {
    trueSolar = trueSolarAdjust(dateStr, hour, city);
    effectiveHour = trueSolar.hour;
  }

  const bazi = buildBazi(dateStr, effectiveHour, gender);

  let ziwei = null;
  if (effectiveHour != null) {
    ziwei = buildZiwei(dateStr, effectiveHour, gender);
  } else {
    ziwei = { skipped: true, reason: '时辰未定，紫微未排（降级为八字单术路径，B级精度）' };
  }

  return {
    meta: { dateStr, inputHour: hour, effectiveHour, gender, city, trueSolar,
            generatedAt: new Date().toISOString() },
    bazi, ziwei,
  };
}

module.exports = { buildChart, trueSolarAdjust, CITY_LONGITUDE };

// ---------- CLI 测试 ----------
if (require.main === module) {
  const [dateStr, hourArg, gender, city] = process.argv.slice(2);
  const hour = hourArg === '-' || hourArg == null ? null : Number(hourArg);
  const result = buildChart({ dateStr, hour, gender: gender || '男', city: city || '北京' });
  console.log(JSON.stringify(result, null, 2));
}
