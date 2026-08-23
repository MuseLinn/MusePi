---
name: musepi-find-simplifications
description: 在 MusePi 代码库找非显然的简化点——无生产消费者的公开方法/事件/配置项/helper、两个表示镜像同一事实、投机通用化、手搓重复中央工具或 Bun 内置的实现；产出有证据的候选清单（评审过、可进 PR + CHANGELOG）。触发："找找简化机会 / 这代码能简化吗 / 哪些是死代码 / 这个包有必要存在吗"。
---

# 找 MusePi 简化点

把宽泛的"找东西简化"请求变成有证据的候选清单，删除或折叠现有表面。这是指导，不是
清单：跟着代码走，保持判断力，宁要几个证据扎实的候选，不要一堆薄猜测。

## 先读仓库上下文

- 读 `AGENTS.md`，尤其 **Central Utilities**（两处实现同一件事就是 bug；扩展中央
  helper 而不是本地 fork）、**Bun Over Node**（Bun 内置优先）、**Catalog import
  convention**（`@musepi/pi-catalog/<module>` 取值、`@musepi/pi-ai` 只出类型）、
  **Generated Files**（`models.json` 永不手改）这些教条——简化候选如果跟它们冲突，
  要么是误判，要么需要额外证据。
- 读 `docs/gui-design.md` / `docs/gui-implementation.md` 再评 GUI/daemon 表面；
  跟既定视觉/行为规范打架的"简化"要有更多证据。
- 知道哪些是**有意的双轨**：`omp-plugins`（OMP 生态扩展包）与 `musepi-extensions`
  （自有扩展系统）并存、CLI/TUI 与桌面 GUI 共用同一扩展系统——默认视为有意，不要
  把"合并这两套"当低成本候选，除非用户明确覆盖。

## 什么算强候选

强候选删、折叠或降级了某样**真实存在**的东西，且有清晰证据表明现状成本大于收益：

- 公开方法、事件、配置项、注册表通知、helper、包、命令或测试产物**没有生产消费者**。
- 只有测试或文档在消费，且它们钉住的行为不承载契约。
- **两个表示镜像同一事实**，尤其是跨持久会话事件与瞬态 `agent/*` 事件、跨 GUI 状态
  与 daemon 状态。
- 一个缝的每个实现都必须支持、却没有任何消费者使用的方法。
- 一个独立包只为了测试/演示/支持代码而存在，徒增发布或依赖开销。
- 实现了**投机通用化**：没有产品主人的多会话/会话加载、后台任务名册、运行时注册表
  失效、中途转向、工具自有 UI 渲染等设计。（MusePi 的 daemon 多会话是产品本身，
  不算。）
- 不变量、回滚路径、预期输出集或特例测试只为了保护一个无人用的 API。
- **手搓代码重复了**中央 helper（`packages/coding-agent/src/utils/`、
  `@musepi/pi-utils`、`@musepi/pi-tui`）、Bun 内置（`Bun.file`/`Bun.write`/
  `Bun.sleep`/`bun:sqlite`/`Bun.spawn`/`Bun.JSON5`/`Bun.stringWidth`…）或 Node
  内置——AGENTS.md 的 Bun Over Node 表和 Central Utilities 就是现成的检查表，
  交换应能删掉实现加它的专属测试。
- 简化后行为可能略有不同，但新行为仍然合理且更好解释。

薄候选通常不够格进清单：删一个拼写错误、跑一次 knip、标"这里看着复杂"却没有
调用点证明。

## 广撒网

用户要广度或许多候选时用并行子代理。给每个代理一个领域并要求证据，不许猜。有用的
领域划分：

- **agent 循环与会话**：turn/step 边界、steer/followUp、中止/取消、持久事件、重放、
  加载/恢复、compaction。
- **daemon 与 GUI**：WebSocket 协议（collab-proto）、会话宿主、GUI 状态与 daemon
  状态的重复、看板/widget 存储、扩展 HMR/`registerComponent`。
- **扩展系统**：custom tools、extensions 生命周期、hooks、plugins、slash commands、
  skills 发现（`.musepi`/`.claude`/`.codex`/`.omp`/github 各 provider 的重复）。
- **LLM/工具/prompt**：stream/generate API、工具 schema 默认值、`prompts/tools/*.md`
  与 schema 的重叠、provider 注册。
- **bash/工具执行**：前台/后台拆分、作业所有权、输出溢出、executor 方法。
- **包/脚本/测试**：包拆分、静态清单、快照预期输出冗余、支持包。

从最大的生产代码增量开始。只停在明显未用符号的宽审计会漏掉重复生命周期或防御机制
最贵的地方。

## 信任与生命周期边界

对每个防御性拷贝、冻结、校验器和回调捕获，说出值从哪来、下一个所有者是谁。同进程
的类型化服务/插件调用通常借用只读值；解析器、配置加载器、队列、模型/工具 JSON、
持久文件、worker、进程和线解码器拥有或校验自己的数据。围绕敌意 getter、假类型对象、
回调替换、同进程交接后变更的测试，是潜在投机契约的证据，不是保留的自动理由。

复杂异步代码画出所有权图，把每个哨兵、就绪 promise、取消路径、disposer、状态标志
映射到唯一所有者或转移。多个机制镜像同一存活/结算事实时，提议一个事务或生命周期
控制器。以下机制分开保留：同步发布与回滚保护、回调隔离、首终结仲裁、worker/进程
所有权、静默式 dispose。

## 手搓 vs 依赖

引入依赖是合法的简化动作，不是策略例外：先问——协议解析器、帧器、重试/退避循环、
glob 匹配器、diff 引擎这类基础设施，`@musepi/pi-utils`、Bun 内置或 Node 内置（引擎
底线内）是否已经做了？证明依赖交换候选像任何候选一样，外加：

- 读手搓实现，点名包覆盖的精确表面；包不覆盖的残余语义算作交换的负分，留在清单里。
- 诚实查包的健康度（维护、采用、传递体积），引擎底线有内置时优先内置。

## 产出

没有 Agent Notes 体系——候选的归宿是**评审 + PR + 每个受影响包的
`CHANGELOG.md` `[Unreleased]` 条目**。删行为时，按 AGENTS.md 测试规则留契约级
回归测试（命名失败模式），把删除本身写进 changelog（`Removed`）。候选清单按
"证据 → 位置 → 建议动作 → 影响"列，标出谁在消费、删掉后谁受影响。
