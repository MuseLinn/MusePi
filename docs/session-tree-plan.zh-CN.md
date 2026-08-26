# 会话树计划

[English](session-tree-plan.md) | 中文

参考：[session.md](../docs/session.html)

本文档描述当前会话树导航的实现方式：内存中的 tree model、leaf movement rules、branching behavior，以及 extension/event integration。

## 子系统定位

会话以 append-only entry log 持久化，但运行时行为是 tree-based：

- 每个非 header entry 都有 `id` 和 `parentId`。
- 活跃位置是 `SessionManager` 中的 `leafId`。
- 追加 entry 时总是创建当前 leaf 的子节点。
- Branching **不会**改写历史；它只在下一次追加前改变 leaf 指向。

关键文件：

- `src/session/session-manager.ts` — tree data model、traversal、leaf movement、branch/session extraction
- `src/session/session-context.ts` — `buildSessionContext` context reconstruction（resolved root→leaf LLM context、compaction/branch-summary replay）
- `src/session/agent-session.ts` — `/tree` navigation flow、summarization、hook/event emission
- `src/modes/components/tree-selector.ts` — interactive tree UI behavior and filtering
- `src/modes/controllers/selector-controller.ts` — `/tree` 与 `/branch` 的 selector orchestration
- `src/slash-commands/builtin-registry.ts` — command routing（`/tree`、`/branch`）
- `src/modes/controllers/input-controller.ts` — double-escape behavior 与 `app.session.tree`/`app.session.fork` keybinding wiring
- `src/session/messages.ts` — 把 `branch_summary`、`compaction` 与 `custom_message` entry 转换为 LLM context messages

## `SessionManager` 中的 tree data model

Runtime indices 存放在 `SessionEntryIndex` helper 中，作为 `SessionManager` 上的 `#index` 持有，并与 journal array `#entries` 保持同步：

- `#entriesById: Map<string, SessionEntry>` — 任意 entry 的快速查找
- `#children: Map<string | null, SessionEntry[]>` — parent→children adjacency
- `#labels: Map<string, string>` — 按 target entry id 解析的 label
- `#leaf: string | null` — 当前在 tree 中的位置
- `#usage` — 运行中的 usage totals

Tree APIs：

- `getBranch(fromId?)` 沿 parent links 走到 root，返回 root→node path
- `getTree()` 返回 `SessionTreeNode[]`（`entry`、`children`、`label`）
  - parent links 变成 children arrays
  - missing parent 的 entry 被视为 roots
  - children 按 timestamp 从 old→new 排序
- `getChildren(parentId)` 返回直接 children
- `getLabel(id)` 从 `#labels` map 解析当前 label

`getTree()` 是 runtime projection；持久化仍是 append-only JSONL entries。

## Leaf movement semantics

共有三种 leaf movement primitives：

1. `branch(entryId)`
   - 校验 entry 存在
   - 设置 `leafId = entryId`
   - 不写入新 entry

2. `resetLeaf()`
   - 设置 `leafId = null`
   - 下一次 append 会创建新的 root entry（`parentId = null`）

3. `branchWithSummary(branchFromId, summary, details?, fromExtension?)`
   - 接受 `branchFromId: string | null`
   - 设置 `leafId = branchFromId`
   - 追加一个 `branch_summary` entry 作为该 leaf 的子节点
   - 当 `branchFromId` 为 `null` 时，`fromId` 被持久化为 `"root"`

## `/tree` navigation behavior（同一 session file）

`AgentSession.navigateTree()` 是 navigation，不是 file forking。

流程：

1. 校验 target 并计算 abandoned path（`collectEntriesForBranchSummary`）
2. 携带 `TreePreparation` emit `session_before_tree`
3. 可选总结 abandoned entries（hook-provided summary 或 built-in summarizer）
4. 计算新 leaf target：
   - 选中 **user** message：leaf 移到其 parent，message text 返回用于 editor prefill
   - 选中 **custom_message**：与 user message 同规则（leaf = parent，text prefills editor）
   - 选中其他 entry：leaf = 选中 entry id
5. 应用 leaf move：
   - 带 summary：`branchWithSummary(newLeafId, ...)`
   - 不带 summary 且 `newLeafId === null`：`resetLeaf()`
   - 其他情况：`branch(newLeafId)`
6. 从新 leaf 重建 agent context 并 emit `session_tree`

重要：summary entries 附加在**新导航位置**，不在 abandoned branch tail。

## `/branch` behavior（新 session file）

`/branch` 与 `/tree` 有意不同：

- `/tree` 在当前 session file 内导航。
- `/branch` 创建新的 session branch file（非持久化模式则为内存替换）。

用户可见 `/branch` 流程（`SelectorController.showUserMessageSelector` → `AgentSession.branch`）：

- Branch source 必须是 **user message**。
- 选中用户文本被提取用于 editor prefill。
- 若选中 user message 是 root（`parentId === null`）：通过 `newSession({ parentSession: previousSessionFile })` 开启新 session。
- 否则：`createBranchedSession(selectedEntry.parentId)` 把历史 fork 到选中的 prompt boundary。

`SessionManager.createBranchedSession(leafId)` 细节：

- 通过 `getBranch(leafId)` 构建 root→leaf path；缺失时报错。
- 从复制路径中排除现有 `label` entries。
- 对路径中仍保留的 entry 从解析后的 label map（`labelsInEffect()`）重建 fresh label entries。
- 持久化模式：写入新 JSONL file 并切换 manager 到该文件；返回新文件路径。
- 内存模式：替换内存 entries；返回 `undefined`。

