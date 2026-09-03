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

// ---------- 城市经度表（真太阳时换算用） ----------
// 【重要约束】本表只能收录 UTC+8 单一时区地区（中国大陆 / 港澳台）。
// 真太阳时公式 offsetMin = (lon - 120) * 4 里的 120 是东八区中央经线，
// 海外城市若直接套用会算错（东京 139.7° 会算出 +79 分钟，正确值是 +19 分钟）。
// 要支持海外必须给城市加 tzOffset 字段并改用 (lon - 15*tzOffset) * 4，届时同步改 trueSolarAdjust。
// 经度取城市中心近似值，误差一般 < 0.1°（< 24 秒）；落在时辰交界的情况由 preflight 告警。
const CITY_LONGITUDE = {
  // ── 直辖市 ──
  北京: 116.41, 上海: 121.47, 天津: 117.20, 重庆: 106.55,
  // ── 省会 / 首府 ──
  石家庄: 114.51, 太原: 112.55, 呼和浩特: 111.75, 沈阳: 123.43, 长春: 125.32,
  哈尔滨: 126.53, 南京: 118.80, 杭州: 120.15, 合肥: 117.28, 福州: 119.30,
  南昌: 115.89, 济南: 117.00, 郑州: 113.62, 武汉: 114.31, 长沙: 112.94,
  广州: 113.26, 南宁: 108.37, 海口: 110.20, 成都: 104.07, 贵阳: 106.63,
  昆明: 102.71, 拉萨: 91.11, 西安: 108.94, 兰州: 103.83, 西宁: 101.78,
  银川: 106.23, 乌鲁木齐: 87.62,
  // ── 港澳台 ──
  香港: 114.17, 澳门: 113.55, 台北: 121.52, 高雄: 120.30, 台中: 120.68,
  // ── 计划单列市 / 经济大市 ──
  深圳: 114.06, 青岛: 120.38, 大连: 121.62, 厦门: 118.09, 宁波: 121.55,
  苏州: 120.62, 无锡: 120.30, 温州: 120.70, 佛山: 113.12, 东莞: 113.75,
  珠海: 113.58, 中山: 113.39, 惠州: 114.42, 汕头: 116.68, 湛江: 110.36,
  泉州: 118.68, 常州: 119.95, 南通: 120.86, 徐州: 117.18, 潍坊: 119.10,
  烟台: 121.39, 淄博: 118.06, 洛阳: 112.45, 唐山: 118.18, 三亚: 109.51,
  // ── 河北 ──
  保定: 115.48, 廊坊: 116.68, 邯郸: 114.54, 秦皇岛: 119.60, 沧州: 116.86,
  衡水: 115.67, 邢台: 114.50, 张家口: 114.89, 承德: 117.94,
  // ── 山西 ──
  大同: 113.30, 临汾: 111.52, 运城: 111.00, 长治: 113.12, 晋中: 112.75,
  阳泉: 113.58, 忻州: 112.73, 吕梁: 111.14,
  // ── 内蒙古 ──
  包头: 109.84, 赤峰: 118.96, 通辽: 122.24, 鄂尔多斯: 109.78, 呼伦贝尔: 119.74,
  // ── 辽宁 ──
  鞍山: 122.99, 抚顺: 123.96, 本溪: 123.76, 锦州: 121.13, 营口: 122.24,
  盘锦: 122.07, 丹东: 124.35, 葫芦岛: 120.84, 朝阳: 120.45,
  // ── 吉林 ──
  吉林: 126.55, 四平: 124.35, 通化: 125.94, 松原: 124.82, 延吉: 129.51,
  // ── 黑龙江 ──
  大庆: 125.11, 齐齐哈尔: 123.92, 牡丹江: 129.62, 佳木斯: 130.35, 伊春: 128.90,
  // ── 江苏 ──
  扬州: 119.42, 镇江: 119.45, 泰州: 119.92, 盐城: 120.16, 淮安: 119.02,
  连云港: 119.16, 宿迁: 118.28,
  // ── 浙江 ──
  嘉兴: 120.76, 湖州: 120.09, 绍兴: 120.58, 金华: 119.65, 台州: 121.43,
  丽水: 119.92, 衢州: 118.87, 舟山: 122.11,
  // ── 安徽 ──
  芜湖: 118.38, 蚌埠: 117.36, 阜阳: 115.82, 六安: 116.51, 安庆: 117.05,
  马鞍山: 118.51, 铜陵: 117.82, 淮南: 117.02, 滁州: 118.32,
  // ── 福建 ──
  漳州: 117.65, 莆田: 119.01, 三明: 117.62, 龙岩: 117.02, 宁德: 119.55,
  // ── 江西 ──
  九江: 115.99, 赣州: 114.93, 上饶: 117.97, 宜春: 114.42, 吉安: 115.00,
  抚州: 116.36, 景德镇: 117.18, 萍乡: 113.85,
  // ── 山东 ──
  临沂: 118.36, 济宁: 116.59, 泰安: 117.09, 威海: 122.12, 日照: 119.53,
  枣庄: 117.32, 聊城: 115.99, 德州: 116.36, 东营: 118.68, 菏泽: 115.48,
  // ── 河南 ──
  开封: 114.31, 洛阳: 112.45, 南阳: 112.53, 新乡: 113.93, 许昌: 113.85,
  安阳: 114.39, 焦作: 113.24, 商丘: 115.65, 信阳: 114.09, 周口: 114.65,
  驻马店: 114.02, 平顶山: 113.19,
  // ── 湖北 ──
  襄阳: 112.14, 宜昌: 111.29, 荆州: 112.24, 荆门: 112.20, 十堰: 110.79,
  孝感: 113.92, 黄冈: 114.87, 黄石: 115.04, 咸宁: 114.32, 随州: 113.38,
  // ── 湖南 ──
  株洲: 113.13, 衡阳: 112.57, 岳阳: 113.13, 常德: 111.69, 湘潭: 112.94,
  邵阳: 111.47, 益阳: 112.36, 娄底: 112.00, 怀化: 110.00, 郴州: 113.02,
  永州: 111.61,
  // ── 广东 ──
  潮州: 116.63, 揭阳: 116.37, 梅州: 116.12, 肇庆: 112.47, 清远: 113.03,
  韶关: 113.60, 茂名: 110.92, 江门: 113.08, 河源: 114.70, 云浮: 112.04,
  // ── 广西 ──
  柳州: 109.42, 桂林: 110.29, 北海: 109.12, 玉林: 110.18, 钦州: 108.62,
  梧州: 111.30, 百色: 106.62, 河池: 108.06,
  // ── 海南 ──
  儋州: 109.58, 东方: 108.62,
  // ── 四川 ──
  绵阳: 104.68, 德阳: 104.40, 南充: 106.11, 宜宾: 104.63, 泸州: 105.44,
  达州: 107.47, 乐山: 103.77, 自贡: 104.78, 攀枝花: 101.72, 遂宁: 105.57,
  内江: 105.06, 广元: 105.84, 眉山: 103.85,
  // ── 贵州 ──
  遵义: 106.93, 六盘水: 104.83, 安顺: 105.95, 毕节: 105.29, 铜仁: 109.19,
  // ── 云南 ──
  曲靖: 103.80, 玉溪: 102.55, 楚雄: 101.53, 大理: 100.23, 昭通: 103.72,
  红河: 103.38, 文山: 104.25, 普洱: 100.97, 西双版纳: 100.80,
  // ── 陕西 ──
  宝鸡: 107.14, 咸阳: 108.71, 渭南: 109.50, 延安: 109.49, 汉中: 107.02,
  安康: 109.03, 榆林: 109.74, 铜川: 108.94,
  // ── 甘肃 ──
  天水: 105.72, 白银: 104.18, 酒泉: 98.51, 张掖: 100.45, 武威: 102.63,
  庆阳: 107.65, 平凉: 107.05,
  // ── 青海 ──
  格尔木: 94.90, 海东: 102.10,
  // ── 宁夏 ──
  石嘴山: 106.38, 吴忠: 106.20, 固原: 106.28,
  // ── 新疆 ──
  喀什: 75.99, 伊宁: 81.32, 克拉玛依: 84.87, 库尔勒: 86.15, 阿克苏: 80.26,
  和田: 79.92, 昌吉: 87.30, 石河子: 86.04,
  // ── 西藏 ──
  日喀则: 88.88, 林芝: 94.36, 昌都: 97.18,
};

