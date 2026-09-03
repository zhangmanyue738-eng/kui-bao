# 命理顾问（八字 + 紫微斗数「双术互证」）

> 接手自 2026-08-28 交接（交接提示词与调研报告原存于 WorkBuddy 会话工作区，已随会话归档，不再提供本地路径）。

## 项目目标

输入出生年月日时 + 出生地 + 性别 + 问题领域 → 八字与紫微双排盘（确定性代码，零幻觉）→ 知识库 RAG 取证 → 带依据、带出处、带置信度的解读。产品定位「传统文化/娱乐参考」。

## 已确认的决策（2026-08-28 与用户对齐）

| 决策项 | 结论 |
|---|---|
| 产品定位 | **先自用，未来可能对外**——按可商用标准搭（知识库只用公版古籍原文、规避现代整理版权库），但不做运营/支付功能 |
| 产品形态 | **Web 页面**（放弃微信小程序：占卜类目审核必拒） |
| 模型接入 | **国产 API 调用**（DeepSeek 等候选，待 MingLi-Bench 实测；不做本地部署——M1 Pro 跑不动 70B） |
| MVP 边界 | **直线跑通**（输入→双排盘→单次 LLM 解读，暂无 RAG/互证），先看效果再深入 |
| 对外置信度展示 | 只显示 高/中/条件式 三档，内部数字不暴露（防伪精确追问） |

## 目录结构

```
mingli-consultant/
├── README.md                          ← 本文件（项目权威文档）
├── 启动命理顾问.command                ← macOS 双击一键启动（起服务+开页面）
├── docs/
│   ├── cross-validation-rules.md      ← 互证规则可执行判定逻辑
│   ├── chart-accuracy-2026-08-30.md   ← 排盘准确性验证报告
│   ├── rectification-notes.md         ← 定盘设计说明
│   ├── bench-*.md / model-eval-*.md   ← 评测报告（按日期）
│   └── ...
├── prompts/
│   └── interpreter-system-prompt.md   ← 解读层 system prompt 模板
├── src/                               ← 代码
│   ├── chart.js                       ← 双排盘（lunar + iztro，真太阳时/子时三档/流年四化）
│   ├── synthesize.js                  ← 双术互证合成（五领域信号 + 流年双术 + 置信度）
│   ├── preflight.js                   ← 澄清闸（信息不全先澄清，23 时拦截等）
│   ├── retrieve.js                    ← 知识库检索（领域词+星曜词打分，量化见 tools/retrieval-quality）
│   ├── interpret.js                   ← 解读层（RAG + 出处校验 + 违规重生成 + 降级兜底）
│   ├── report.js                      ← DOCX 导出（手写 OOXML 零依赖）
│   ├── sessions.js                    ← 会话归档（JSONL，历史抽屉）
│   ├── badcase.js                     ← 归因回流分析（Wilson 区间 + 归因快照）
│   ├── bench.js                       ← 命理知识评测集（63 题/11 题型 + drift 检测）
│   ├── eval.js                        ← LLM 端到端质检（22 题/双模型对比）
│   ├── doctor.js                      ← 环境体检（46 项，改动后必跑）
│   ├── rectify.js                     ← 定盘（时辰校准：信息增益选题 + 贝叶斯收敛）
│   ├── stability.js                   ← 稳定性测试（同盘多次一致性）
│   ├── verify-chart.js / cross-check.js ← 排盘准确性门禁
│   ├── build-kb.js / extract-tiaohou.js ← 知识库构建（596 条 + 调候表 120 条）
│   ├── validate-schema.js             ← 统一 schema 零依赖校验器
│   └── server.js                      ← Web 服务（node:http，端口 3766）
├── tools/                             ← 自检工具（badcase-selftest / report-check / rag-check / retrieval-quality）
├── public/index.html                  ← 前端（报告 / 导出 DOCX+打印 / 历史抽屉 / badcase 反馈）
├── data/                              ← kb.jsonl / sessions.jsonl / feedback.jsonl（gitignored）
├── knowledge/                         ← 知识库源（ziwei-doushu 自用 + bazi-classics 公版）
├── samples/ / schema/ / docs/ / prompts/
├── .env                               ← API key（已 gitignore）
└── package.json
```

## 运行

