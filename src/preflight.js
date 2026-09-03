/**
 * preflight.js — 调用前「澄清闸」
 *
 * 背景：排盘是确定性计算，但**输入**里凡是影响结果的未知量，一旦被静默填默认值，
 * 错误就不可见——报告照样生成、照样流畅，只是地基是歪的。
 * 例：城市经度表未收录 → 真太阳时跳过校正 → 时柱可能整柱错 → 日主强弱/用神/格局全错。
 *
 * 原则（学自 Horosa 的 clarify-before-call gate）：
 *   只要某项输入会影响结果且存在分歧/缺失，**结构化拦截**并返回可直接转给用户的追问文本，
 *   由真人确认后才允许出报告。宁可多问一句，绝不静默默认。
 *
 * 拦截项（都会改变排盘结果）：
 *   1. 城市未收录或未填 → 真太阳时无法校正（经度每差 15° 差一个时辰）
 *   2. 出生在 1986-05-04 ~ 1991-09-15 夏令时区间 → 记录的出生时间是钟表时间还是标准时间
 *   3. 出生在 23-24 点 → 子时换日三档流派分歧
 *   4. 农历闰月出生 → 闰月排盘流派分歧
 *
 * 不拦截、仅提示（warnings）：
 *   - 真太阳时换算后落在时辰交界 ±10 分钟（建议补出生分钟数）
 *   - 时辰未知（已知降级路径，前端已显式处理）
 */
const { Solar } = require('lunar-javascript');
const { resolveCity, inDSTRange, normalizeSect, ZISHI_OPTIONS, LEAP_OPTIONS } = require('./chart.js');

/** 农历闰月判定：lunar 库以负数月份表示闰月 */
function isLeapLunarMonth(dateStr) {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  try {
    return Solar.fromYmdHms(y, m, d, 12, 0, 0).getLunar().getMonth() < 0;
  } catch (e) {
    return false;
  }
}

/** 真太阳时换算后是否落在时辰交界（±10 分钟），返回交界提示文本或 null */
function boundaryHint(dateStr, hour, city) {
  const { lon } = resolveCity(city);
  if (hour == null || lon == null) return null;
  const offsetMin = Math.round((lon - 120) * 4);
  let h = hour + offsetMin / 60;
  if (inDSTRange(dateStr)) h -= 1;
  const frac = Math.abs(h - Math.round(h));
  const nearBoundary = frac < 10 / 60 || frac > 50 / 60;
  if (!nearBoundary) return null;
  // 时辰是两小时一段，换算后小时为偶数则是整点起，奇数则是半程
  const hh = ((Math.round(h) % 24) + 24) % 24;
  return `真太阳时校正后（${offsetMin >= 0 ? '+' : ''}${offsetMin} 分钟）落在时辰交界 ${10} 分钟内，` +
    `当前按时辰 ${hh} 时计算。若出生时间有具体分钟数，建议补填后再排盘`;
}

/**
 * 调用前体检
 * @param input { dateStr, hour, gender, city, sect, dstMode }
 * @returns { ok, blocking[], warnings[], facts, sect }
 *   ok=false 表示必须先让用户回答 blocking 里的问题才能出报告
 */
