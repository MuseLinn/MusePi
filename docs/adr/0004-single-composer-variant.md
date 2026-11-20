# ADR 0004: 输入卡收敛为单一 Composer + variant

- 状态：提议（未实施；实施前 0.7.7 不发布）
- 背景：欢迎页与会话页的输入卡已经共用一个跨场景宿主（`apps/desktop/src/components/ChatView.tsx` 的 `.gui-composer-host` + `composer-surface` 位置），但卡片内部仍是 `HeroComposer`（2298 行）与 `SessionComposer`（2597 行）两套实现，靠 `Composer.tsx` 的 mode 判别切换；dsh 的对应物是**一个** `conversation.composer.bar`，用 `variant: hero | composer` 切皮（其源码注释：inert 是 prop 不是另一棵树，textarea DOM 因此跨切换存活）。参照实现之间的差距只有这一处：dsh/kimiwork 的输入框切换不重挂编辑器，我们重挂。
- 目标：`Composer` 成为唯一实现，`variant` 决定皮肤与状态分支；`HeroComposer`/`SessionComposer` 删除，行为等价（发送载荷、附件、草稿、专注态、插件席位 `conversation.composer.bar` 全部保持）。
- 已实测的两个死路（下次不要再试）：
  1. **只把 draft 上移到 `Composer` 不够。** `SessionComposer` 用 `useDraftPersistence` 在挂载/换会话时把 text 重置为该会话的存盘草稿（空串即清空），会覆盖 entry 传来的 `initialDraft`——实测：欢迎页注入文本 → 切会话后输入框为空。要让 draft 跨 skin 存活，必须同时把**持久化所有权**移进 entry（按当前 variant/session 读写），否则得到"草稿看起来丢了"的假状态。
  2. **portal 把 `ComposerFrame` 挂进宿主 wrap 不可行。** 两个 skin 的 portal 跨 React 树，切换时 DOM 先移除再插入，闪一帧；`chat-view-composer-host.test.tsx` 断言的是同一节点，做不到就不是常驻。
