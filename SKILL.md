---
name: kui-bao
description: |
  窥豹（管中窥豹的窥豹）——「双术互证命理顾问」项目的运行、维护与扩展工作流。
  触发词：窥豹、命理顾问、双术互证、八字紫微排盘、mingli-consultant、
  命理解读服务、接着做命理项目、评测命理模型、重建命理知识库。
  适用于：启动/调试该项目、重排盘、改解读规则、加知识库条文、
  跑模型评测、修排盘 bug。不适用于陌生项目里的通用排盘需求。
agent_created: true
---

# 窥豹（kui-bao）— 双术互证命理顾问 · 项目工作流

> 「管中窥豹」：以两术之管，窥命局之豹。本 skill 是该项目的完整工作流文档（含 28 条实测坑清单、铁律与质检命令），代码即本仓库全部内容。

## 项目位置与启动

- 代码：`/Users/yanqiu/Documents/workbuddy/mingli-consultant/`（本仓库本地副本；权威文档：该目录 `README.md`）
- 日常入口：桌面 `命理顾问.command` 双击即用（冷启动/已运行两分支，见项目内 `启动命理顾问.command`）
- 启动：`cd <项目目录> && node src/server.js` → Web 在 `http://127.0.0.1:3766`
- **必须用 run_in_background 跑 server**；nohup 起的进程会随会话回收。会话恢复后先 `curl -s -m 5 http://127.0.0.1:3766/` 探活，挂了就重启
- API key 在项目 `.env`（DEEPSEEK_API_KEY / DEEPSEEK_MODEL=deepseek-chat），底座模型已实测定为 **deepseek-chat（v4-flash）**

## 流水线（顺序不可乱）

```
preflight.js(澄清闸,拦截未确认项) → chart.js(双排盘,零幻觉) → synthesize.js(互证合成,置信度分级)
→ retrieve.js(知识库检索) → interpret.js(RAG+出处校验+降级兜底) → 前端展示
```

0. **preflight.js（澄清闸）**：凡影响结果的未知量一律**结构化拦截**，禁止静默填默认值。
   拦截 4 项：城市未收录/未填、1986-05-04~1991-09-15 夏令时、23 时子时口径、农历闰月。
   `/api/interpret` 未确认则回 **422 + needConfirm**，不出报告（可传 `force:true` 绕过）。
   防死循环靠 `decided` 字段：用户答过的项不再追问（选「不校正」也是个决定）
0a. **农历输入（2026-09-03）**：前端可切公历/农历，农历走 `src/lunar-convert.js` 在服务端
   确定性转成公历 dateStr，之后全链路复用（闰月/夏令时/子时拦截自动生效）。
   年历查询 `GET /api/lunar/year/:y`（闰月+每月天数，前端动态渲染下拉）。
   **库的坑**：小月三十（如 2000 腊月三十）会静默进位到下月初一——必须 round-trip 校验
   （转公历再转回农历逐项比对），不一致报「该农历日期不存在」；闰月不存在时库抛英文错，已转友好文案。
   响应带 `lunarLabel`（如「农历1995年闰八月初三」）进结果卡、归档与导出。
1. **chart.js**：lunar-javascript（八字）+ iztro（紫微）。真太阳时校正（城市经度表 259 座）+ 1986-91 夏令时扣回。时辰未知 → 时柱 null + `hourPillarMissing:true` + 紫微 `{skipped:true}`（B 级精度降级）
2. **synthesize.js**：简化喜用神（扶抑法+月令加权）→ 五大领域信号提取 → S1-S3 合成（一致=高/单术=中/冲突=条件式/双中性=平稳）。规则文档：`docs/cross-validation-rules.md`
3. **retrieve.js + data/kb.jsonl**：68 条知识（古籍公版原文为主）。改了 `knowledge/` 后运行 `node src/build-kb.js` 重建
4. **interpret.js**：条文注入 prompt → 生成 → 出处校验（[KB-xxx] 去括号比对 + 《书名》须在条文内）→ 违规重生成 1 次 → 再违规降级无 RAG 模式。**宁可不引，绝不伪造出处**
5. 报告五行格式硬性要求：【结论】【盘面依据】【知识出处】【置信度】

## 定盘（出生时辰校准）

- 入口：前端时辰选「不确定 / 帮我定盘」→ `/api/rectify/start` → 逐题 `/api/rectify/answer`
- 原理：时辰对紫微是全局性的（命宫重排），对八字只多一个时柱 → **以紫微大限为主要区分器**
- **关键设计**：必须按「年龄段」提问，不能按「第几段大限」——
  各时辰大限**宫名序列相同**，但五行局步长不同（水二局2年/宫…火六局6年/宫），
  同一年龄各时辰走的是**不同的宫**，区分度正来自这里
- **信息增益方向别写反**：熵 H 本身即增益。所有候选预测一致（p=0/1）时 H=0 → 增益 0，不得选
- 置信度：后验 ≥0.55 high / 0.40-0.55 medium / <0.40 low（建议按时辰未知处理）
- 自测：`node src/rectify-benchmark.js 15`（自洽性 93%，**非真人准确率**，见 docs/rectification-notes.md）
- 已知失效：年龄太小（可问区间不足）→ 系统诚实标记 low，不强行给答案

## 质检与评测

