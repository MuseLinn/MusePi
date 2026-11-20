# ADR 0004: 输入卡收敛为单一 Composer + variant

- 状态：提议（未实施；实施前 0.7.7 不发布）
- 背景：欢迎页与会话页的输入卡已经共用一个跨场景宿主（`apps/desktop/src/components/ChatView.tsx` 的 `.gui-composer-host` + `composer-surface` 位置），但卡片内部仍是 `HeroComposer`（2298 行）与 `SessionComposer`（2597 行）两套实现，靠 `Composer.tsx` 的 mode 判别切换；dsh 的对应物是**一个** `conversation.composer.bar`，用 `variant: hero | composer` 切皮（其源码注释：inert 是 prop 不是另一棵树，textarea DOM 因此跨切换存活）。参照实现之间的差距只有这一处：dsh/kimiwork 的输入框切换不重挂编辑器，我们重挂。
- 目标：`Composer` 成为唯一实现，`variant` 决定皮肤与状态分支；`HeroComposer`/`SessionComposer` 删除，行为等价（发送载荷、附件、草稿、专注态、插件席位 `conversation.composer.bar` 全部保持）。
- 已实测的两个死路（下次不要再试）：
  1. **只把 draft 上移到 `Composer` 不够。** `SessionComposer` 用 `useDraftPersistence` 在挂载/换会话时把 text 重置为该会话的存盘草稿（空串即清空），会覆盖 entry 传来的 `initialDraft`——实测：欢迎页注入文本 → 切会话后输入框为空。要让 draft 跨 skin 存活，必须同时把**持久化所有权**移进 entry（按当前 variant/session 读写），否则得到"草稿看起来丢了"的假状态。
  2. **portal 把 `ComposerFrame` 挂进宿主 wrap 不可行。** 两个 skin 的 portal 跨 React 树，切换时 DOM 先移除再插入，闪一帧；`chat-view-composer-host.test.tsx` 断言的是同一节点，做不到就不是常驻。
- 进度：第 1 步的**文本 + 草稿持久化**已完成（`Composer` 持有 draft 与一次性 `carry`，`useDraftPersistence` 接受 `carryText` 并在本会话无存盘草稿时采用）。实机探针：欢迎页注入 `DRAFT-PROBE-42` → 切会话读到同一文本；会话 → 新建任务回到欢迎页同样保留。附件随后也并入：`Composer` 持有 `useAttachments` 的 intake（`stageFiles` 按 variant 决定），两个 skin 只消费它；`useDraftPersistence` 增加 `keepAttachments`，欢迎页已放置的缩略图在目标会话没有自己的草稿时保留，普通换会话仍以会话 stash 为准。输入注入（pendingEdit/quote）仍属该步余下部分。
- 计划（每步独立提交、各自保绿）：
  1. **状态所有权上移**：text、attachments、draft 持久化、pendingEdit/quote 注入统一由 `Composer` 持有，两个 skin 只收 props（`variant` 之外不再各自 `useState`）。
  2. **共享 body**：把 `ComposerFrame` 的 children 收敛为一个 `ComposerBody`（editor stack + attach row + footer），hero 专属装饰（greeting / tips / reminders / modes / design rail / connector picker）改为 `above`/`below` 槽由 `ChatView` 传入。
  3. **删除旧实现**：`Composer` 直接按 `variant` 渲染同一棵树；`useDraftPersistence` 从 session-only 改为 variant-aware。
- 不变量（已固化）：`apps/desktop/test/chat-view-composer-host.test.tsx` —— 场景切换前后 `.gui-composer-host` 与 `.gui-composer-wrap` 必须是同一 DOM 节点且各只有一个。合并过程中它必须一直绿。
- 验证门槛：`apps/desktop` 全量测试（当前 0 fail）、`check`（biome + tsgo）、隔离档案实机构建：欢迎⇄会话飞行、专注态 ⌘⇧E、附件拖放、插件席位替换输入卡、以及首字延迟/输入延迟对比（合并后不得退化）。
- 回滚：三刀分开；任一步失败按提交回退，宿主与 hoc 座位（`conversation.hero.frame`）保持现状，欢迎页不受影响。