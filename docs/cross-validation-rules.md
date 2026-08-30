# 互证规则可执行判定逻辑（待办 1）

> 对应交接提示词第四节「双术分工与互证规则」。目标：把定性规则表细化为**程序可判定**的取证规则与合成算法，供排盘层 JSON → 互证合成模块直接实现。
>
> 设计原则：
> 1. 每个领域先各自从八字、紫微排盘 JSON 中**提取结构化信号**，再做合成——取证与合成解耦
> 2. 信号只有三个方向值：`favorable`（利）、`unfavorable`（不利）、`neutral`（无明显信号）；**禁止程序输出吉凶断语**，只输出方向 + 强度 + 证据链，措辞交给解读层
> 3. 双术信号不一致时不硬选边，输出条件式结论所需的全部素材（A 术证据、B 术证据、可引动的变量）

---

## 一、信号数据结构（统一接口）

每个领域、每种术数各产出一条 `DomainSignal`：

```ts
interface DomainSignal {
  domain: 'career' | 'wealth' | 'marriage' | 'health' | 'annual';
  method: 'bazi' | 'ziwei';        // 信号来源术数
  direction: 'favorable' | 'unfavorable' | 'neutral';
  strength: number;                 // 0.0 ~ 1.0，量化依据见各领域规则
  evidence: Evidence[];             // 证据链，逐条对应排盘 JSON 字段
  conditions?: string[];            // 条件式结论的"引动变量"（如流年干支、流四化）
}

interface Evidence {
  field: string;                    // 排盘 JSON 路径，如 bazi.tenGods.官星.strength
  value: string;                    // 原始值，如 "丙火正官，坐长生，旺"
  rule: string;                     // 触发的取证规则编号，如 "BZ-CAREER-01"
}
```

**方向判定总则**：规则表里每条取证规则预先标好「取到该值 → 判什么方向、多少强度」。程序只做匹配，不做判断。

**强度分档**（全领域统一）：

| strength | 含义 |
|---|---|
| 0.8–1.0 | 主星/用神旺相、庙旺得地，或化禄/禄存同宫等强信号 |
| 0.5–0.7 | 有明确信号但受制/平闲，或一吉一凶混杂 |
| 0.2–0.4 | 弱信号、闲曜、余气 |
| 0 | 无相关星曜/十神入局 → `neutral` |

---

## 二、统一排盘 JSON 最小字段清单（待办 5 的输入）

互证模块只依赖以下字段，schema 设计时必须覆盖：

**八字侧**（来自 lunar-python）：
`year/month/day/hour pillars`（干支+藏干）、`dayMaster`（日主天干+五行）、`fiveElementsCount`（五行个数与旺衰评分）、`tenGods`（十神列表及各自由度：旺/相/休/囚/死）、`favorableElements`（调候+扶抑得出的喜用神）、`dayBranch`（日支）、`spouseStar`（夫妻星：男看财、女看官）、`luckPillars`（大运干支+起止年龄）、`annualPillar`（流年干支）、`shenSha`（神煞，仅限标注用）、`hourPillarMissing`（布尔，时柱待定标记）

**紫微侧**（来自 iztro）：
`palaces[12]`（每宫：主星+庙旺利陷、辅星、杂曜）、`siHua`（生年四化：禄权科忌落在何宫何星）、`bodyPalace`（身宫）、`mingZhu/shenZhu`（命主身主）、`flowPalaces`（流年宫位叠加：流曜+流四化）、`decadal`（大限宫位+年龄区间）

---

## 三、五大领域取证规则

### 3.1 事业（career）

**八字取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| BZ-CAREER-01 | 正官/七杀（官星）旺衰 | 官星为喜用且旺 → favorable 0.8；官星旺但为忌 → unfavorable 0.6；官星弱或不见 → neutral 0.2 |
| BZ-CAREER-02 | 食伤旺衰与喜忌 | 食伤为喜用旺 → favorable 0.7（技术/专业/自由职业倾向）；食伤为忌旺 → unfavorable 0.5 |
| BZ-CAREER-03 | 格局 | 正官格/食神制杀等成格且不破 → favorable 0.9；格局破败 → unfavorable 0.6 |
| BZ-CAREER-04 | 大运走向 | 未来大运生扶官星/用神 → favorable 0.6（写入 conditions：起止年龄）；克泄用神 → unfavorable 0.6 |

**紫微取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| ZW-CAREER-01 | 官禄宫主星庙旺 | 庙旺主星 ≥2 颗 → favorable 0.8；陷落主星 → unfavorable 0.6；无主星借对宫 → neutral 0.3（标注"借宫"） |
| ZW-CAREER-02 | 官禄宫四化 | 化禄/化权入官禄 → favorable 0.9；化忌入官禄 → unfavorable 0.8 |
| ZW-CAREER-03 | 官禄宫辅星 | 禄存/天马/左辅右弼同宫 → favorable 0.5；擎羊陀罗火铃同宫 → unfavorable 0.5 |
| ZW-CAREER-04 | 命宫三方四正 | 命宫主星气质与事业型（杀破狼/机月同梁等）匹配 → 记录星系标签，不单独定方向，供解读层措辞用 |