- **排盘准确性门禁（改动排盘层后必跑）**：
  - `node src/verify-chart.js 3000` —— L1 结构自检 + L2 独立规则对拍（五虎遁/五鼠遁/时支/日柱连续性/大运顺逆/紫微命宫公式/身宫口诀 + **子时三档口径对拍**）。基准：3006 张盘、**42850 项 100% 通过**（2026-09-03 加子时口径校验后）。**前台跑会超时，必须 `run_in_background`**
  （子时口径相关项数会随随机样本命中 23 时的个数小幅浮动，**硬校验失败必须为 0**，总数不必逐位对得上）
  - `node src/cross-check.js 1000` —— L3 跨实现对拍（Node lunar-javascript × Python lunar-python，四柱/纳音/大运）。基准：8000 字段 100% 一致。Python 侧依赖 `~/.workbuddy/binaries/python/envs/default` 的 lunar-python（装包需 `--proxy http://127.0.0.1:21081`）
  - 验证策略与已知边界：`docs/chart-accuracy-2026-08-30.md`
- **输出稳定性**：`node src/stability.js 3`（同盘多次，查档位种类一致/出处/禁止词）
- 模型评测：`node src/eval.js [模型名...]`，报告写入 `docs/model-eval-YYYY-MM-DD.md`
- schema 校验：`node src/validate-schema.js`（样例过期时 `node src/validate-schema.js --regen` 一键重生成）
- badcase：前端按钮 + 事实文本框 → `data/feedback.jsonl`
- **一条命令全跑**：`npm test`（schema + verify + crosscheck）；`npm run test:full`（再加稳定性）

### 命理知识评测 bench（P1-1，2026-09-03 完成）

**与 eval.js 的分工**：eval 测「报告格式与合规」（引用出处/禁止词/置信度档位），
bench 测「读盘与命理知识是否出错」。**排盘层零幻觉 ≠ 模型读盘不出错**——
bench 首轮就测出模型判断大运顺逆只有 2/7（29%，低于瞎猜）。

- 题库 `data/bench.jsonl`（63 题 / 11 题型），**答案全部由 chart.js、synthesize.js 现算**
- `npm run bench -- --build` 重建题库；`--verify` 做 drift 检测（不联网，秒级，已接入 doctor）
- `npm run bench deepseek-chat` 跑评测，报告写入 `docs/bench-YYYY-MM-DD.md`

**四条硬约束**（改 bench 前必读）：
1. 答案只出自确定性脚本，**不用 LLM 写题、不用人拍脑袋**
2. 每题记 `answerFrom` / `chartRef`，可复算
3. drift 检测：排盘层改了而题库没重建 → 立刻报错，否则会把「排盘层变了」误报成「模型退步」
4. 判定严格且可自动化，**不用 LLM 当裁判**（judge 也是 LLM 就是自证循环）

**首轮结论（2026-09-03，deepseek-chat 63 题 79%）**——读「产品兜底」列：
| 能力 | 正确率 | 说明 |
|---|---|---|
| 读盘类（日主/五行/十神/命宫主星/互证方向）| 100% | 模型能读盘 |
| 抗谄媚（纠正错误前提）| 7/7 | 好，不会顺着错前提编 |
| 五虎遁/五鼠遁口诀 | 40~57% | 已兜底（干支直接给了） |
| 命主口诀 | 50% | 已兜底（mingZhu 字段） |
| **大运顺逆** | **29%，低于瞎猜** | 有「一律答逆」强先验，已加 `daYunDirection` 字段兜底 |

**方法论**：凡是口诀推导的结果，一律由排盘层算好直接喂，**不要让模型自己推**。
bench 报告里标 ⚠️「未兜底」的题型正确率低才是真实风险；已兜底的低分只是说明
「这个值确实不该让模型推」。

## 知识库（596 条）与版权

- `tradition`: bazi(528) / ziwei(68)；`license`: public_domain(48，古籍原文) / modern(548，现代整理)
- **自用全用；对外必须切公版模式**（检索传 `{ publicOnly: true }`）
- 重建：`node src/build-kb.js`；调候表：`node src/extract-tiaohou.js`（穷通宝鉴 120 条结构化）
- 检索用 `retrieveBalanced`（双术配额 5:5 + 词长加权 + 同出处限流 2 条），
  **不要用 `retrieve`**（会被条目多的一侧淹没；eval 曾因此误报出处违规）

## 喜用神与从格（防系统性误判）

- 扶抑法 + 月令加权 + 穷通宝鉴调候；冲突时（14.3%）以调候为急并提示
- 从格/专旺粗判阈值 **专旺 ≥0.78、从弱 ≤0.13**（命中率 4.7%，贴近经验比例）；
  注意 ratio 下限是 1/9≈0.111（日主自身必计入），从弱阈值必须 > 0.111
- 命中从格 → 置信度封顶「中」+ 报告开头提示人工复核

## 输出三类硬门禁（interpret.js）

出处合法 / 禁止词 / 置信度不得自行调级。最多三轮重生成，
**三轮不过则拦截不输出**（`complianceFailed`，前端显示提示而非报告）。
改 prompt 或换模型后必须跑 `stability` + `eval`。

## 排盘准确性：已验证 / 未验证 / 真实风险

