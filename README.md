# 命理顾问（八字 + 紫微斗数「双术互证」）

> 接手自 2026-08-28 交接。完整交接提示词见：
> `/Users/yanqiu/WorkBuddy/2026-08-25-16-34-33/.workbuddy/artifacts/handoff-prompt-bazi-ziwei-consultant.md`
> 调研报告：同目录下 `bazi-ziwei-consultant-2026-08-28.md`、`dual-method-consultant-design-2026-08-28.md`

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
├── README.md                          ← 本文件
├── docs/
│   └── cross-validation-rules.md      ← 待办1：互证规则可执行判定逻辑
├── prompts/
│   └── interpreter-system-prompt.md   ← 待办2：解读层 system prompt 模板
├── src/                               ← 代码
│   ├── chart.js                       ← 双排盘（八字 lunar + 紫微 iztro，真太阳时/降级）
│   ├── build-kb.js                    ← 知识库构建（TS 数据 → data/kb.jsonl）
│   ├── retrieve.js                    ← 知识库检索（关键词打分，MVP 无 embedding）
│   ├── interpret.js                   ← 解读层（RAG + 出处校验 + 违规重生成 + 降级兜底）
│   └── server.js                      ← Web 服务（node:http，端口 3766）
├── public/index.html                  ← 前端页面（含 badcase 反馈按钮）
├── data/                              ← kb.jsonl（知识库）/ feedback.jsonl（用户反馈）
├── knowledge/ziwei-doushu             ← 知识库源仓库（git clone，自用）
├── samples/                           ← 排盘样例输出
├── .env                               ← API key（已 gitignore）
└── package.json
```

## 运行

```bash
cd mingli-consultant
node src/server.js        # 启动 Web（127.0.0.1:3766）
node src/build-kb.js      # 重建知识库（改了 knowledge/ 后执行）
node src/interpret.js 2000-8-16 14 男 深圳 career,wealth,marriage   # CLI 单测
```

## 架构（已定，勿改）

```
采集层 → 排盘层(确定性: lunar-javascript + iztro) → 知识层(RAG: 古籍+格局库)
→ 解读层(LLM受约束: 出处校验/违规重生成/降级兜底) → 互证合成(待接) → 质检(MingLi-Bench)
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

- 已验证：四柱正确性、日柱连续性、大运顺逆、紫微命宫与身宫定位
- 未独立验证（信任成熟库）：节气精确时刻与农历朔望、紫微十四主星布盘
- 已知风险：子时流派（默认晚子时，应做成可选项）、闰月处理、真太阳时边界、城市经度表仅 28 城

## 三条靠谱原则（不可违反）

1. 排盘绝不交给 LLM，全用确定性库（lunar / iztro）计算
2. 解读必须有出处（格局知识库/古籍 RAG），禁止模型自由发挥
3. 底座模型用 MingLi-Bench 实测挑选，不迷信宣传

## 合规红线

产品定位「传统文化/娱乐参考」；不得引导用户做医疗、投资、婚姻等重大决策；不渲染吉凶祸福焦虑。每次输出末尾附固定免责声明。
