# /tree 命令参考

[English](tree.md) | 中文

`/tree` 打开交互式**会话树**导航器。它让你跳转到当前会话文件的任意条目，并从该点继续。

这是文件内的叶移动，不是新会话导出。

## `/tree` 的作用

- 从当前会话条目构建树（`SessionManager.getTree()`）
- 打开 `TreeSelectorComponent`，支持键盘导航、筛选和搜索
- 选中后，调用 `AgentSession.navigateTree(targetId, { summarize, customInstructions })`
- 从新的叶路径重建可见聊天
- 选择 user/custom 消息时可预填充编辑器文本

主要实现：

- `src/slash-commands/builtin-registry.ts`（`/tree`、`/branch` 命令路由）
- `src/modes/controllers/input-controller.ts`（按键绑定、双击 Esc 行为）
- `src/modes/controllers/selector-controller.ts`（树 UI 启动 + 摘要提示流程）
- `src/modes/components/tree-selector.ts`（导航、筛选、搜索、标签、渲染）
- `src/session/agent-session.ts`（`navigateTree` 叶切换 + 可选摘要）
- `src/session/session-manager.ts`（`getTree`、`branch`、`branchWithSummary`、`resetLeaf`、标签持久化）

## 如何打开

以下任一方式打开同一个选择器：

- `/tree`
- 为 `app.session.tree` action 配置的按键绑定
- 空编辑器双击 Esc，且 `doubleEscapeAction = "tree"`（默认）
- `/branch` 且 `doubleEscapeAction = "tree"` 时（路由到树选择器而非仅用户的 branch picker）

## 树 UI 模型

树由会话条目的父指针（`id` / `parentId`）渲染。

- 子项按时间戳升序排列（旧的在前，新的在下）
- 活跃分支（从根到当前叶的路径）用圆点标记
- 标签（如有）在节点文本前渲染为 `[label]`
- 若存在多个根（孤立/断链），它们会显示在一个虚拟分支根下

```text
Example tree view (active path marked with •):

├─ user: "Start task"
│  └─ assistant: "Plan"
│     ├─ • user: "Try approach A"
│     │  └─ • assistant: "A result"
│     │     └─ • [milestone] user: "Continue A"
│     └─ user: "Try approach B"
│        └─ assistant: "B result"
```

选择器以当前选中项为中心，最多显示：

- `max(5, floor(terminalHeight / 2))` 行

## 树选择器中的按键绑定

- `Up` / `Down`：移动选中项（循环）
- `Left` / `Right`：上翻页 / 下翻页
- `Enter`：选中节点
- `Esc`：有搜索时清空搜索；否则关闭选择器
- `Ctrl+C`：关闭选择器
- `Type`：追加到搜索查询
- `Backspace`：删除搜索字符
- `Shift+L`：编辑/清除选中条目的标签
- `Ctrl+O`：向前循环筛选模式
- `Shift+Ctrl+O`：向后循环筛选模式
- `Alt+D/T/U/L/A`：直接跳转到特定筛选模式

## 筛选与搜索语义

筛选模式（`TreeList`）：

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

### `default`

显示对话节点以及任何未明确抑制的条目类型。它会隐藏这些设置/记账类条目：

- `label`
- `custom`
- `model_change`
- `thinking_level_change`

当前代码中，其他未特殊渲染的内部条目类型可能显示为空行。

### `no-tools`

同 `default`，额外隐藏 `toolResult` 消息。

### `user-only`

仅 role 为 `user` 的 `message` 条目。

### `labeled-only`

仅当前解析到标签的条目。

### `all`

会话树中的所有内容，包括记账/自定义条目。

### 仅工具调用的助手节点行为

仅包含**工具调用**（无文本）的助手消息，在所有筛选视图中默认隐藏，除非：

- 消息是 error/aborted（`stopReason` 不是 `stop`/`toolUse`），或
- 它是当前叶（始终保持可见）

### 搜索行为

- 查询按空格分词
- 匹配是模糊的（子序列）且不区分大小写（`fuzzyMatch`）
- 所有 token 都必须匹配（AND 语义）
- 可搜索文本包括标签、角色和类型特定内容（消息文本、分支摘要文本、自定义类型、工具命令片段等）

