/**
 * doctor.js — 环境体检（一条命令看清这台机器能不能跑、跑得对不对）
 *
 * 存在的理由：本项目是「确定性排盘 + LLM 解读」两段式，任何一段悄悄坏掉
 * 都会表现为「还在出报告，但结果不可信」——这正是最难发现的一类故障。
 * doctor 用只读检查把这类故障在开跑前顶出来。
 *
 * 用法：
 *   node src/doctor.js              # 全量体检
 *   node src/doctor.js --offline    # 跳过联网检查（服务探活仍走本机）
 *   node src/doctor.js --json       # 机器可读输出（供脚本/自动化消费）
 *   node src/doctor.js --port=3766  # 指定服务端口
 *
 * 退出码：0 = 无 fail（warn 不算错）；1 = 存在 fail
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildChart, CITY_LONGITUDE, resolveCity, SECT_DEFAULTS, sectStamp,
  ZISHI_OPTIONS, LEAP_OPTIONS, SCHOOL_OPTIONS } = require('./chart.js');

const ROOT = path.join(__dirname, '..');
const PY = '/Users/yanqiu/.workbuddy/binaries/python/envs/default/bin/python';
const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models';
const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const AS_JSON = argv.includes('--json');
const portArg = argv.find(a => a.startsWith('--port='));
const PORT = portArg ? portArg.split('=')[1] : (process.env.PORT || 3766);

// ---------- 结果收集 ----------
const results = [];
/** @param {'ok'|'warn'|'fail'} status */
function add(group, name, status, detail, fix) {
  results.push({ group, name, status, detail, fix: fix || '' });
}
const ok = (g, n, d) => add(g, n, 'ok', d);
const warn = (g, n, d, f) => add(g, n, 'warn', d, f);
const fail = (g, n, d, f) => add(g, n, 'fail', d, f);

function maskKey(k) {
  if (!k) return '(空)';
  const s = String(k);
  return s.length <= 10 ? '***' : `${s.slice(0, 6)}…${s.slice(-4)}（长度${s.length}）`;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 已安装依赖版本（读 node_modules/x/package.json，不引入 semver 依赖） */
function installedVersion(pkg) {
  const p = path.join(ROOT, 'node_modules', pkg, 'package.json');
  const j = readJSON(p);
  return j ? j.version : null;
}

// =====================================================================
// 1. 运行时与依赖
// =====================================================================
function checkRuntime() {
  const v = process.version;
  const major = Number(v.slice(1).split('.')[0]);
  // 需要原生 fetch（Node 18+）；cross-check 用 execFileSync，无额外要求
  major >= 18 ? ok('运行时', 'Node 版本', `${v}（${process.platform} / ${process.arch}）`)
              : fail('运行时', 'Node 版本', `${v} 过低，需要 Node 18+（用到原生 fetch）`, '升级 Node 到 18 或更高');

  const pkg = readJSON(path.join(ROOT, 'package.json'));
  if (!pkg) { fail('运行时', 'package.json', '读取失败'); return; }

  const deps = Object.keys(pkg.dependencies || {});
  const missing = [];
  const lines = [];
  for (const d of deps) {
    const iv = installedVersion(d);
    if (!iv) missing.push(d);
    else lines.push(`${d}@${iv}（要求 ${pkg.dependencies[d]}）`);
  }
  if (missing.length) fail('运行时', '依赖安装', `缺失：${missing.join('、')}`, 'npm install');
  else ok('运行时', '依赖安装', lines.join('，'));

  // 本项目自定的 skills / prompts 约定文件
  const need = ['prompts/interpreter-system-prompt.md', 'schema/unified-chart.schema.json'];
  const lack = need.filter(f => !fs.existsSync(path.join(ROOT, f)));
  lack.length ? warn('运行时', '工程文件', `缺失：${lack.join('、')}`, '检查仓库完整性')
              : ok('运行时', '工程文件', `${need.length} 个关键文件齐全`);
}

// =====================================================================
// 2. 配置（.env）
// =====================================================================
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return false;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
  return true;
}

