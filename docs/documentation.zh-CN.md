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
| Superpowers 设计与执行记录 | `docs/superpowers/specs`、`docs/superpowers/plans`；只服务进行中的改动 |
| 已完结或被取代的计划 | 删除；历史由 git 记录 |

代码、脚本、配置、目录结构和 `--help` 已能回答许多查询。文档应记录非显然契约、理由、副作用和工作流，不要缓存可以低成本查询的事实。

## 文档类型

| 类型 | 位置 | 可以写什么 |
| --- | --- | --- |
| 现行规范 / 参考 | `docs/*.md`，`status: living` 或 `reference` | 系统现在如何工作、契约，以及解释当前行为的原因。不写日期，不写变更叙述。 |
| 决策记录 | `docs/adr/NNNN-topic.md`，一个决策一份 | 背景、决定、理由、影响、被否决的方案、证据。不可改写；后续决策另起 ADR 取代。 |
| 变更日志 | `packages/coding-agent/CHANGELOG.musepi.md` | 用户可见的变化，中英各一份。 |
| 计划 / 审计 | `docs/review/` | 进行中的工作与验证记录；结束即删除。 |
| Superpowers 记录 | `docs/superpowers/specs`、`docs/superpowers/plans` | 单个进行中改动的设计与执行说明；落地即删除，不当作活文档。 |
| 生成参考 | 由生成器拥有的文件 | 重新生成，不手改。 |
| 索引 | `docs/index.md` | 只做路由。 |

决策记录不是规范：它保存“为什么这样选、否决了什么”；living 文档用现在时陈述最终契约。时间线由 git 记录，不写“最后更新”。

## living 文档不写变更史

- living 文档里的日期决策标记是债务。`scripts/check-doc-hygiene.ts` 在 `docs/doc-hygiene-baseline.json` 冻结每个文件的当前数量；新增标记会失败。改动某个主题时，把它的日期条目逐条迁进 ADR，写出现行契约，再降低基线。
- living 文档不写“此前 / 曾经 / 现在改为 / 不再”、PR 号或 commit SHA。仍然解释当前行为的原因可以保留，历史删掉。
- `scripts/check-doc-budgets.ts` 用 `docs/doc-budgets.json` 冻结核心文档的词数上限。上限只降不升；要升必须在改动说明里给出理由。

## 手写组件何时收成 primitive

收敛规则同时适用于材质与交互：

1. 第二个消费者出现时，收敛到两者中更好的那个，不保留两套皮肤。
2. 第三个消费者出现时，在第四份拷贝之前抽出唯一 primitive。
3. 抽取必须同时交付：唯一所有者（类、组件或模块）、所有数值进 `tokens.css` 或该 primitive、一份有文档的 API、一个契约测试，并在同一次改动里删掉各调用点的拷贝。
4. 把 primitive 写进 `docs/gui-components.md`（或其归属文档），说明消费者可以覆盖什么；有争议的选择链接决策记录。
5. 少于两个真实消费者时，不要抽占位 abstraction。

## 测试文档

测试是契约，不是文档；测试计划属于 review 记录，结束即删。

- 只为尚未覆盖的行为契约新增测试。一个 primitive 一个契约测试；在调用点重复证明同一材质的测试是拷贝，primitive 接管时删除。
- 契约变化时，同一次改动更新契约测试与归属规范。行为或契约删除时删掉测试；不要为已移除的 UI 路径保留测试。
- 测试名写清契约；由规范链接测试，不要反过来在规范里罗列测试。
- 真实浏览器检查只证明它测到的级联与像素，不证明原生渲染、其他引擎或其他平台；引用测试时写明这个边界。

## 渐进披露

每轮加载的文字都有成本。根指南只保留所有任务都需要的内容，分支细节放在指针之后；指针必须同时说明材料内容和触发条件。

长文档不必然需要拆分。读者必须反复跳过无关内容、受众不同，或某个独立契约可以靠近所属模块时，才拆分。不要把必须一起阅读的完整流程切成碎片。

每篇文档开头给读者地图：本文负责什么、不负责什么、下一步应看哪篇。历史叙述归 ADR 与 changelog，不放在当前契约的开头。

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
- `status`：`living`、`reference` 或 `draft`。
- `summary`：让读者判断本页是否回答其问题的一句话。
- `scope`： owning 代码或文档路径，不是所有消费者的清单。
- `layout`：文档站页面使用 `default`。
- `lang`：中文页标 `zh-CN`，英文页可省略。

`living` 表示 scope 内代码变化时必须同步复核；`reference` 是稳定背景；`draft` 不是当前契约；已完结或被取代的材料直接删除，不再保留成第二套文档，历史由 git 记录。不要手维护“最后更新日期”，时间序列由 git 记录。

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

写入命令只记录指定配对的 hash。不要为了清理旧债务执行全量写入，把无关文件混入当前改动。临时或已闭合文档直接删除，不作为活文档继续翻译。

`.agents/rules/` 保持英文；`.agents/skills/*/SKILL.md` 是中文流程文档、frontmatter 用英文；两者都不参与 `scripts/verify-translation-pairing.ts`。每个包都有中英文 README，既有例外由 `scripts/verify-package-readmes.ts` 记录。

## 改动检查

1. 确定 owning 文档及其 scope。
2. 精简重复与过期叙述时保留全部契约。
3. 按需更新元数据和两种语言。
4. 归属或结构变化时更新索引和指针。
5. 运行 `bun scripts/check-docs.ts`、具名配对严格检查和相关行为/文档门禁。
6. 检查最终文件清单，排除无关 hash 或格式化改动。
