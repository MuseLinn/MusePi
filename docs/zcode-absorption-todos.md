# ZCode 改进吸收：设计与实施清单

来源：用户提供的 ZCode 更新日志（2026-09）。每项给出**已核实的**代码锚点、方案、验收与规模；"不适用"项已说明理由，避免重复评估。

> **本文档是工作文档，不是长期规格**：逐项吸收/关闭后应整体删除，不要翻译成 `.zh-CN.md`（临时文档不配对，见 `docs/i18n/README.md` 的门控与 `AGENTS.md` 的双语约定）。若某项转成长期能力，把设计搬进对应的 `docs/gui-design.md` / `docs/gui-implementation.md` 后再从本文移除。

锚点核对时间：2026-09-15（逐条 `grep`/`sed` 实证，非推测）。标记 ⚠️ 的是与原始描述**不符**、已就地纠正的地方。

## 状态总览

> **2026-09-15 审计**：第 1–9 项**均未落地**（代码核对：@ 中文搜索 / 换行输入 / 「+」菜单全无命中；闲时任务仅有 daemon 侧 Idle-run window——`ScheduledTasksPage.tsx:35`，缺聊天内自然语言创建+卡片）。「暂不适用」里的**工作区面板拆分已落地**（见该节）。下表为原始规划。

> **2026-09-22 收尾**：#1（闲时任务）、#2（@ 中文搜索）、#3（问答卡换行输入）、#5（子智能体模型审计——本仓无此下拉，规则已满足）、#8（拖动指示线 `.gui-drop-line`）均已落地关闭；剩余 open：#4、#6、#7、#9。

| # | 项 | 规模 | 前置 | 建议批次 | 状态 |
|---|---|---|---|---|---|
| 1 | 闲时任务（自然语言创建 + 聊天内卡片） | 中 | 无 | 第一批 | ✅ 已落地（2026-09-22 审计确认） |
| 2 | @ 引用支持中文搜索 | 小 | 无 | 第一批 | ✅ 已落地（2026-09-22 审计确认） |
| 3 | 问答卡换行输入（>5 行内滚） | 小 | 无 | 第一批 | ✅ 已落地（2026-09-22） |
| 5 | 子智能体可选模型与供应商一致性 | 小-中 | 无（先审计） | 第一批 | ✅ 审计关闭（2026-09-22，无该 UI，规则在位） |
| 8 | 拖动指示线视觉重量 | 小 | **需确认指哪一处** | 第一批 | ✅ 已落地（roadmap M2.8 `.gui-drop-line`） |
| 9 | 会话分享附件校验 | 小-中 | 无 | 第二批 | open |
| 4 | 输入框「+」菜单扩展 | 中 | 无 | 第二批 | open |
| 7 | 高 DPI / 应用缩放点击坐标 | 中 | 无 | 第三批 | open |
| 6 | Windows 截图链路加固 | 大 | 无 | 第三批（拆 2-3 PR） | open |

---

## 1. 闲时任务：任意会话自然语言创建 + 聊天内直达编辑的卡片

**目标**：任意会话里用自然语言（"每天 22:00 跑一次 XX"）创建闲时任务；聊天中出现一张卡片，可直达任务中心的编辑表单；数据与定时任务页同一份。

**现状（已核实）**

后端能力**基本齐备，可直接复用**：

- 存储与语义：`packages/coding-agent/src/daemon/crons.ts` — `cronStoragePath()` `:77-81`（`~/.musepi/crons.json`）、运行历史 `:99-113`（`crons.runs.json`，上限 100）、`CronSchedule.idleWindow` `:27-34`、`computeNextRun` `:341-347`、`constrainToIdleWindow` `:458-497`（支持跨午夜 22:00–08:00，按任务时区解释）。
- 调度循环：`daemon/server.ts:2735-2738`（构造时 `loadCronTasks()` + 30s 扫描）、`#cronScan` `:2825-2834`、`#cronRun` `:2952-3023`（新建会话跑 prompt，按 `stopReason` 判成败）、广播 `crons.changed` `:3243-3250`。
- RPC：`daemon/server.ts:4865-4950` — `cron.list` / `cron.upsert` / `cron.runs` / `cron.nextRuns` / `cron.delete` / `cron.toggle` / `cron.runNow`。
- GUI 任务中心：`packages/desktop-app/src/components/ScheduledTasksPage.tsx`（`refresh` `:189-199`、30s 轮询 + `crons.changed` `:201-220`、保存 `cron.upsert` `:274-289`、日历/看板/列表三 tab `:348-371`、编辑器 `CronEditor` `:830-1210`、闲时窗口字段 `:1070-1118`）。

