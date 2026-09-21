# 客户端（GUI）差距计划：对照 openchamber 的 UI/UX + 对照 musepi TUI 的功能

> **工作文档，不是长期规格**：逐项落地/关闭后整体删除，不要翻译 `.zh-CN.md`（临时文档不配对，见 `docs/i18n/README.md`）。
> 来源：两轮只读审计（openchamber `C:\Users\unive\projects\harness-engineering\openchamber` ↔ `packages/desktop-app`/`packages/client-core`；musepi TUI `packages/coding-agent/src/modes` ↔ 同）。**标 ✅ 的结论我已亲自 grep/sed 复核**，其余为审计结论（附锚点，落地前请顺手核对）。
> 日期：2026-09-15。

## 0. 结论摘要（先做什么）

用户问的两条线，一句话答案：

- **审批卡：不是"TUI 有而客户端没有"** —— TUI 自己的工具审批**也只有 Approve / Deny**（`extensibility/extensions/wrapper.ts:332`）。客户端真正缺的是**另外三样**：①**范围**（一次 / 本会话 / 永久）②**批准前看到 diff / 新文件全文** ③**备注与"先改再审"**。而且缺口在**协议层**：`tool.approve` / `tool.deny` 只收布尔（`daemon/server.ts:9097-9111`），推送载荷里 `args` 是**硬编码 `null`**（`server.ts:1430`、`:1588`）——所以不先补协议，前端做不了 diff 预览。
- **顺手抓到两个真 bug**（P0，与本次规划无关但应立即修）：✅托盘「始终允许」是假按钮；✅归档状态在桌面端与 guest 端用了两套 key。

建议第一批（详见 §4）：**P0-1 托盘假按钮 → P0-2 归档单点化 → P0-4 worktree 禁用桩 → P0-5 新建文件断头 → P1-1 审批卡（先 daemon 补 args，再前端三态+预览）**。
（原列的"P0-3 分支切换"经复核**不成立**：能力已存在，见 §1 P0-3。）

---

## 1. P0：已核验的真实缺陷（不是规划，是 bug）

### P0-1 ✅ 托盘「始终允许」是假按钮

- ✅ 发送端：`packages/desktop-app/src/tray-menu-main.tsx:214` 发 `remember: true`
- ✅ 接收端：`packages/desktop-app/electron/main.cjs` 的 `case "respond-approval"`（≈`:1013-1021`）只读 `action.approved` / `action.id` / `action.sessionId`，**`remember` 从未被读取** → 行为等同「允许一次」。`electron/tray.cjs:229-251` 的「始终允许」同样只是标签。
- 修法（二选一，需产品定夺）：
  - **A（推荐）**：让 `remember` 真正生效 —— 经 `settings.set` 写 `tools.approval[tool] = "allow"`（schema 在 `config/settings-schema.ts:4092-4102`，`settings.set` handler 在 `daemon/server.ts:8453-8512`，注意 `:8475-8481` 要求键在 schema 内且 `hasUi`）。
  - **B（若暂不做持久化）**：把按钮改名为「允许一次」，删掉 `remember`，别留假承诺。

### P0-2 ✅ 归档状态分裂两套 key，且无人统一管理

- ✅ 桌面端一律 `musepi-gui-archived`：`GuiHeader.tsx:512/520`、`SessionSidebar.tsx:218/316/376/469/478`、`ScheduledTasksPage.tsx:300/310/311`
- ✅ guest 端用**另一个** key：`guest-client/src/components/shell/WorkspaceView.tsx:41` → `musepi-collab-archived`
- 后果：① 桌面 GUI 与 guest/mobile 看到**两份互不相干**的归档；② 清站点数据 = 全部会话被"取消归档"；③ daemon 无归档概念 → TUI 与 GUI 也无法一致。
- 另有**两个事件名**并存：`musepi-gui-sessions-archived`（`GuiHeader.tsx:524`）与 `musepi-gui-archived-changed`（`ScheduledTasksPage.tsx:311`，`SessionSidebar.tsx:478` 监听）。
- 修法：收拢到单点模块（如 `lib/session-store.ts`），统一 key + 统一事件 + **旧 key 迁移**（先读旧后写新，别直接丢用户数据）。归档若要跨端/跨机一致，需上升为 daemon 侧会话状态（`session.*`），这是更大的一项，可后置。