function checkConfig() {
  const hasFile = loadEnv();
  if (!hasFile) { fail('配置', '.env', '未找到 .env', '在项目根目录创建 .env，写入 DEEPSEEK_API_KEY=sk-xxx'); return; }

  const key = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  if (!key) fail('配置', 'DEEPSEEK_API_KEY', '未配置', '在 .env 写入 DEEPSEEK_API_KEY=sk-xxx');
  else if (!/^sk-/.test(key)) warn('配置', 'DEEPSEEK_API_KEY', `已配置但格式可疑：${maskKey(key)}`, 'DeepSeek 的 key 通常以 sk- 开头');
  else ok('配置', 'DEEPSEEK_API_KEY', maskKey(key));

  ok('配置', 'DEEPSEEK_MODEL', model);

  // .env 是否被 git 追踪（泄露风险）
  const gi = path.join(ROOT, '.gitignore');
  const giTxt = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  /\.env/.test(giTxt) ? ok('配置', '.env 已忽略', '.gitignore 包含 .env')
                      : warn('配置', '.env 未忽略', '.gitignore 里没有 .env，存在密钥入库风险', '在 .gitignore 增加一行 .env');
}

// =====================================================================
// 3. 联网：DeepSeek API（key 有效性 + 模型可用性）
//
// 为什么用「1-token 真实探针」而不是 GET /models 列表比对：
// 实测网关把 deepseek-chat 作为别名映射到 deepseek-v4-flash，/models 里
// 只列 v4-flash / v4-pro，不含别名。按列表比对会误报「模型不可用」。
// 探针能一次验证三件事：key 是否有效、模型能否生成、实际解析到哪个模型。
// 成本可忽略（max_tokens=1）。
// =====================================================================
async function checkLLM() {
  if (OFFLINE) { add('联网', 'DeepSeek API', 'skip', '已用 --offline 跳过'); return; }

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) { add('联网', 'DeepSeek API', 'skip', '未配置 key，跳过连通性检查'); return; }

  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const t0 = Date.now();
  try {
    const resp = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '回复一个字：好' }],
        max_tokens: 1, temperature: 0, stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const body = await resp.text();

    if (resp.status === 200) {
      let real = model;
      try { real = JSON.parse(body).model || model; } catch { /* 无法解析也不致命 */ }
      real === model
        ? ok('联网', 'DeepSeek API', `可用（${ms}ms），模型 ${model} 直接命中`)
        : ok('联网', 'DeepSeek API', `可用（${ms}ms），${model} → 网关解析为 ${real}（别名，正常）`);
      return;
    }
    if (resp.status === 401 || resp.status === 403) {
      fail('联网', 'DeepSeek API', `HTTP ${resp.status} — key 无效或已过期：${body.slice(0, 150)}`,
        '到 DeepSeek 控制台重新生成 key 并更新 .env');
      return;
    }
    if (resp.status === 402 || /insufficient|balance|quota/i.test(body)) {
      fail('联网', 'DeepSeek API', `HTTP ${resp.status} — 账户余额不足或配额用尽：${body.slice(0, 150)}`,
        '充值后重试。解读层会因此完全不可用，排盘层不受影响');
      return;
    }
    // 400 多半是模型名写错：顺带把可用列表打出来，省得猜
    let hint = '校对 .env 的 DEEPSEEK_MODEL';
    if (resp.status === 400) {
      const list = await listModels(key);
      if (list) hint = `可用模型：${list.join(', ')}`;
    }
    fail('联网', 'DeepSeek API', `HTTP ${resp.status}：${body.slice(0, 150)}`, hint);
  } catch (e) {
    clearTimeout(timer);
    const aborted = e.name === 'AbortError';
    warn('联网', 'DeepSeek API', aborted ? '超时（>15s）' : `不可达：${e.message}`,
      aborted ? '检查代理/网络；排盘层不受影响，但解读层会失败' : '检查网络或代理设置');
  }
}

/** 仅在报错时调用的辅助：列出网关可用模型（失败返回 null，不产生额外告警） */
async function listModels(key) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(DEEPSEEK_MODELS_URL, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const ids = (JSON.parse(await r.text()).data || []).map(m => m.id);
    return ids.length ? ids : null;
  } catch { return null; }
}