## Context reconstruction 与 summary/custom 集成

`buildSessionContext()`（在 `session-context.ts` 中，通过 `SessionManager.buildSessionContext()` 暴露）解析活跃 root→leaf path 并构建有效 LLM context state：

- 跟踪 path 上最新的 thinking/model/service-tier/mode/TTSR/MCP-selection state。
- 处理 path 上最新 compaction：
  - 先 emit compaction summary
  - 从 `firstKeptEntryId` 到 compaction point replay kept messages
  - 再 replay post-compaction messages
- 把 `branch_summary` 与 `custom_message` entries 作为 `AgentMessage` objects 纳入。

`session/messages.ts` 随后把这些消息类型映射为 model input：

- `branchSummary` 与 `compactionSummary` 变成 user-role templated context messages
- `custom`/`hookMessage` 变成 developer-role content messages（通过 agent-core 的 `convertMessageToLlm`）

因此 tree movement 通过改变活跃 leaf path 来改变 context，而不是通过修改旧 entries。

## Labels 与 tree UI behavior

Label persistence：

- `appendLabelChange(targetId, label?)` 在当前 leaf chain 上写入 `label` entries。
- `SessionEntryIndex` 中的 `#labels` 立即更新（set 或 delete）。
- `getTree()` 把当前 label 解析到每个返回的 node 上。

Tree selector behavior（`tree-selector.ts`）：

- 把 tree 扁平化以便导航，保持 active-path 高亮，并优先展示 active branch。
- 支持 filter modes：`default`、`no-tools`、`user-only`、`labeled-only`、`all`。
  - `default` 会抑制 `label`、`custom`、`model_change` 和 `thinking_level_change`；它不是完整的“hide all internal entries” filter。
- 支持对 rendered semantic content 做 free-text search。
- `Shift+L` 打开 inline label editing 并通过 `appendLabelChange` 写入。

Command routing：

- `/tree` 总是打开 tree selector。
- `/branch` 打开 user-message selector，除非 `doubleEscapeAction=tree`，此时也使用 tree selector UX。

## Extension 和 hook touchpoints

Command-time extension API（`ExtensionCommandContext`）：

- `branch(entryId)` — 创建 branched session file
- `navigateTree(targetId, { summarize? })` — 在当前 tree/file 内移动

Tree navigation 相关 events：

- `session_before_tree`
  - 接收 `TreePreparation`：
    - `targetId`
    - `oldLeafId`
    - `commonAncestorId`
    - `entriesToSummarize`
    - `userWantsSummary`
  - 可取消 navigation
  - 可提供 summary payload 替代 built-in summarizer
  - 接收 abort `signal`（Escape cancellation path）
- `session_tree`
  - emit `newLeafId`、`oldLeafId`
  - 创建了 summary 时包含 `summaryEntry`
  - `fromExtension` 表示 summary origin

相邻但相关的 lifecycle hooks：

- `/branch` flow 使用 `session_before_branch` / `session_branch`
- compaction entries 使用 `session_before_compact`、`session.compacting`、`session_compact`，后续影响 tree-context reconstruction

## 真实约束与边界条件

- `branch()` 不能 target `null`；root-before-first-entry state 使用 `resetLeaf()`。
- `branchWithSummary()` 支持 `null` target 并记录 `fromId: "root"`。
- 在 tree selector 里选中当前 leaf 是 no-op。
- Summarization 需要 active model；若无，summarize navigation 会快速失败。
- 若 summarization 被中止，navigation 被取消且 leaf 不变。
- 内存会话的 `createBranchedSession` 不会返回 branch file path。
- Tree context reconstruction 包含 service-tier 与 MCP tool-selection state，但这些 entries 不会变成 LLM messages。

## Plan approval session naming

当用户从 plan mode（`InteractiveMode.#approvePlan`）批准 plan 时，approval handler 会用 plan 的 title 作为 session name 的 seed，使生成的（fresh 或 compacted）session 不会保持 unnamed。

Trigger：

- Plan approval 到达 `#approvePlan(...)` 且 `options.title` 已从 plan-approval details 填充。
- 这对所有 approval choice 都生效（`Approve and execute`、`Approve and compact context`、`Approve and keep context`）；合成 `plan-approved` prompt 原本会 bypass input-controller 的 title-generation path。

Naming source：

- 归一化后的 plan title 经 `humanizePlanTitle(title)`（`packages/coding-agent/src/plan-mode/approved-plan.ts`）人性化：
  - 把连续的 `-`/`_` 替换为单个空格
  - trim whitespace
  - 首字符大写
  - 对 whitespace-only / separator-only 输入返回 `""`
- 人性化名称只在当前 session 没有名称时（`!sessionManager.getSessionName()`）应用；随后调用 `sessionManager.setSessionName(name, "auto")`，后者同样拒绝覆盖用户命名的 session。
- 成功应用后，terminal title（`setSessionTerminalTitle`）与 editor border color 会刷新以反映新名称。

`humanizePlanTitle` 示例：

- `migrate-mcp-loader` → `Migrate mcp loader`
- `fix_session_naming` → `Fix session naming`
- `foo--bar__baz` → `Foo bar baz`
- `RefactorRouter` → `RefactorRouter`（无可展开分隔符）
- `""` / `"---"` → `""`（不应用名称）

## Legacy compatibility still present

Session migrations 在 load 时仍会运行：

- v1→v2 增加 `id`/`parentId` 并把 compaction index anchor 转为 id anchor
- v2→v3 把 legacy `hookMessage` role 迁移为 `custom`

迁移后的当前 runtime behavior 是 version-3 tree semantics。