**三个缺口**：

1. **agent 侧没有可调用的 cron 工具** —— `tools/builtin-names.ts` 无 cron/schedule 类工具；全仓 `grep` 只命中 `daemon/server.ts` 与 `collab/host.ts`。⇒ 模型自己没有建任务的入口，这是本项的核心工作量。
2. **没有聊天内卡片** —— 有两条现成插槽路径（都不需要改 wire 协议）：
   - **(a) tool-render 注册表（推荐）**：`packages/client-core/src/tool-render/registry.ts:42-97` 按工具名映射渲染器；契约 `tool-render/types.ts:82-102`；**最佳模板** `tool-render/tools/board.tsx:48-81`（卡片内按钮 → `openBoardFromChat(id,title)` `:72`）。
   - **(b) `custom_message`**：`Transcript.tsx:899-907` → `renderCustomMessage` `:613-760`（既有分支 `collab-prompt`/`ttsr`/`advisor`/`async-result`/`retry_failure`/`irc:*`）；daemon 侧 `sessionManager.appendCustomMessageEntry(customType, …)`，示例 `session/async-job-delivery.ts:72`。
3. **`ScheduledTasksPage` 没有"外部指定任务"的 props** —— `:174` / `:222-227` 只有内部 `selectedId` state。

**方案**

1. 新增工具（建议名 `schedule_task`，放 `packages/coding-agent/src/tools/`，薄封装 `cron.upsert`）：入参 `name` / `prompt` / `schedule`（含 `idleWindow`）/ `cwd` / `model` / `thinkingLevel`；返回 `{ taskId, nextRunAt }`。同时加进 `tools/builtin-names.ts` 的 `BUILTIN_TOOL_NAMES`。
2. 卡片：`packages/client-core/src/tool-render/tools/schedule-task.tsx`（显示名称、调度摘要、闲时窗口、下一次运行、"编辑"按钮），在 `registry.ts:42-97` 注册；若要"常驻不折叠"，加进 `components/transcript/ToolCard.tsx:53-55` 的 `isArtifactCard()`（现有 `widget`/`board`）。
3. 跳转：卡片按钮派发 `window` 事件（照抄 `components/transcript/canvas-jump.tsx:44-67` 的 `omp-open-board` 模式）；宿主监听加在 `packages/desktop-app/src/app.tsx:576-585` 旁 → `viewSwapRef.current("scheduled")`；`ScheduledTasksPage` 增 `initialTaskId?: string` props，打开时定位到该任务的编辑器。
4. i18n：卡片文案进 `packages/client-core/src/i18n/{zh-CN,en-US}/<域>.ts`（按域拆分；en 必须 `as const satisfies Record<ZhKey, string>`）。

**验收**

- 任意会话自然语言下达 → 出现卡片；点"编辑" → 任务中心打开该任务编辑器，字段（含闲时窗口）与创建时一致。
- `cron.list` 能查到；daemon 重启后仍在；`cron.nextRuns` 预览与 `idleWindow` 顺延一致。
- 无 daemon 时创建失败要给出可读错误，不能静默。

**坑（项目已记录，务必遵守）**

- `cron.upsert` 新建走**显式字段白名单**：`crons.ts:206-222` `mergeCronTask` —— `model`/`thinkingLevel` 必须带上，否则从聊天建的卡片会丢模型/思考等级（`docs/gui-implementation.md:452`）。
- `rpc.request` 方法名不校验：接 RPC 前核对 `daemon/server.ts:4865-4950` 的 switch（board 视图曾调不存在的 `cron.update` 并 `.catch(() => {})` 静默失败，`docs/gui-implementation.md:471`）。
- 欢迎区已有 `"schedule idle-window tasks from the task center"` 文案（`WelcomeComposer.tsx:76`、`guest-client/.../WelcomeHint.tsx:30`），本项落地后该提示应指向新入口。

---

## 2. @ 引用支持中文搜索