- **已验证**：四柱正确性、日柱连续性、大运顺逆、紫微命宫与身宫定位（用独立公式与口诀表对拍，非库自证）
- **未独立验证**（信任成熟库）：节气精确时刻与农历朔望、紫微十四主星布盘规则
- **真实风险（须知）**：
  1. ~~**子时流派**~~ **已于 2026-09-03 解决**：做成三档显式参数（见下节），默认值以代码为准 = `midnight`
  2. **闰月处理**——iztro `fixLeap` 由 `sect.leap` 驱动（`asIs` 按当月 / `nextMonth` 按下月），校验时闰月样本已跳过
  3. **真太阳时边界**——落在时辰交界 ±10 分钟会打 `boundaryRisk` 标记，需人工判断
  4. ~~**城市经度表仅 28 个**~~ 已扩到 **259 座**（全国地级市 + 省会）。未收录仍会被澄清闸拦下（**不静默按北京算**）
  5. **夜子时校验要按次日日干推时干**，否则五鼠遁会误报（校验器已处理）

## 流派口径（sect）——改动排盘层必读

口径差异会直接改结果，必须**显式声明 → 全程透传 → 报告落款**三件事都做到。

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `zishi` | `early` 早子时 / `midnight` 夜子时 / `late` 晚子时 | **midnight** | 仅 23 时出生有分歧（约 1/24 命中率，命中则日柱时柱全变） |
| `leap` | `asIs` 闰月按当月 / `nextMonth` 闰月按下月 | **asIs** | 驱动 iztro `fixLeap` |
| `school` | `ziping` 子平法 | **ziping** | 扶抑 + 月令加权 + 穷通宝鉴调候 |

- 落款 `sectStamp` = `夜子时 · 子平法 · 闰月按当月 · 南派三合（iztro）`，出现在报告结尾与前端结果卡
- **文档曾写「默认晚子时」是错的**，实际一直是 lunar 默认 sect=2 = 夜子时。以 `SECT_DEFAULTS`（chart.js）为准
- 三档口径必须用**独立公式**验证真分得开（verify-chart.js 的 `L2-子时口径有效性`），
  否则可能出现「参数没生效但测试全绿」——曾因真太阳时把 23 时校正到亥时而被掩盖
- 自测隔离技巧：验证子时口径要传 `city: null`，否则经度校正会把 23 时推走

## 已踩过的坑（改代码前必读）

1. **iztro 字段名**：四化是 `s.mutagen`（不是 mutate），庙旺是 `s.brightness`；宫位名多不带「宫」字（官禄/财帛），匹配要做兼容
2. **lunar-javascript**：时柱是 `ec.getTimeGan()/getTimeZhi()`（不是 getHour*）；大运 `ec.getYun(gender).getDaYun()`；没有 WUXING_GAN 常量表（chart.js 内置了映射）
3. **JSON Schema**：`type:["string","null"]` 与 `$ref` 并用时 $ref 覆盖 type——可空枚举要用 `oneOf:[{type:null},{$ref}]`
4. **npm 装包**：会话默认代理会 502，走 Phantom `export https_proxy=http://127.0.0.1:21081 http_proxy=http://127.0.0.1:21081`（以当时实际监听端口为准）
5. **校验器比对**：`[KB-055]`（带括号）vs id `KB-055`（不带）——任何 ID 匹配先去括号
6. **给 chart.meta 加字段必须同步改 `schema/unified-chart.schema.json`**：meta 是 `additionalProperties:false`，
   漏改会导致 `npm run schema` 报「多余字段」（2026-09-03 加 dstMode/sect/sectStamp 时踩过）
7. **handler 里先算完再 writeHead**：写成 `writeHead(200)` → `res.end(JSON.stringify(f()))` 的话，
   `f()` 一抛异常就会走到 catch 二次写头，触发 `ERR_HTTP_HEADERS_SENT` 并**把整个进程带崩**（踩过一次，已加 try/catch 安全网）
8. **城市经度表只能收 UTC+8 地区**：公式 `offsetMin=(lon-120)*4` 里的 120 是东八区中央经线。
   海外城市直接套用会算错（东京会算出 +79 分钟，正确 +19）。要支持海外必须加 `tzOffset` 字段并改公式。
   doctor 的「时区守卫」会拦 73°E~135°E 之外的条目
9. **DeepSeek 网关有别名**：`DEEPSEEK_MODEL=deepseek-chat` 不在 `/models` 返回列表里，
   但实际可用并解析为 `deepseek-v4-flash`。**别用 `/models` 列表判断模型可用性**，要用 1-token 真实探针（doctor 已如此实现）
10. **改完代码必须重启服务**：服务是长跑后台进程，跑的是旧代码且不会报错。
    `npm run doctor` 的「代码新鲜度」会比对服务返回的 `/api/cities` 数量与本地表，不一致就是忘了重启
11. **归档记录的字段名**（前端/脚本对接前先看 `saveSession`）：时间是 `ts`（**没有** `createdAt`），
    模型/用量/检索条文在 `meta.{model,usage,passages}`（**不在顶层**）。曾经前端写成 `s.createdAt`/`s.model`，
    页面一片空白却不报错——静默失效比报错更耗时间
12. **sessions.jsonl 的整体重写会静默丢坏行**：`updateSession`/`removeSession` 是「读全量→改→写全量」，
    而 `readAll` 会把解析失败的行挑出来（不进 records）。所以**修坏行必须先手工从文件里摘出来再动**，
    直接调 removeSession 会把坏行数据一起抹掉。doctor 的「可解析性」会报坏行，报了就先修再改
13. **同一文件的多个 Edit 并行会丢改动**（实测丢过 4 处，且都是「看起来改成功了」）：
    同一个文件必须串行改，改完用 `grep -E` 全局复查一遍