```bash
cd mingli-consultant
npm start                       # 启动 Web（127.0.0.1:3766）；或 macOS 双击「启动命理顾问.command」
npm run doctor                  # 环境体检 46 项（改完代码先跑这个）
npm test                        # schema + bench drift + reportcheck + badcase:check + verify + crosscheck
npm run test:full               # test 全链 + stability（同盘多次一致性）

node src/build-kb.js            # 重建知识库（改了 knowledge/ 后执行）
npm run badcase                 # badcase 归因报告（真实反馈攒到几十条后才有意义）
node src/eval.js                # LLM 端到端质检（双模型对比，走真实 API）
```

## 架构

```
采集层 → 澄清闸(preflight: 信息不全先澄清) → 排盘层(确定性: lunar + iztro，含流年四化)
→ 互证合成(synthesize: 五领域信号 + 一致/冲突/单术判定 + 置信度)
→ 知识层(RAG: 古籍+格局库 596 条) → 解读层(LLM 受约束: 出处校验/违规重生成/降级兜底)
→ 质检(bench drift + 三类硬门禁) → 展示/导出(Web / DOCX / 打印 PDF)
→ 回流(会话归档 sessions + badcase 反馈自带归因快照 + 归因分析)
```

## 交接进度

| 待办项 | 状态 | 产出 |
|---|---|---|
| 1. 互证规则细化为可执行判定逻辑 | ✅ 已完成 | `docs/cross-validation-rules.md` |
| 2. 解读层 system prompt 模板 | ✅ 已完成 | `prompts/interpreter-system-prompt.md` |
| 3. 时辰不确定降级 + 真太阳时换算 | ✅ 已实现 | `src/chart.js`（时柱待定→三柱降级；经度校正+夏令时扣回） |
| 4. 模型实测 | 🔶 首轮完成 | DeepSeek 双模型对比：v4-flash 100% 全通过（9.4s/4352tok）完胜 reasoner 68%（20.5s）；**底座定为 deepseek-chat**。GLM/Qwen 等 key 到位后用 `node src/eval.js <model>` 扩展；正式 MingLi-Bench 对接待知识库扩充 |
| 5. 统一排盘 JSON schema | ✅ 已完成 | `schema/unified-chart.schema.json`（draft-07，含时辰未知降级分支）+ `src/validate-schema.js` 零依赖校验器 |
| MVP 第2步：知识库 RAG + 出处强制 | ✅ 已完成 | 68 条知识库 + 检索 + 出处校验（违规→重生成→降级兜底） |
| badcase 反馈回路 | ✅ 已完成 | 前端按钮 → `POST /api/feedback` → `data/feedback.jsonl` |
| 互证合成接入 | ✅ 已完成 | `src/synthesize.js`（简化喜用神+五大领域取证规则+S1-S3合成）；报告含【置信度】行；前端互证标签 |
| 排盘准确性验证 | ✅ 已完成 | `src/verify-chart.js`（3006 盘/38873 项，100%）+ `src/cross-check.js`（跨实现对拍 8000 字段，100%）；报告 `docs/chart-accuracy-2026-08-30.md` |
| 八字知识库（补齐双术短板） | ✅ 已完成 | 知识库 68→596 条（紫微 68 + 八字 528）；每条带 `tradition`(bazi/ziwei) 与 `license`(public_domain/modern)，对外可一键剔除 modern |
| 调候用神 + 从格/专旺防误判 | ✅ 已完成 | 穷通宝鉴调候表结构化（120 条）；从格粗判（专旺≥0.78/从弱≤0.13，命中 4.7%）→ 压置信度+提示复核 |
| 输出三类硬门禁 | ✅ 已完成 | 出处合法 / 禁止词 / 置信度不得调级；最多三轮重生成，仍不过则**拦截不输出** |
| 定盘（时辰校准） | ✅ 已完成 | src/rectify.js：紫微大限区分 + 信息增益选题 + 贝叶斯收敛；自洽性验证 14/15 命中、平均 4 题；设计说明 docs/rectification-notes.md |
| 稳定性测试 | ✅ 已完成 | `src/stability.js`：同盘 3 次，档位种类一致率 100%、出处 0 违规、禁止词 0 命中 |
| P0-1 澄清闸 | ✅ 已完成 | `src/preflight.js`：信息不全先澄清后解读；23 时必须澄清（早/晚子时）；正反例进 doctor |
| P0-2 流派口径参数化 | ✅ 已完成 | 子时三档（晚子/早子/分日）+ 闰月两派，口径戳 `sectStamp` 跟随报告与归档 |
| P0-3 doctor 环境体检 | ✅ 已完成 | `src/doctor.js` 46 项：依赖/密钥泄露/真实 LLM 探针/出处命名/子时三档/流年立春分界+四化冒烟/城市表 259 座一致性等；故障分支均实测触发 |
| P1-1 命理知识评测集 | ✅ 已完成 | `src/bench.js` 63 题/11 题型（答案全部自算），drift 检测接入 `npm test`；答案不得抄 Mingyu 仓库（无 License） |
| P1-2 报告导出 | ✅ 已完成 | `src/report.js` 手写 OOXML 零依赖；PDF 走系统打印（有意取舍）；报告头自带口径表格 |
| P1-3 会话归档检索 | ✅ 已完成 | `src/sessions.js` JSONL（不用 sqlite，理由见 SKILL）；6 个 API + 前端历史抽屉 |
| P2 badcase 归因回流 | ✅ 已完成 | `src/badcase.js`：Wilson 下界判定 + 最小样本 + 多重比较提醒；反馈写入时自带归因快照（含 sectStamp，归档删了也能归因）；合成数据自检 46 项。**自动校正规则刻意不做**（防污染解读层） |
| 检索质量量化 | ✅ 已完成 | `tools/retrieval-quality.js`（`npm run rq` / `rq:base`）：改检索必须跑 A/B，判据事前定死（区分度↓+命中强度↑） |
| 流年双术互证 | ✅ 已完成 | ①修流年干支立春分界 bug（原公历年公式每年 1/1~2/3 错一年，bench 天然测不到，doctor 语义断言守住）②紫微流年四化落宫接入（KB-009 入命明文定方向）；**流曜 KB 0 条，永久不接** |
| 流年粒度收口 | ✅ 已完成 | 提示词原允许月度两档但无计算无条文（流月 KB 0 条）→ 收口为只允许全年方向；原则：提示词粒度许可不得超过计算层支撑范围 |
| 一键启动 | ✅ 已完成 | `启动命理顾问.command`：双击起服务+开页面，关窗口=停服务 |