⚠️ **事实纠正**：现状**不是**"按 ASCII 边界切词"。过滤是**纯大小写不敏子串** `includes`，中文 query 本来就能命中中文文件名/路径（`use-completion.ts:194-199`、`WelcomeComposer.tsx:631-636`）。真正挡住的是**触发条件**。

**现状（已核实）**

- 触发：`packages/desktop-app/src/components/composer/use-completion.ts:164-191` ——
  `const line = value.slice(value.lastIndexOf("\n") + 1); if (line.startsWith("@") && line.length >= 1) { setAtQuery(line.length > 1 ? line.slice(1) : ""); … }`
  ⇒ **要求"当前行以 @ 开头"**。`中文@`、`。@`、`见(@` 一律不触发。
- 第二份同款实现（欢迎页）：`WelcomeComposer.tsx:751-759`。
- guest-client **没有** @ mention 逻辑（其 `shell/Composer.tsx` 是纯 textarea），只有 i18n 字符串 —— 所以本项只动 desktop-app 两处。
- 输入源：`Composer.tsx:1884-1898`（`onChange` → `onAtInput`）；键盘导航 `:1262-1283`；菜单渲染 `:1918-1934`。
- 菜单里唯一的 ASCII-only 正则是 `/` 的：`composer/slash-command-tip.tsx:17`（与本项无关）。

**方案**

把"行首判定"换成"caret 前 token 边界判定"：取 caret 之前文本，用带 Unicode 属性的正则匹配行尾的 `@token`，例如

```
/(?:^|[\s\n，。；：、！？（）()\[\]【】《》"'`])@([\p{L}\p{N}_./\\-]*)$/u
```

- `atQuery` 取捕获组，不再 `line.slice(1)`。
- 保留原"行首 @"行为（正则的 `(?:^|…)` 已覆盖）。
- **必须排除** `email@host`：要求 `@` 前是行首/空白/标点，或 `@` 前字符不是字母数字（否则 `foo@bar` 会误触发）。
- 两个调用点抽成**同一个导出的函数**（放 `use-completion.ts` 导出、WelcomeComposer 复用），避免继续漂移。

**验收**：`中文@`、`见@`、`。@`、行首 `@` 均唤起；`@` 后输入中文按子串过滤；`user@example.com` 不唤起；IME 合成中不误触发；Esc 关闭后同一 token 不立刻重开。

**规模**：小（1 个函数 + 2 处调用点）。

---

## 3. 问答卡换行输入（超 5 行内部滚动）

⚠️ **事实纠正**：**审批卡（ApprovalCard）根本没有文本输入框**，只有 approve/deny 两个按钮，RPC 也不带文本参数（`desktop-app/src/components/ApprovalCard.tsx:27,55-76`；提交 `app.tsx:1868-1880` → `tool.approve`/`tool.deny { sessionId, requestId }`；guest 版 `guest-client/src/components/shell/ApprovalCard.tsx:25,32`）。"自定义回答 + 换行"落在 **ask（提问）** 流程上。

**现状（已核实）**

- desktop：`packages/desktop-app/src/components/AskCard.tsx` —— **单行 `<input>` 且 Enter 立即提交**：`:357`（input 模式，`:364-366` Enter 提交）、`:380`（select 的 Other）、`:540`（dialog 的 Other）、`:572`（note，Enter 关闭 `:579-581`）。提交 `app.tsx:1887-1898` → `session.askAnswer { sessionId, requestId, answer }`（`answer: string | AskDialogAnswer | null`，`AskCard.tsx:53`）。
- guest：`guest-client/src/components/shell/Composer.tsx` 的 `AskEditor` **已经是 `<textarea rows=1>`** 自动增高 + Enter 提交（非 shift、含 IME 守卫）：`:87-113`、`:80`、`shouldSubmitOnEnter` `:34-37`。
- 两份是**各自独立实现**（无共享组件）。

**方案**

1. desktop `AskCard` 的 4 处单行 input（`:357`/`:380`/`:540`/`:572`）改为自增高 `<textarea>` + `max-height: 5 行`（约 `calc(5 * 1.5em)`）+ `overflow-y: auto`。
2. 键盘语义与 guest 对齐：Enter 提交、Shift+Enter 换行、`isComposing` 期间不提交（照抄 `shouldSubmitOnEnter` 的 IME 守卫）；note 保持 Enter 关闭（它是短注释，不适合多行阻塞）。
3. RPC 契约不变（`session.askAnswer` 的 `answer` 已支持任意字符串）。

**验收**：≥5 行时内部滚动、卡片不被撑破；Shift+Enter 换行不提交；含换行的答案原样送达 daemon 并能在 transcript 回显；IME 合成时 Enter 不误提交。

**规模**：小。与项目"确认框 Enter 确认"的约定不冲突。

---

## 4. 输入框「+」菜单扩展

**现状（已核实）**

- 组件：`packages/desktop-app/src/components/AttachMenu.tsx`（`add` 图标打开 `:47-57`；挂载 `Composer.tsx:1606-1631`；token 插入 `Composer.tsx:1621-1630` 用 `setRangeText`）。
- **现有 9 项**（按渲染顺序）：add images `:60-70`（隐藏 file input `:200-211`）/ insert command `:71-82` / mention file `:83-94` / insert session `:95-106` / insert ultrathink `:108-120` / insert workflowz `:121-133` / plan mode `:135-156` / goal mode `:157-178` / guided goal mode `:179-199`。分隔线在 `:107`、`:134`。
- 能力盘点（要什么 → 已有/要新）：
  - **附件 = 已有**（`composer/use-attachments.ts`，含粘贴/拖拽 `:81-98`、图片附件）。
  - **goal = 已有**（菜单开关 + `composer/goal-detail-card.tsx` + chip `Composer.tsx:1669-1674` + `session.goal` `:1618`）。
  - **会话入口 = 已有**（insert session + `#` 补全 `use-completion.ts:212-246`，`session.list`/`session.tree`）。
  - **已启用插件 = 要新**（无菜单入口；可复用 `ExtensionStatusCard`（`Composer.tsx:1634`）与 `ExtensionsCenter.tsx` 的数据源）。
  - **当前工作区文件 = 要新**（"mention file"只插 `@` token；真正的文件树在 `components/FilePane.tsx:353` 用 `workspace.tree`）。⚠️ `composer/context-dialog.tsx` 是**上下文占用**面板，不是文件选择器，别误用。