**事业领域合成示例**：八字 BZ-CAREER-01 → favorable 0.8，紫微 ZW-CAREER-02 → unfavorable 0.8（化忌入官禄）→ 双术冲突 → 条件式结论，引动变量取 BZ-CAREER-04 的大运区间。

### 3.2 财帛（wealth）

**八字取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| BZ-WEALTH-01 | 正财/偏财旺衰与喜忌 | 财星为喜用旺 → favorable 0.8；财星为忌旺 → unfavorable 0.6（求财辛苦/因财受制）；财星不见 → neutral 0.3 |
| BZ-WEALTH-02 | 食伤生财路径 | 食伤与财星相生且均不弱 → favorable 0.7（凭技能生财） |
| BZ-WEALTH-03 | 比劫夺财 | 比劫旺而财星受克 → unfavorable 0.6（合作破财倾向） |
| BZ-WEALTH-04 | 身强身弱 | 身强能任财 → 方向跟随 BZ-WEALTH-01 上调 0.1；身弱财旺 → unfavorable 0.5（财多身弱） |

**紫微取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| ZW-WEALTH-01 | 财帛宫主星庙旺 | 同 ZW-CAREER-01 逻辑 |
| ZW-WEALTH-02 | 财帛宫化禄/化忌 | 化禄入财帛 → favorable 0.9；化忌入财帛 → unfavorable 0.8；化忌+禄存同宫 → unfavorable 0.5（"禄逢冲破"需标注出处） |
| ZW-WEALTH-03 | 田宅宫状态 | 田宅宫吉（化禄/库旺）→ favorable 0.4（守财能力，作辅助信号）；田宅化忌 → unfavorable 0.4 |

### 3.3 婚姻（marriage）

**八字取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| BZ-MARR-01 | 日支（夫妻宫）十神与合冲 | 日支为喜用 → favorable 0.6；日支逢冲（子午冲等）→ unfavorable 0.6；日支合入 → favorable 0.5 |
| BZ-MARR-02 | 夫妻星旺衰（男看财/女看官） | 夫妻星为喜用旺而清 → favorable 0.8；夫妻星为忌或混杂（多现争合）→ unfavorable 0.6；不现 → neutral 0.3（标注"夫妻星不现，看日支"） |
| BZ-MARR-03 | 日支与夫妻星互动 | 夫妻星坐日支且相生 → favorable 0.7 |
| BZ-MARR-04 | 神煞参考项 | 红鸾/天喜/桃花：仅记录标签供措辞，**不单独定方向**（神煞权重低，防过度解读） |

**紫微取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| ZW-MARR-01 | 夫妻宫主星 | 庙旺吉星（天府/天相/天同/太阳太阴庙旺等）→ favorable 0.7；杀破狼孤克星陷落 → unfavorable 0.6 |
| ZW-MARR-02 | 夫妻宫四化 | 化禄/化科入夫妻 → favorable 0.8；化忌入夫妻 → unfavorable 0.8；化忌+擎羊 → unfavorable 0.9 |
| ZW-MARR-03 | 夫妻宫煞曜 | 六煞星 ≥2 颗同宫 → unfavorable 0.5 |

**婚姻领域特别约束**：婚姻结论方向只允许 favorable/unfavorable 弱化措辞（"利于感情稳定 / 需多经营"），解读层措辞规则见 system prompt 模板第 6 节。

### 3.4 健康（health）

**八字取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| BZ-HEALTH-01 | 五行偏枯 | 某五行个数 0 或 ≥5 → 记录"偏枯五行"标签 + 对应脏腑（木-肝胆、火-心小肠、土-脾胃、金-肺大肠、水-肾膀胱），direction = unfavorable 0.5 |
| BZ-HEALTH-02 | 用神受克 | 喜用神被旺神克泄 → unfavorable 0.5 |
| BZ-HEALTH-03 | 日主强弱 | 日主太弱无根 → unfavorable 0.4 |

**紫微取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| ZW-HEALTH-01 | 疾厄宫主星 | 主星平和 → neutral 0.2；陷落/属克泄命主五行的主星组合 → unfavorable 0.4 |
| ZW-HEALTH-02 | 疾厄宫煞曜忌 | 化忌入疾厄 → unfavorable 0.7；六煞 ≥2 → unfavorable 0.5 |

**健康领域红线**：证据只输出「五行/星曜倾向标签」（如"木弱"），**禁止输出任何疾病名称**。解读层措辞限定为作息、脏腑养护方向的生活建议（见 system prompt 模板第 6 节）。

### 3.5 流年（annual）