### P0-3 ⚠️ 已证伪：分支切换**并非缺失**（审计结论错误，已纠正）

- 审计曾称"daemon 有 `git.branches` / `git.checkout` 但 GUI 零调用 → 用户无法切分支"。**复核实为错误**：两处早就在用 ——
  - `desktop-app/src/components/StatusCards.tsx:248`（`git.branches`）+ `:261`（`git.checkout`，含 `create` 新建分支）
  - `desktop-app/src/components/WelcomeComposer.tsx:386` + `:414`（新建会话时的分支选择）
  - daemon 侧 handler：`git.branches`（`server.ts:5330`，返回 `{current, branches}`，仅本地分支）、`git.checkout`（`server.ts:5362`，参数 `{cwd?, branch, create?}`）
- **真正的差距只是"选择器不如 openchamber 丰富"**（属增强，不是 bug）：缺远程分支、ahead/behind、搜索、最近使用分支、脏工作区切换确认、以及 stash/冲突/同步相关对话框（openchamber 参照：`views/git/BranchSelector.tsx`、`DirtyBranchSwitchDialog.tsx`、`SyncActions.tsx`）。
- 结论：**降级为 P2 增强项**，不列为 P0。教训：审计结论里凡"某能力完全缺失"的判断，落地前必须用 `grep '"method.name"'` 在 GUI 包里复核。

### P0-4 ✅ 已落地：worktree 通过 daemon RPC 实现（原计划是"移除禁用桩"）

- 原判断（"daemon 只有 CLI、无 RPC → 只能删或大改"）**过于保守**。复核发现两半零件都在：
  - `utils/git.ts` 的 `worktree` API（`add`/`remove`/`list`/`prune`）—— 已扩出 `createBranch` + `startPoint` 以表达 `git worktree add -b <名> <路径> <起点>`；
  - `SessionManager.moveSession`（`agent-session.ts:7268`），且**早已可从任意客户端触达**：`/move` 斜杠命令是 `handle` 支持的，daemon 的 `session.slashCommand` 会跑完整的 cwd 换根（重载设置/插件/通知）。
- 落地：新增 `worktree.create` RPC（`daemon/server.ts` + `utils/session-worktree.ts`），返回 `{path, branch, repoRoot, reused}`；GUI 在会话 ⋯ 菜单点「移至新工作树」→ 输入分支名 → 建树 → `/move <路径>` → toast。`musepi worktree` CLI 仍只管 `list`/`clear`，两者不冲突。
- 测试：`test/daemon/worktree-create.test.ts` 4 例（新建/复用/检出已存在分支/非仓库报错）。注意 `git worktree add` 在 Windows 上要数秒，需显式 30s 超时。

### P0-5 ✅ 已落地：新建文件后有明确出口（能力早就有，缺的是可发现性）

- 原判断（"建完只能去外部编辑器，流程是断的"）**部分不成立**：`FilePane.tsx` 的行右键菜单**早就有** `t("open with app")` → `window.electronAPI.openWith("", path)`（`:646-650`），能力齐全。
- 真实缺口 = **用户不知道**：新建的空文件既不提示也无法直接打开。落地方式取零成本方案：建文件成功后经既有 `musepi-gui-toast` 通道提示 `"<文件> — GUI 无内置编辑器：用该行右键菜单的「在应用中打开」编辑"`（新增一个 i18n key），不新增样式、不新增状态。

---

## 2. 功能：对照 musepi TUI

### 2.1 审批卡（用户点名项）——真相与差距

**真相**：不要按"TUI 更丰富"来定目标。三处的事实：