**方案**：新增 2 个菜单项（已启用插件 / 工作区文件），复用既有数据源与弹层组件，**不新造 RPC**（插件走 extensions 数据源，文件走 `workspace.tree`）；插入交互沿用 token 机制（`@` / `#`）。菜单分组在现有两条分隔线基础上再加一段"上下文"。

**验收**：两个新项可用；插件列表与扩展中心一致（含启用态）；插入后 token 与光标位置正确；上/下/Enter/Esc 键盘导航不回归。

**规模**：中（主要成本在弹层选择器 UI）。

---

## 5. 子智能体可选模型与所选供应商不一致

**现状（已核实）**

- task 工具实现：`packages/coding-agent/src/task/agents.ts` —— `model?: string | string[]` `:26`；内置 agent 用**角色引用**：`model: "@task"` `:57`、`model: "@smol"` `:71`。
- 角色别名展开：`packages/coding-agent/src/config/model-resolver.ts` —— 源标识（`@smol`/`pi/slow`/`*`）`:940`、self-alias 防环 `:1012`、`@smol` 展开 `:1071`。
- 工具注册与深度限制：`tools/index.ts:654-656`（`canSpawnAtDepth(task.maxRecursionDepth)`）；工具名在 `tools/builtin-names.ts`。
- 项目既有约束（`AGENTS.md`）：**模型身份恒为 `provider/id`，禁止裸 id** —— 两个 provider 可提供同名模型（`opencode-go` 与 `opencode-zen` 都有 `deepseek-v4-flash`）。

**方案（先审计，后改；不要凭猜改）**

1. 审计任务卡/子智能体模型下拉的**数据源**：是否用了全量 `models.listAvailable` 而没有按"当前所选 provider"过滤，或反之——选了 A 供应商却列出 B 的模型。
2. 审计提交路径：传入的是裸 id 还是 `provider/id`；落到 `model-resolver` 后解析到的模型是否与 UI 展示的是**同一个 provider**（同名 id 跨 provider 是已知陷阱）。
3. 统一策略：下拉只列当前 provider 的目录（跨 provider 需显式标注），提交一律 `provider/id`；角色引用（`@task`/`@smol`）的解析结果在 UI 上要能看到实际落到哪个 `provider/id`。
4. 回归测试：同名模型跨两个 provider 的场景（先例：项目里任务卡、角色模型都出过同类 bug）。

