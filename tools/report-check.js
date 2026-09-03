/**
 * report-check.js — DOCX 导出自检
 *
 * 为什么要单独一个自检而不是「buildDocx 没抛异常就算过」：
 *   手写 zip 最容易出的错是**字节层面**的（CRC 错、中央目录偏移错、
 *   部件声明与文件对不上），这类错误 Node 侧完全不报错，
 *   但 Word/WPS 打开就是一句「文件已损坏」。不实测等于没测。
 *
 * 三道检查：
 *   ① zip 结构完整（unzip -t，外部工具，不自己给自己判卷）
 *   ② 每个 XML 部件格式良好（python3 xml.etree，同样不自己判自己）
 *   ③ 内容正确（标题/加粗标签/表格/列表/软换行都进了 document.xml）
 *
 * 用法：node tools/report-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildDocx, parseMarkdown, suggestName } = require(path.join(__dirname, '..', 'src', 'report.js'));

// 覆盖报告里真实出现过的全部语法 + 几个边界
const MD = `# 一、命盘速览

日主丙火，生于申月，命理上呈现身弱的倾向。命主为巨门，命宫主星为天府。
软换行这一行应该保留。

### 事业

【结论】官星透出，命理上呈现**利于仕途**的倾向。
【盘面依据】八字：\u5e74\u5e72\u5e9a\u91d1\u504f\u8d22\u900f\u51fa\uff1b\u7d2b\u5fae\uff1a\u5b98\u7984\u5bab\u592a\u9633\uff08\u5e99\uff09\u3002
【知识出处】[KB-033] \u300a\u7d2b\u5fae\u6597\u6570\u5168\u4e66\u300b\uff1a\u547d\u5bab\u89c1\u516d\u5409\u661f\u3002
【置信度】\u4e2d\uff08\u5355\u672f\u4fe1\u53f7\uff09

## 三、总结与行动建议

**宜**
- 宜在专业领域持续深耕
- 宜培养稳健理财习惯，含 <tag> & "引号" 需转义
- 第三条

**避**
1. 避免高风险投机
2. 避免情绪化决策

> 引用行：需要留意的一段话

| 项目 | 值 |
| --- | --- |
| 出生时间 | 2000-8-16 14 时 |
| 流派口径 | \u5b50\u65f6 midnight |

---

—— 以上内容为传统文化/娱乐参考，不构成医疗、投资、婚姻等重大决策建议。`;

const META = {
  dateStr: '2000-8-16', hour: 14, gender: '男', city: '深圳',
  trueSolar: true, sectStamp: '子时=midnight · 闰月=normal · 子平',
};

let fail = 0;
function ok(cond, msg, detail) {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}${cond || !detail ? '' : '\n     ' + detail}`);
  if (!cond) fail++;
}

console.log('══════ DOCX 导出自检 ══════\n');

// ── ① Markdown 解析 ──
console.log('── ① Markdown 解析');
const blocks = parseMarkdown(MD);
const kinds = blocks.reduce((m, b) => (m[b.type] = (m[b.type] || 0) + 1, m), {});
ok(kinds.h === 3, `标题 3 个（实得 ${kinds.h || 0}）`);
ok(kinds.table === 1, `表格 1 个（实得 ${kinds.table || 0}）`);
ok(kinds.hr === 1, `分隔线 1 个（实得 ${kinds.hr || 0}）`);
ok(kinds.quote === 1, `引用 1 个（实得 ${kinds.quote || 0}）`);
ok(kinds.li === 2, `列表 2 组（实得 ${kinds.li || 0}）`);
const liGroups = blocks.filter(b => b.type === 'li');
ok(liGroups[0] && !liGroups[0].ordered && liGroups[0].items.length === 3, '无序列表 3 项');
ok(liGroups[1] && liGroups[1].ordered && liGroups[1].items.length === 2, '有序列表 2 项');
const pBlocks = blocks.filter(b => b.type === 'p');
ok(pBlocks.some(b => b.text.includes('\n')), '软换行被保留在段落内（未被合并）');
ok(blocks.some(b => b.type === 'table' && b.rows.length === 3 && b.rows[0][0] === '项目'), '表格含表头 + 2 行数据');

// ── ② 生成 DOCX ──
console.log('\n── ② 生成 DOCX');
const buf = buildDocx({ report: MD, meta: META });
const tmp = path.join(os.tmpdir(), `report-check-${process.pid}.docx`);
fs.writeFileSync(tmp, buf);
ok(buf.length > 1000, `生成 ${buf.length} 字节`);
ok(buf.slice(0, 2).toString() === 'PK', '以 PK 开头的合法 zip 签名');
ok(suggestName(META) === '命理报告-2000-8-16-深圳', `建议文件名：${suggestName(META)}`);

// ── ③ zip 结构（交给系统 unzip 判卷，不自己给自己打分）──
console.log('\n── ③ zip 结构（unzip -t）');
let unzipOk = true, unzipMsg = '';
try {
  unzipMsg = execFileSync('unzip', ['-t', tmp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok(/No errors detected|testing:\s+OK/.test(unzipMsg) || !/error/i.test(unzipMsg), 'unzip 未报告错误');
} catch (e) {
  unzipOk = false;
  ok(false, 'unzip -t 失败', String(e.stdout || e.stderr || e.message).trim());
}
if (unzipOk) {
  const listing = execFileSync('unzip', ['-l', tmp], { encoding: 'utf8' });
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'docProps/core.xml']) {
    ok(listing.includes(part), `包含部件 ${part}`);
  }
}

// ── ③b macOS 原生 docx 解析器能读出来 ──
// 这道比 zip/XML 校验更硬：前两道只证明「字节没写错」，
// 这道证明「OOXML 语义也对」——微软/苹果的解析器认这份文件。
// 手写 OOXML 最容易栽在语义上（缺部件、rId 对不上、Content_Types 漏声明），
// 而这些在 Node 侧一个错都不报，只表现为用户那边「文件已损坏」。
console.log('\n── ③b macOS textutil 能解析（OOXML 语义正确）');
try {
  const txt = execFileSync('textutil', ['-convert', 'txt', '-stdout', tmp],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [label, needle] of [
    ['报告头进入文档', '双术互证命理报告'],
    ['meta 表：出生时间', '2000-8-16 14 时'],
    ['meta 表：流派口径', '子时=midnight'],
    ['正文标题', '一、命盘速览'],
    ['五行格式标签保留', '【结论】'],
    ['三级标题', '事业'],
    ['无序列表', '• 宜在专业领域持续深耕'],
    ['有序列表', '1. 避免高风险投机'],
    ['引用', '引用行：需要留意的一段话'],
    ['表格', '项目'],
    ['结尾免责声明', '不构成医疗、投资、婚姻等重大决策建议'],
  ]) {
    ok(txt.includes(needle), label, txt.includes(needle) ? '' : `未找到「${needle}」，实际输出：\n${txt.slice(0, 400)}`);
  }
} catch (e) {
  ok(false, 'textutil 解析失败（文件可能被 Word 判为损坏）',
    String(e.stderr || e.stdout || e.message).trim());
}

// ── ④ XML 格式良好（交给 python 判卷）──
console.log('\n── ④ XML 部件格式良好（python3 xml.etree）');
const PY = '/Users/yanqiu/.workbuddy/binaries/python/envs/default/bin/python3';
const pyBin = fs.existsSync(PY) ? PY : '/usr/bin/python3';
const xmlCheck = `
import zipfile, xml.etree.ElementTree as ET, sys
z = zipfile.ZipFile(${JSON.stringify(tmp)})
bad = z.testzip()
if bad: print("CRC-BAD:" + bad); sys.exit(1)
names = z.namelist()
for n in names:
    if n.endswith('.xml') or n.endswith('.rels'):
        ET.fromstring(z.read(n))
print("XML-OK:" + ",".join(names))
# 内容抽查
doc = z.read('word/document.xml').decode('utf-8')
checks = {
  '标题进入文档': '双术互证命理报告' in doc,
  '加粗标签【结论】': '<w:b/>' in doc and '【结论】' in doc,
  '中文字符已写入': '命主为巨门' in doc,
  '特殊字符已转义': '&lt;tag&gt;' in doc and '&amp;' in doc,
  '软换行转 w:br': '<w:br/>' in doc,
  '表格已生成': '<w:tbl>' in doc,
  '分隔线有边框': 'w:pBdr' in doc,
}
for k, v in checks.items():
    print(("  OK  " if v else "  MISS") + " " + k)
    if not v: sys.exit(2)
`;
try {
  const out = execFileSync(pyBin, ['-c', xmlCheck], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok(true, '全部 XML 部件解析通过');
  for (const line of out.split('\n')) {
    if (line.startsWith('  OK  ')) ok(true, line.slice(6));
    else if (line.startsWith('  MISS')) ok(false, line.slice(6));
    else if (line.startsWith('XML-OK:')) console.log(`     部件：${line.slice(7)}`);
  }
} catch (e) {
  ok(false, 'Python XML 校验失败', String(e.stdout || e.stderr || e.message).trim().split('\n').slice(0, 6).join('\n     '));
}

// ── ⑤ 空报告必须报错，不能导出一个空壳 ──
console.log('\n── ⑤ 边界');
let threw = false;
try { buildDocx({ report: '   ' }); } catch (e) { threw = /报告正文为空/.test(e.message); }
ok(threw, '空报告抛错（不产出空壳文件）');
ok(buildDocx({ report: '# 只有标题\n\n正文' }).length > 1000, '无 meta 也能导出（头信息缺失不应阻断）');

fs.unlinkSync(tmp);
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