| 表面 | 实际能力 | 锚点 |
|---|---|---|
| TUI 工具审批 | **仅 Approve / Deny**，无 note、无"总是允许"、无编辑 | `extensibility/extensions/wrapper.ts:332`（`select(prompt, ["Approve","Deny"])`）、prompt 构造 `tools/approval.ts:258-278` |
| TUI 的 ACP 权限门 | **4 态**：Allow once / Always allow / Reject / Always reject（但由**外部 ACP 客户端**渲染，不是 musepi 自己的界面） | `session/acp-permission-gate.ts:16-21`；`session/client-bridge.ts:34`；决策缓存仅**每会话内存** `session/session-tools.ts:242` |
| TUI 计划审批 | Approve and execute / Approve and compact / Refine plan + **外部编辑器/批注/反馈** | `modes/interactive-mode.ts:3998-4011`；`modes/components/plan-review-overlay.ts:129-153` |
| openchamber PermissionCard | **3 态** `once / always / reject` + 快捷键 + **diff / 写文件全文预览**（语法高亮）+ JSON 树 + 同权限模式合并 + 多卡排队（最新一张持键盘） | `chat/PermissionCard.tsx:50,143-145`；`chat/DiffPreview.tsx:35,99`；`permissionCardPatterns.ts` |

**客户端实际缺的 6 项**（按价值）：

1. **范围**：无法"本会话/永久允许该工具"。daemon 路径**完全没有**该语义（TUI 的 always 只存在于 ACP 与内存 Map）。
2. **批准前看到将写入的内容**：openchamber 有 diff/write 预览；musepi 只能看 `prompt` 里的文本明细（`ApprovalCard.tsx:36-52` 把 prompt 去掉首行塞进 `<pre>`）。
3. **结构化参数**：✅ 推送载荷 `args` **恒为 `null`**（`daemon/server.ts:1430`、`:1588`；类型 `guest-client/src/lib/client.ts:53-58` 声明了 `args` 但永远是空）。→ 想在前端画 diff，**必须先让 daemon 带上 args**（`approval-bridge.ts:10-14` 注释解释了为什么现在只有渲染后的 prompt）。
4. **备注 / 反馈**：审批 RPC 无 note 字段（TUI 的 ask 有 `✎ note`：`modes/components/ask-dialog.ts:319`；计划审批有 feedback）。
5. **先改再审**：无法编辑命令/参数再批准（wrapper 内部支持按修订后的 `effectiveParams` 审批 `wrapper.ts:230-245`，但没暴露给客户端）。
6. **四个表面不一致 + 一处按钮顺序反**：桌面卡（Approve/Deny，`ApprovalCard.tsx:64/75`）、托盘（3 按钮但 remember 失效）、桌宠（布尔，`bubble-main.tsx:492`）、guest（**Deny 在前**，`guest-client/src/components/shell/ApprovalCard.tsx:27/34`）——四套独立实现，能力互相漂移。

**协议根因（必须一起改）**：`tool.approve` / `tool.deny` 只收 `{ sessionId, requestId }` 并回布尔（`daemon/server.ts:9097-9111`；`daemon/approval-bridge.ts:23-28,49-62,78-119`）。scope / note / 修订参数**无处可放**。

**建议落地顺序**：① daemon 在载荷里带 `args`（+ 可选 `toolCallId`）→ ② 前端画 diff/write 预览（复用 guest-client 既有 `DiffBlock`）→ ③ 扩协议加 `scope` 与 `note` → ④ 统一四个表面（抽共享卡组件）→ ⑤ 托盘 `remember` 接上（= P0-1）。

### 2.2 slash 命令净缺口（TUI 有、GUI 完全无对应）

分发契约：命令可带 `handle`（headless/GUI 可跑）与 `handleTui`（TUI 专属）；daemon `session.slashCommand`(`server.ts:6824`) 只跑 `handle`，命中无 `handle` 的返回 `{consumed:false, reason:"tui-only"}`（`server.ts:6884-6891`）。

净缺口 7 项，逐个判定：

| 命令 | 值不值得补 | 说明 |
|---|---|---|
| `/copy` **选择器** | **值得（S）** | TUI 有 `showCopySelector` + `extractLastCodeBlock`（`slash-commands/collab`:764 起 / `modes/components/copy-selector.ts`）；GUI 只有浏览器原生复制，无法挑"最后那个代码块"。 |
| `/handoff` | 值得（M） | 交接/摘要式移交，GUI 无对应（`slash-commands/lifecycle:246`）。需先看它产出什么。 |
| `/loop` | 待定 | TUI 专属循环运行模式（`modes` :351），概念上接近 cron/闲时任务；可考虑映射到任务中心而不是新做一套。 |
| `/vibe` | 待定（L） | 整体运行模式 + 独立 runtime（`vibe/runtime.ts`），不是一个小面板。 |
| `/tan` | 待定 | 后台 tan 任务（`controllers/tan-command-controller.ts`），要看与现有 `job`/后台作业的关系。 |
| `/omfg` | 低 | `omfg-panel.ts` 彩蛋/情绪化面板，价值低。 |
| `/hotkeys` | 低 | GUI 已有 CommandPalette / 快捷键；仅"帮助页"缺失（可并入帮助对话框）。 |