**八字取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| BZ-ANN-01 | 流年干支与日主的十神 | 流年干支十神为喜用 → favorable 0.7；为忌 → unfavorable 0.7 |
| BZ-ANN-02 | 流年与四柱的刑冲合害 | 天克地冲日柱 → unfavorable 0.6；六合/三合入喜用 → favorable 0.6 |
| BZ-ANN-03 | 大运与流年互动 | 大运喜用+流年相生 → favorable 0.6（写在 conditions：具体年份）；岁运并临/反吟伏吟 → unfavorable 0.5 |

**紫微取证**：

| 规则号 | 取值 | 判定 |
|---|---|---|
| ZW-ANN-01 | 流年命宫主星与煞曜 | 流命宫庙旺吉 → favorable 0.6；流命宫化忌+煞 → unfavorable 0.7 |
| ZW-ANN-02 | 流四化 | 流禄入本命三方 → favorable 0.5；流忌冲本命命宫/官禄 → unfavorable 0.6 |
| ZW-ANN-03 | 大限与流年叠加 | 大限吉+流年吉 → favorable 0.7；大限忌+流年忌 → unfavorable 0.7 |

**流年领域合成约束**：流年问题必须同时给出**月份/季节级粗颗粒节奏**（由八字流月干支 + 紫微流月宫位叠加得到，仅标注"相对平缓/需留意"两档，不做逐日吉凶）。

---

## 四、合成算法（互证合成模块）

```ts
type Direction = 'favorable' | 'unfavorable' | 'neutral';

interface SynthesisResult {
  domain: Domain;
  verdict: 'consistent' | 'single-method' | 'conditional';
  confidence: 'high' | 'medium' | 'conditional';
  baziSignal: DomainSignal;
  ziweiSignal: DomainSignal;
  conditions: string[];   // 条件式结论的引动变量
}

function synthesize(bazi: DomainSignal, ziwei: DomainSignal): SynthesisResult {
  // 规则 S1：双术都有明确方向信号
  if (bazi.direction !== 'neutral' && ziwei.direction !== 'neutral') {
    if (bazi.direction === ziwei.direction) {
      // 一致：置信度高；强度取两术均值的 1.1 倍（封顶 1.0），体现互证加成
      return {
        domain: bazi.domain, verdict: 'consistent', confidence: 'high',
        baziSignal: bazi, ziweiSignal: ziwei, conditions: []
      };
    }
    // 冲突：不硬选边 → 条件式。取强度更高一方为主结论素材，另一方为条件变量
    const primary = bazi.strength >= ziwei.strength ? bazi : ziwei;
    const secondary = primary === bazi ? ziwei : bazi;
    return {
      domain: bazi.domain, verdict: 'conditional', confidence: 'conditional',
      baziSignal: bazi, ziweiSignal: ziwei,
      conditions: [
        `主信号来自${primary.method === 'bazi' ? '八字' : '紫微'}（强度 ${primary.strength}）`,
        `若流年/大运引动以下变量则偏向另一方：`,
        ...secondary.conditions ?? [],
        `引动判据：流年干支十神为${secondary.method === 'bazi' ? '其喜用' : '流四化吉化入相关宫位'} 时切换倾向`
      ]
    };
  }

  // 规则 S2：仅单术有信号 → 置信度中，标注来源术数
  if (bazi.direction !== 'neutral' || ziwei.direction !== 'neutral') {
    return {
      domain: bazi.domain, verdict: 'single-method', confidence: 'medium',
      baziSignal: bazi, ziweiSignal: ziwei, conditions: []
    };
  }

  // 规则 S3：双术均 neutral → 输出"此领域盘面无明显倾向"，解读层只做中性描述
  return {
    domain: bazi.domain, verdict: 'consistent', confidence: 'medium',
    baziSignal: bazi, ziweiSignal: ziwei, conditions: []
  };
}
```

**S3 的输出不是空话**：「双术均无明显信号」本身是有价值的结论（该领域平稳、无强倾向），解读层措辞为"此领域盘面呈现平稳倾向，无明显起伏信号"。

## 五、时柱待定的降级处理（对接待办 3）

- `hourPillarMissing === true` 时：八字侧**跳过所有依赖时柱的规则**（时柱十神、时支合冲），仅用年月日三柱取证，且每条 `DomainSignal.evidence` 强制追加 `{ field: 'bazi.hourPillar', value: '时柱待定', rule: 'BZ-GLOBAL-00' }`
- 全部八字信号的 `strength` 统一乘以 0.8 的降级系数
- 紫微侧不受影响（紫微只需时辰定命宫；若**时辰完全未知**，紫微整侧标记 `method: 'ziwei', direction: 'neutral'` 并注明「时辰未定，紫微未排」，走 S2 单术路径——此时只能给到 B 级精度，输出模板见 system prompt 第 7 节）
- 合成时若任一术数处于降级状态，`confidence` 上限为 `medium`，禁止出现 `high`

## 六、与解读层的接口

合成模块把 `SynthesisResult[]`（每领域一条）+ 原始排盘 JSON + RAG 检索条文一起交给解读层 LLM。解读层**只能**基于这份输入写作，规则见 `prompts/interpreter-system-prompt.md`。