/**
 * 城市名容错解析：先精确匹配，再去掉「市/县/区/省/自治州」等后缀重试。
 * 用户手输「深圳市」「哈尔滨」这类带后缀的写法不该被当成未收录而拦下。
 * @returns { name: string|null, lon: number|null }  未收录时 name 为 null
 */
function resolveCity(city) {
  if (city == null) return { name: null, lon: null };
  const raw = String(city).trim();
  if (!raw) return { name: null, lon: null };
  if (CITY_LONGITUDE[raw] != null) return { name: raw, lon: CITY_LONGITUDE[raw] };
  const stripped = raw.replace(/(特别行政区|自治州|自治县|地区|市|县|区|省)$/g, '');
  if (stripped && CITY_LONGITUDE[stripped] != null) return { name: stripped, lon: CITY_LONGITUDE[stripped] };
  return { name: null, lon: null };
}

// ---------- 流派口径 ----------
// 口径差异会直接改结果（日柱/时柱/紫微安星），必须显式声明、全程透传、报告落款。
// 三档子时：仅 23:00-24:00 出生的人受影响（约占 1/24），但一旦命中，日柱时柱全变。
const ZISHI_OPTIONS = {
  early:    { label: '早子时', desc: '日柱与时干均按当日' },
  midnight: { label: '夜子时', desc: '日柱当日，时干按次日日干起算' },
  late:     { label: '晚子时', desc: '日柱与时干均按次日' },
};
const LEAP_OPTIONS = {
  asIs:      { label: '闰月按当月', desc: '农历闰月出生，按该闰月本身排盘' },
  nextMonth: { label: '闰月按下月', desc: '农历闰月出生，按下个月排盘' },
};
const SCHOOL_OPTIONS = { ziping: { label: '子平法', desc: '扶抑 + 月令加权 + 穷通宝鉴调候' } };
// 默认口径：与历史行为保持一致（lunar 库默认 sect=2 = 夜子时）
// 注意：SKILL.md 旧版写作「默认晚子时」是错的，实际一直是夜子时，此处连同文档一并修正。
const SECT_DEFAULTS = { zishi: 'midnight', leap: 'asIs', school: 'ziping' };