**反向提醒**：GUI 已**本地拦截**若干 TUI-only 命令为原生面板（`/usage`/`/debug`/`/context`/`/btw`/`/autoresearch`，见 `Composer.tsx:1034-1138`），这套做法是对的，新补命令请沿用（不要指望 daemon 直接跑）。

### 2.3 其他 TUI 能力接缝

- **`/tree` 节点标签**：TUI `Shift+L` 打标（`modes/components/tree-selector.ts`）在 GUI 无 RPC 支撑 → 需要 daemon 补端点。
- **会话内消息级 `parentId` 未实时发射**：`TrajectoryView.tsx:350` 已按 `buildMessageTree(entries)` 前向兼容，但 daemon 尚未在 `session.history`/事件流里带出该字段（注意：`session.tree`(3963) 是**跨会话**树，两回事，别混淆）。
- 已确认**无重复标签 bug**：`composer/plan-panel.tsx:113-145` 三个审批动作标签互不相同（`approve`/`keep`/`compact`），与 TUI 平价；textarea 可编辑而 TUI 是 section 内联编辑，属**刻意降级**（文件头 `:15-22` 已说明）。

---

## 3. UI/UX：对照 openchamber 的 Top 12

> 先排除**已对齐**的（代码里已有 parity 注释）：Prompt 导航轨 `TurnRail.tsx:17`、待发队列 `composer/queue-panel.tsx:20`、浏览器视口预设 `lib/browser-viewport.ts:1`、选中文本工具条 `SelectionToolbar.tsx:131`、Git changes 树 `git-panel.tsx:326`、右栏 surface 注册表 `lib/surfaces/registry.ts:1`、语音 `lib/voice.ts:1`、上下文环 `ContextRing.tsx:1`。

