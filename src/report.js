/**
 * report.js — 报告导出（DOCX）
 *
 * 为什么手写 OOXML 而不是装 docx 包 / pandoc：
 *   本机无 Homebrew，装 pandoc 或 libreoffice 属于「为一个功能装一个系统级工具」，
 *   日后再也不会用到，是纯 clutter。而 DOCX 本质就是 zip + 几个 XML，
 *   手写下来 ~300 行，用 node 内置 zlib 打包，零新增依赖、完全可控。
 *
 * 为什么不做二进制 PDF 生成：
 *   PDF 必须**嵌入字体**才能正确显示，中文字体 5~10MB 起步，手写嵌入不现实；
 *   PDFKit / wkhtmltopdf / weasyprint 全都要装系统依赖。
 *   改走浏览器打印（window.print() + @media print 样式表），macOS 原生
 *   「存储为 PDF」出的是**矢量文本、可搜索可选中、无字体坑**，质量反而更好。
 *   所以本模块只负责 DOCX，PDF 由前端打印链路完成。
 *
 * 用法：
 *   const { buildDocx, parseMarkdown } = require('./report.js');
 *   const buf = buildDocx({ report, meta });
 */
const zlib = require('zlib');

// ────────────────────────────── zip 打包 ──────────────────────────────
// DOCX 就是个 zip。node 只给 deflate，没给 zip 容器，所以自己写。
// 只需要「本地文件头 + 中央目录 + EOCD」三部分，不需要分卷/加密/注释。

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 打包成 zip Buffer。entries: [{ name, data: Buffer }] */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    // DOS 时间：随便给个固定值即可，Word 不在意（避免每次构建产生不同字节）
    const dosTime = 0x6000, dosDate = 0x5A21;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);          // version needed
    lfh.writeUInt16LE(0, 6);           // flags
    lfh.writeUInt16LE(8, 8);           // deflate
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);          // extra len

    chunks.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);          // version made by
    cdh.writeUInt16LE(20, 6);          // version needed
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);          // extra
    cdh.writeUInt16LE(0, 32);          // comment
    cdh.writeUInt16LE(0, 34);          // disk start
    cdh.writeUInt16LE(0, 36);          // internal attrs
    cdh.writeUInt32LE(0, 38);          // external attrs
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));

    offset += lfh.length + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cd, eocd]);
}

// ────────────────────────────── XML 基础 ──────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * 行内 Markdown → 一串 <w:r>。
 * 支持 **粗体** 与 `代码`；【结论】这类标签自动加粗（文档里更好读，且不改动文字本身）。
 */
function runs(text, base = '') {
  if (!text) return '';
  // 先把【xxx】标签拆出来单独加粗：报告五行格式全靠它分节
  const parts = String(text).split(/(【[^】]*】)/);
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    const isLabel = /^【[^】]*】$/.test(part);
    // 再在剩余片段里处理 **粗体** 与 `代码`
    const sub = part.split(/(\*\*[^*]+\*\*|`[^`]+`)/);
    for (const sp of sub) {
      if (!sp) continue;
      let style = base;
      let content = sp;
      if (/^\*\*[^*]+\*\*$/.test(sp)) { style += '<w:b/>'; content = sp.slice(2, -2); }
      else if (/^`[^`]+`$/.test(sp)) { style += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'; content = sp.slice(1, -1); }
      else if (isLabel) style += '<w:b/>';
      const rpr = style ? `<w:rPr>${style}</w:rPr>` : '';
      out += `<w:r>${rpr}<w:t xml:space="preserve">${esc(content)}</w:t></w:r>`;
    }
  }
  return out;
}

/**
 * Markdown → 块列表。只支持报告实际用到的语法，不要写成通用 Markdown 解析器。
 * 块类型：h(1-4) / p / li / quote / hr / table
 */
function parseMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 标题
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) { blocks.push({ type: 'h', level: hm[1].length, text: hm[2].trim() }); i++; continue; }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    // 表格（| a | b |）——报告里目前没有，但前端可能贴进来，做个兜底别让它变成乱码
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const rows = [];
      rows.push(splitRow(line));
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', rows });
      continue;
    }

    // 引用
    const qm = line.match(/^\s*>\s?(.*)$/);
    if (qm) {
      const buf = [qm[1]];
      i++;
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ type: 'quote', text: buf.join(' ').trim() });
      continue;
    }

    // 列表（连续的 - / * / 数字. 归为一组，共享同一套编号/缩进）
    const lm = line.match(/^\s*(?:([-*+])\s+|(\d+)[.)]\s+)(.*)$/);
    if (lm) {
      const ordered = !!lm[2];
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:([-*+])\s+|(\d+)[.)]\s+)(.*)$/);
        if (!m) break;
        // 混用有序/无序时按第一项为准，避免编号断裂
        items.push(m[3]);
        i++;
      }
      blocks.push({ type: 'li', ordered, items });
      continue;
    }

    // 普通段落：连续非空行合并（报告的五行格式里偶尔有软换行）
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push({ type: 'p', text: buf.join('\n') });
  }
  return blocks;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

// ────────────────────────────── 块 → OOXML ──────────────────────────────