**验收**：选定 provider=A 时，子智能体可选模型全部来自 A；不存在"看着能选、实际解析到别的 provider 同名模型"；角色引用的展示与实际解析一致。

**规模**：小-中（审计为主，修一个过滤/传参即可）。

---

## 6. Windows 截图链路加固

**现状（已核实）**

- 调用链：`tools/browser.ts:205-209` → `tools/browser/tab-worker.ts:1649-1736` `#captureScreenshot()`（`:1667` `preparePageForScreenshot`、`:1698` `page.screenshot`）→ 主进程 `electron/managed-browser.cjs:1440-1489`（`:1459` `wc.capturePage()`；注释 `:1442-1443` 说明 Electron debugger 不响应 `Page.captureScreenshot`，`capturePage()` 才是支持路径）。
- **激活**：`tab-worker.ts:724-739` —— `activate` 时 `page.bringToFront()`（`:730`）；`activate=false` 时改为要求 `document.visibilityState === "visible"`，否则直接抛 `"The attached browser tab is not visible; switch to it before taking a screenshot"`（`:736-737`）。决策点 `tab-supervisor.ts:714` + `shouldPreserveConnectedBrowserFocus`（`browser/attach.ts:121`）。**主进程的 capture 分支自己不 `selectTab`**（`Target.activateTarget` 在 `managed-browser.cjs:1339-1344`）。
- **托盘后失败的真实根因**：`main.cjs:2182-2188`（非 macOS 下 close 被 preventDefault → `mainWindow.hide()`）⇒ guest 无合成表面 ⇒ `capturePage()` 永不 settle ⇒ `managed-browser.cjs:1444-1447` 注释（"cap the wait AND retry once"）+ `:1462` 报 `"Page.captureScreenshot timed out (no composited surface)"`。渲染侧只能覆盖"面板折叠"（`ManagedBrowserHost.tsx:47-48` 保留在屏盒子；`:87-89` 用 opacity 而非 `display:none`，注释直言 `display:none` 会让 agent 失去截图表面），**覆盖不了整个窗口被 hide**。
- 超时/重试：`managed-browser.cjs:57` `CAPTURE_TIMEOUT_MS = 1_500`、`:59` `CAPTURE_RETRY_MS = 220`、`:1455-1473` 最多 2 次（失败 220ms 后重试）；agent 侧 `tab-worker.ts:153` `QUICK_OP_TIMEOUT_MS = 20_000`（`screenshot` 属 quick op，`:1660` 注释称"the 20s screenshot timeouts"）；`browser/launch.ts:31` `BROWSER_PROTOCOL_TIMEOUT_MS = 60_000`。
  ⚠️ **"跨进程恢复 3s 超时"在截图路径上不存在**：全仓唯一的 3000ms 是 daemon SIGTERM 宽限（`electron/daemon.cjs:283`）。这一句需要重新定位（怀疑是 CDP/relay 层或原始日志里的别处），**不要照抄成需求**。
- tab 重建：`managed-browser.cjs:661-682` `createTab`（`waitForGuest()` 失败 → `dispose()` + `handleTabDestroyed()`，返回 null，调用方转 CDP error `:1323-1326`）、`:685-692` `ensureAgentTab`、`:694-698` `ensureTab`、`:1315-1332` `Target.createTarget`、`:584-608` `setOwner`/`releaseTabs`（窗口 closed / 主框架导航时清记录）、`:705-728` `handleGuestReady` 收养/重建。
- agent 侧恢复：`tab-worker.ts:865-913` `#init()`（attach 分支 `#findAttachedTarget` `:915-922`，找不到抛 `"Target … is no longer available"`）、`:893` `if (payload.recover) await this.#recoverAttachedTarget(target)`（`:950-965`，`Page.handleJavaScriptDialog`/`Page.stopLoading`/`Fetch.disable`，全 best-effort）、supervisor 重试 `tab-supervisor.ts:290`。

**方案（按子问题拆，逐条独立可验证）**