function checkPreflight(input = {}) {
  const { dateStr, hour, city, dstMode = 'auto' } = input;
  const sect = normalizeSect(input.sect);
  // decided：用户已经明确回答过的项，即使答案仍是「不校正 / 用默认」，也不再重复追问
  const decided = input.decided || {};
  const blocking = [];
  const warnings = [];

  const facts = {
    dateStr: dateStr || null,
    hour: hour ?? null,
    cityKnown: resolveCity(city).lon != null,
    city: resolveCity(city).name || city || null,
    dstRange: dateStr ? inDSTRange(dateStr) : false,
    zishiAmbiguous: hour === 23,
    leapMonth: isLeapLunarMonth(dateStr),
    hourMissing: hour == null,
  };

  // ── 1. 城市 / 真太阳时 ────────────────────────────────
  if (hour != null && !facts.cityKnown && !decided.city) {
    blocking.push({
      kind: 'city',
      field: 'city',
      question: city
        ? `出生城市「${city}」暂未收录，无法做真太阳时校正。经度每差 15° 就差一个时辰，时柱一变，日主强弱、用神、格局和后面所有结论都会跟着变。怎么处理？`
        : '未提供出生城市，无法做真太阳时校正（经度每差 15° 就差一个时辰，时柱一变，后面所有结论都会跟着变）。怎么处理？',
      options: [
        { value: '__none__', label: '不校正，直接按钟表时间排盘', hint: '报告会标注「未做真太阳时校正」，结论精度降低' },
      ],
      // 可输入城市名（前端 datalist 由 GET /api/cities 填充，此处不再回传城市清单，
      // 避免每次拦截都带上几百条无关数据）
      input: {
        type: 'text',
        placeholder: '或填写出生城市（已收录则自动校正）',
      },
    });
  }

  // ── 2. 夏令时 ────────────────────────────────────────
  if (facts.dstRange && !decided.dstMode) {
    blocking.push({
      kind: 'dst',
      field: 'dstMode',
      question: '出生时间在 1986-05-04 ~ 1991-09-15 中国大陆夏令时区间内。你手上的出生时间是哪一种？',
      options: [
        { value: 'auto', label: '钟表时间（夏令时），请扣回 1 小时', hint: '出生证明、家长口述的通常都是这种，也是本项目默认处理方式' },
        { value: 'none', label: '已经是标准时间，不要再扣', hint: '若记录时已自行换算过' },
      ],
      current: dstMode,
    });
  }

  // ── 3. 子时流派 ──────────────────────────────────────
  if (facts.zishiAmbiguous && !decided.zishi) {
    blocking.push({
      kind: 'zishi',
      field: 'sect.zishi',
      question: '出生在 23-24 点，正好落在子时换日的分歧点上。不同流派会排出不同的日柱和时柱，用哪个口径？',
      options: ['midnight', 'late', 'early'].map(k => ({
        value: k,
        label: `${ZISHI_OPTIONS[k].label}（${ZISHI_OPTIONS[k].desc}）`,
        hint: k === 'midnight' ? '现代排盘软件主流默认，也是本项目默认' : '',
      })),
      current: sect.zishi,
    });
  }

  // ── 4. 闰月口径 ──────────────────────────────────────
  if (facts.leapMonth && !decided.leap) {
    blocking.push({
      kind: 'leap',
      field: 'sect.leap',
      question: '出生在农历闰月，闰月怎么排盘流派有分歧，用哪个口径？',
      options: ['asIs', 'nextMonth'].map(k => ({
        value: k,
        label: LEAP_OPTIONS[k].label,
        hint: LEAP_OPTIONS[k].desc,
      })),
      current: sect.leap,
    });
  }

  // ── 非阻断提示 ───────────────────────────────────────
  const bh = boundaryHint(dateStr, hour, city);
  if (bh) warnings.push(bh);
  if (facts.hourMissing) {
    warnings.push('未填出生时辰：时柱与紫微均无法排，走 B 级精度（年月日三柱）单术路径。可在时辰处选「不确定 / 帮我定盘」反推。');
  }

  return { ok: blocking.length === 0, blocking, warnings, facts, sect };
}

/**
 * 把用户的确认结果合并回输入，产出可直接喂给 buildChart 的参数
 * @param input  原始输入
 * @param confirm { city?:string, dstMode?:'auto'|'none', sect?:{zishi,leap} }
 */