// =====================================================================
// 4. 本机服务探活（含澄清闸端点）
// =====================================================================
async function req(url, options = {}, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return { status: r.status, text: await r.text() };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, text: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

async function checkService() {
  const base = `http://127.0.0.1:${PORT}`;
  const home = await req(base + '/');
  if (home.status !== 200) {
    add('服务', `127.0.0.1:${PORT}`, 'skip',
      home.status === 0 ? '未启动（连接失败）' : `HTTP ${home.status}`,
      'npm start');
    return false;
  }
  const hasClarify = /renderClarify|pickClarify/.test(home.text);
  hasClarify ? ok('服务', `127.0.0.1:${PORT}`, '已启动，前端含澄清闸 UI')
             : warn('服务', `127.0.0.1:${PORT}`, '已启动，但前端未发现澄清闸 UI（可能是旧版本在跑）', '重启服务加载最新 public/index.html');

  // 历史档案 UI：服务读的是磁盘上的 public/index.html，进程是旧代码时页面就没有这个入口，
  // 而它是攒 badcase 的唯一入口 —— 缺了会让人以为「没归档」，其实只是按钮没出来。
  const hasHistory = /hist-drawer/.test(home.text) && /loadHistory|openSession/.test(home.text);
  hasHistory ? ok('服务', '前端历史档案 UI', '已就位（抽屉 + 检索 + 打开）')
             : warn('服务', '前端历史档案 UI', '页面里找不到历史档案入口 —— 长跑进程可能还在用旧前端',
                 '重启服务：npm start');

  // 代码新鲜度：跑着的进程可能还是改代码之前启动的（本项目服务是长跑后台进程，很容易忘记重启）
  const citiesApi = await req(base + '/api/cities', {}, 5000);
  if (citiesApi.status === 200) {
    try {
      const n = JSON.parse(citiesApi.text).count;
      const local = Object.keys(CITY_LONGITUDE).length;
      n === local ? ok('服务', '代码新鲜度', `城市表一致（${local} 座），跑的是最新代码`)
                  : warn('服务', '代码新鲜度', `服务返回 ${n} 座，本地表 ${local} 座 —— 进程是旧代码`, '重启服务：npm start');
    } catch { /* 忽略解析失败 */ }
  } else {
    warn('服务', '/api/cities', `HTTP ${citiesApi.status}（旧版服务无此端点）`, '重启服务：npm start');
  }

  // 澄清闸端点冒烟：先测「正常可直接排盘」的样例，再测「必须拦截」的样例
  const clean = await req(base + '/api/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳' }),
  }, 5000);
  if (clean.status !== 200) {
    fail('服务', '/api/preflight', `HTTP ${clean.status}：${clean.text.slice(0, 150)}`, '重启服务');
  } else {
    try {
      const j = JSON.parse(clean.text);
      j.ok ? ok('服务', '/api/preflight 放行', '标准样例直接放行（无需澄清）')
           : fail('服务', '/api/preflight 放行', `标准样例被误拦：${(j.blocking || []).map(b => b.kind).join(',')}`, '检查 preflight.js 拦截条件');
    } catch {
      fail('服务', '/api/preflight', '返回非 JSON', '重启服务');
    }
  }

  // 反例：23 时必须被拦下问子时口径，否则说明澄清闸失效
  const blocked = await req(base + '/api/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateStr: '2000-8-16', hour: 23, gender: '男', city: '深圳' }),
  }, 5000);
  if (blocked.status === 200) {
    try {
      const j = JSON.parse(blocked.text);
      const hasZishi = (j.blocking || []).some(b => b.kind === 'zishi');
      hasZishi ? ok('服务', '/api/preflight 拦截', '23 时正确拦下子时口径确认')
               : fail('服务', '/api/preflight 拦截', '23 时未拦下子时口径，澄清闸失效', '检查 preflight.js 的 zishi 分支');
    } catch { /* 已在上面报过 */ }
  }
  return true;
}

// =====================================================================
// 5. 知识库
// =====================================================================
function newestMtimeUnder(dir, exts) {
  let newest = 0, file = '';
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); continue; }
      if (exts && !exts.some(x => e.name.endsWith(x))) continue;
      try {
        const mt = fs.statSync(p).mtimeMs;
        if (mt > newest) { newest = mt; file = p; }
      } catch { /* ignore */ }
    }
  };
  walk(dir);
  return { mtime: newest, file };
}

