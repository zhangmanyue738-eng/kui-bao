/**
 * build-kb.js — 把 ziwei-doushu 仓库的结构化 TS 数据切分为 RAG 知识库
 * 输出 data/kb.jsonl，每行一条 { id, source, domain, text }
 * 运行：node src/build-kb.js
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', 'knowledge', 'ziwei-doushu');
const OUT = path.join(__dirname, '..', 'data', 'kb.jsonl');

const entries = [];
let seq = 0;
const nid = () => 'KB-' + String(++seq).padStart(3, '0');

// ───────── 1. 古籍（classics/data/*.ts）：Book { title, chapters[{ title, paragraphs[{ text }] }] } ─────────
function extractClassics() {
  const dir = path.join(REPO, 'lib', 'classics', 'data');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const bookTitle = (raw.match(/title:\s*'([^']+)'/) || [])[1] || f;
    // 按 chapter 块切分
    const chapterRe = /title:\s*'([^']+)'[\s\S]*?paragraphs:\s*\[([\s\S]*?)\n\s*\]/g;
    let m;
    while ((m = chapterRe.exec(raw)) !== null) {
      const chTitle = m[1];
      const textRe = /text:\s*'((?:[^'\\]|\\.)*)'/g;
      const paras = [];
      let t;
      while ((t = textRe.exec(m[2])) !== null) paras.push(t[1].replace(/\\'/g, "'").trim());
      // 每 2 段合为一个 chunk（保持出处粒度又不太碎）
      for (let i = 0; i < paras.length; i += 2) {
        const text = paras.slice(i, i + 2).join('\n');
        if (text.length < 30) continue;
        entries.push({ id: nid(), source: `《${bookTitle}》${chTitle}`, text });
      }
    }
  }
}

// ───────── 2. 格局库（lib/ziwei/patterns.ts）：Pattern { name, level, description, palaces, source } ─────────
function extractPatterns() {
  const raw = fs.readFileSync(path.join(REPO, 'lib', 'ziwei', 'patterns.ts'), 'utf8');
  // 逐个 Pattern 对象块提取（对象内不含裸 { } 嵌套的字段区）
  const re = /name:\s*'([^']+)',[^{}]*?level:\s*'([^']+)'[^{}]*?description:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [_, name, level, desc] = m;
    // 向后找最近的 source
    const after = raw.slice(re.lastIndex, re.lastIndex + 300);
    const src = (after.match(/source:\s*'([^']+)'/) || [])[1] || '';
    const levelMap = { excellent: '上格', good: '吉格', neutral: '平', caution: '慎' };
    entries.push({
      id: nid(),
      source: src ? `格局库·${src}` : '格局库（ziwei-doushu patterns）',
      text: `格局「${name}」（${levelMap[level] || level}）：${desc.replace(/\\'/g, "'")}`,
    });
  }
}

// ───────── 3. 倪海厦天纪（lib/nihai/*.ts）：NiModule { name, description, details[], references } ─────────
function extractNihai() {
  const dir = path.join(REPO, 'lib', 'nihai');
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
      const text = [`【${name}】${desc.replace(/\\'/g, "'")}`, ...details].join('\n');
      if (text.length < 60) continue;
      entries.push({ id: nid(), source: `倪海厦《天纪》讲义·${name}`, text });
    }
  }
}

extractClassics();
extractPatterns();
extractNihai();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
console.log(`知识库构建完成：${entries.length} 条 → ${OUT}`);
const bySrc = {};
for (const e of entries) bySrc[e.source.split('·')[0]] = (bySrc[e.source.split('·')[0]] || 0) + 1;
console.log(bySrc);