14. **BSD grep 的 `\|` 不是或操作**：`grep -n "a\|b"` 在 macOS 上静默返回空，看起来像「没有匹配」。用 `grep -E "a|b"`
15. **命主 ≠ 命宫主星**（2026-09-03 修掉的系统性误读）：iztro 的 `ast.soul`/`ast.body` 是**命主/身主**
    （分别按命宫地支、生年地支查表得来），**不是命宫里坐的主星**。源码 `astro.js:212` 为证：
    `soul = earthlyBranches[命宫地支].soul`。实测某盘 `soul=巨门` 而命宫内主星是 `天府`。
    项目曾三处把 `soul` 当「命宫主星」用，`interpret.js` 更直接喂给了 LLM——模型于是拿命主星去讲命宫特质，
    报告照样通顺合规，**eval 一条都抓不到**。现统一用语义化字段：`mingZhu`/`shenZhu`/`mingGongBranch`/`mingGongStars`，
    `soul`/`body` 仅保留向后兼容（verify-chart 对拍在用），**新代码不许用**
16. **slimChart 的星曜是字符串，不是对象**（2026-09-03 修掉的静默丢词）：`interpret.js` 的 `slimChart`
    为省 token 把星曜压成 `"天府[庙](禄)"` 字符串，而 `retrieve.js` 原按 `s.name` 取——
    **紫微侧 44 个检索词全部静默归零**，只剩命主/身主/五行局 3 个词在撑。
    表现为 RAG 降级与紫微侧检索质量低，不报错、不掉异常。现 `retrieve.js` 用 `starName()`/`starSiHua()`
    兼容两种形态。相关：slimChart 里宫位名键是 `palace` 不是 `name`。
    **排查这类问题的正确姿势**：`node tools/rag-check.js` 直连真实 `extractQueryTerms` 打印词池
    （复刻一份逻辑去测等于没测，bug 就是这么藏过去的）
17. **出题时「题干」与「答案」可能不同源**：bench 的 `genHourGan` 曾取「日柱天干」出题、却用「时柱天干」当答案，
    子时跨日时两者不同源（日柱当日、时干按次日日干），题干于是自相矛盾——**模型按口诀答对反被判错**。
    修法是给生成器加**独立口诀复算自校验**（`wuShuDun`/`wuHuDun`/`daYunDirectionByRule`），
    不一致就跳过不出题。原则：**宁可不出题，也不能出自相矛盾的题**
18. **模型的命理知识边界（bench 实测）**：能读盘（日主/五行/十神/命宫主星 100%），
    **不会推口诀**——大运顺逆 2/7（29%，**低于瞎猜**，有「一律答逆」的强先验）、五虎遁/五鼠遁 40~57%、命主 50%。
    **凡是口诀推导的结果一律由排盘层算好直接喂**，别让模型自己推。
    `daYunDirection` 字段（chart.js，两条独立路径交叉校验后才落值）就是这么来的
19. **量化指标本身会骗人，先审指标再看结论**（2026-09-03 连踩三次，每次都差点做出错误决定）：
    - **分子分母必须同源**：`countHits` 里 `w.length>=2` 只在分子侧过滤、分母用 `words.size`，
      于是单字词（天干「丙」/五行「火」）被踢出分子却留在分母，八字侧覆盖率被结构性锁死在 1/3=33.3%，
      **8 个样本数值一模一样**——这是指标坏掉的强信号（真实世界不会这么齐）。
      修法：分母只算「进入判定的词」，即 `eligible.size`
    - **别把区分度不同的东西等权**：宫位名（命宫/财帛）每个盘都有，命中它几乎零信息量；
      星曜（武曲/七杀）不同盘落星不同，才有真实区分度。混成一个「命中率」会得出反向结论
    - **覆盖率用 Set 会丢掉「命中强度」**：实测出现过「覆盖率都是 6/9、命中次数却 9→16」，
      改善恰恰在强度上。必须同时看 `hits / passages`（平均每条命中几个特征词）
20. **改检索必须跑量化对比，且判据要事先定死**：`tools/retrieval-quality.js` + `LEGACY=1` 从 git 提取真实旧版对比
    （**自动提取，别手工 `git show`** —— 手工步骤会失忆，隔几天回来要么临时文件早删了报 MODULE_NOT_FOUND，
    要么留着过期副本却以为在对比最新版）。
    判据：**区分度↓ 且 命中强度↑ 才算净改善**。
    踩过的坑：第一次改（星曜词无脑放行）单案例命中 9→16 明显变好，但全样本星曜覆盖率 84.4%→73.8%、
    命中强度 1.79→1.67——**不能拿单个案例的改善掩盖整体劣化，该回滚就回滚**（已 `git checkout` 回滚后重做）
21. **知识出处里可能混进拼音文件名**：`shishen-geju.md` 存在于 `knowledge/` 却没登记在 `BAZI_FILE_MAP`，
    `build-kb.js` 兜底成 `{book: key}`（key 就是文件名），于是 30 条条目出处变成
    「八字断法·shishen-geju·十神定义」，**直接印进报告的【知识出处】**——
    而「出处必须是真实可查的书名篇名」是硬门禁之一，这条链上不能有机器名。
    修法：登记中文书名 + **兜底改为抛错**（宁可构建失败，也不静默产出假出处），
    doctor 加「出处命名」检查防复发。重建后 id 与正文零变化（id 按 push 顺序生成，改 source 不影响）