- 进度：第 1 步的**文本 + 草稿持久化**已完成（`Composer` 持有 draft 与一次性 `carry`，`useDraftPersistence` 接受 `carryText` 并在本会话无存盘草稿时采用）。实机探针：欢迎页注入 `DRAFT-PROBE-42` → 切会话读到同一文本；会话 → 新建任务回到欢迎页同样保留。附件随后也并入：`Composer` 持有 `useAttachments` 的 intake（`stageFiles` 按 variant 决定），两个 skin 只消费它；`useDraftPersistence` 增加 `keepAttachments`，欢迎页已放置的缩略图在目标会话没有自己的草稿时保留，普通换会话仍以会话 stash 为准。输入注入（pendingEdit/quote）仍属该步余下部分。
- 剩余部分的真实形状（2026-11-20 复核）：`ComposerFrame`、`ComposerEditor`、`useAttachments`、草稿持久化现在都已在共享层，第 2 步不是"把两块 JSX 挪到一起"这么机械——两个 skin 的 frame body 各约 500 行，引用了各自组件内 ~50 个局部（handlers、refs、派生值），直接抽 `ComposerBody` 等于给每个引用搬一条 prop。可行的切法是先建一个 `ComposerSurfaceContext`（由 entry 提供、skin 消费）把这些局部显式化，再抽 body；否则会得到一条 50+ props 的签名。这一步需要一次独立的实现与验证窗口。
- 第 2 步起步（2026-11-20）：`apps/desktop/src/components/composer/surface.tsx` 已建立 entry→skin 的 `ComposerSurfaceContext`（variant、intake、draft/carry），两个 skin 优先从它取；无 provider 的直接挂载仍走 props/本地状态。下一步把 body 需要的 handlers/refs 逐项搬进该 surface，直到 frame body 可以整体抽出。
- 第 2 步续（2026-11-20）：发送合同已收进 surface（`send(text, payload)`，payload 是两边的并集；entry 按 variant 分派到 `onSubmit`/`onSend`），两个 skin 的发送点改走它，直接挂载仍回退到各自 handler。剩下要搬的是编辑器/焦点句柄与工具栏动作。
- 第 2 步续（2026-11-21）：编辑器栈已抽出（`apps/desktop/src/components/composer/editor-stack.tsx`）：`gui-ta-stack` + `ComposerEditor` + 组合输入生命周期 + suggestion 行合成一个组件，两个 skin 都改用它，`variant` 只决定皮肤类、placeholder 与是否挂 IME ref；会话页保留 `data-composer-input` 供 `composer-input-redirect` 命中，欢迎页靠 `autoFocus`。附件 chip 的连线也抽出（`composer/chip-actions.tsx`，`attachmentChipActions`）：移除/重排/`@` 插入/sketch 重开这些以 chip 顺序为语义的动作由一份实现提供，两个 skin 只剩“怎么打开选择器”的差异；`test/composer-chip-actions.test.tsx` 固化这层合同。工具栏侧抽出菜单插入（`composer/insert-token.ts`）、专注按钮（复用 `FocusButton`）、语音覆盖层（`composer/voice-overlays.tsx`）；欢迎页的补全面板换成会话用的 `CompletionMenus`（图标/路径/rootLabel/活动行滚动一致），两边不再各写一份菜单。
- 实机验证（2026-11-21，隔离档案）：欢迎页 `gui-composer-editor--welcome` 可输入、专注按钮进入 `--active`；合成粘贴一张 PNG → 1 个 chip 且自动落一个 `@图片1`，chip 的 `@` 再插一个、`X` 移除后文本只剩用户自己的文字；欢迎页回车后 `.gui-composer-host` 节点不变、编辑器类切到 `--session`、宿主只有一个；会话页重复上述 chip 步骤结果一致。
- 仍未合并的部分（如实）：两个 skin 仍是各一个组件，父级 `Composer` 按 `variant` 二选一。差异来自**状态模型**而不是 UI：hero 独占首条消息载荷（plan/goal/guided/文件/连接器/设计体系）与问候/提示/提醒，session 独占队列/目标/审批/会话命令集。要真正合成一棵树，正确顺序是先把每边的“专有 hook + JSX”收进各自子组件，再由 `variant` 选择——这不是搬 JSX，而是重写两套状态所有权，需要独立窗口。
- 重写清单（2026-11-21 盘点，供下一次连续实现使用）：`HeroComposer` 有 25 个 `useEffect`、17 个 `useState`、6 个 `useRef`；`SessionComposer` 19/12/7。这些 hook 按所有权分三类：
  1. **共享**（已在 entry 或共享模块）：text/draft、`useAttachments`、draft persistence、`ComposerFrame`、`ComposerEditor`、发送路由（`createSurfaceSend`）。
  2. **session 专有**：`useDraftPersistence` 的会话键、`useInputHistory`、队列/目标/计划/权限/模型 ladder、`swarmHost`、`onBtw`、`useCompletion` 的会话命令集。
  3. **hero 专有**：首次发送载荷（planMode/goalMode/guidedGoal/files/videos）、模式 chip、设计体系 rail、连接器选择、问候/提示/提醒、连接器/项目行。
  合并时的规则：hero 专有 hook 必须留在 hero 分支渲染的子树里（或在 `variant === "hero"` 下用独立子组件承载），否则会话态会多跑 25 条监听/RPC；session 专有同理。这也是为什么不能把两份 body 直接塞进一个函数——hook 不能条件调用，必须先把「专有 hook + 其 JSX」打包成两个子组件，再由 `variant` 选择。
- 计划（每步独立提交、各自保绿）：
  1. **状态所有权上移**：text、attachments、draft 持久化、pendingEdit/quote 注入统一由 `Composer` 持有，两个 skin 只收 props（`variant` 之外不再各自 `useState`）。
  2. **共享 body**：把 `ComposerFrame` 的 children 收敛为一个 `ComposerBody`（editor stack + attach row + footer），hero 专属装饰（greeting / tips / reminders / modes / design rail / connector picker）改为 `above`/`below` 槽由 `ChatView` 传入。
  3. **删除旧实现**：`Composer` 直接按 `variant` 渲染同一棵树；`useDraftPersistence` 从 session-only 改为 variant-aware。
- 不变量（已固化）：`apps/desktop/test/chat-view-composer-host.test.tsx` —— 场景切换前后 `.gui-composer-host` 与 `.gui-composer-wrap` 必须是同一 DOM 节点且各只有一个。合并过程中它必须一直绿。
- 验证门槛：`apps/desktop` 全量测试（当前 0 fail）、`check`（biome + tsgo）、隔离档案实机构建：欢迎⇄会话飞行、专注态 ⌘⇧E、附件拖放、插件席位替换输入卡、以及首字延迟/输入延迟对比（合并后不得退化）。
- 回滚：三刀分开；任一步失败按提交回退，宿主与 hoc 座位（`conversation.hero.frame`）保持现状，欢迎页不受影响。