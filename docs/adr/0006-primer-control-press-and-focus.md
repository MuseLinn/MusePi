# ADR 0006: 引导页控件的按压与焦点反馈

- 状态：已接受（2026-11-24）
- 背景：用户反馈「按键缺乏交互反馈」。核查后是两处结构缺口叠加：
  - `.gui-btn` 只有 `:hover` 与 `:disabled`，没有 `:active`。一次点击在处理器生效之前没有任何视觉变化，读起来像按钮没反应。
  - `packages/client-core/src/styles/base.css` 的全局 `:focus-visible` 被刻意清空（`outline: none; box-shadow: none`），理由写在注释里：焦点由控件自己表达。但引导页的控件没有一个自写焦点样式，于是键盘 Tab 完全看不到当前位置。
  - 同样缺按压反馈的还有关闭键、折叠分支头、分段标签、外观卡片、`GuiSelect` 触发器；开关缺焦点环；`.gui-input` 缺焦点态（只有 `caret-color`，空输入框时看不出来）。
- 决定：
  - 按压是**缩放而非位移**，取值落在既有的 0.94–0.98 区间（`gui-composer-send` 0.96、`gui-composer-queue` 0.96、`gui-onboarding-close` 0.94、外观卡片按下时把 `translateY(-1px)` 收回并叠 0.97）。这是 §5u 已经写下的规则：「a press is a scale, never a displacement」。
  - 焦点环用 agent 胶囊的配方：`outline: 2px solid var(--color-accent)` + `outline-offset: 2px`。落在容器边缘内部的控件（分支折叠头）用 `-2px` 内缩，避免描边被 `overflow: hidden` 裁掉。
  - 包裹型输入（`.gui-obo-search`）的边框画在容器上，焦点也由容器用 `:focus-within` 表达；裸输入框（`.gui-input`）用 `:focus-visible` 改 `border-color`。
  - `prefers-reduced-motion` 不需要额外处理：`gui-base.css` 的通配规则已把 `transition-duration` 压到 0.01ms，`transform` 会立即到位。动效开关 `gui-motion-off` 同理，因为它只关 animation 与逐条列出的 transition——按压反馈属于「按下即生效」的状态，不属于可关闭的动效。
- 理由：
  - 反馈必须落在用户点击的那个元素上。把反馈移到 toast 或状态行会让「有没有按到」这个问题留到处理结果之后才回答。
  - 焦点环是键盘可用性的下限，不是装饰。全局清空焦点框的前提是「控件自己表达」，前提不成立时缺口是静默的——这正是这次的状态。
- 影响：
  - 契约测试 `apps/desktop/test/tour-overlay-hierarchy.test.ts` 的 `primer controls answer the pointer and the keyboard` 一组锁住 `.gui-btn` 的 transition/active/focus、三个引导控件的 `:active`、外观卡片的 active 与 focus。
  - 新增引导控件默认继承 `.gui-btn`；自绘按钮必须同时声明 `:active` 与 `:focus-visible`。
- 被否决的方案：恢复全局焦点框（会与已上线的「控件自表达」设计冲突，且立刻影响全应用）；只加 `:hover` 加深（按住不动时仍然没有反馈）。

## 附：引导的语音步骤按「图标 | 文案 | 动作」读

同一个反馈里指出的视觉层级问题，改动落在 `apps/desktop/src/styles/gui-misc.css` 的 `.gui-obo-voice-check` 与 `OnboardingVoiceSetup.tsx`：

- 检查卡是三列网格（`32px | 1fr | auto`），动作固定在自己的列、与标题同排。此前是两列，按钮被塞在状态说明下方，位置随文案长度漂移；动作文案在「检查 / 重新检查 / 检查中…」之间切换时也会把说明挤动。
- 状态瓦片承担结果配色——成功绿（`--color-ok`）、失败红（`--color-danger`）——而不是只让卡片的 1px 边框变色，因为人先看的是图标，读状态句是第二步。
- 下载按钮升为该卡的主操作（`gui-btn-primary` 强调色）：在它之前，用户拿不到可用的麦克风。
- 契约测试同一文件的 `the voice step reads as icon, copy, action` 一组锁住三列网格、动作列与状态着色。