function blockXml(b, listState) {
  switch (b.type) {
    case 'h': {
      return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/><w:spacing w:before="240" w:after="120"/></w:pPr>${runs(b.text)}</w:p>`;
    }
    case 'hr': {
      return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr><w:spacing w:before="120" w:after="120"/></w:pPr></w:p>`;
    }
    case 'quote': {
      return `<w:p><w:pPr><w:pStyle w:val="Quote"/><w:ind w:left="360"/></w:pPr>${runs(b.text, '<w:color w:val="555555"/>')}</w:p>`;
    }
    case 'li': {
      // 用 numPr 会牵出一整套 numbering.xml；这里用手动缩进 + 项目符号字符，
      // 报告层级浅（最多两级），够用且不引入额外部件
      return b.items.map((it, idx) => {
        const bullet = b.ordered ? `${idx + 1}. ` : '• ';
        return `<w:p><w:pPr><w:ind w:left="480" w:hanging="240"/><w:spacing w:after="60"/></w:pPr>${runs(bullet + it)}</w:p>`;
      }).join('');
    }
    case 'table': {
      const [head, ...body] = b.rows;
      const cell = (t, bold) =>
        `<w:tc><w:tcPr><w:tcBorders>` +
        ['top', 'left', 'bottom', 'right'].map(s => `<w:${s} w:val="single" w:sz="4" w:color="BFBFBF"/>`).join('') +
        `</w:tcBorders><w:shd w:val="clear" w:fill="${bold ? 'F2F2F2' : 'auto'}"/></w:tcPr>` +
        `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${runs(t, bold ? '<w:b/>' : '')}</w:p></w:tc>`;
      const row = (cells, bold) => `<w:tr>${cells.map(c => cell(c, bold)).join('')}</w:tr>`;
      return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>` +
        ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
          .map(s => `<w:${s} w:val="single" w:sz="4" w:color="BFBFBF"/>`).join('') +
        `</w:tblBorders></w:tblPr>${row(head, true)}${body.map(r => row(r, false)).join('')}</w:tbl>` +
        `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>`;
    }
    default: {
      // 段落里保留软换行：转成 <w:br/>，否则报告里被合并成一大坨
      const segs = String(b.text).split('\n');
      const inner = segs.map((s, idx) => (idx ? '<w:br/>' : '') + runs(s)).join('');
      return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${inner}</w:p>`;
    }
  }
}

// ────────────────────────────── 部件组装 ──────────────────────────────

function stylesXml() {
  // 中文字体必须写在 eastAsia 上，只写 ascii 的话 Word/WPS 会用默认字体渲染中文
  const font = (ea, sz, bold) =>
    `<w:rFonts w:ascii="${ea}" w:eastAsia="${ea}" w:hAnsi="${ea}"/>` +
    (bold ? '<w:b/>' : '') + `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
  return `${XML_DECL}
<w:styles ${W}>
  <w:docDefaults>
    <w:rPrDefault><w:rPr>${font('宋体', 22)}</w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:line="360" w:after="120"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr>${font('黑体', 32, true)}</w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="300" w:after="150"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr>${font('黑体', 28, true)}</w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr>${font('黑体', 24, true)}</w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="3"/></w:pPr>
    <w:rPr>${font('黑体', 22, true)}</w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
    <w:rPr><w:color w:val="555555"/></w:rPr></w:style>
</w:styles>`;
}

const CONTENT_TYPES = `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `${XML_DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${esc(title)}</dc:title>
  <dc:creator>双术互证命理顾问</dc:creator>
  <cp:lastModifiedBy>双术互证命理顾问</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

/**
 * 报告头：把「这份报告是按什么口径排的」写进文档里。
 * 不写的话，几个月后拿到一份 DOCX 根本不知道当时的子时口径/流派/是否夏令时——
 * 而这几项恰恰会改变排盘结果（项目里 preflight 全程在管的东西，导出不能丢）。
 */
function headerBlocks(meta) {
  if (!meta) return [];
  const rows = [
    ['出生时间', meta.dateStr + (meta.hour != null && meta.hour !== '' ? ` ${meta.hour} 时` : ' 时辰未知')],
    ['性别 / 城市', [meta.gender, meta.city].filter(Boolean).join(' / ')],
    ['真太阳时', meta.trueSolar ? '已校正' : '未校正'],
    ['流派口径', meta.sectStamp || '—'],
    ['生成时间', new Date().toLocaleString('zh-CN', { hour12: false })],
  ].filter(r => r[1] && r[1] !== '—' || r[0] === '流派口径' || r[0] === '生成时间');
  return [
    { type: 'h', level: 1, text: '双术互证命理报告' },
    { type: 'table', rows: [['项目', '值'], ...rows] },
  ];
}

/** 组装 document.xml */
function documentXml(blocks) {
  const body = blocks.map(b => blockXml(b)).join('');
  return `${XML_DECL}
<w:document ${W}>
<w:body>${body}
  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;
}

/**
 * 生成 DOCX。
 * @param {object} p
 * @param {string} p.report  报告正文（Markdown）
 * @param {object} [p.meta]  { dateStr, hour, gender, city, trueSolar, sectStamp }
 * @param {string} [p.title] 文档标题（也用于文件名）
 * @returns {Buffer}
 */
function buildDocx({ report, meta, title } = {}) {
  if (!report || !String(report).trim()) throw new Error('报告正文为空，无法导出');
  const docTitle = title || '双术互证命理报告';
  const blocks = [...headerBlocks(meta), ...parseMarkdown(report)];

  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(blocks), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOC_RELS, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml(docTitle), 'utf8') },
  ]);
}

/** 建议文件名（不含扩展名），供下载头用 */
function suggestName(meta) {
  const d = (meta && meta.dateStr) ? String(meta.dateStr).replace(/\//g, '-') : '未注明日期';
  const city = (meta && meta.city) ? `-${meta.city}` : '';
  return `命理报告-${d}${city}`;
}

module.exports = { buildDocx, parseMarkdown, suggestName, zip };
