---
name: musepi-code-review
description: 按 MusePi 仓库标准评审 PR/改动——AGENTS.md 代码质量规则（无 ReturnType、禁内联 import、prompt 进 .md）、GUI 规则（DialogFrame、hook 顺序、provider/id）、测试契约级断言（禁 mock.module、禁 source-grep 测试）、i18n 域同步、TUI 净化、worker 契约、中央工具复用、CHANGELOG。触发：评审 PR、检查改动正确性、"这个 PR 有没有问题"、提交前自查。
---

# 评审 MusePi 改动

**这是指导，不是完整清单。** 先读 PR 的完整 diff 和足够多的周边代码来理解设计，
再按下面过。优先正确性、生命周期、安全和破坏的必需行为，其次才是风格；一条有实质
论据的 blocker 好过一列 nit。评审者指出缺陷时要给：缺陷、位置、影响、证据。

## 事实源

- `AGENTS.md` —— 仓库常驻规则：代码质量、Central Utilities、Bun Over Node、
  Generated Files、Logging、TUI Sanitization、测试规则、Changelog、Releasing。
- `docs/gui-design.md`、`docs/gui-implementation.md` —— GUI 视觉/交互标准与
  daemon RPC 契约；改 GUI 行为必须同步更新。
- `docs/i18n.md`、`docs/extensions-dev.md`、`docs/skills.md`、`docs/modes-plan.md`
  —— i18n 词表、扩展 API、skills 运行时、预设体系。
- `skill://musepi-prose-standard` —— 注释/文档/prompt/字符串的编辑标准；
  `skill://musepi-trim-cot-leakage` —— 清理思维链泄漏。

## 阻塞性要求

1. **新文案走语义评审**：用 `musepi-prose-standard` 评审每段新增/修改的 Markdown、
   JSDoc、注释、prompt、描述、诊断和可见字符串。自动检查证明不了覆盖、准确、
   放置和编辑质量。
2. **文档跟代码同步**：配置、默认值、错误、线字段、事件、公开行为在同一 diff 里
   更新包 README 和 JSDoc。GUI 行为改动同步 `docs/gui-design.md` /
   `docs/gui-implementation.md`；扩展 API 改动同步 `docs/extensions-dev.md`。
   注释只写非显然契约；叙述、测试走查、评审历史和重复理由要删或链到唯一家。
3. **i18n 同步**：zh 域文件加 key 必须同步 en 域文件（`as const satisfies`，
   缺 key 即编译错）；插件/扩展文案走 `registerTranslations` 不走词表。绿的编译
   不等于翻译质量——两边语义和术语都要对比。
4. **代码质量规则**：无 `ReturnType<>`、无内联 `import()`、ES `#private` 不用
   `private` 关键字、prompt 一律静态 `.md` + Handlebars（禁代码内拼 prompt）、
   barrel 用 `export *`、`Promise.withResolvers()`。
5. **中央工具复用**：新 helper 前先查 `packages/coding-agent/src/utils/`、
   `@musepi/pi-utils`、`@musepi/pi-tui`——两处实现同一件事就是 bug。git/jj 只走
   `src/utils/git.ts`/`src/utils/jj.ts`；渲染走 `replaceTabs`/`truncateToWidth`/
   `shortenPath`/`PREVIEW_LIMITS`。
6. **日志纪律**：可能跑在 TUI/RPC/SDK/worker/后台的代码必须用中央 `logger`，
   不用 `console.*`；只有退出即结束的独立 CLI 命令可以用 `console.*` 做有意的
   用户输出。
7. **测试契约级**：按 AGENTS.md 测试规则——每个测试命名一个外部可观察契约的失败
   模式；禁 `mock.module()`（spyOn 代替）；禁 source-grep 测试（读 `.ts` 源码文本
   断言）；禁静态回显/成功透传；测试必须全套安全（不污染 `Bun.*`/`process.env`）。
8. **必需证据存在**：作者在本地跑了相关检查（`bun check`、相关测试、必要时的
   `bun run gen:models`），CI 覆盖平台矩阵；评审者补看两者都测不到的语义缺口。
9. **CHANGELOG**：行为变更更新受影响包的 `[Unreleased]` 分区；已发布分区不可动。

## 手动检查

- **意图与接口契约**：追踪变更接口的两侧。实现与 PR 意图一致，包括错误、取消、
  所有权、dispose。
- **生命周期与并发**：异步 setup、回调、进程、teardown 按 AGENTS.md 生命周期规则
  查——发布前竞态、await 期间取消、独立错误上报、回调隔离、重入前的所有权、完整
  detach 清理、静默式 dispose。GUI 侧：DialogFrame 常挂载由 `open` 驱动、hook 必须
  声明在任何 early return 之前、模态拥有键盘。
- **模型标识与作用域**：`provider/id` 而非裸 id；模型选择 session 作用域
  （`session.setModel`），欢迎页 preselect 不写 DEFAULT；角色思考阶梯按
  `getSupportedEfforts` 而非固定档。
- **能力与消费者匹配**：追踪每个消费者，再标消费者特定行为泄漏进接口的；反向也标：
  通用服务（注册表、会话、agent）上新公开方法只有内部一个调用者 = 不必要的 API
  扩张，要求构造时传给该消费者的私有能力闭包。
- **范围、所有权、必要性**：把每个抽象、状态机、选项、防御拷贝、兼容路径映射到
  当前契约、生产消费者和归属插件/服务。挑战无关特性和投机通用化。
- **模型视角**：检查受影响的模式里模型实际读到的 prompt、工具 schema、结果、诊断。
  标出模型任务之外的概念；稳定文本逐字核对，动态行为靠 snapshot 或端到端覆盖。
- **借用与派生状态**：判定每个保留值是借用还是持有（按包契约），再追踪通知和每个
  缓存、prompt、UI 回显、重放、查询视图到文档化的成功点和权威源。
- **边界覆盖完整操作**：定位完整产出/保留结果的所有者（含包装和元数据），测极小/
  精确上限、超大单块、多字节文本的字节上限。
- **真实入口路径**：测试走发布的 Loader、bin、worker、daemon 桥或子进程；手挂插件
  抓不到 Loader 导出错误，函数插件必须命名导出命名空间且无默认导出。
- **测试强度**：断言会在预期回归上失败，验证外部状态/日志/事件/dispose 而不是
  复述实现或信任 agent 报告。覆盖率是必要不充分——场景正确性才是证据。
- **TUI 净化**：所有渲染路径（含错误消息、diff、流式预览）走 `replaceTabs`/
  `truncateToWidth`/`shortenPath`/`PREVIEW_LIMITS`；流式与重建双路径都要验证。
- **worker 契约**：新 worker 必须进 `cli.ts` 的 selector 分发表并按 worker 契约
  实现（`workerHostEntry()` 重入单入口，或测试环境 fallback 直接模块）；用
  `--smoke-test` 探针验证。
- **生成文件**：`models.json` 改动必须来自生成器/解析器 + `bun run gen:models`，
  手改直接拦。

## 报告

本地化缺陷贴到最紧的相关 diff 范围；跨切架构/范围/全览综合用 PR 级评论。blocker
与建议分开，已被绿灯门禁强制的不重复提。回复评审时逐条验证，用技术依据修或驳，
不表演性同意。
