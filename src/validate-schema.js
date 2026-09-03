/**
 * validate-schema.js — 零依赖 schema 校验器（覆盖本项目用到的 draft-07 子集）
 * 用法：node src/validate-schema.js [json文件路径...]
 * 无参数时校验 samples/ 下全部样例 + 生成一个时辰未知的样例
 */
const fs = require('fs');
const path = require('path');
const { buildChart } = require('./chart.js');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'unified-chart.schema.json'), 'utf8'));

function resolveRef(schema, root) {
  return schema;
}

function typeOk(v, t) {
  if (Array.isArray(t)) return t.some(tt => typeOk(v, tt));
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'null') return v === null;
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  if (t === 'string') return typeof v === 'string';
  if (t === 'boolean') return typeof v === 'boolean';
  return true;
}

/** @returns {string[]} 错误列表 */
function validate(v, schema, root, pathStr) {
  const errors = [];
  if (schema.$ref) {
    const refPath = schema.$ref.replace(/^#\//, '').split('/');
    let s = root;
    for (const p of refPath) s = s[p];
    return validate(v, s, root, pathStr);
  }
  if (schema.oneOf) {
    const passIdx = schema.oneOf.filter(s => validate(v, s, root, pathStr).length === 0);
    if (passIdx.length !== 1) errors.push(`${pathStr}: oneOf 匹配 ${passIdx.length} 个分支（须恰好 1 个）`);
    return errors;
  }
  if (schema.enum) {
    if (!schema.enum.includes(v)) errors.push(`${pathStr}: 值 ${JSON.stringify(v)} 不在枚举内`);
    return errors;
  }
  if (schema.const !== undefined) {
    if (v !== schema.const) errors.push(`${pathStr}: 应为 ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.type && !typeOk(v, schema.type)) {
    errors.push(`${pathStr}: 类型应为 ${schema.type}，实际 ${v === null ? 'null' : typeof v}${Array.isArray(v) ? '(array)' : ''}`);
    return errors;
  }
  if (typeof v === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errors.push(`${pathStr}: "${v}" 不匹配 ${schema.pattern}`);
  }
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) errors.push(`${pathStr}: ${v} < minimum ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errors.push(`${pathStr}: ${v} > maximum ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errors.push(`${pathStr}: 数组长度 ${v.length} < ${schema.minItems}`);
    if (schema.maxItems != null && v.length > schema.maxItems) errors.push(`${pathStr}: 数组长度 ${v.length} > ${schema.maxItems}`);
    if (schema.items) v.forEach((item, i) => errors.push(...validate(item, schema.items, root, `${pathStr}[${i}]`)));
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (schema.required) {
      for (const k of schema.required) {
        if (!(k in v)) errors.push(`${pathStr}: 缺少必填字段 "${k}"`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(v)) {
        if (!(k in schema.properties)) errors.push(`${pathStr}: 多余字段 "${k}"`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in v) errors.push(...validate(v[k], sub, root, `${pathStr}.${k}`));
      }
    }
    if (schema.propertyNames && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [k, val] of Object.entries(v)) {
        const pn = schema.propertyNames;
        if (pn.pattern && !new RegExp(pn.pattern).test(k)) errors.push(`${pathStr}: 属性名 "${k}" 不匹配 ${pn.pattern}`);
        errors.push(...validate(val, schema.additionalProperties, root, `${pathStr}.${k}`));
      }
    }
  }
  return errors;
}

function checkFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errs = validate(data, SCHEMA, SCHEMA, '$');
  if (errs.length === 0) { console.log(`✅ ${path.basename(file)}`); return true; }
  console.log(`❌ ${path.basename(file)} — ${errs.length} 处违规:`);
  errs.slice(0, 20).forEach(e => console.log('   ' + e));
  return false;
}

// ───────── 样例定义：样例由这里生成，不由人手写 ─────────
// 排盘层一改字段，旧样例就与新 schema 不符；所以样例必须能一键重生成，
// 否则「样例失败」这件事会被手工改 JSON 掩盖过去，等于放弃回归。
const SAMPLE_INPUTS = [
  { dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳', slug: 'shenzhen' },
  // 佳木斯 130.35°E → 真太阳时 +41 分钟，23 时校正后仍在 23 时，正好触发子时三档口径分歧。
  // 用北京（114°E 附近）会被校正到亥时，口径差异被掩盖 —— 这是踩过的坑
  { dateStr: '2000-8-16', hour: 23, gender: '男', city: '佳木斯', slug: 'jiamusi' },
  { dateStr: '1995-6-15', hour: null, gender: '女', city: '杭州', slug: 'hangzhou' },   // 时辰未知降级
];

function regenSamples() {
  const samplesDir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(samplesDir, { recursive: true });
  for (const inp of SAMPLE_INPUTS) {
    const chart = buildChart(inp);
    const name = `sample-${inp.dateStr}-${inp.hour == null ? 'null' : inp.hour}-`
      + `${inp.gender === '男' ? 'm' : 'f'}-${inp.slug}.json`;
    fs.writeFileSync(path.join(samplesDir, name), JSON.stringify(chart, null, 2));
    console.log(`🔄 重生成 ${name}`);
  }
}

// 主流程
const args = process.argv.slice(2).filter(a => a !== '--regen');
const REGEN = process.argv.includes('--regen');
let allOk = true;
if (REGEN) {
  regenSamples();
  console.log('');
}
if (args.length) {
  for (const f of args) allOk = checkFile(f) && allOk;
} else {
  const samplesDir = path.join(__dirname, '..', 'samples');
  // 样例文件由 --regen 生成，这里只负责校验（含上面 SAMPLE_INPUTS 里定义的每一份）
  const files = fs.readdirSync(samplesDir).filter(f => f.endsWith('.json')).map(f => path.join(samplesDir, f));
  for (const f of files) allOk = checkFile(f) && allOk;
}
process.exit(allOk ? 0 : 1);
