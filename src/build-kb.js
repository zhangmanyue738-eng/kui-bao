/**
 * build-kb.js — 构建 RAG 知识库
 * 输出 data/kb.jsonl，每行 { id, source, tradition, license, text }
 *   tradition: bazi | ziwei        —— 用于按术数检索
 *   license:   public_domain | modern —— 对外发布时可一键剔除 modern（版权保护）
 * 运行：node src/build-kb.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ZIWEI_REPO = path.join(ROOT, 'knowledge', 'ziwei-doushu');
const BAZI_DIR = path.join(ROOT, 'knowledge', 'bazi-classics', 'references');
const OUT = path.join(ROOT, 'data', 'kb.jsonl');

const entries = [];
let seq = 0;
const nid = () => 'KB-' + String(++seq).padStart(3, '0');
const push = (source, tradition, license, text) => {
  text = (text || '').trim();
  if (text.length < 25) return;
  entries.push({ id: nid(), source, tradition, license, text });
};

// ───────── 1. 紫微古籍（classics/data/*.ts）─────────
function extractZiweiClassics() {
  const dir = path.join(ZIWEI_REPO, 'lib', 'classics', 'data');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const bookTitle = (raw.match(/title:\s*'([^']+)'/) || [])[1] || f;
    const chapterRe = /title:\s*'([^']+)'[\s\S]*?paragraphs:\s*\[([\s\S]*?)\n\s*\]/g;
    let m;
    while ((m = chapterRe.exec(raw)) !== null) {
      const chTitle = m[1];
      const textRe = /text:\s*'((?:[^'\\]|\\.)*)'/g;
      const paras = [];
      let t;
      while ((t = textRe.exec(m[2])) !== null) paras.push(t[1].replace(/\\'/g, "'").trim());
      for (let i = 0; i < paras.length; i += 2) {
        push(`《${bookTitle}》${chTitle}`, 'ziwei', 'public_domain', paras.slice(i, i + 2).join('\n'));
      }
    }
  }
}

// ───────── 2. 紫微格局库（patterns.ts，带古籍出处）─────────
function extractZiweiPatterns() {
  const p = path.join(ZIWEI_REPO, 'lib', 'ziwei', 'patterns.ts');
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, 'utf8');
  const re = /name:\s*'([^']+)',[^{}]*?level:\s*'([^']+)'[^{}]*?description:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [_, name, level, desc] = m;
    const after = raw.slice(re.lastIndex, re.lastIndex + 300);
    const src = (after.match(/source:\s*'([^']+)'/) || [])[1] || '';
    const levelMap = { excellent: '上格', good: '吉格', neutral: '平', caution: '慎' };
    push(`格局库·${src || 'ziwei-doushu patterns'}`, 'ziwei', 'modern',
      `格局「${name}」（${levelMap[level] || level}）：${desc.replace(/\\'/g, "'")}`);
  }
}

// ───────── 3. 倪海厦《天纪》讲义（现代整理，仅自用）─────────
function extractNihai() {
  const dir = path.join(ZIWEI_REPO, 'lib', 'nihai');
  if (!fs.existsSync(dir)) return;
  for (const f of ['tianji.ts', 'renji.ts', 'diji.ts']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    const modRe = /name:\s*'([^']+)',[^{}]*?description:\s*'((?:[^'\\]|\\.)*)'([\s\S]*?)(?=\n\s*\{\n\s*id:|\n\s*\];|$)/g;
    let m;
    while ((m = modRe.exec(raw)) !== null) {
      const [_, name, desc, rest] = m;
      const details = [];
      const dRe = /'((?:[^'\\]|\\.)*)'/g;
      let d;
      const detailsBlock = rest.match(/details:\s*\[([\s\S]*?)\]/);
      if (detailsBlock) while ((d = dRe.exec(detailsBlock[1])) !== null) details.push(d[1].replace(/\\'/g, "'"));
      push(`倪海厦《天纪》讲义·${name}`, 'ziwei', 'modern',
        [`【${name}】${desc.replace(/\\'/g, "'")}`, ...details].join('\n'));
    }
  }
}

// ───────── 4. 八字参考资料（markdown）─────────
// 公版古籍：渊海子平(宋)、穷通宝鉴(清)、神峰通考(明) —— 标注 **原文** 的引用块
// 现代整理：其余断法文件（梁湘润体系等）
const BAZI_FILE_MAP = {
  'yuanhai-ziping': { book: '渊海子平', pub: true },
  'qiongtong-baojian': { book: '穷通宝鉴', pub: true },
  'shenfeng-bingyao': { book: '神峰通考', pub: true },
  'geju-chengbai': { book: '子平真诠·滴天髓（格局成败）', pub: false },
  'ershichangsheng': { book: '十二长生表', pub: false },
  'hunyin-duanfa': { book: '婚姻断法', pub: false },
  'liunian-duanyu': { book: '流年断语', pub: false },
  'liunian-liandong': { book: '流年联动', pub: false },
  'dayun-jixiong': { book: '大运吉凶', pub: false },
  'xiaoyun': { book: '小运', pub: false },
  'liuqin-duanyu': { book: '六亲断语', pub: false },
  'shengwang-muku-duanfa': { book: '生旺墓库断法', pub: false },
  'shensha': { book: '神煞', pub: false },
  'tiangan-dizhi': { book: '天干地支', pub: false },
  'taiyuan-minggong': { book: '胎元命宫', pub: false },
  'mangpai-koujue': { book: '盲派口诀', pub: false },
  'duanming-nianling': { book: '断命年龄', pub: false },
  'liang-xiangrun-rule-selector': { book: '梁湘润规则择用', pub: false },
  'zhen-taiyangshi': { book: '真太阳时', pub: false },
  'bazi-sop': { book: '八字分析流程', pub: false },
};

function extractBaziMarkdown() {
  if (!fs.existsSync(BAZI_DIR)) return;
  for (const f of fs.readdirSync(BAZI_DIR).filter(f => f.endsWith('.md'))) {
    const key = f.replace(/\.md$/, '');
    const meta = BAZI_FILE_MAP[key] || { book: key, pub: false };
    const raw = fs.readFileSync(path.join(BAZI_DIR, f), 'utf8');
    // 按 ## 或 ### 切分（粒度更细，检索更准）
    const sections = raw.split(/^#{2,3}\s+/m).slice(1);
    // 日干：用于调候表条目的天干补全（从 ## 标题如「甲木调候」取）
    let currentGan = null;
    for (const sec of sections) {
      const lines = sec.split('\n');
      const title = lines[0].trim();
      if (/^目录$/.test(title)) continue;
      const ganMatch = title.match(/^([甲乙丙丁戊己庚辛壬癸])[木火土金水]调候/);
      if (ganMatch) currentGan = ganMatch[1];

      // 原文块：**原文** 之后的 > 引用行
      const quotes = [];
      let sawYuanwen = false;
      for (const ln of lines) {
        if (/\*\*原文\*\*|^原文[：:]/.test(ln)) { sawYuanwen = true; continue; }
        const q = ln.match(/^>\s?(.*)$/);
        if (q && q[1].trim() && sawYuanwen) quotes.push(q[1].trim());
      }
      if (quotes.length) {
        push(`《${meta.book}》${title}`, 'bazi', meta.pub ? 'public_domain' : 'modern',
          quotes.join('\n'));
      }

      // 表格 → 文本条目（如穷通宝鉴调候表：| 寅月 | 初春 | 丙火、癸水 | 说明 |）
      const tableRows = [];
      let inCode = false;
      for (const ln of lines) {
        if (/^\s*```/.test(ln)) { inCode = !inCode; continue; }
        if (inCode) continue;
        const r = ln.match(/^\|\s*([^|]+)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/);
        if (!r) continue;
        const c = r.slice(1).map(s => s.trim());
        if (c.every(x => /^[-: ]+$/.test(x))) continue;  // 分隔行
        if (/月令|季节|^项目$|^十神$|^关系$/.test(c[0])) continue; // 表头
        tableRows.push(c);
      }
      if (tableRows.length) {
        // 调候表：日干 + 月令 + 用神 + 说明
        for (const c of tableRows) {
          const [zhiyue, season, yongshen, note] = c;
          if (currentGan && /^[寅卯辰巳午未申酉戌亥子丑]月$/.test(zhiyue) && yongshen) {
            // 表格属「整理形式」，即便源自古籍也归 modern（对外发布更安全）
            push(`《${meta.book}》${currentGan}日干调候·${zhiyue}`, 'bazi', 'modern',
              `${currentGan}日干生于${zhiyue}（${season}）：调候用神 ${yongshen}。${note || ''}`);
          } else {
            push(`八字断法·${meta.book}·${title}`, 'bazi', 'modern', c.filter(Boolean).join(' ｜ '));
          }
        }
      }

      // 其余正文（断语、要点）作为现代整理条目
      const bodyLines = [];
      inCode = false;
      for (const ln of lines.slice(1)) {
        if (/^\s*```/.test(ln)) { inCode = !inCode; continue; }
        if (inCode) continue;
        const s = ln.trim();
        if (!s) continue;
        if (/^>/.test(s)) continue;            // 引用已归入原文
        if (/^\|/.test(s)) continue;            // 表格已单独处理
        if (/^---+$/.test(s)) continue;
        if (/^#{1,6}\s/.test(s)) continue;
        if (/^\d+\.\s*$/.test(s)) continue;
        bodyLines.push(s.replace(/^[-*]\s*/, '').replace(/\*\*/g, ''));
      }
      if (bodyLines.length) {
        const body = bodyLines.join('\n');
        for (let i = 0; i < body.length; i += 500) {
          push(`八字断法·${meta.book}·${title}`, 'bazi', 'modern', body.slice(i, i + 500));
        }
      }
    }
  }
}

extractZiweiClassics();
extractZiweiPatterns();
extractNihai();
extractBaziMarkdown();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

// 统计
const stat = { tradition: {}, license: {} };
for (const e of entries) {
  stat.tradition[e.tradition] = (stat.tradition[e.tradition] || 0) + 1;
  stat.license[e.license] = (stat.license[e.license] || 0) + 1;
}
console.log(`知识库构建完成：${entries.length} 条 → ${OUT}`);
console.log('按术数:', stat.tradition);
console.log('按版权:', stat.license, '（对外发布时可剔除 modern 条目）');
