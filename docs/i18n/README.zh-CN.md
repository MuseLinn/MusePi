# 双语文档

[English](README.md) | 中文

MusePi 的用户向与项目文档以英文和简体中文双语维护，与 dsh 约定及仓库既有的
包 README 规则（`README.md` + `README.zh-CN.md`，由
`scripts/verify-package-readmes.ts` 门控）一致。本页定义配对约定、门与渐进落地政策。

## 配对约定

- **两种语言同等权威。** 文档可以先以任一语言撰写，另一侧由其翻译而来；两者无高低之分，
  绑定它们的是「内容一致」。
- **一对 = 三个同级文件。** 英文 `foo.md`、中文 `foo.zh-CN.md`、一致性记录 `foo.i18n.yaml`，
  同目录存放。不设 locale 目录、不做中英混排文件。
- **一致性记录。** `foo.i18n.yaml` 记录双方在「最后一次确认为一致」时的 git blob hash：
  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh-CN.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```
  用 blob hash（而非 commit hash），使同一 PR 内编辑的文件也可计算，一致性成为纯内容比较。
- **语言切换器。** 英文侧在标题后链接中文侧：`English | [中文](foo.zh-CN.md)`
  （README 类可用等价内联 HTML）。中文侧回链：`[English](foo.md) | 中文`。
  Pages 站的 jekyll-relative-links 插件会把 `.md` 链接改写为 `.html`。
- **结构镜像。** 标题顺序、列表类型、表格维度、代码块在两侧一一对应。
  编辑一侧的 PR 必须在同一 PR 内更新另一侧。

## 门：verify-translation-pairing

`bun run verify-translation-pairing` 机械执行契约：

1. 范围内每份文档都有完整配对（`.md` + `.zh-CN.md`）。
2. 每个既有配对一致：两侧都存在、当前 blob hash 等于记录值（只改一侧而不重新确认会红）、
   两侧都带语言切换器。

用法：

- `bun run verify-translation-pairing` —— 全量状态报告（永不失败；missing-pair 列出以便渐进翻译）。
- `bun run verify-translation-pairing <stem...>` —— 指定配对的严格检查（违规即失败）；
  用三个文件任一或裸 stem 命名配对。
- `bun run verify-translation-pairing --write <stem...>` —— 记录指定配对 blob hash；
  `--write --all` 记录所有完整配对。

## 范围与排除

**范围**：`docs/**` 下所有 markdown，加上根 `index.md` 与 `README.md`（及其 `.zh-CN.md` 对应）。

**排除**（永不配对；门会拒绝为它们添加 `.zh-CN.md` 或 `.i18n.yaml`）：

- `docs/AGENTS.md`、`docs/CLAUDE.md` 等 agent 指令文件——仅英文维护。
- `docs/skills/examples/**/README.md`——独立示例项目，非文档。

**普遍要求**：范围内任何现有或未来文档都以完整双语对合入，不存在逐文件分批清单。

## 渐进落地

语料规模大（截至 2026-08-25 为 147 份），历史上多为单语。翻译渐进落地：

1. 全量报告列出 `missing-pair` 行，不阻塞 CI。
2. 指定配对检查是严格的，编辑过的配对不会静默过期。
3. 新配对优先级：用户向文档（settings、keybindings、environment-variables、
   session 操作、tools）→ 活文档（gui-design、gui-implementation、i18n）→ 其余。
4. 已过时或已闭合的内部设计/计划文档**删除而非翻译**（见 2026-08-25 清理：
   upstream-sync、extension-hmr-v2-plan）。