| # | 差距 | openchamber 锚点 | musepi 现状 | 规模 |
|---|---|---|---|---|
| 1 | **行级内联评审评论**（diff 选区 / 文件预览 / 浏览器标注 / 聊天文本 四入口共用一个 store，草稿以 chip 挂 composer） | `components/comments/useInlineCommentController.ts:56`、`InlineCommentCard.tsx:25`、`stores/useInlineCommentDraftStore.ts`；汇入 `chat/composer/submit/buildOutgoingMessage.ts:17` | **absent**（最接近的是 `SelectionToolbar.tsx:131` 的整段引用，无行区间锚定、无评论卡） | L |
| 2 | **GUI 里没有代码编辑器**（文件面板只读） | `views/FilesView.tsx`（4485 行）：CodeMirror + 1.5s 防抖自动保存 + 外部改动侦测 + 多文件 tab + 跳到行 + 预览内查找 | `FilePane.tsx:308` 只有预览；唯一写操作是建空文件 `:600`；两包都无 codemirror/monaco 依赖 | L |
| 3 | **Diff 视图**：并排/统一、查找、虚拟化、行锚点、分支范围、大 diff 降级 | `views/DiffView.tsx`（2236 行）、`views/PierreDiffViewer.tsx`、`chat/message/DiffViewToggle.tsx`、`views/branchDiffScope.ts` | `git-panel.tsx:484` 把 `git.diff` 原始文本塞进 `<div>`，无虚拟化/并排/查找 | M–L |
| 4 | **Worktree 工作流** | `session/NewWorktreeDialog.tsx`、`views/WorktreesView.tsx` | `GuiHeader.tsx:865` 是 disabled 桩（见 P0-4） | L |
| 5 | **分支 / stash / 冲突 / 同步 UI**（更丰富的选择器） | `views/git/BranchSelector.tsx`、`StashesDialog.tsx`、`ConflictDialog.tsx`、`SyncActions.tsx` | 分支切换**已有**两处（`StatusCards.tsx:248/261`、`WelcomeComposer.tsx:386/414`）；缺远程分支 / ahead-behind / 搜索 / 最近分支 / 脏工作区确认 / stash 与冲突对话框 | M/项 |
| 6 | **审批卡展示将写入的内容**（diff/写文件预览 + 三态） | `chat/PermissionCard.tsx:50`、`chat/DiffPreview.tsx:35` | `ApprovalCard.tsx:36-90` 纯文本 + 两键（见 §2.1） | M |
| 7 | **工作状态面板**：分区可配置 + 面板内 MCP 开关 + pin 消息 + 遥测（吞吐/时长/令牌） | `chat/work-status/WorkStatusPanel.tsx:69`、`work-status/sections.ts:13-23`、`WorkStatusMcpSection.tsx`、`WorkStatusPinnedSection.tsx`、`WorkStatusTelemetrySection.tsx` | `StatusCards.tsx:110`（git/todo/subagent 已可比）+ `ContextRing.tsx`；无分区配置/无 MCP 开关/无 pin/无遥测 | M |
| 8 | **工具输出全屏对话框**（虚拟化 + JSON 树 + mermaid pan/zoom + split/unified diff） | `chat/message/ToolOutputDialog.tsx`（1220 行）、`ui/JsonTreeView.tsx` | 只有卡片内联展开；两包无 JsonTree | M–L |
| 9 | **Walkthrough**（把整条分支 diff 讲成分阶段叙事，带目录/进度/逐 hunk） | `views/walkthrough/*` | absent | L（需 daemon 产出阶段） |
| 10 | **Multi-run**（同一 prompt 跨 N 模型并行 + 结果融合） | `multirun/MultiRunLauncher.tsx:85`、`MultiRunFusionDialog.tsx:68` | absent（最接近的是顺序队列） | L（需会话编排） |
| 11 | **浏览器标注层 + 设备栏 + dev server 发现** | `browser/useAnnotationAttach.ts:19`、`BrowserDeviceBar.tsx:26`、`BrowserEmptyState.tsx` | `ManagedBrowserPane.tsx:200` 已较强（多标签/pick element `:671`/viewport fit `:694`），但**无标注覆层、无设备预设栏、无 dev server 发现** | M |
| 12 | **多会话标签条**（同窗口并列，可拖拽/未读/右键） | `layout/SessionTabsStrip.tsx`、`stores/useSessionTabsStore` | absent | M–L |
| 次 | 归档浏览页、计划文件可编辑、命令面板「文件」tab、用户 snippets、magic prompt 模板编辑、右栏 surface 显隐对话框、Git 身份编辑器、目录浏览对话框、帮助/关于对话框 | `views/ArchiveView.tsx:22`、`views/PlanView.tsx`、`ui/CommandPalette.tsx`、`sections/snippets/*`、`sections/magic-prompts/*`、`layout/ContextRailSurfacesDialog.tsx:22`、`sections/git-identities/GitIdentityEditorDialog.tsx`、`session/DirectoryExplorerDialog.tsx`、`ui/HelpDialog.tsx` | 见 `components/CommandPalette.tsx:26-30`、`composer/plan-panel.tsx:21-25` 的自述注释；右栏已有排序+宽度但**无显隐配置**（上轮用户跳过了该项） | S–M |

**明确不要照抄**（一句话理由）：VS Code 扩展宿主布局（架构不通）；auth/SessionAuthGate（面向 opencode server 的 Cookie 鉴权）；`packages/mobile/*` 与 Capacitor 插件（musepi 有自有 mobile）；Linear 集成（musepi 走 `gh`）；GitHub 设备码 OAuth（musepi 委托 `gh` 凭据模型）；`ui/*` 原语与 ThemeProvider（Tailwind/Base-UI 会分叉视觉语言，且绕过 `AGENTS.md` 钉死的 `DialogFrame`/`MenuPopup` 键盘语义）；shiki Worker 高亮（musepi 用 tree-sitter natives）；multirun 的**实现**（依赖其 store/opencode 形状，只抄交互）；opencode 二进制更新链路；`MemoryDebugPanel`（绑其 memory store 形状）；多 runtime 切换器与各家窗口装饰；drawio 图编辑器（新引入能力，进 backlog 别混本轮）。