1. **托盘后截图失败**：capture 前若主窗口不可见，走"临时可见"路径 —— `showInactive()`（不抢焦点、不闪到用户面前）→ capture → 恢复原可见性；失败兜底仍保留现有错误文案。**不要**改成"总是显示窗口"。
2. **准备阶段短暂重试**：把 `preparePageForScreenshot` 的 `visibilityState` 检查从"立刻抛"改为 1-2 次短重试（与 `:1455-1473` 的 220ms 同风格），覆盖"刚切 tab 还没合成"的瞬态。
3. **标签页重建空白页**：`createTab` 的 `waitForGuest()` 失败路径补一次重试；`handleGuestReady` 收养后回填 url（避免重建后 `about:blank` 被当成真实页面）。
4. **残留缩放**：明确 `Emulation.setDeviceMetricsOverride`（`managed-browser.cjs:1580-1585`，`deviceScaleFactor: 0` = 保持当前，**不是**恢复）的生命周期 —— 现只在切 preset / 传空 viewport 时 `clearDeviceMetricsOverride`（`:1587`）；关面板/换会话时应显式 clear。实测梗：`:1571-1578` 注释记录过 1440 宽 host 在 `scale(0.227)` 下把视口压成 327px。
5. **超时语义对齐**：把 `:57/:59`、`tab-worker.ts:153`、`launch.ts:31` 的常量与注释统一说明，并修正"3s"的来源。

**验收**

- 窗口收托盘后 agent 仍能截图（或给出明确、可执行的错误，而不是 20s 后超时）。
- 连续截图不改变页面缩放/视口；折叠-展开面板后截图正确。
- tab 重建后不出现"空白页"截图。

**规模**：大（跨 agent / main / renderer 三层）。**建议拆 2-3 个 PR**，1+2 先做（收益最直接），3/4/5 各自独立。

---

## 7. 应用缩放 + Windows 高 DPI 下点击坐标/截图偏移

**现状（已核实）**

- 原生（`crates/pi-natives/src/desktop/`）：
  - `win32/capture.rs:56-69` 读 `monitor.scale_factor()`（非法 scale 直接报错 `:61-65`）；`:105-147` `lay_out()` 多屏取最大 scale，产出**物理**（`pixel_*`）与**逻辑**两套坐标（`:126-145`）；`:224-264` `capture_desktop()`（多屏合成，必要时 `resize` 到 pixel 尺寸 `:241-250`）；`:266-297` `capture_window()`；`:313-328` `logical_to_physical()`（点击前乘 scale）。
  - `frame.rs:97-152` `map_point()`（"最近一次截图的像素坐标" → 逻辑屏幕坐标；窗口型帧按当前窗口位置重锚 `:137-148`，尺寸变了直接拒绝 `:141-146`；桌面型帧按 region `:134-135,149`）；`frame.rs:187-219` `apply_capture_caps()`（`maxWidth/maxHeight` 缩图后同步 `geometry.scaled()` `:216`）。
  - 注入点击/移动：`win32/input.rs:265-266`（`logical_to_physical` → `SetCursorPos`）、`:334-335`（`SendInput`）、`:646-647`。
  - 已有测试：`frame.rs:265-288`（`pixel_to_logical_at_one_and_two_x`、`cap_scaling_adjusts_geometry`）。
- JS 侧：`tools/computer/worker.ts:366-375` `#screenPoint()`（截图像素点按窗口 bounds 缩放）、`:207-220`（记录"模型看到的那一帧"尺寸）；安全上限 `tools/computer.ts:28-29` `COORDINATE_SAFE_MAX_CAPTURE_WIDTH/HEIGHT = 1280/896`（`:146-150` 生效）。
- 浏览器侧（page space ↔ 屏幕）：`browser/launch.ts:23` `DEFAULT_VIEWPORT = {1365,768,deviceScaleFactor:1.25}`、`:481-492` `applyViewport`；`tab-supervisor.ts:221-223` `page.setViewport(...)`；`browser/cmux/cmux-tab.ts:386,429,1120` 用 `geometry.dpr`。
- 宿主 CSS 缩放（易与页面缩放混淆）：`ManagedBrowserHost.tsx:75` `transform: scale(...)`，来源 `lib/browser-viewport.ts:20-23` `fitViewport()`（`scale = min(1, availWidth/width)`）；全仓源码**没有** `setZoomFactor`/`setZoomLevel`。