22. **反馈只存 sessionId 指针 → 全变成孤儿**：`feedback.jsonl` 原本只存 `sessionId`，
    而归档是**可删除**的（前端有「删除档案」按钮），两者生命周期不一致。
    实测 **3/3 条反馈指向的归档已不存在**，拿不到日主/命宫/领域判定/引用条文 → 彻底无法归因。
    修法：反馈写入时**自带归因快照**（`buildAttribution`，几百字节，含 sectStamp）。
    **只存生辰也不行**：口径可能已经变了，重排出来的盘跟当时不是一回事。
    已验证：把 `sessions.jsonl` 清空后，带快照的反馈仍能完整分组，孤儿则不能
23. **分子分母必须同源（本项目第二次踩到）**：badcase 基线原按「全量已评分」算，
    但分组只在「带快照」集合里做 → 孤儿只进基线的分子分母、不进任何分组。
    后果是**静默的**：孤儿里 bad 偏多会把基线抬高，于是所有组都更难被判定，工具变得「什么都不报」。
    修法：判定用同源基线（带快照），全量基线仅供展示，报告里两个都列并说明差异
24. **核心分支可能从未被执行过，得注入合成数据自检**：`analyze()` 里「可疑组」判定要求 `n≥5`，
    而真实反馈要攒到几十条才可能触发 —— 真数据攒够之前，这段就是**从未运行过的代码**。
    修法：`analyze({ file })` 支持注入 fixture，`tools/badcase-selftest.js` 用合成数据跑通全部分支。
    已验证的关键用例：**「点估计高于基线、但 Wilson 下界够不着」的组必须放过**
    （实测组 C：点估计 66.7% 是基线 36.7% 的近两倍，但 n=6 时下界只有 30.0% → 正确未判定。
    用点估计就会误判，用下界才守得住）
25. **归因维度要按因果方向分开**：引用条文（KB-xxx）是**模型的输出**，日主/命宫/领域判定是**输入/盘面属性**。
    混在一张表里会因果倒置（「他错在哪 → 因为他引用了这条」，这条推论不能指导任何改动），
    而且每份报告引 10 条 → 每条反馈多贡献 10 个组，把多重比较的 K 撑大、`K×0.05` 假阳性期望失真。
    拆成 `core`（盘面与判定）与 `passage`（条文质量信号）两段独立统计
26. **依赖「当前日期」的逻辑，bench 天然覆盖不到**：流年干支原来用公历年公式 `(year-4)%10`，
    而八字流年分界是**立春**——每年 1/1~2/3 整整错一年（实测 2027-01-20 公式给「丁未」正确是「丙午」）。
    bench 题库生成于「今天」，永远不会落在立春前的窗口里，所以 63 题全绿也抓不到这个 bug。
    修法：①实现改用 lunar 的 `getYearInGanZhiExact()`（立春分界）②doctor `checkAnnual()` 用
    **语义断言**（1 月中旬必属上一干支年、立春当天必切换）守住，**不硬编码具体干支**
27. **对拍必须严格同参数，否则是制造假差异**：排查流年四化落点「不一致」折腾半天，
    结果是手探用了午时（idx=6）而 buildChart 是 14:00=未时（idx=7）——根本不是同一张盘。
    另外注意 `yearly.stars` 里只有**流曜**（流禄/流羊/流马…），四化星要靠
    `yearly.mutagen`（固定禄权科忌各一）× 本命宫位映射自己算；
    星曜对象的 `mutagen` 字段是**本命四化**（生年干定），与流年四化是两回事，混用全错
28. **提示词允许的输出粒度不得超过计算层的支撑范围**：提示词曾允许 LLM 给流年「月度平缓/需留意」
    两档，但计算层只算到年、知识库流月 0 条——LLM 一旦真输出月度档位就是无据编造，
    而 QA 只查禁词不查依据（实测一次样本没输出，属许可性风险非现行违规）。
    修法：流年收口到「只允许全年方向、依据给什么只能说什么」；
    开放新粒度的前置条件 = 计算层接入 + KB 有条文，二者缺一不开
