---
name: musepi-prose-standard
description: MusePi 代码库的文案/注释标准——写"契约"而不是写过程：删推理过程、重复和装饰，一处事实一个家；覆盖 JSDoc、代码注释、prompt .md、i18n 文案、GUI 可见字符串、CHANGELOG、docs。触发：写/审/改注释、文档、prompt、用户可见文案，或"这个注释太啰嗦 / 文档怎么组织 / 这段话怎么改"。
---

# MusePi 文案标准

写得足以保住契约，然后删掉推理过程、重复和装饰。**契约**是调用方、被调方、实现方、
生产者或消费者依赖的义务、不变量、前置/后置条件或兼容性承诺。本 skill 负责编辑判断
与必要覆盖面；清理"思维链泄漏"（死会话引用、变更叙述、评审对白、控制流叙述、含糊
推迟）用 `musepi-trim-cot-leakage`。这是指导，不是脚本。

注释描述代码无法表达的**非显然契约或理由**；不复述代码已经明说的事实。不要把
`契约/边界/形状/表面/缝/门/词汇` 当禁词：先问更精确的词是不是更好（写 `响应字段`、
`JSON 校验`、`ESM 导出` 而不是 `响应形状`、`校验边界`、`模块形状`），但调用方/被调方
契约、安全/进程边界就该叫边界。

## 保留完整命题

改动一段文案前，先列出其中的每个命题，逐一保留：

- 行为者和动作；
- 条件、时序、顺序；
- 情态（必须/可以/绝不）；
- 否定保证与例外；
- 所有权、副作用、失败模式、后果。

只有当每个事实分句都存活且更清晰时，才删形容词、重复和叙述。**字数变少本身不是
改进。**

- 在用法处保留完整的本地契约：那里需要的行为、失败、所有权、后果。架构、理由、算法、
  历史、扩展例子一律链接到归属文档。一个解释只有一个家；关键契约事实可以在本地重复。
- 保留非显然的理由——省略它可能导致误用或错误简化时；否则写后果并链接理由的家。

## 各位置的必需覆盖面

这不是单向删减：当代码、类型、结构传达不了下面的契约时，要**补**文案；本地已显然
的事实不加注释。

- **公开 JSDoc**：写调用方可见的返回区分、抛错/拒绝、副作用、所有权、时序、取消、
  持久性。函数式导出带 `@param`/`@returns`。
- **内部注释**：定位非本地结构与明显复杂的本地结构——不变量、竞态次序、所有权、
  安全边界、意外的失败行为。删控制流叙述和代码复述。
- **prompt 文件**：prompt 一律是静态 `.md`（AGENTS.md 规则：禁代码内拼 prompt），
  Handlebars 做动态内容。**措辞即行为**：改动 prompt 视为行为变更，需要 snapshot/
  测试佐证。
- **i18n 文案**：走域文件（`desktop-web/src/i18n/{zh-CN,en-US}/<domain>.ts`、
  `coding-agent/src/i18n/zh-CN/`），zh 加 key 必须同步 en（en 域文件
  `as const satisfies Record<ZhKey, string>`，缺 key 即编译错）；插件/扩展文案走
  `registerTranslations`，GUI 另有 `tLoose`。key 是契约：不擅自改语义。
- **GUI/CLI 可见字符串**：同 prompt——措辞即行为，改动要过 snapshot 或行为验证。
- **测试**：只解释非显然的测试设计——为什么需要这个 fixture、断言、平台迁就、
  真实入口或间接观察。删走查式叙述和清单（AGENTS.md 测试规则已定义好坏测试）。
- **CHANGELOG**：按包 `CHANGELOG.md` 的 `## [Unreleased]` 分区（Breaking/Added/
  Changed/Fixed/Removed），已发布分区不可改；评审不挑分区格式（`bun run release`
  会自动规范化）。
- **docs**：产品行为文档归属 `docs/gui-design.md`（设计/交互标准）与
  `docs/gui-implementation.md`（RPC 契约/踩坑/验证工作流）；改 GUI 行为必须同步。
  扩展 API 变更同步 `docs/extensions-dev.md`。文档是现状描述，不是变更日志。
- **诊断/错误消息**：点名失败主体或路径、被违反的规则、非显然的纠正；删内部执行叙述。

## 复用现有事实

写任何 helper/文案前先查 `packages/coding-agent/src/utils/`、`@musepi/pi-utils`、
`@musepi/pi-tui` 和调用点旁边的领域模块——**两处实现同一件事就是 bug**（AGENTS.md
Central Utilities 规则）。JSDoc 同理：能链接到中央 helper 的契约就不要在调用点重写
一份。

## 边界

- 不动 `vendor/`、`node_modules/`、`packages/*/node_modules`、录制产物/快照/fixtures
  ——这些保持原样。
- 生成的 `packages/catalog/src/models.json` 永不手改：改生成器/解析器
  （`scripts/generate-models.ts`、`provider-models/`），再 `bun run gen:models` 重生成。
- 与 `musepi-trim-cot-leakage` 配合：先保命题，再删转写；拿不准就先列命题再动手。