## 当前待扩展（均卡外部输入）

- 跨厂商模型对比（GLM/Qwen key 到位后 `node src/eval.js <model>`）
- 检索升级 embedding 版（需 embedding 服务；当前关键词检索已量化调优）
- 月度档位（前置：流月干支接入计算层 + 知识库补流月条文）
- **最缺的是真实使用数据**：多排盘多评价，反馈尽量填「补充真实情况」；
  攒到几十条后 `npm run badcase` 开始产出归因规律

## 知识库与版权

- 来源：`knowledge/ziwei-doushu`（紫微）+ `knowledge/bazi-classics`（八字，源自 stephenxu007-ux/bazi-destiny-master）
- 每条带 `license` 标签：**public_domain**（古籍原文，48 条）/ **modern**（现代整理与断语，548 条）
- **自用**：两者都用；**对外发布前**必须切到公版模式（检索传 `{ publicOnly: true }`）
- 重建：`node src/build-kb.js`；调候表：`node src/extract-tiaohou.js`

## 排盘准确性门禁

**改动排盘层后必须跑**（详见 `docs/chart-accuracy-2026-08-30.md`）：

```bash
node src/verify-chart.js 3000   # 独立规则对拍（五虎遁/五鼠遁/日柱连续性/大运顺逆/紫微命宫身宫）
node src/cross-check.js 1000    # 跨实现对拍（Node lunar-javascript × Python lunar-python）
```

- 已验证：四柱正确性、日柱连续性、大运顺逆、紫微命宫与身宫（当前 42894 项 100% + 跨实现对拍 8000 项 100%）
- 未独立验证（信任成熟库）：节气精确时刻与农历朔望、紫微十四主星布盘
- 已解决的历史风险：子时流派（已参数化三档）、城市经度表（28→259 座）、流年立春分界（已修并有语义断言）
- 仍在的已知风险：真太阳时边界；闰月处理已参数化（sect 两派）但 UI 未暴露切换入口

## 三条靠谱原则（不可违反）

1. 排盘绝不交给 LLM，全用确定性库（lunar / iztro）计算
2. 解读必须有出处（格局知识库/古籍 RAG），禁止模型自由发挥
3. 底座模型用 MingLi-Bench 实测挑选，不迷信宣传

## 合规红线

产品定位「传统文化/娱乐参考」；不得引导用户做医疗、投资、婚姻等重大决策；不渲染吉凶祸福焦虑。每次输出末尾附固定免责声明。
输出粒度红线：健康禁疾病名、婚姻禁克夫克妻、财帛禁标的建设议、流年只允许全年方向（月度/逐日无计算无条文，禁止输出）；句式禁绝对断言。