---

## 4. 建议批次

**第一批（本周，收益/风险比最好）**

1. **P0-1 托盘假按钮** —— 先是 bug 修复，产品定夺 A/B（建议 A：接 `settings.set` → `tools.approval`）。
2. **P0-2 归档单点化** —— 一个模块 + key 迁移 + 统一事件名。纯重构，无 UI 变化，但要写迁移测试。
3. ~~**P0-3 分支切换**~~ → **已证伪，移出本批**（能力已存在）。改为 P2 增强：给现有选择器补远程分支/ahead-behind/搜索/脏工作区确认（参照 openchamber `BranchSelector.tsx`，用 musepi 自己的 `DialogFrame`/`MenuPopup`）。
4. **P1-1 审批卡第一步（daemon 带 `args`）** —— 只改 daemon 载荷 + 类型，不动 UI；为第 6 项铺路，可独立验证（同 §2.1 顺序 ①）。

**第二批**

5. **P1-1 续：审批卡三态 + diff/write 预览 + note**，并抽共享卡统一四个表面（含 guest 按钮顺序）。
6. **§3-11 浏览器标注 + 设备栏**（在既有 `ManagedBrowserPane.tsx` 上扩展）。
7. **§3-7 工作状态面板分区/MCP 开关/pin/遥测**（在 `StatusCards.tsx` 上扩展）。
8. **§3-6 → 依赖第 5 项**。

**第三批（大，需单独立项）**

9. §3-2 文件编辑器（是 §3-1/§3-3/§3-8 的前置，最大单体投入）。
10. §3-1 + §3-3 内联评论 + 真 diff 视图（互相依赖）。
11. §3-4 worktree、§3-9 walkthrough、§3-10 multirun、§3-12 会话标签条 —— 都需要 daemon/session 编排侧配合，先出设计再排期。

---

## 5. 纪律（照旧）

- 门禁：项目自带 biome 二进制（`node node_modules/@biomejs/biome/bin/biome check --write <files>`）、`bun run check:ts` 全 workspace exit 0、对应包测试。基线：`packages/desktop-app` 201 pass/0 fail；`packages/coding-agent` 有 **48 个 pre-existing 失败**（TTSR/transcript），与 GUI 无关，别去"修"。
- GUI 硬规则（`AGENTS.md`）：模态必须独占键盘（`DialogFrame` 捕获 Escape / 移动焦点 / 恢复焦点）、`DialogFrame` 常挂载由 `open` 驱动（条件挂载会杀掉退场动画）、小内容对话框用 `gui-dialog--confirm` 紧凑样式、所有 hook 必须在任何 early return 之前、模型身份恒为 `provider/id`。
- i18n：按域拆 `packages/client-core/src/i18n/{zh-CN,en-US}/<域>.ts`，en 必须 `as const satisfies Record<ZhKey, string>`。
- 本文档落地/关闭后**整体删除**（不要翻译、不要长期挂着）。

---

## 10. DSH 官方桌面端对照（2026-09-15，参考库已更新）

来源：官方首个桌面端已随 dsh v0.1.5/0.1.6 alpha 落地（本地旧检出 cd5ef81481=0.1.2 还没有 `apps/desktop`，拉取后为 0d1f50007f）。读了一手文档三份：`apps/desktop/README.zh.md`、`.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md`、`2026-09-09-desktop-immediate-window-and-direct-start.zh.md`。

**先纠正定位**：官方桌面端是**包裹 dsh Web UI 的 Electron 壳**——它不做自己的渲染层（产品 UI 来自已安装的 dsh 包），设计重心是打包、运行时隔离、发布身份与安全，**不是面板/组件 UX**。因此能吸收的主要是**壳层工程与安全实践**；musepi 的 UI/UX 对照仍以 openchamber（§3）为准。

### 可吸收（按价值排序）

