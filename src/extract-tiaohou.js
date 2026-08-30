/**
 * extract-tiaohou.js — 从《穷通宝鉴》markdown 表抽取结构化调候用神表
 * 输出 data/tiaohou-table.json：{ "甲": { "寅月": { yongshen: ["丙火","癸水"], note: "…" }, … }, … }
 * 用途：synthesize.js 按 (日干, 月支) 直接查调候用神，替代纯扶抑 heuristic
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'knowledge', 'bazi-classics', 'references', 'qiongtong-baojian.md');
const OUT = path.join(__dirname, '..', 'data', 'tiaohou-table.json');

const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const ZHI_MONTH = ['寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥', '子', '丑']; // 农历正月至腊月

function extract() {
  const raw = fs.readFileSync(SRC, 'utf8');
  const table = {};
  let currentGan = null;
  let rows = 0;
  for (const line of raw.split('\n')) {
    const h2 = line.match(/^##\s+([甲乙丙丁戊己庚辛壬癸])[木火土金水]调候/);
    if (h2) { currentGan = h2[1]; table[currentGan] = table[currentGan] || {}; continue; }
    // 表格行：| 寅月 | 初春 | 丙火、癸水 | 说明 |
    const m = line.match(/^\|\s*([寅卯辰巳午未申酉戌亥子丑])月\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (m && currentGan) {
      const zhi = m[1];
      const yongshen = m[3].trim();
      const note = m[4].trim();
      if (yongshen && yongshen !== '—' && yongshen !== '-') {
        table[currentGan][zhi + '月'] = { yongshen, season: m[2].trim(), note };
        rows++;
      }
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(table, null, 2));
  // 完整性自检：10 天干 × 12 月令
  let missing = 0;
  const report = [];
  for (const g of GAN) {
    const n = Object.keys(table[g] || {}).length;
    report.push(`${g}木${''}:${n}`);
    if (n < 12) missing += 12 - n;
  }
  console.log(`调候表抽取完成：${Object.keys(table).length} 个天干，${rows} 条记录 → ${OUT}`);
  console.log('各天干覆盖月数:', report.join(' '));
  if (missing > 0) console.warn(`⚠️ 缺 ${missing} 条（需人工补全）`);
  return table;
}

extract();
