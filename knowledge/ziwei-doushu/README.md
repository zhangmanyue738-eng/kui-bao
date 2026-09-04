# 第三方数据出处声明（NOTICE）

本目录包含来自开源项目 [Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)（MIT License，Copyright (c) 2026 紫微研究）的**数据文件**，仅保留本项目 `src/build-kb.js` 实际引用的部分：

| 文件 | 用途 | 本项目中的许可标注 |
|---|---|---|
| `lib/classics/data/*.ts` | 《紫微斗数全书》《全集》《骨髓赋》古籍原文 | `public_domain`（古籍本身为公有领域） |
| `lib/ziwei/patterns.ts` | 紫微格局库（带古籍出处） | `modern` |
| `lib/nihai/*.ts` | 倪海厦《天纪》讲义整理 | `modern`（原讲义为现代版权内容，仅供个人学习参考） |

原始应用的代码（Next.js 排盘应用）未包含在本项目中。MIT 许可声明见同目录 `LICENSE`。

**公版模式**：设置环境变量 `KB_PUBLIC_ONLY=1` 后，知识库检索仅使用 `public_domain` 条目（48 条古籍原文），所有现代整理内容（含倪海厦讲义）不参与解读。