function applyConfirmations(input = {}, confirm = {}) {
  const rawCity = confirm.city !== undefined && confirm.city !== null && confirm.city !== ''
    ? confirm.city
    : input.city;
  const sect = { ...(input.sect || {}), ...(confirm.sect || {}) };
  return {
    ...input,
    // '__none__' 是用户在澄清闸里明确选的「不校正」——这是个决定，不是没填
    city: rawCity === '__none__' ? null : rawCity,
    dstMode: confirm.dstMode === 'none' ? 'none' : 'auto',
    sect,
    // decided：已经回答过的项，checkPreflight 不再追问（避免选了"不校正"又弹同一个问题）
    decided: {
      city: confirm.city !== undefined,
      dstMode: confirm.dstMode !== undefined,
      zishi: !!(confirm.sect && confirm.sect.zishi),
      leap: !!(confirm.sect && confirm.sect.leap),
    },
    // 审计用：记录用户实际确认了什么
    confirmed: {
      city: confirm.city !== undefined ? confirm.city : null,
      dstMode: confirm.dstMode || 'auto',
      zishi: (confirm.sect && confirm.sect.zishi) || null,
      leap: (confirm.sect && confirm.sect.leap) || null,
    },
  };
}

module.exports = { checkPreflight, applyConfirmations, isLeapLunarMonth, boundaryHint };

// ---------- CLI 自测 ----------
if (require.main === module) {
  const cases = [
    { label: '常规（深圳 14 时）', input: { dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳' } },
    { label: '城市带后缀（淄博市）', input: { dateStr: '2000-8-16', hour: 8, gender: '男', city: '淄博市' },
      expect: r => r.facts.cityKnown ? '（已归一为「' + r.facts.city + '」，不拦截）' : '（未归一，异常）' },
    { label: '城市未收录（满洲里）', input: { dateStr: '2000-8-16', hour: 8, gender: '男', city: '满洲里' },
      expect: r => r.facts.cityKnown ? '❌ 该城市已被收录，本用例失效，请换一个未收录城市' : '' },
    { label: '未填城市', input: { dateStr: '2000-8-16', hour: 8, gender: '男' } },
    { label: '夏令时区间（1988 乌鲁木齐）', input: { dateStr: '1988-6-15', hour: 12, gender: '女', city: '乌鲁木齐' } },
    { label: '子时分歧（23 时）', input: { dateStr: '2000-8-16', hour: 23, gender: '男', city: '北京' } },
    { label: '时辰未知', input: { dateStr: '2000-8-16', hour: null, gender: '男', city: '北京' } },
    { label: '闰月（1995 闰八月）', input: { dateStr: '1995-10-9', hour: 10, gender: '女', city: '广州' } },
  ];
  for (const c of cases) {
    const r = checkPreflight(c.input);
    console.log(`\n── ${c.label}`);
    console.log(`   ok=${r.ok}  拦截 ${r.blocking.length} 项 / 提示 ${r.warnings.length} 项${c.expect ? '  ' + c.expect(r) : ''}`);
    r.blocking.forEach(b => console.log(`   [拦截] ${b.field}: ${b.question}`));
    r.warnings.forEach(w => console.log(`   [提示] ${w}`));
  }

  // 防死循环：用户明确选了「不校正」之后，不得再追问同一项
  console.log('\n── 决定后复查（防死循环）');
  // 探针城市必须是「未收录」的，否则这条用例形同虚设——先自检，收录了就大声报错
  const PROBE = '满洲里';
  const base = { dateStr: '2000-8-16', hour: 8, gender: '男', city: PROBE };
  const before = checkPreflight(base);
  if (before.facts.cityKnown) {
    console.log(`   ❌ 用例失效：「${PROBE}」已在城市表里，换一个未收录的城市再跑`);
  } else {
    const after = checkPreflight(applyConfirmations(base, { city: '__none__' }));
    console.log(`   未决定时 ok=${before.ok} 拦截 ${before.blocking.length} 项`);
    console.log(`   选「不校正」后 ok=${after.ok} 拦截 ${after.blocking.length} 项 → ${after.ok ? '✓ 不再追问' : '✗ 出现死循环'}`);
  }
}