function normalizeSect(sect = {}) {
  return {
    zishi: ZISHI_OPTIONS[sect.zishi] ? sect.zishi : SECT_DEFAULTS.zishi,
    leap: LEAP_OPTIONS[sect.leap] ? sect.leap : SECT_DEFAULTS.leap,
    school: SCHOOL_OPTIONS[sect.school] ? sect.school : SECT_DEFAULTS.school,
  };
}

/** 报告落款：一行说清这张盘是按什么口径排的 */
function sectStamp(sect) {
  const s = normalizeSect(sect);
  return [
    ZISHI_OPTIONS[s.zishi].label,
    SCHOOL_OPTIONS[s.school].label,
    LEAP_OPTIONS[s.leap].label,
    '南派三合（iztro）',
  ].join(' · ');
}

/** 取次日（本地时区构造，避免 '2000-8-16' 被当成 UTC 而错日） */
function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`;
}

/** 中国大陆夏令时区间：1986-05-04 ~ 1991-09-15（右开区间） */
function inDSTRange(dateStr) {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  return t >= new Date(1986, 4, 4).getTime() && t < new Date(1991, 8, 15).getTime();
}

/**
 * 真太阳时校正（平太阳时版；MVP 不含均时差，误差 ±4 分钟内一般不改时辰，
 * 边界时辰（xx:50~xx:10 换算后仍在临界）会打 boundaryRisk 标记）
 * @param dstMode 'auto' = 按夏令时扣回 1 小时（默认）；'none' = 用户声明已是标准时间
 */
function trueSolarAdjust(dateStr, hour, city, dstMode = 'auto') {
  const { lon } = resolveCity(city);
  if (lon == null) return { hour, adjusted: false, boundaryRisk: false, dstApplied: false,
    note: `未知城市[${city}]，未做真太阳时校正` };
  let dstNote = '', dstApplied = false;
  if (inDSTRange(dateStr)) {
    if (dstMode === 'auto') {
      hour -= 1; dstApplied = true; dstNote = '（夏令时已扣回1小时）';
      if (hour < 0) hour += 24;
    } else {
      dstNote = '（夏令时区间，但按用户声明未扣回）';
    }
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
    dstApplied,
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
/**
 * 子时口径落地：只有 hour === 23 存在分歧，其余时辰三档口径结果完全相同。
 *  - early    早子时 → 按当日子时初（hour=0）排盘：日柱当日、时干按当日日干
 *  - late     晚子时 → 按次日子时初排盘：日柱次日、时干按次日日干
 *  - midnight 夜子时 → 保持 23 点原样交给 lunar（其 sect=2 即此口径）：日柱当日、时干按次日日干
 */
function resolveZishi(dateStr, hourOrNull, zishi) {
  if (hourOrNull !== 23) return { dateStr, hour: hourOrNull, note: '' };
  if (zishi === 'early') return { dateStr, hour: 0, note: '早子时口径：23时按当日子时初排盘' };
  if (zishi === 'late') return { dateStr: nextDay(dateStr), hour: 0, note: '晚子时口径：23时按次日子时初排盘' };
  return { dateStr, hour: 23, note: '夜子时口径：日柱当日，时干按次日日干' };
}

function buildBazi(dateStr, hourOrNull, gender, sect = {}) {
  const s = normalizeSect(sect);
  const rz = resolveZishi(dateStr, hourOrNull, s.zishi);
  const solar = Solar.fromYmdHms(...rz.dateStr.split('-').map(Number), rz.hour ?? 12, 0, 0);
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
    zishiNote: rz.note || undefined,
  };
}

// ---------- 紫微 ----------
// 注：紫微命宫由「生月 + 生时地支」定位，子时早/晚地支同为子，
// 故命宫与五行局在三档口径下一致；此处传不同 index 仅为口径自洽与可审计。
function buildZiwei(dateStr, hour, gender, sect = {}) {
  const s = normalizeSect(sect);
  let d = dateStr, t = hourToTimeIndex(hour);
  if (hour === 23) {
    if (s.zishi === 'early') { d = dateStr; t = 0; }
    else if (s.zishi === 'late') { d = nextDay(dateStr); t = 0; }
    else { d = dateStr; t = 12; }
  }
  const ast = astro.bySolar(d, t, gender, s.leap === 'asIs', 'zh-CN');
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
/**
 * @param input { dateStr, hour, gender, city, sect:{zishi,leap,school}, dstMode:'auto'|'none' }
 *   city 缺失/未收录时**不做**真太阳时校正（不静默按北京算），由 preflight 层拦下并追问。
 */
function buildChart(input) {
  let { dateStr, hour, gender, city, dstMode = 'auto' } = input;
  const sect = normalizeSect(input.sect);
  let effectiveHour = hour;
  let trueSolar = null;
  // 容错归一：「深圳市」→「深圳」，保证 meta 里落的是标准名（审计/检索用）
  const rc = resolveCity(city);
  if (rc.name) city = rc.name;

  if (hour != null && city) {
    trueSolar = trueSolarAdjust(dateStr, hour, city, dstMode);
    effectiveHour = trueSolar.hour;
  }

  const bazi = buildBazi(dateStr, effectiveHour, gender, sect);

  let ziwei = null;
  if (effectiveHour != null) {
    ziwei = buildZiwei(dateStr, effectiveHour, gender, sect);
  } else {
    ziwei = { skipped: true, reason: '时辰未定，紫微未排（降级为八字单术路径，B级精度）' };
  }

  return {
    meta: { dateStr, inputHour: hour, effectiveHour, gender, city, trueSolar, dstMode,
            sect, sectStamp: sectStamp(sect),
            generatedAt: new Date().toISOString() },
    bazi, ziwei,
  };
}

module.exports = { buildChart, trueSolarAdjust, CITY_LONGITUDE, resolveCity,
  normalizeSect, sectStamp, nextDay, inDSTRange, resolveZishi,
  ZISHI_OPTIONS, LEAP_OPTIONS, SCHOOL_OPTIONS, SECT_DEFAULTS };

// ---------- CLI 测试 ----------
// 用法：node src/chart.js 2000-8-16 14 男 深圳 [zishi] [leap] [dstMode]
if (require.main === module) {
  const [dateStr, hourArg, gender, city, zishi, leap, dstMode] = process.argv.slice(2);
  const hour = hourArg === '-' || hourArg == null ? null : Number(hourArg);
  if (!city) console.error('⚠️ 未提供城市，本次不做真太阳时校正（真实使用应由 preflight 拦截）');
  const result = buildChart({ dateStr, hour, gender: gender || '男', city: city || null,
    sect: { zishi, leap }, dstMode: dstMode || 'auto' });
  console.log(JSON.stringify(result, null, 2));
}