29. **knowledge/ 下的子目录未必是「自己的资产」——先查引用关系再谈版权**：
    `knowledge/ziwei-doushu` 一直是第三方项目（Renhuai123/ziwei-doushu，MIT）的整体 clone
    （Next.js 应用 + 数据），本项目实际只用 3 个数据文件（lib/classics/data/*.ts、
    lib/ziwei/patterns.ts、lib/nihai/*.ts）。开源前已瘦身至 10 个文件（736K→约 300K），
    kb 重建 md5 零漂移（91414ede）验证未伤数据。教训：**瘦身前后必须各跑一次 build-kb 对 md5**。
30. **git push 报 SSL_ERROR_SYSCALL 可能是「假失败」**：连接断了但数据可能已送达——
    重试显示 Everything up-to-date 时，先 curl GitHub API 核对远端 commit hash 再判断，别盲目强推。
31. **公版模式已实现**：`KB_PUBLIC_ONLY=1` → interpret 检索传 `{publicOnly:true}`（retrieve 原生支持），
    只用 48 条公版古籍。注意公版模式下条文池变小，检索条数可能少于 k（实测 7/10），解读会更薄——
    这是诚实的代价，别为凑数把 modern 混回去

## 检索质量量化（2026-09-03，Task #31）

`node tools/retrieval-quality.js`（`npm run rq`），对比基线 `npm run rq:base`（默认 LEGACY_REF=HEAD）。

- **背景**：`DOMAIN_TERMS` 里混进了 `武曲/破军/七杀/禄存` 这些**星曜名**，它们同时是盘面特征，
  却被 `!domainTerms.has(t)` 从特征词池剔除、只拿封顶 0.5 的领域加权 → 「命盘有武曲」与「没武曲」得分一样，
  紫微侧最有区分度的信号被抹平
- **最终改法**（`retrieve.js`）：星曜路径产出的词单独记进 `starTerms`，豁免领域词排除；
  但打分时**限累加 2 次**——只放行不限累加的话，星曜密集的条文会独占 top-10，实测覆盖率反而 84%→74%（密集≠相关）
- **量化结果（8 个命盘，HEAD 基线 → 改动后）**：

| 指标 | 基线 | 改动后 | 判定 |
|---|---|---|---|
| 区分度（两两 Jaccard，越低越好）| 0.332 | **0.296** | ✅ −11% |
| 星曜覆盖率 | 84.4% | **85.7%** | ✅ +1.3pp |
| 星曜命中强度（星/条）| 1.79 | **1.88** | ✅ +5% |
| 八字侧覆盖率 | 68.8% | **75.0%** | ✅ +6.2pp |
| 宫位名覆盖率 | 43.4% | 17.3% | ↓ 非坏事（top-10 从泛论宫位转向讲具体星曜）|
| 星曜被领域词挡下 | 武曲 破军 禄存 七杀 | **无** | ✅ 达成 |

- **净效果**：星曜（含命主/身主/四化）与日主成为主要信号，宫位名与领域词降为背景加权。
  端到端 `npm run eval` 复测 **22/22 + RAG 降级 0 次**，质量未下降

## 报告导出（P1-2，2026-09-03 完成）

- `src/report.js` + `POST /api/report/export`（DOCX）。前端报告卡片里有「导出 DOCX」「打印 / 存为 PDF」两个按钮，
  新解读与历史档案共用 `renderResultBody`，所以两边都自动带上
- **DOCX 手写 OOXML，零新增依赖**：不装 docx 包、不装 pandoc/libreoffice（本机无 Homebrew，
  为一个功能装系统级工具是纯 clutter）。用 `node:zlib` + 自写 zip 容器（本地文件头/中央目录/EOCD + CRC32）
- **PDF 刻意不做服务端生成**：二进制 PDF 必须**嵌入字体**，中文字体 5~10MB 起步；PDFKit/wkhtmltopdf 全要装依赖。
  改走 `window.print()` + `@media print`，macOS 原生「存储为 PDF」出的是**矢量文本、可搜索可选中、无字体坑**
- 导出入参两种：① `sessionId` → 服务端从归档取**当时那份**完整报告（推荐，前端内存刷新就没了）
  ② `report + meta` → 导出刚生成尚未归档的
- 报告头会自动写入 `dateStr/hour/gender/city/真太阳时/sectStamp/生成时间` 的表格——
  **口径必须跟着文件走**，否则几个月后拿到一份 DOCX 根本不知道当时用的什么子时口径
- **校验必须交给外部工具，不自己给自己判卷**：`node tools/report-check.js` 三道
  ① `unzip -t`（zip 字节层）② `textutil -convert txt`（**OOXML 语义层**，这道最关键——
  手写 OOXML 最容易栽在语义上，缺部件/rId 对不上在 Node 侧一个错都不报，只表现为用户那边「文件已损坏」）
  ③ python `xml.etree` 逐个部件解析 + 内容抽查

## 会话归档（P1-3，2026-09-03 完成）

攒 badcase 的地方。原则：**先有检索，攒下来的样本才用得上**（所以它排在评测集之前）。

- 存储 `data/sessions.jsonl`，一行一条，与 `kb.jsonl`/`feedback.jsonl` 同一范式。
  **没用 sqlite**：`node:sqlite` 每次启动抛 ExperimentalWarning、API 仍标实验性，而自用规模只有千级 / 约 20MB，
  JSONL 能直接 grep、能 git diff、零依赖。索引在内存里（读全量 → 过滤），这个量级够用
- 记录内容：`input` / `sectStamp` / `index`（抽取的检索字段）/ **完整 `chart`** / **`synthesis`** / `report` / `meta`。
  存完整排盘而非只存入参，是为了复盘时不必重排——**口径可能已经变了**，重排出来的盘跟当时不是一回事
- 白名单 `EDITABLE = ['note','rating','comment','facts']`，禁止改报告正文与排盘（前端 PATCH 越权返回 400）
- `feedback.jsonl` 是**不可变审计流水**，不删不改；同时把结构化结论回写进档案，便于按 `rating=bad` 检索
- interpret 成功后自动归档；**合规拦截（complianceFailed）的不归档**，免得污染样本池
- API：`GET /api/sessions?action=stats` / `GET`（q·rating·dayMaster·mingStar·from/to·limit/offset）
  / `GET /:id` / `POST` / `PATCH /:id` / `DELETE /:id`。注意响应包的是 `session` 键，列表项走 `slim()`（不含 report 正文）
- 前端：右上角「历史档案」抽屉，全文搜索 + 评分筛选，点开即加载完整报告与互证合成。
  **新解读与历史档案共用 `renderResultBody()`** —— 复制两份渲染逻辑必然日后改一处漏一处
- doctor 会查：坏行（fail）、体积 >50MB（warn）、评价率 <30%（warn）、记录完整性、检索可用性冒烟

## badcase 归因回流（P2，2026-09-03 完成）

会话归档解决「badcase 翻得出来」，这一层解决「**翻出来之后看得出规律**」——攒 badcase 的全部价值都在这一步。

- 入口：`npm run badcase`（`node src/badcase.js`）；`--min=N` 调最小样本阈值（默认 5）；`--json`
- 自检：`npm run badcase:check`（**合成数据，46 项**）——真实样本攒够前，这是唯一能验证判定逻辑的手段
- 输出分三段：**盘面/判定分组**（哪类盘、哪类判定更容易错）、**可疑组**、**条文质量信号**（哪条 KB 被引就容易被判不准）

### 三条硬约束（写在 `src/badcase.js` 文件头，改这个文件前先读）

1. **小样本不判**：n 太小时 bad 率毫无意义（1/1=100%、0/1=0%）。一律给 Wilson 95% 区间 + 最小样本阈值
2. **判定用区间下界，不点估计**：只有「该组 bad 率的 Wilson **下界**仍高于全局基线」才算可疑。
   合成数据实测：点估计 66.7%（基线 36.7% 的近两倍，肉眼很可疑）但 n=6 下界仅 30.0% → 正确放过
3. **多重比较必须说清楚**：K 个组在 α=0.05 下**期望就有 K×0.05 个假阳性**，这个数字直接打在报告里

刻意**不自动生成校正规则**：那会让排盘层之外的东西反过来污染解读，而「排盘零幻觉」是铁律。
这里只做**人工复核的优先级排序**。同理，发现可疑组**不退出非 0**——它只是线索，让 doctor 报警会逼人去处理噪声。

### doctor 检查项（`checkBadcase()`，5 项）

| 检查 | 失败后果 |
|---|---|
| 导出接口 | analyze/buildAttribution/featureKeys/wilson/report 缺失 |
| Wilson 区间 | 0/1 或 1/1 的区间收得太窄 → 把「没数据」当「没问题」。实测 0/1→[0,0.79]、1/1→[0.21,1] |
| 快照接线 | **既查 require 也查调用**——只加调用忘了 require 会静默通过，首次提交反馈才抛 `buildAttribution is not defined`（这个坑真踩过） |
| 字段映射 | 用**真实归档**跑 `buildAttribution`；`sessions.js` 的 index 结构一改而这里没同步，就会静默抽出一片 null |
| 数据健康度 | 孤儿占比（warn，不是 fail——数据问题不是代码缺陷） |

故障分支均实测触发过：移除 require → fail；把 `index.dayMaster` 改名 → 字段映射 fail。

### 当前数据状态（2026-09-03）

`data/feedback.jsonl` 3 条反馈**全是孤儿**（产生于快照机制之前，无法回填）。
因此工具当前**只能验证链路，不能产出命理结论**——报告会明确写「任何分组结论都是噪声」。
继续用会自动带上快照，孤儿比例会自然下降。

## 流年双术接入（2026-09-03 完成）

**流年维度从「单术」变成真「双术互证」**：此前紫微侧流年信号是桩函数（恒 neutral、strength 0），
annual 领域走 single-method 降级——「双术互证」在流年上名不副实。现在：

- **排盘层**（`chart.js buildAnnualMutagen`）：iztro `horoscope().yearly` 取流年干支与四化星，
  映射「本命宫位 → 流年宫名」，产出 `ziwei.annualMutagen = { ganzhi, flowDate, byFlowPalace }`。
  只算盘、不做解读，符合分层架构
- **合成层**（`synthesize.js ziweiAnnualSignal`）：只按 KB-009《骨髓赋》四化星论的**入命明文**定方向——
  「化禄入命，财源广进；化权入命，能担大任；化科入命，名声远播；化忌入命，须经磨炼方能成器」。
  禄/权/科入流年命宫 → favorable；忌入流年命宫 → unfavorable；其余落宫一律 neutral、只记证据不解读
- **刻意不接流曜**：流曜（流喜/流禄/流马…）知识库 **0 条依据**，接了就是拍脑袋，
  违反「解读必带古籍出处」。待扩展项里的「流曜接入」**永久关闭**，除非知识库补了条文
- doctor `checkAnnual()` 新增「紫微四化冒烟」：锁「干支 2 字 + 禄权科忌各一颗 + 无 error」，
  防 iztro 升级改 horoscope 结构后**静默产出 error**（故障分支已实测触发）

实测（2026 丙午年，两分支均真实触发）：
- 天机化权入命 → 八字 favorable + 紫微 favorable → **consistent / high**（真双术一致）
- 廉贞化忌入命 → 八字 favorable vs 紫微 unfavorable → **conditional**（两术冲突降级）

## 铁律（不可违反）

1. 排盘绝不交给 LLM，只用确定性库
2. 解读必须有出处，校验不过就降级，禁止伪造引用
3. 报告结论方向必须跟随 synthesize 结果，置信度不得由模型自行调级
4. 红线：健康禁疾病名、婚姻禁克夫克妻、财帛禁标的建设议；流年只允许全年方向——月度/逐日拆分无计算无条文（流月 KB 0 条），禁止输出，待流月计算+条文齐备后才可开放；句式禁绝对断言
5. 知识库对外发布前须替换为公版古籍自整理版（当前 ziwei-doushu 仓库仅限自用）

## 常用命令

```bash
npm run doctor                         # 【改完代码先跑这个】环境体检，44 项（数量随数据量浮动）
npm run badcase                        # badcase 归因分析（攒够样本后看规律）
npm run badcase:check                  # badcase 自检（合成数据 46 项，改 src/badcase.js 后必跑）
npm run sessions                       # 会话归档自测（索引抽取 / 检索 / 白名单 / 统计 / 清理回滚）
npm run bench -- --build               # 重建命理知识题库（改排盘层/合成规则后必跑）
npm run bench -- --verify              # 题库 drift 检测（不联网，秒级）
npm run bench deepseek-chat            # 命理知识评测 → docs/bench-YYYY-MM-DD.md
node tools/rag-check.js                # 检索词池体检（改 slimChart/retrieve 后必跑）
npm run rq                             # 检索质量量化（区分度/覆盖率/命中强度）
npm run rq:base                        # 同上，但以 HEAD 版 retrieve.js 为基线做 A/B
npm run reportcheck                    # DOCX 导出自检（改 src/report.js 后必跑）
npm run kb                             # 重建知识库（改 knowledge/ 或 BAZI_FILE_MAP 后必跑）
node src/server.js                     # 起 Web（3766）
node src/chart.js 2000-8-16 14 男 深圳 # 单测排盘（时辰未知传 -）
node src/preflight.js                  # 澄清闸自测（含防死循环用例）
node src/synthesize.js 2000-8-16 14 男 深圳   # 单测互证合成
node src/interpret.js 2000-8-16 14 男 深圳 career,wealth,marriage  # CLI 全链路
node src/build-kb.js                   # 重建知识库
node src/validate-schema.js            # schema 校验
node src/eval.js                       # 模型评测
```

### doctor 覆盖什么（npm run doctor）

运行时/依赖、`.env` 配置与密钥泄露防护、**DeepSeek 真实探针**（key 有效性 + 模型可用性 + 别名解析）、
知识库条数与 `knowledge/` 同步状态、**出处的书名不得是拼音文件名**、调候表完整性、城市表时区守卫与覆盖数、子时三档有效性、
Python 侧 lunar-python（crosscheck 依赖）、排盘冒烟（含夏令时扣回生效验证）、**流年**（立春分界语义断言 + 紫微四化冒烟）、
**会话归档健康**（坏行 / 体积 / 评分分布 / 评价率 / 记录完整性 / 检索可用性冒烟）、
**命理题库健康**（题量 / 题型覆盖 / drift 检测）、**报告导出**（DOCX 生成 / 前端 UI / 路由注册）、
**badcase 归因**（导出接口 / Wilson 区间 / 快照接线 require+调用 / 字段映射用真实归档验 / 孤儿占比 warn）、
服务探活 + **代码新鲜度** + **前端历史档案 UI 是否就位** + 澄清闸正例（放行）/反例（23 时必须拦截）。
支持 `--offline`（跳过联网）、`--json`（机器可读）、`--port=NNNN`。
退出码：有 fail 为 1，纯 warn 为 0。
**总项数会随数据量浮动**（归档库为空时会话归档组只跑 1 项，有记录后跑 5 项），别拿固定数字当断言。

## 待扩展项（P0 三项与 P1-1、P1-2、P1-3 均已于 2026-09-03 完成）

**P0 已完成**：① preflight 澄清闸 ② 流派口径参数化（sect）③ `npm run doctor` 环境体检
**P1-1 已完成**：命理知识评测（63 题 / 11 题型，答案全部自算，drift 检测已接入 doctor 与 `npm test`）
**P1-2 已完成**：报告导出（`src/report.js` 手写 OOXML + `/api/report/export` + 前端导出/打印）
**P1-3 已完成**：会话归档检索（`data/sessions.jsonl` + `src/sessions.js` + 6 个 API + 前端历史抽屉）
**P2 已完成**：badcase 归因回流（`src/badcase.js` + 反馈自带归因快照 + `tools/badcase-selftest.js`）

- ~~**P1-1 命理知识评测集**~~：已完成（见「命理知识评测 bench」一节）。
  注意**不要直接用 Mingyu 仓库那 40 题——该仓库无 License，抄了就是污染**
- ~~**P1-2 报告导出 DOCX/PDF**~~：已完成（见「报告导出」一节）。
  PDF 走系统打印而非服务端生成，**是有意的取舍**——别再想着装 PDFKit/wkhtmltopdf 了
- ~~**P1-3 本地会话归档检索**~~：已完成。改用 JSONL 而非 sqlite（理由见上节），不用再做
- ~~**badcase 回流校正规则**~~：归因层已完成（见「badcase 归因回流」一节）。
  注意只有**归因**做了——**自动校正规则是刻意不做的**，那会让排盘层之外的东西反过来污染解读，
  违反「排盘零幻觉」铁律。这里只产出人工复核的优先级排序
- 跨厂商模型对比（GLM/Qwen key 到位后 `node src/eval.js <model>`）、检索升级 embedding 版
- ~~桌面一键启动脚本~~：已完成。项目根目录 `启动命理顾问.command`，双击即起服务+开页面（关窗口=停服务）
- ~~流年紫微侧流曜/流四化接入~~：**四化已完成**（见「流年双术接入」一节）；**流曜永久关闭**——知识库 0 条依据，不接
