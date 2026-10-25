---
layout: default
title: 文档维护规范
status: living
summary: MusePi 文档的事实归属、渐进披露、元数据、双语配对和精简规则。
scope:
  - docs
  - .agents
  - packages
lang: zh-CN
---

# 文档维护规范

[English](documentation.md) | 中文

本规范定义 MusePi 文档的组织与维护方式，适用于产品文档、实现契约、包指南和 agent 指令。agent 执行规则归根 `AGENTS.md` 与 `.agents/rules/`，本页不复制这些规则。

## 一个事实只有一个归属

每条规则只有一个权威位置。其他文档链接到它，只保留本地后果。新增规则前先确定归属，不要顺手追加到最方便的长文件。

| 内容 | 归属 |
| --- | --- |
| 每轮加载的执行边界与仓库路由 | 根 `AGENTS.md` |
| 按任务加载的工程规则 | `.agents/rules/` |
| 可复用的 agent 工作流程 | `.agents/skills/*/SKILL.md` |
| 产品与实现契约 | `docs/` |
| 模块所有权与局部不变量 | 包 README 或 `DOCUMENTATION.md` |
| 计划、审计与验证记录 | `docs/review/` |
| 已完结或被取代的计划 | `docs/archive/` |

代码、脚本、配置、目录结构和 `--help` 已能回答许多查询。文档应记录非显然契约、理由、副作用和工作流，不要缓存可以低成本查询的事实。

## 渐进披露

每轮加载的文字都有成本。根指南只保留所有任务都需要的内容，分支细节放在指针之后；指针必须同时说明材料内容和触发条件。

长文档不必然需要拆分。读者必须反复跳过无关内容、受众不同，或某个独立契约可以靠近所属模块时，才拆分。不要把必须一起阅读的完整流程切成碎片。

每篇文档开头给读者地图：本文负责什么、不负责什么、下一步应看哪篇。历史叙述归 ADR、changelog 或归档计划，不放在当前契约的开头。

## 元数据

新文档和已纳管的活文档使用 YAML frontmatter：

```yaml
---
layout: default
title: 简短文档标题
status: living
summary: 一句话说明契约与读者。
scope:
  - packages/example
  - docs/example.md
---
```

字段含义：

- `title`：站点与读者可见标题；正文仍保留一个 H1。
- `status`：`living`、`reference`、`draft` 或 `archived`。
- `summary`：让读者判断本页是否回答其问题的一句话。
- `scope`： owning 代码或文档路径，不是所有消费者的清单。
- `layout`：文档站页面使用 `default`。
- `lang`：中文页标 `zh-CN`，英文页可省略。

`living` 表示 scope 内代码变化时必须同步复核；`reference` 是稳定背景；`draft` 不是当前契约；`archived` 是历史材料，不再更新活状态。不要手维护“最后更新日期”，时间序列由 git 记录。

运行 `bun scripts/check-docs.ts`。既有旧文件可渐进迁移，新文件和已纳管核心文档必须有合法元数据。迁出旧状态时应补齐元数据，而不是放宽检查器。

## 精简但保留契约

删除或移动段落前，保留所有有效命题：行为者、动作、条件、顺序、情态、例外、所有权、副作用、失败模式和后果。只有这些事实仍然清楚时，更短才是改进。

删除重复规则、过期历史、死设计引用、评审对白和仅复述默认行为的指令。省略后可能导致误用的非显然理由必须保留。不能仅因文档太长就删除契约，应重组或链接。

## 双语配对

一组配对由 `X.md`、`X.zh-CN.md` 和 `X.i18n.yaml` 构成。两种语言具有同等权威，标题、列表和表格结构保持镜像。同一改动中更新双方，语言切换链接放在 H1 后。

使用具名检查和限定写入：

```sh
bun run verify-translation-pairing docs/example
bun run verify-translation-pairing --write docs/example
```

写入命令只记录指定配对的 hash。不要为了清理旧债务执行全量写入，把无关文件混入当前改动。临时或已闭合文档应删除或归档，不作为活文档继续翻译。

`.agents/` 下的 agent 专用规则以及 `scripts/verify-translation-pairing.ts` 明确排除的文件保持英文。每个包都有中英文 README，既有例外由 `scripts/verify-package-readmes.ts` 记录。

## 改动检查

1. 确定 owning 文档及其 scope。
2. 精简重复与过期叙述时保留全部契约。
3. 按需更新元数据和两种语言。
4. 归属或结构变化时更新索引和指针。
5. 运行 `bun scripts/check-docs.ts`、具名配对严格检查和相关行为/文档门禁。
6. 检查最终文件清单，排除无关 hash 或格式化改动。