| # | 官方做法 | musepi 现状 | 落地建议 | 规模 |
|---|---|---|---|---|
| D1 ✅已落地(eef22103d) | **加载页不依赖后端**：窗口先开，本地加载页只用壳资源，收 starting/ready/error 三态；失败页同窗口给诊断 + 重启/重装/禁用插件/重置；就绪后**同窗口**换产品 UI；启动中关窗会取消启动 | splash（`app.tsx` booting 分支）等 daemon，慢/失联时无限停留——正是 splash 冻结类问题的温床 | boot 加**超时与恢复态**：N 秒未就绪 → 展示诊断（daemon 日志尾部/重试/打开诊断面板），不再无限 splash；`render-process-gone` 重载时退回 boot 页 | M |
| D2 | **不做 staging 健康检查**：直接启动真实 Host，失败给真实诊断（官方明确否决"双后端探针"：两次插件初始化且不保证真实进程能起） | — | 作为 D1 的设计纪律：不引入预启动探针 | 0 |
| D3 ✅已落地(eef22103d) | **dev 数据隔离**：`dev:desktop` 的 Harness home / 一次性项目 / Electron userData 全在 `.desktop-build/development/` 下，与用户数据零交集；调试端口 env 可覆盖（Main 9229 / Renderer 9222 / Host 9230） | dev 复用真实 userData/daemon——"GUI 复用已在运行的 daemon"造成的测试污染本周踩了两次 | `dev-desktop.mjs` 默认注入独立 `PI_CONFIG_DIR` + 独立 userData（env 可逃逸）；调试端口参数化 | M |
| D4 | **插件/包事务安全**：改 profile 前**停 Host**；生命周期脚本必须进 `allowBuilds` 白名单否则安装失败；精确版本 + lockfile 完整性 + 仅用户目录权限；失败保留现场供显式修复、**不自动回滚** | `marketplace.install` / `daemon.plugins.*` 直接对运行中 daemon 安装；无 allowBuilds 类白名单（第三方 postinstall 可执行任意代码） | 安装前停/挂起 daemon 或隔离事务；加 allowBuilds 白名单（需安全评审）；先做"安装需确认 + 展示将运行的 lifecycle 脚本" | M–L |
| D5 | **渲染进程沙箱收敛**：`nodeIntegration:false / contextIsolation:true / sandbox:true`；preload 只暴露类型化 RPC/生命周期/更新/locale/插件操作，**不暴露** ipcRenderer、文件系统、shell、pnpm 参数 | preload 暴露 `openPath`/`openWith`/haptic 等（较宽），未系统审计 | preload 暴露面逐项审计并文档化到 `gui-implementation.md`；评估 `sandbox:true` 可行性 | M |
| D6 | **单实例锁 = profile 权威 owner**：后启动只聚焦窗口，绝不碰 profile 状态 | 已有 `requestSingleInstanceLock`（本批修的 dev-desktop 陈旧实例陷阱正是这层） | 已对齐；补：锁被拒时**显式告知**"已有实例在运行"，而非静默退出 | S |
| D7 | **更新差分 + 显式确认**：壳+运行时=一个签名发布单元；NSIS/macZIP blockmap 差分下载；更新前确认弹窗 | 已用 electron-updater（UpdateToast） | 核对 blockmap 差分是否生效；与"会话运行中"的互斥处理 | S |

### 不吸收（架构不同，一句话理由）

- **包裹 Web UI 的薄壳架构**：musepi 自己拥有 React SPA + daemon JSON-RPC，这正是与 openchamber 同路的产品差异。
- **无端口传输**（`dsh-app://` + 分帧字节管道）：musepi 的 TUI/远程/guest 共享**需要**端口，采纳会拆掉多客户端架构；可吸收的只有"端口文件 + 单实例锁"纪律（已做）。
- **内置 Node/pnpm + 包物化**：musepi 的 daemon 随应用分发，无插件依赖图安装问题（除非做 D4）。
- **COS 上传链路 / macOS 公证细节**：发布基础设施不同。

### 结论

官方桌面的"设计思路"价值在**壳层纪律**（加载页自治、失败可恢复、沙箱最小暴露面、profile 归属、发布身份绑定），不在 UI。建议先做 D1 + D3（直接对应本周踩过的 splash 卡死与测试污染），D4 进安全 backlog。