**方案**：以 `frame.rs` 的几何为**单一真源**，把两条不变量写成测试锁定：

1. 截图被 `maxWidth/maxHeight` 缩小 ⇒ 坐标必须经 `apply_capture_caps()` 的 `geometry.scaled()`（已有实现 `:216` + 测试）。
2. **应用级缩放不得进入页面层坐标**：`ManagedBrowserHost` 的 CSS `transform: scale` 只做视觉；页面视口靠 `Emulation.setDeviceMetricsOverride` 表达（`managed-browser.cjs:1580-1585`），两者不可叠加计算。
3. 新增高 DPI 集成测试（scale 1.25 / 1.5 / 2.0）：断言"截图中心点 → 点击"落点误差 < 1px；多屏不同 scale 时不串坐标。

**验收**：125%/150%/200% 缩放下点击与截图落点一致；多屏混合 scale 正确；缩放变更后第一帧截图即为新缩放（无滞后一帧）。

**规模**：中（主要是补测试 + 明确不变量，而非重写）。

---

## 8. 降低拖动指示线视觉重量

⚠️ **前置：需先确认指哪一处**。仓库里两类 drop 反馈，**都不是"细线"**：

- 自定义工作区分组（`components/CustomGroups.tsx:226,251,333`）：
  - `.gui-group--dragover`（`styles/gui-settings.css:618`）= 7% accent 底 + `inset 0 0 0 1.5px` 45% accent 环
  - `.gui-group-head--dragover`（`:2405`）= `inset 0 0 0 1.5px` **满** accent 环
- 侧栏项目（工作区）重排（`components/SessionSidebar.tsx:982-1000`）：`onDragOver`/`onDrop` **完全没有指示样式**（该行只有一个 `mb-1.5`）。

⇒ 若指的是分组那两处 inset 环，本项是"降低重量"；若指侧栏项目重排，实际是"**补**一个轻量插入线"，性质相反。**先确认再动手**。

**方案（确认后）**：统一为一套轻量规则并抽成共用 class（例如 `.gui-drop-line`），避免两组各写一份：

- 1.5px 满 accent 环 → 1px `color-mix(in oklab, var(--color-accent) 28%, transparent)`；或改为 `inset 0 2px 0` 风格的插入线。
- 过渡 ≤120ms，且尊重 `gui-motion-off` / `prefers-reduced-motion`。

**验收**：拖动时落点提示清晰但不刺眼；与 `@dnd-kit` 迁移后的其他拖拽（todos / 消息队列 / 右栏 tab）视觉语言一致。

**规模**：小。

---

## 9. 会话分享附件校验

**现状（已核实）**

- 入口：`packages/coding-agent/src/export/share.ts:486-511` `shareSession()`；快照 `buildShareSnapshot` `:93-96` → `export/html/index.ts:192-200` `buildSessionData()`（`entries: sm.getEntries()` `:195`，**逐条原样**进载荷）；密封 `sealSessionData` `:551-561`（gzip → AES-256-GCM）；上传 `shareViaServer` `:645-663` / `uploadToServer` `:666-687`；gist 分支 `:613-642`。
- **附件确实在载荷里**：附件以 `fileMention` 消息存在（`session/messages.ts:294-302`，`files: [{path, content, image}]`），share 只**脱敏改写、不删除**（`share.ts:182-187`、`:471-479`）；内联图片 base64 也在，只在超限时被 `stripImagePayloads()` 清空（`:567-589`，>1024 换占位、`data:` 换 1×1 GIF）。
- **唯一的硬校验是体积**：`SERVER_MAX_SEALED_BYTES = 1_000_000` `:37`、`GIST_MAX_SEALED_BYTES = 5_000_000` `:39`、`sealToFit()` `:525-549`（① 去图片 `:530-533` ② 逐级 `TEXT_CAPS [32768, 8192, 2048, 512]` `:49/:535-539` ③ 砍最旧 entries `:541-546` ④ 仍超限**抛错** `:548`）；返回 id 校验 `/^[A-Za-z0-9_-]{10,64}$/` `:683`。**没有任何附件级校验**（存在性/大小/数量/去重都没有）。
- 相关差异（写测试时注意）：export 会带子会话（`index.ts:279-282`），**share 不带**（`share.ts:94` 未收集 `subSessions`，故 `SessionData.subSessions` 在 share 中恒为 undefined）；export 删 `previousSessionFiles`（`:184-189`），share 保留并脱敏（`:241-255`）。
- 调用点：`commands/share.ts:56-65`、`modes/controllers/command-controller.ts:245-248`、`slash-commands/builtin-collaboration.ts:413-416`。