## 选中结果（重要）

`navigateTree` 根据选中条目类型计算新叶行为：

### 选中 `user` 消息

- 新叶变为选中条目的 `parentId`
- 如果父节点是 `null`（根用户消息），叶重置为根（`resetLeaf()`）
- 选中消息文本复制到编辑器以便编辑/重新提交

### 选中 `custom_message`

- 叶规则同 user 消息（`parentId`）
- 提取文本内容并复制到编辑器

### 选中非用户节点（assistant/tool/summary/compaction/custom bookkeeping 等）

- 新叶变为选中节点 id
- 编辑器不预填充

### 选中当前叶

- 无操作；选择器关闭并返回“Already at this point”

```text
Selection decision (simplified):

selected node
   │
   ├─ is current leaf? ── yes ──> close selector (no-op)
   │
   ├─ is user/custom_message? ── yes ──> leaf := parentId (or resetLeaf for root)
   │                                     + prefill editor text
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

## 切换时摘要流程

摘要提示由 `branchSummary.enabled` 控制（默认：`false`）。

启用后，选中节点后 UI 询问：

- `No summary`
- `Summarize`
- `Summarize with custom prompt`

流程细节：

- 摘要提示中的 Esc 重新打开树选择器
- 自定义提示取消返回到摘要选择循环
- 摘要期间，UI 显示 loader 并将 `Esc` 绑定到 `abortBranchSummary()`
- 如果摘要被中止，树选择器重新打开且不应用移动

`navigateTree` 内部：

- 从旧叶到公共祖先收集已放弃分支的条目
- 发出 `session_before_tree`（扩展可以取消或注入摘要）
- 仅在请求且需要时使用默认摘要器
- 使用以下方式应用移动：
  - `branchWithSummary(...)` 当存在摘要时
  - `branch(newLeafId)` 用于无摘要的非根移动
  - `resetLeaf()` 用于无摘要的根移动
- 用重建的会话上下文替换 agent 对话
- 发出 `session_tree`

注意：如果用户请求摘要但无可摘要内容，导航继续而不创建摘要条目。

## 标签

树 UI 中的标签编辑调用 `appendLabelChange(targetId, label)`。

- 非空标签设置/更新解析后的标签
- 空标签清除它
- 标签作为仅追加的 `label` 条目存储
- 树节点显示解析后的标签状态，而非原始标签条目历史

## `/tree` 与相邻操作

| 操作 | 范围 | 结果 |
|---|---|---|
| `/tree` | 当前会话文件 | 将叶移动到选中位置（同一文件） |
| `/branch` | 通常是当前会话文件 -> 新会话文件 | 默认从选中的**用户**消息分支到新会话文件；如果 `doubleEscapeAction = "tree"`，`/branch` 打开树导航 UI |
| `/fork` | 整个当前会话 | 将会话复制到新的持久化会话文件 |
| `/resume` | 会话列表 | 切换到另一个会话文件 |

关键区别：`/tree` 是单个会话文件内的导航/重定位工具。`/branch`、`/fork` 和 `/resume` 都会改变会话文件上下文。

## 操作者工作流

### 从更早的用户提示重新运行，且不丢失当前分支

1. `/tree`
2. 搜索/选中更早的用户消息
3. 选择 `No summary`（或根据需要摘要）
4. 在编辑器中编辑预填充的文本
5. 提交

效果：新分支在同一会话文件内从选中点开始增长。

### 带上下文面包屑离开当前分支

1. 启用 `branchSummary.enabled`
2. `/tree` 并选中目标节点
3. 选择 `Summarize`（或自定义提示）

效果：`branch_summary` 条目在继续之前被附加到目标位置。

### 调查隐藏的记账条目

1. `/tree`
2. 按 `Alt+A`（all）
3. 搜索 `model`、`thinking`、`custom` 或 labels

效果：检查完整的内部时间线，而不仅是对话节点。

### 为后续跳转添加书签

1. `/tree`
2. 移动到条目
3. 按 `Shift+L` 并设置标签
4. 之后使用 `Alt+L`（`labeled-only`）快速跳转

效果：在持久分支里程碑之间快速导航。