function checkKnowledge() {
  const kbPath = path.join(ROOT, 'data', 'kb.jsonl');
  if (!fs.existsSync(kbPath)) { fail('知识库', 'kb.jsonl', '不存在', 'npm run kb'); return; }

  let lines = [];
  try { lines = fs.readFileSync(kbPath, 'utf8').split('\n').filter(Boolean); } catch (e) {
    fail('知识库', 'kb.jsonl', `读取失败：${e.message}`); return;
  }

  const byTradition = {}, byLicense = {};
  let bad = 0;
  const ids = new Set();
  let dup = 0;
  for (const ln of lines) {
    try {
      const o = JSON.parse(ln);
      if (!o.id || !o.text) { bad++; continue; }
      if (ids.has(o.id)) dup++; else ids.add(o.id);
      byTradition[o.tradition || '?'] = (byTradition[o.tradition || '?'] || 0) + 1;
      byLicense[o.license || '?'] = (byLicense[o.license || '?'] || 0) + 1;
    } catch { bad++; }
  }
  const tStr = Object.entries(byTradition).map(([k, v]) => `${k} ${v}`).join(' / ');
  const lStr = Object.entries(byLicense).map(([k, v]) => `${k} ${v}`).join(' / ');

  if (bad) fail('知识库', 'kb.jsonl 解析', `${bad} 行格式错误`, 'npm run kb 重建');
  else if (dup) warn('知识库', 'kb.jsonl 编号', `${dup} 个重复 id`, '检查 build-kb.js 编号生成');
  else if (lines.length < 100) warn('知识库', 'kb.jsonl', `仅 ${lines.length} 条，偏少`, 'npm run kb');
  else ok('知识库', 'kb.jsonl', `${lines.length} 条（${tStr}；${lStr}）`);

  // 与 knowledge/ 源文件是否同步
  const src = newestMtimeUnder(path.join(ROOT, 'knowledge'), ['.md', '.json', '.txt']);
  const kbMt = fs.statSync(kbPath).mtimeMs;
  if (src.mtime && src.mtime > kbMt) {
    warn('知识库', '与 knowledge/ 同步',
      `源文件 ${path.relative(ROOT, src.file)} 更新于知识库之后`, 'npm run kb');
  } else if (src.mtime) {
    ok('知识库', '与 knowledge/ 同步', '知识库不早于源文件');
  }

  // 调候表（穷通宝鉴）：结构是「10 天干 × 12 月」两层嵌套，要数叶子节点
  const thPath = path.join(ROOT, 'data', 'tiaohou-table.json');
  if (!fs.existsSync(thPath)) { warn('知识库', '调候表', '不存在', 'node src/extract-tiaohou.js'); return; }
  const th = readJSON(thPath);
  if (!th || typeof th !== 'object') { warn('知识库', '调候表', '解析失败', 'node src/extract-tiaohou.js'); return; }
  const gans = Object.keys(th);
  const months = new Set();
  let leaves = 0, empty = 0;
  for (const g of gans) {
    const v = th[g] || {};
    for (const m of Object.keys(v)) { months.add(m); leaves++; if (!v[m] || !v[m].yongshen) empty++; }
  }
  if (leaves < 120) warn('知识库', '调候表', `仅 ${leaves} 条（期望 10×12=120）`, 'node src/extract-tiaohou.js');
  else if (empty) warn('知识库', '调候表', `${leaves} 条，其中 ${empty} 条缺 yongshen`, 'node src/extract-tiaohou.js');
  else ok('知识库', '调候表', `${gans.length} 天干 × ${months.size} 月 = ${leaves} 条，无缺失`);
}