**方案**

1. 在 `buildShareSnapshot` 之后加**发布前附件统计 + 显式拦截**：统计 `fileMention.files` 与内联 image 的数量/总字节。
2. 超阈值时**不静默**：`share.ts:548` 现在只抛一句 `"Session too large to share: …"` —— 改为返回结构化原因，并提供"剥离附件后继续"的显式选项。
3. 把"剥离附件"变成 `sealToFit` 降级链里的**显式一步**并把结果带回（今天丢图是静默的）：调用方能知道"已剥离 N 个附件"。
4. 顺序约束：剥离必须发生在**脱敏之后**（脱敏在 `:95`）—— 否则脱敏正则会去扫已经不存在/被替换的字节。**为此写测试。**

**验收**：含大附件的会话分享 ⇒ 要么成功且结果明确"已剥离 N 个附件"，要么以可读原因拒绝；不出现"看似成功但内容被悄悄截断"；`share.redactSecrets` 与剥离的组合有测试覆盖（含 image 字节跳过的既有测试 `tests/share.test.ts:414-463` 不能回归）。

**规模**：小-中。

---

## 暂不适用 / 已有（勿重复评估）

- **Markdown 预览选中正文加入对话**：MusePi 无独立 Markdown 预览面板。
- **登录失败取消按钮/渠道列表、Start Plan、BigModel 购买页、飞书机器人、Repo Wiki、access_token 401**：ZCode 特有账号/商业体系。
- **工作区面板拆分（会话/终端/Side Pane 独立面板）**：✅ **已落地（2026-09-15）**。会话列 / Side Pane（面板+rail）/ 终端 dock 拆为独立圆角卡片（`.gui-float-card` + `.gui-pane-right--inner` / `.gui-right-rail` / `.gui-terminal-dock` 各自 radius+shadow），去竖线分割，间隙露出玻璃基底；样式与设置页卡片统一。前置障碍已消除：原「TabBar 架构否决」已被 tab-primary 模型取代（`docs/archive/gui-right-panel-redesign.md` §3.3.2）。最大化锚点同步改为会话列（`.gui-chat-column`），rail 不再被吞。**待实跑复验**：场景过渡（welcome↔chat 交叉淡入时卡片轮廓）、玻璃模式下 rail/面板/会话卡片的材质一致性。
- **统一「问题上报」文案**：MusePi 入口已按自身品牌命名（`tools/report-tool-issue.ts` 已有）。
- **PDF 文件读取恢复、旧 Coding Plan 历史迁移**：MusePi 未引入对应缺陷。
- **Chromium 结束页面进程导致主进程崩溃**：待确认 MusePi 是否有同类 `<webview>` 崩溃监听缺口（低优先级核查项）。可核对的现成锚点：`electron/main.cjs:2170-2174` 已有 `render-process-gone` 处理（会 reload），但要确认托管浏览器 guest 的崩溃是否走同一通道（`managed-browser.cjs:661-682` 的 `handleTabDestroyed` 是另一条）。

## 工作纪律（改本文涉及的功能时遵守）

- 门禁：项目自带 biome 二进制（`node node_modules/@biomejs/biome/bin/biome check --write <files>`）、`bun run check:ts` 全 workspace exit 0、对应包测试。既有基线：`packages/desktop-app` 201 pass/0 fail；`packages/coding-agent` 有 **48 个 pre-existing 失败**（TTSR/transcript 渲染），与 GUI 改动无关，**不要去"修"**。
- i18n：按域拆 `packages/client-core/src/i18n/{zh-CN,en-US}/<域>.ts`，en 必须 `as const satisfies Record<ZhKey, string>`，禁止塞回单文件（`AGENTS.md`）。
- 长文本渲染、模型身份、模态键盘等 GUI 硬规则见 `AGENTS.md` 的 "GUI Development Rules" 与 `docs/gui-design.md` / `docs/gui-implementation.md`。
- 本文档吸收完成后**整体删除**（不要翻译、不要长期挂着）。