// =====================================================================
// 6. 城市经度表
// =====================================================================
function checkCities() {
  const cities = Object.keys(CITY_LONGITUDE);

  // 时区守卫：本表只能收录 UTC+8 地区。中国版图约 73°E~135°E；
  // 一旦有人往表里加了海外城市，(lon-120)*4 就会算错真太阳时且不会报错——这里必须顶出来。
  const CN_WEST = 73, CN_EAST = 135;
  const bad = cities.filter(c => typeof CITY_LONGITUDE[c] !== 'number' ||
    CITY_LONGITUDE[c] < CN_WEST || CITY_LONGITUDE[c] > CN_EAST);
  if (bad.length) {
    fail('城市表', '时区守卫', `${bad.length} 座经度越界（${bad.slice(0, 5).join('、')}），真太阳时公式按东八区推导，海外城市会算错`,
      '海外城市必须带 tzOffset 字段并改 trueSolarAdjust 为 (lon - 15*tzOffset) * 4');
  } else {
    ok('城市表', '时区守卫', `${cities.length} 座全部落在 ${CN_WEST}°E~${CN_EAST}°E（UTC+8 单一时区，公式成立）`);
  }

  const lons = cities.map(c => CITY_LONGITUDE[c]);
  const span = (Math.max(...lons) - Math.min(...lons)).toFixed(2);
  if (cities.length < 100) {
    warn('城市表', '覆盖不足', `仅 ${cities.length} 座，未收录城市会被澄清闸拦下（不静默按北京算）`,
      '需要时在 chart.js 的 CITY_LONGITUDE 补充');
  } else {
    ok('城市表', '覆盖数', `${cities.length} 座，经度跨度 ${span}°（换算后极差 ${((Math.max(...lons) - 120) * 4 - (Math.min(...lons) - 120) * 4).toFixed(0)} 分钟）`);
  }

  // 校正幅度最大的城市要能被肉眼核对（西部地区真太阳时比钟表时间晚 2 小时以上，是常见质疑点）
  const extreme = cities.slice().sort((a, b) => CITY_LONGITUDE[a] - CITY_LONGITUDE[b]);
  const w = extreme[0], e = extreme[extreme.length - 1];
  ok('城市表', '校正极值',
    `最西 ${w}（${((CITY_LONGITUDE[w] - 120) * 4).toFixed(0)} 分钟）／最东 ${e}（+${((CITY_LONGITUDE[e] - 120) * 4).toFixed(0)} 分钟）`);

  // 容错匹配是否生效（用户常输「深圳市」这类带后缀写法，不该被当成未收录）
  const cases = [['深圳市', '深圳'], ['哈尔滨', '哈尔滨'], ['淄博市', '淄博'], ['东京', null]];
  const wrong = cases.filter(([input, want]) => resolveCity(input).name !== want);
  wrong.length
    ? fail('城市表', '容错匹配', wrong.map(([i, w]) => `${i}→${resolveCity(i).name}（应为 ${w}）`).join('，'), '检查 resolveCity 的后缀剥离规则')
    : ok('城市表', '容错匹配', '「深圳市」→「深圳」等后缀写法已归一，未收录返回 null');
}

// =====================================================================
// 7. 流派口径
// =====================================================================
function checkSect() {
  const s = SECT_DEFAULTS;
  const valid = ZISHI_OPTIONS[s.zishi] && LEAP_OPTIONS[s.leap] && SCHOOL_OPTIONS[s.school];
  if (!valid) { fail('流派口径', '默认值', `非法组合：${JSON.stringify(s)}`, '修正 SECT_DEFAULTS'); return; }
  ok('流派口径', '默认口径',
    `${ZISHI_OPTIONS[s.zishi].label} / ${LEAP_OPTIONS[s.leap].label} / ${SCHOOL_OPTIONS[s.school].label}`);
  ok('流派口径', '报告落款', sectStamp(s));

  // 三档子时必须真的分得开，否则说明参数没生效（曾经踩过：被真太阳时掩盖）
  const base = { gender: '男', city: null };
  const outs = ['early', 'midnight', 'late'].map(z => {
    const c = buildChart({ dateStr: '2000-8-16', hour: 23, ...base, sect: { zishi: z } });
    return `${c.bazi.pillars.day}${c.bazi.pillars.hour}`;
  });
  const uniq = new Set(outs);
  if (uniq.size === 3) ok('流派口径', '子时三档有效性', `early=${outs[0]} midnight=${outs[1]} late=${outs[2]}`);
  else fail('流派口径', '子时三档有效性', `三档结果未分离（${outs.join(' / ')}），参数可能没生效`, '检查 chart.js resolveZishi');
}

// =====================================================================
// 8. Python 侧（跨实现对拍依赖）
// =====================================================================
function checkPython() {
  if (!fs.existsSync(PY)) {
    warn('对拍依赖', 'python', `未找到 ${PY}`, 'npm run crosscheck 会失败；重建 venv 或改 cross-check.js 里的 PY 路径');
    return;
  }
  try {
    const out = execFileSync(PY, ['-c', 'import lunar_python,sys;print(lunar_python.__name__, sys.version.split()[0])'],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    ok('对拍依赖', 'lunar-python', `可用（python ${out.trim().split(' ')[1] || ''}）`);
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().slice(0, 200);
    warn('对拍依赖', 'lunar-python', `不可用：${msg}`,
      'pip install lunar-python（装进 /Users/yanqiu/.workbuddy/binaries/python/envs/default）');
  }
}

// =====================================================================
// 9. 排盘层冒烟（确定性部分，不花钱不联网）
// =====================================================================
function checkSmoke() {
  const cases = [
    { name: '标准样例 深圳14时', input: { dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳' } },
    { name: '夏令时样例 1988年', input: { dateStr: '1988-7-1', hour: 10, gender: '女', city: '北京' } },
    { name: '时辰未知降级', input: { dateStr: '1995-6-15', hour: null, gender: '女', city: '杭州' } },
  ];
  for (const c of cases) {
    try {
      const chart = buildChart(c.input);
      const p = chart.bazi.pillars;
      const need = c.input.hour == null
        ? (p.year && p.month && p.day && chart.bazi.hourPillarMissing && chart.ziwei.skipped)
        : (p.year && p.month && p.day && p.hour && chart.ziwei && chart.ziwei.soul);
      if (!need) { fail('排盘冒烟', c.name, `关键字段缺失：${JSON.stringify(p)}`, '检查 chart.js'); continue; }
      const extra = c.input.hour == null ? '（已降级为八字三柱）'
        // 说「命主」而不是「命宫主星」：ziwei.soul 是按命宫地支查表得来的命主，
        // 命宫里坐的星是 mingGongStars。叫错了就是在给下游埋误读（见 chart.js 注释）
        : `（${p.year} ${p.month} ${p.day} ${p.hour}，命主 ${chart.ziwei.mingZhu || '?'}，命宫主星 ${(chart.ziwei.mingGongStars || []).join('、') || '空宫'}）`;
      ok('排盘冒烟', c.name, '通过' + extra);
    } catch (e) {
      fail('排盘冒烟', c.name, `抛异常：${e.message}`, '检查 chart.js 及依赖版本');
    }
  }

  // 夏令时扣回是否真的生效
  try {
    const a = buildChart({ dateStr: '1988-7-1', hour: 10, gender: '男', city: '北京', dstMode: 'auto' });
    const b = buildChart({ dateStr: '1988-7-1', hour: 10, gender: '男', city: '北京', dstMode: 'none' });
    a.meta.trueSolar.dstApplied && !b.meta.trueSolar.dstApplied
      ? ok('排盘冒烟', '夏令时扣回', `auto 已扣（有效时辰 ${a.meta.effectiveHour}），none 未扣（${b.meta.effectiveHour}）`)
      : fail('排盘冒烟', '夏令时扣回', 'dstMode 未生效', '检查 trueSolarAdjust');
  } catch (e) {
    fail('排盘冒烟', '夏令时扣回', e.message);
  }
}

// =====================================================================
// 10. 会话归档（攒 badcase 的地方，坏了等于白攒）
// =====================================================================
const SESSIONS_FILE = path.join(ROOT, 'data', 'sessions.jsonl');

function checkSessions() {
  let sessions;
  try { sessions = require('./sessions.js'); }
  catch (e) { fail('会话归档', '模块加载', `require 失败：${e.message}`, '检查 src/sessions.js'); return; }

  if (!fs.existsSync(SESSIONS_FILE)) {
    // 全新环境还没跑过解读，文件不存在是正常的——但这必须是「因为没跑过」，
    // 而不是因为建目录失败，所以要确认 data/ 可写。
    try {
      fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
      ok('会话归档', '归档文件', `尚未创建（${SESSIONS_FILE}）—— 跑一次解读就会自动建，data/ 可写`);
    } catch (e) {
      fail('会话归档', '归档文件', `data/ 不可写：${e.message}`, '检查目录权限');
    }
    return;
  }

  let stats, listed;
  try {
    stats = sessions.stats();
    listed = sessions.listSessions({ limit: 500 });
  } catch (e) {
    fail('会话归档', '读取', `读取失败：${e.message}`, 'sessions.jsonl 可能损坏，检查最近一次写入是否完整');
    return;
  }

  // 坏行：readAll 不丢弃坏行，而是随 bad 数组返回——这里必须报出来，
  // 否则坏行会在下次整体重写时被静默抹掉（数据丢失比报错更糟）。
  stats.badLines > 0
    ? fail('会话归档', '可解析性', `${stats.badLines} 行 JSON 解析失败`,
        '手工修 data/sessions.jsonl 的坏行，或从备份恢复；不要直接整体重写（会丢这些行）')
    : ok('会话归档', '可解析性', `${stats.total} 行全部可解析`);

  // 规模与体积：JSONL 是全量重写模型，体积越大每次写入越慢、崩一半的风险越高
  const mb = (stats.bytes / 1024 / 1024).toFixed(2);
  const sizeLine = `${stats.total} 条 / ${mb} MB`;
  stats.bytes > 50 * 1024 * 1024
    ? warn('会话归档', '体积', sizeLine, '超过 50MB：定期导出备份后清理旧档案，避免每次写入都要重写整个大文件')
    : ok('会话归档', '体积', sizeLine + (stats.total ? `（平均 ${Math.round(stats.bytes / stats.total / 1024)} KB/条）` : ''));

  if (!stats.total) {
    ok('会话归档', '评分分布', '暂无档案（跑一次解读后自动归档）');
    return;
  }

  const g = stats.byRating.good || 0, b = stats.byRating.bad || 0;
  const rate = Math.round((g + b) / stats.total * 100);
  ok('会话归档', '评分分布',
    `准 ${g} / 不准 ${b} / 未评 ${stats.total - g - b}（评价率 ${rate}%）· 带回真实事实 ${stats.withFacts} 条`);

  // 已评价比例：攒了几十条却没人评价，等于攒了一堆没法用的样本
  if (stats.total >= 10 && rate < 30) {
    warn('会话归档', '评价率', `${rate}% —— 攒了 ${stats.total} 条却基本没评价`,
      '开历史面板把看过的标一下，否则这些样本无法用来校正规则');
  }

  // 记录完整性：缺 chart / report 的档案打开就是空白页
  const broken = listed.items.filter(it => !it.hasChart);
  broken.length
    ? warn('会话归档', '记录完整性', `${broken.length} 条缺少完整排盘（打开会是空白）：${broken.slice(0, 3).map(r => r.id).join('、')}`,
        '这些多半是早期记录或手工写入；可直接删除，别留着污染检索')
    : ok('会话归档', '记录完整性', `${stats.total} 条均含完整排盘`);

  // 检索可用性冒烟：拿一条真实记录的特征去检索，命中才说明检索真能用。
  // 只查「文件在不在」不够——字段抽错时文件在、但永远搜不到。
  const probe = listed.items.find(it => it.index && it.index.dayMaster);
  if (probe) {
    try {
      const hit = sessions.listSessions({ dayMaster: probe.index.dayMaster, limit: 500 });
      hit.total > 0
        ? ok('会话归档', '检索可用性', `按日主「${probe.index.dayMaster}」检索命中 ${hit.total} 条`)
        : fail('会话归档', '检索可用性', `按日主「${probe.index.dayMaster}」检索应命中却为 0`, '检查 buildIndex 是否抽错字段');
    } catch (e) {
      fail('会话归档', '检索可用性', e.message, '检查 sessions.js listSessions');
    }
  }
}

/**
 * 第 11 组：命理知识题库（bench）
 *
 * 只查「文件在不在」不够。题库有三个真实风险，都必须体检：
 *   ① 条数太少 —— 统计上不可信，跑出来的正确率没意义
 *   ② 题型缺失 —— 少一种题型就等于那一块能力没被测到，而报告上看不出来
 *   ③ drift      —— 排盘层改了但题库没重算，答案与现算结果对不上，
 *                   此时评测会把「排盘层变了」误报成「模型退步了」
 * drift 检测不联网、秒级，适合常驻体检。
 */
function checkBench() {
  const BENCH_FILE = path.join(ROOT, 'data', 'bench.jsonl');
  if (!fs.existsSync(BENCH_FILE)) {
    warn('命理题库', '题库文件', 'data/bench.jsonl 不存在', '运行 npm run bench -- --build 生成题库');
    return;
  }

  let rows;
  try {
    rows = fs.readFileSync(BENCH_FILE, 'utf8').trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {
    fail('命理题库', '可解析性', `解析失败：${e.message}`, '题库 JSONL 损坏，运行 npm run bench -- --build 重建');
    return;
  }

  // 必备题型：缺任何一种，报告里的「总正确率」都是虚高的
  const REQUIRED = ['dayMaster', 'hourGan', 'monthGan', 'dayunDirection', 'mingZhu', 'adversarial'];
  const byType = {};
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  const missing = REQUIRED.filter(t => !byType[t]);

  if (rows.length < 40) {
    warn('命理题库', '题量', `仅 ${rows.length} 题`, '建议 ≥40 题，否则分题型正确率的抽样误差过大');
  } else {
    ok('命理题库', '题量', `${rows.length} 题`);
  }

  missing.length
    ? fail('命理题库', '题型覆盖', `缺少题型：${missing.join('、')}`,
        '检查对应生成器是否因自校验守卫全部跳过了题（宁可不出题，也不能出自相矛盾的题）')
    : ok('命理题库', '题型覆盖', `${Object.keys(byType).length} 种题型齐全（${Object.entries(byType).map(([k, v]) => k + ' ' + v).join(' · ')}）`);

  // drift：重算答案与存盘答案比对。这是把「排盘层改动」与「模型退步」区分开的唯一手段。
  try {
    const { verifyBench } = require('./bench.js');
    const res = verifyBench();
    res.drift === 0
      ? ok('命理题库', 'drift 检测', `${res.total} 题答案与现算一致`)
      : fail('命理题库', 'drift 检测', `${res.drift}/${res.total} 题答案已漂移：${res.samples.join('；')}`,
          '排盘层或合成规则改过了，运行 npm run bench -- --build 重算题库；否则评测会把排盘变化误判为模型退步');
  } catch (e) {
    warn('命理题库', 'drift 检测', `无法执行：${e.message}`, '检查 src/bench.js 是否导出了 verifyBench');
  }
}

// =====================================================================
// 输出
// =====================================================================
const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' };

function render() {
  const groups = [];
  for (const r of results) if (!groups.includes(r.group)) groups.push(r.group);

  const L = [];
  L.push('');
  L.push('══════ 命理顾问 · 环境体检 ══════');
  L.push(`时间：${new Date().toLocaleString('zh-CN')}${OFFLINE ? '（离线模式）' : ''}`);
  L.push('');
  for (const g of groups) {
    const rows = results.filter(r => r.group === g);
    L.push(`── ${g} ──`);
    for (const r of rows) {
      L.push(`  ${ICON[r.status]} ${r.name}：${r.detail}`);
      if (r.fix && r.status !== 'ok') L.push(`      → 建议：${r.fix}`);
    }
    L.push('');
  }

  const nOk = results.filter(r => r.status === 'ok').length;
  const nWarn = results.filter(r => r.status === 'warn').length;
  const nFail = results.filter(r => r.status === 'fail').length;
  const nSkip = results.filter(r => r.status === 'skip').length;

  L.push('── 汇总 ──');
  L.push(`  通过 ${nOk}  ·  警告 ${nWarn}  ·  失败 ${nFail}  ·  跳过 ${nSkip}`);
  if (nFail) {
    L.push('');
    L.push('  存在失败项，排盘或解读可能不可信：');
    results.filter(r => r.status === 'fail').forEach(r => L.push(`    ❌ [${r.group}] ${r.name} — ${r.detail}`));
  } else if (nWarn) {
    L.push('  无致命问题，警告项不影响排盘正确性，但建议按提示处理。');
  } else {
    L.push('  全部通过。');
  }
  L.push('');
  return { text: L.join('\n'), nFail, nWarn, nOk, nSkip };
}

async function main() {
  checkRuntime();
  checkConfig();
  checkKnowledge();
  checkCities();
  checkSect();
  checkPython();
  checkSmoke();
  checkSessions();
  checkBench();
  await checkLLM();
  await checkService();

  if (AS_JSON) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), offline: OFFLINE,
      summary: {
        ok: results.filter(r => r.status === 'ok').length,
        warn: results.filter(r => r.status === 'warn').length,
        fail: results.filter(r => r.status === 'fail').length,
        skip: results.filter(r => r.status === 'skip').length,
      },
      checks: results,
    }, null, 2));
  } else {
    console.log(render().text);
  }
  process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
}

if (require.main === module) main();
module.exports = { main };
