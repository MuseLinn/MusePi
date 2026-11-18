# 移动端 UI 设计令牌体检与会话列表能力对照

> 只读审计。全仓唯一写入物是本文件，未改动任何源码。
> 审计对象：`packages/client-core/src/components/shell/shell.css`（7510 行）、`packages/client-core/src/components/transcript/transcript.css`（4860 行）。
> 参考实现：`D:/Projects/Agents/references/bitfun/src/mobile-web`、`D:/Projects/Agents/references/openchamber/packages/ui/src/apps/mobileSidebar`。
> 统计口径、复算方法与已知误差列在第 1 节末尾；凡是本文件没写出 `文件:行` 的结论都不成立。

---

## 0. 结论摘要

1. **令牌化程度按属性严重分层，不是整体落后。** 颜色已经做得很好（裸硬编码占比 4.8% / 8.4%），间距几乎没做（91.5% / 98.8%）。`tokens.css` 里已定义 `--space-1..6`（4/8/12/16/20/24px），两份文件只引用了 59 次 / 4 次。**间距是唯一一个"令牌已备好、却基本没用"的类别**，投入产出比最高。
2. **圆角守卫被自己的白名单放过了。** `scripts/check-radius-tokens.ts:35` 的 `ALLOWED_RE` 把 `999px` 列为合规值，所以 `shell.css` 26 处、`transcript.css` 23 处 `border-radius: 999px` 全部通过检查；而 `--radius-full` 已定义为 `9999px`（`tokens.css:89`），`transcript.css` 对它的引用数是 0。这不是漏检，是守卫主动开了口子。
3. **`shell.css:1` 的自我描述与实际不符。** 首行写 "Token vars only — no raw colors"，但同文件 `shell.css:23` 就是 `rgba(255, 255, 255, 0.08)`、`:33` 是 `rgba(24, 26, 32, 0.5)`。注释承诺的契约没有守卫，且已有 38 处裸颜色值。
4. **动效无障碍是本次唯一有明确合规风险的项。** `shell.css` 45 个带 `animation` 的普通选择器里只有 14 个被 `prefers-reduced-motion` 覆盖，`transcript.css` 29 个里只有 9 个；剩下的会一直跑（`ss-spin` 900ms infinite、`tr-shimmer` 1.1s infinite）。而 `packages/client-core/src/styles/` 下只有 `tokens.css:1300` 一处 reduced-motion 媒体查询，没有全局兜底。
5. **会话行操作能力接近参考实现，差距在语义而非功能。** MusePi 的 `SwipeableRow`（`SessionsSheet.tsx:326` 定义处；`SWIPE_ACTIONS_PX = 142` 在 `:317`）已有速度判定、二阶确认、`inert` 遮罩，功能上不缺；缺的是键盘可达性（`ss-swipe-btn` 无 `:focus-visible` 样式）、行状态的无障碍语义（`ss-item-status` 是 `aria-hidden` 的纯圆点）、以及会话列表与连接态的联动。
6. **触控目标的兜底机制已经做对，只剩 4 个漏网控件。** `shell.css:3076` 的 `@media (pointer: coarse)` 块覆盖 34 个选择器并把它们提到 48px，覆盖面很广；真正未覆盖的是 `.sh-jobaction` 22px（`shell.css:6978`）、`.sh-tree-toggle` 16px（`:3966`）、`.sh-ws-sidebar--closed` 宽 34px（`:3211`）、`.qr-close` 40px（`:4614`）。

---

## 1. 令牌占比统计

### 1.1 口径

- **一个"值"= 一次出现**，不是一次声明。`padding: 8px 12px` 记两次；`0 1px 2px oklch(0 0 0 / 30%)` 在 shadow 类记 3 次长度 + 1 次颜色。
- **裸硬编码**：不在 `var()` 内部、直接写死的字面量。
- **回退字面量**：写在 `var(--x, <这里>)` 第二参数里的值。它不会被主题覆盖生效，但**不阻断主题切换**（外层 token 有效时整条声明仍解析）。单独成列，避免把 `var(--fg-muted, #fff)` 算成"没用令牌"。
- **占比 = 裸硬编码 ÷ (裸硬编码 + token 引用)**。回退字面量不进分母，见 1.4 的分歧说明。
- 五类属性与计数单位：

| 类别 | 判定的属性 | 计什么 |
| --- | --- | --- |
| color | `color` / `background*` / `border*` / `outline*` / `fill` / `stroke` / `filter` / `mask-image` / `--*` 自定义属性 / 任何 `*shadow*` | `#rgb` `rgb()` `rgba()` `hsl()` `oklch()` `oklab()` 出现次数 |
| radius | 属性名含 `radius` | `px` / `rem` / `em` 长度 |
| shadow | 属性名含 `shadow` | `px` / `rem` / `em` 长度（偏移量，不含模糊与颜色） |
| motion | `transition*` / `animation*` / `*duration` / `*delay` | `ms` / `s` 时长 |
| space | `padding*` / `margin*` / `gap` / `row-gap` / `column-gap` | `px` / `rem` / `em` 长度 |

- 已排除：注释、`@keyframes` 内的 `0%`/`100%` 选择器、`@media` 条件里的长度、非交互属性的尺寸（`width`/`height`/`font-size`，另见 1.3）。
- 零值影响可忽略：两份文件里 `padding/margin/gap` 的 `0px` 只有 1 处（`shell.css`），不会抬高硬编码数。

### 1.2 汇总

| 文件 | 全文件裸硬编码 | 回退字面量 | token 引用 | 裸值占比 |
| --- | --- | --- | --- | --- |
| `shell.css` | 886 | 90 | 1037 | **46.1%** |
| `transcript.css` | 499 | 61 | 505 | **49.7%** |
| 合计 | 1385 | 151 | 1542 | 47.3% |

### 1.3 按属性分类

`shell.css`（3822 条声明，1001 条规则，1148 处 `var()`）：

| 类别 | 裸硬编码 | 回退字面量 | token 引用 | 裸值占比 |
| --- | --- | --- | --- | --- |
| 颜色 | 38 | 33 | 747 | **4.8%** |
| 圆角 | 28 | 0 | 122 | 18.7% |
| 阴影 | 57 | 0 | 39 | 59.4% |
| 动效时长 | 130 | 4 | 70 | 65.0% |
| 间距 | 633 | 53 | 59 | **91.5%** |

`transcript.css`（2327 条声明，619 条规则，612 处 `var()`）：

| 类别 | 裸硬编码 | 回退字面量 | token 引用 | 裸值占比 |
| --- | --- | --- | --- | --- |
| 颜色 | 38 | 55 | 417 | **8.4%** |
| 圆角 | 23 | 0 | 57 | 28.7% |
| 阴影 | 20 | 2 | 4 | **83.3%** |
| 动效时长 | 91 | 0 | 23 | 79.8% |
| 间距 | 327 | 4 | 4 | **98.8%** |

除上表五类之外，还有 640（shell）/ 336（transcript）处裸长度写在 `height`、`width`、`font-size`、`top/bottom/left/right` 等属性上。它们不属于本次五个类别，未计入占比；若要继续压缩，这是下一个池子——但其中包含大量几何常量（图标 13/14/15px、header 高度、grabber 尺寸），不宜盲目令牌化。

### 1.4 分歧与已知误差

- **回退字面量是否算"没用令牌"存在两种合理口径。** 本报告取"不算"：`var(--fg-muted, rgba(...))` 在正常主题下走 token，只有 token 缺失时才用回退值，把它计入硬编码会夸大问题。若按"算"处理，`shell.css` 会升到 48.4%、`transcript.css` 升到 52.6%。两个数字都保留，供不同决策使用。
- 分组统计里，`transcript.css` 的 `aicss tool-kind treatments` 段含 17 处回退颜色（`transcript.css:2515-2701`），来源是 `var(--border-strong, var(--border, oklch(1 0 0 / 9%)))` 这类多层回退。它们说明该段的作者预期 token 可能缺失——这本身是一个待查问题（是防御性写法，还是某条渲染路径确实拿不到 token）。
- 统计脚本按大括号配对解析，不处理 `@layer` / 嵌套 CSS。两份文件当前都不使用嵌套，脚本结果已与人工抽查（`shell.css:1-120`、`:5364-5510`、`transcript.css:1640-1700`）一致。

### 1.5 按功能分组

"硬编码 / token"两列是该组的裸值数与 token 引用数合计；"间距""动效"两列单独给出，因为这两类是主要矛盾。

`shell.css`：

| 功能分组 | 硬编码 | token | 占比 | 间距(硬/令牌) | 动效(硬/令牌) |
| --- | --- | --- | --- | --- | --- |
| 连接与扫码（connect screen / server switcher / QR） | 184 | 175 | **51.3%** | 111 / 7 | 34 / 22 |
| 语音输入输出（voice panel / stt / tts） | 116 | 160 | 42.0% | 90 / 3 | 16 / 9 |
| 设置与主题（switches / accent / theme toggle） | 106 | 114 | 48.2% | 74 / 16 | 12 / 4 |
| 面板 / 工作区 / 任务（guest panels / 五标签 / AsyncJobBar） | 90 | 120 | 42.9% | 78 / 5 | 8 / 5 |
| 会话列表与滑动行（SessionsSheet / swipe / Workspace） | 86 | 103 | 45.5% | 57 / 1 | 19 / 5 |
| 输入区与附件（composer / send / attachments / chips） | 89 | 109 | 44.9% | 75 / 0 | 5 / 4 |
| 提示 / 横幅 / Toast | 50 | 57 | 46.7% | 25 / 3 | 15 / 7 |
| 头部 / 导航 / 标签栏 | 48 | 70 | 40.7% | 35 / 2 | 9 / 6 |
| 响应式与断点（6 段断点覆盖） | 71 | 65 | **52.2%** | 59 / 7 | 3 / 1 |
| 应用框架与兼容壳 | 31 | 41 | 43.1% | 16 / 2 | 9 / 7 |
| 视觉组件（reactbits / context ring / skeleton） | 15 | 23 | 39.5% | 13 / 13 | 0 / 0 |

`transcript.css`：

| 功能分组 | 硬编码 | token | 占比 | 间距(硬/令牌) | 动效(硬/令牌) |
| --- | --- | --- | --- | --- | --- |
| 回合 / 工具卡片（rows / thinking / aicss / 各类卡片） | 311 | 325 | 48.9% | 203 / 2 | 59 / 18 |
| Markdown 正文 | 100 | 92 | **52.1%** | 71 / 1 | 13 / 1 |
| 响应式与断点 | 43 | 40 | **51.8%** | 24 / 0 | 7 / 1 |
| 头部 / 导航（回合头 / 折叠头 / 来源卡） | 39 | 46 | 45.9% | 28 / 0 | 7 / 3 |
| 输入区与附件（!/!! shell 命令行） | 13 | 26 | 33.3% | 7 / 0 | 6 / 1 |
| 应用框架与兼容壳 | 6 | 4 | 60.0% | 6 / 1 | 0 / 0 |

### 1.6 高频值分布（去重后）

`shell.css` 间距（686 次，35 种值）：`8px ×100`、`6px ×98`、`10px ×87`、`12px ×74`、`4px ×58`、`2px ×53`、`0px ×52`、`16px ×27`、`14px ×22`、`18px ×15`、`20px ×15`。
前五种合计 417 次（60.8%），而 `--space-1..6` 恰好覆盖 4/8/12/16/20/24。**6px 和 10px 不在令牌阶梯上**（阶梯是 4 的倍数），这是阶梯本身与真实用量的错位——处理方式不是硬套，而是要么补 `--space-1-5`/`--space-2-5`，要么把 6/10 归并到 8/12 并接受视觉变化。这个决定需要产品确认，不能由实现方单方面挑。

`transcript.css` 间距（331 次，21 种值）：`6px ×54`、`8px ×50`、`10px ×42`、`2px ×39`、`4px ×31`、`3px ×21`、`12px ×17`。同样是 6/10 居多。

`shell.css` 动效时长（134 次，30 种值）：`120ms ×28`、`150ms ×22`、`160ms ×14`、`220ms ×10`、`240ms ×10`、`320ms ×10`。
`transcript.css` 动效时长（91 次，32 种值）：`120ms ×32`、`220ms ×10`、`140ms ×5`、`160ms ×4`。
30+ 种时长说明没有节奏表。`tokens.css:145-266` 已有 `--spring` / `--spring-snappy` / `--spring-bouncy` / `--spring-liquid` 四组缓动曲线，但**没有任何时长令牌**——所以"动效硬编码"里缓动曲线早已统一（`shell` 引用 31 次 `--spring-snappy`、24 次 `--spring`），真正没统一的是时长数字。

`shell.css` 圆角（28 次）：`999px ×26`、`1.5px ×1`、`0.5px ×1`。
`transcript.css` 圆角（23 次）：`999px ×23`。
**这就是全部。** 两份文件的圆角裸值只有"药丸半径"一种，而 `--radius-full` 就是为此存在的。

### 1.7 令牌使用集中度（说明"令牌是否真的在用"）

`shell.css` 间距位置的 token 引用只有 8 种，且绝大多数不是间距令牌：`--safe-bottom ×17`、`--mp-keyboard-inset ×16`、`--safe-top ×11`、`--sh-tabbar-space ×6`、`--space-1 ×1`、`--space-3 ×1`。
即：**那里引用的 `var()` 全是安全区与键盘内边距，不是间距节奏令牌。** `--space-2/4/5/6` 在 `shell.css` 里一次都没被用于 `padding/margin/gap`。

`transcript.css` 的四个间距 token `--tr-row-pad` / `--tr-para-gap` / `--tr-heading-gap` / `--tr-code-gap` 各用 1 次。它们的存在证明作者想过这件事，但没有推广。

---

## 2. 参考实现能力对照

参考实现说明：

- `bitfun/src/mobile-web` 是 OpenBitFun 的浏览器远控客户端，自带 `AGENTS.md`（已读），强调"配对、重连、断线、会话列表、聊天视为一个连接产品流程"，且"连接态语义必须在常驻指示、横幅、对话框、禁用态之间保持一致"。
- `openchamber/packages/ui/src/apps/mobileSidebar` 目录内**没有** `AGENTS.md`；其上位仓库根 `D:/Projects/Agents/references/openchamber/AGENTS.md` 已读。该目录是桌面会话侧栏的电话版行模型，强调"指针在桌面 hover/右键做的事，拇指用滑动做"，且不可变式要求"一个失败实体不得抹掉或阻塞无关的完整实体"。

### 2.1 P0 — 会话行滑动动作在键盘/辅助技术下不可达

| 项 | 内容 |
| --- | --- |
| **现状** | `SessionsSheet.tsx:448` 的滑动动作容器用 `aria-hidden={!open} inert={!open}` 遮住，按钮另有 `tabIndex={open ? 0 : -1}`（`:451`、`:464`）。展开后按钮进入 tab 序，但 `shell.css` 中 `.ss-swipe-btn`（`shell.css:5345`）**没有任何 `:focus-visible` 规则**——整个文件里 `:focus-visible` 只出现 9 次（`:829`、`:2260`、`:6839`、`:6868`、`:6965`、`:6985`、`:7164`、`:7176`、`:7376`），都不覆盖 `ss-*`。 |
| **参考** | openchamber 的同一个按钮组件 `mobileRowParts.tsx:127-142`（`MobileSwipeAction`）显式带 `focus-visible:ring-2 focus-visible:ring-inset`，并按 `tone` 区分 ring 颜色（destructive 用 `ring-destructive`）。 |
| **差距** | 展开滑动动作后，键盘/开关控制的用户看不到焦点落在哪个按钮上。iOS VoiceOver 与 Android TalkBack 的焦点框可以兜住一部分，但外接键盘与鸿蒙的键盘导航不会。 |
| **可落地动作** | 给 `.ss-swipe-btn`、`.ss-swipe-btn--delete`、`.ss-swipe-btn--confirm` 加 `:focus-visible` 样式，复用 `--ring`（`tokens.css:63`）；`.ss-rename-input` 同查。验收：`bun test packages/client-core/test/sessions-sheet*.test.tsx`（若无则新建，断言 `:focus-visible` 规则存在不成立——应改为断言展开后 tab 序可达且 `document.activeElement` 落在按钮上，并加一条 CSS 结构检查）。 |
| **分级理由** | P0 因为它是「不可达」而非「不好看」：一个已经实现的功能对一类输入方式完全失效。 |

### 2.2 P1 — 会话行的运行/暂停状态对读屏不可见

| 项 | 内容 |
| --- | --- |
| **现状** | `SessionsSheet.tsx:509` 的行状态槽 `<span className="ss-item-status" aria-hidden>`：`working` 时是 `Loader2` 图标，否则是 `<span className="ss-item-dot">`（`shell.css:4294`，8px 圆点，`background: var(--ok)`）。两者都被 `aria-hidden` 屏蔽，且没有替代文本。`ss-item--active`（当前会话）在 `shell.css:4281` 只改背景色，没有 `aria-current`。 |
| **参考** | openchamber `MobileSessionRow.tsx:137-150` 的 `liveState` / `pinMarker` / `doneHint` 三个状态图标各自带 `aria-label`（`t('sessions.aiRename.generating')`、`t('sessions.sidebar.session.status.pinned')`、`t('sessions.sidebar.session.work.doneSuggested')`），并用 `MobileSessionPendingBadges`（`:225`）单独播报等待中的请求。 |
| **差距** | "这个会话正在跑""这个会话暂停了"是列表页最关键的两个状态，目前只靠颜色+图标传达。读屏用户拿到的是一个纯按钮，标题之外没有任何状态。 |
| **可落地动作** | ① `ss-item-status` 去掉 `aria-hidden`，给内部图标加 `aria-label`（复用语料里现有的 `settings.recording` 类语义键，或新增两条）；② 给 `ss-item` 加 `aria-current={active ? "true" : undefined}`；③ 若同屏有多个运行中会话，考虑 `role="status"` 的 polite 播报，但要避免每次轮询都播——只在状态跃迁时播。需要新增 i18n 键，建议条目见第 4 节。 |
| **分级理由** | P1：信息缺失但用户仍可通过颜色/图标辨认可视状态，不阻断任务。 |

### 2.3 P1 — 动效无障碍在移动端大面积失效

| 项 | 内容 |
| --- | --- |
| **现状** | 用大括号配对统计（排除注释与 `@keyframes` 内部）：`shell.css` 有 45 个带 `animation` 声明的普通选择器，其中 **14** 个被 `@media (prefers-reduced-motion: reduce)` 覆盖（8 个 reduce 块：`shell.css:67/311/435/1656/4421/4818/5997/6512`），**29** 个既无媒体查询也无 `.gui-motion-off` 变体。`transcript.css` 有 29 个，覆盖 **9** 个（9 个 reduce 块：`transcript.css:2206/2774/2826/2961/3080/4130/4294/4715/5036`），**20** 个两者都无。 |
| **未覆盖实例（会一直跑）** | `ss-spin`（`shell.css:4305`，`animation: ss-spin 900ms linear infinite`，用于会话行的 working 圈）；`tr-shimmer`（`transcript.css:2876`，`1.1s ease-in-out infinite`，窗口化加载条）；`tr-working-spin`（`transcript.css:3193`，`0.9s linear infinite`）；`tr-shimmer` 类本身（`transcript.css:1129-1131`，`tr-pulse 1.4s infinite`）；`.qr-scanline`（`shell.css:4557`，扫码扫描线）。 |
| **加剧因素** | `gui-motion-off` 这个类只在 `apps/desktop/src/app.tsx:499` 由桌面「动效开关」写入；`packages/client-core` 与 `apps/mobile` 里没有任何写入点（全仓搜索结果只有读取方：`image-morph.ts:69`、`DotMatrixMark.tsx:527`、`StatusText.tsx:9` 等）。所以依赖 `.gui-motion-off` 的兜底在移动端**恒不生效**。同时 `packages/client-core/src/styles/` 下只有 `tokens.css:1300` 一处 reduced-motion 查询，没有全局 `* { animation: none }` 兜底。 |
| **参考** | bitfun 侧同样没有全局 `* { animation: none }` 兜底，而是**按组件逐个补**，共 8 处 `@media (prefers-reduced-motion: reduce)`：`src/styles/global.scss:170`（页面转场五态）、`src/styles/components/sessions.scss:1154`、`src/styles/components/chat.scss:217`、`src/styles/components/tool-card.scss:905`、`src/styles/components/workspace.scss:240`、`src/styles/components/harmony-native.scss:1463`、`src/styles/components/adaptive-shell.scss:571`，连单文件组件的 spinner 都单独写了一条（`src/components/WorkspaceFiles.scss:49`：`.runtime-files__spinner { animation: none; }`）。其 `AGENTS.md`（"Component style integration"）另要求在 compact / intermediate / wide 三档都检查，包括键盘焦点。**差距的性质因此是"补漏不均"而不是"没有机制"**——MusePi 也有 reduce 块，只是覆盖的选择器比例低得多。 |
| **差距** | 系统开启「减少动态效果」的 iOS/Android/鸿蒙用户，在移动端会看到 49 个选择器的动画照常播放，其中多个是常驻无限循环。这既是无障碍问题，也是耗电问题。 |
| **可落地动作** | ① 在 `tokens.css` 增加一条全局兜底：`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }`——但这会连带杀掉"进度感"，需要与设计确认；② 更保守：只对上述 49 个选择器逐个补 `@media` 块，优先 `infinite` 的那几个（`ss-spin`、`tr-shimmer`、`tr-working-spin`、`qr-scanline`、`sh-voice-pulse`）；③ 给 `packages/client-core/src/app.tsx` 加一个读取 `prefers-reduced-motion` 并写 `gui-motion-off` 的副作用，让已有的 16 条 `.gui-motion-off` 规则（`shell.css` 12 条、`transcript.css` 4 条）在移动端生效。 |
| **分级理由** | P1：不阻断功能，但违反已声明的无障碍预期，且常驻无限动画在低端设备上有实际渲染成本。 |
| **未验证** | 未在真机上用「减少动态效果」开关跑过；上述覆盖数来自静态解析，实际渲染还取决于 `@media` 是否被 WebView 正确应用（ArkWeb 对 `prefers-reduced-motion` 的支持未核实）。 |

### 2.4 P1 — 触控目标尺寸：真实未达标的是 4 个控件

| 项 | 内容 |
| --- | --- |
| **现状** | `shell.css:3076` 起有 `@media (pointer: coarse)` 块，注释明确写"HarmonyOS @cross-device-app-dev/touch-target-size requires ≥40vp and recommends 48vp"。该块覆盖 40 条规则、34 个不同选择器，把按钮、分段控件、输入框、附件删除点等提到 48px，甚至把 `.sh-attach-remove` 的命中区从 17px 扩到 48px（`:3144-3157`）。**这套兜底机制本身是符合规范的做法，覆盖面也相当广**，问题只在于漏了几个控件。 |
| **清单（真实未覆盖，4 个）** | `.sh-jobaction` 22×22px（`:6978`）——AsyncJobBar 的取消/详情按钮，`AsyncJobBar.tsx:137/146/179/218`，是本文件里最小的可点击控件；`.sh-ws-sidebar--closed` 宽 34px（`:3211`）——收起态侧栏的入口，宽高两个方向都未进 coarse 块；`.sh-tree-toggle` 16×16px（`:3966`）；`.qr-close` 40×40px（`:4614`）——扫码关闭按钮，`QrScanner.tsx:228`。 |
| **清单（被覆盖，勿再提案）** | `.sh-ws-sidebar-toggle`（`:3214`）已由 coarse 块 `min-height: 48px` + `min-width: 48px` 覆盖（`:3121`、`:3136-3138`）；`.sh-queue-actions button`（`:1456`）与 `.ss-swipe-btn`（`:5347`）已由 `:3125-3127` 提到 48px；`.sh-header .sh-host-chip` 已被 `:3084` 覆盖（移动设置页的变体见 `:6348` 的 `.sh-mobile-settings-section .sh-host-chip`；其中 `:6359` 的 `.sh-dot` 是 8px 状态圆点，装饰而非控件）。**这四项在早期草稿里被误列为缺陷，已改正。** |
| **清单（误报，剔除）** | `.sh-jobs-chip-count`（`:7017`，16px）在 `AsyncJobBar.tsx:202` 是 `<span>` 计数徽标，不是控件；`.sh-accent-swatch`（`:6257`，30px）外层是 `.sh-accent-swatch-btn`（`:6245`，44×44px，已核实），实际命中区达标；`.sh-header-right .sh-btn-icon svg`（`:7239`）是按钮内部图标，外层按钮已由 coarse 块兜住；`.sh-suggest-chip`（`:4931`）无显式高度，由 `padding: 6px 14px` 撑出，`:6435` 另有一条针对 composer 场景的 36px 规则。 |
| **差距** | 4 个真实项里，`.sh-jobaction` 22px 与 `.sh-tree-toggle` 16px 低于鸿蒙 40vp 下限，也低于 iOS HIG 44pt；`.qr-close` 40px 恰好卡在鸿蒙下限、低于推荐值 48px。`.sh-ws-sidebar--closed` 的问题在宽度（34px）而非高度——收起的侧栏是一条 34px 宽的窄条。 |
| **可落地动作** | 在 `shell.css:3076` 的 coarse 块里补入 `.sh-jobaction`、`.sh-tree-toggle`、`.qr-close`、`.sh-ws-sidebar--closed`，给前三者 `min-width/min-height: 48px`，给最后一项 `min-width: 48px`（高度已由继承的行高满足，需实测确认）。 |
| **分级理由** | P1：鸿蒙侧有明确规范数字；22px 与 16px 在手指操作下误触率高。但覆盖面已广，属"补漏"而非"重建"。 |
| **未验证** | 未在真机测量实际命中区。清单基于 CSS 显式 `height` / `min-height` / `width` 声明与 coarse 块的选择器匹配，不代表浏览器最终布局盒尺寸；`.sh-ws-sidebar--closed` 的子元素是否另有更大的可点区域未核实。 |

### 2.5 P2 — 会话列表空态只有一句话，没有出口

| 项 | 内容 |
| --- | --- |
| **现状** | `SessionsSheet.tsx:259-263`：`filtered.length === 0` 时渲染单个 `<p className="ss-empty">`，文案二选一（`general.noResults` / `transcript.noSessionsYet`）；样式 `shell.css:4244-4249` 只是 20px 内边距 + 居中文本。无主操作按钮、无筛选复位入口（搜索框里已有内容时不提供"清空并看全部"）。 |
| **参考** | openchamber `MobileSectionRows` / `SessionDashboardSections.tsx:163-171` 用 `MobileStatus` 组件区分三种态：`loading`（带 `title={t('sessions.loadingSessions')}`）、搜索无结果（`t('sessions.emptySearch')`）、真空（`t('sessions.noSessions')`）——**加载态与空态是两个不同分支**，不是共用一句文案。bitfun `DevicesPage.tsx:406-416` 的空态是带 `aria-labelledby` 的三步引导区。 |
| **差距** | ① 加载中与真空共用同一句（`sessions` 为空数组时也会落到"暂无会话"，用户无法区分"还没加载"和"真的没有"）；② 搜索无结果时没有一键清除查询的按钮（面板底部有"新建会话"，但不在空态附近）。 |
| **可落地动作** | ① 给 `SessionsSheet` 传入加载状态（或由 `sessions === null` 区分），加载中渲染骨架行而非空文案（`TranscriptSkeleton` 已有可复用的 `role="status"` 模式，`TranscriptSkeleton.tsx:26`）；② 搜索无结果时在 `.ss-empty` 下方加一个"清除搜索"按钮，复用已有的 `ss-search-clear` 行为；③ 真空态补一个主操作（新建会话），与底部 `.ss-footer-action--new` 保持一致，不要新造文案。 |
| **分级理由** | P2：可用性瑕疵，不影响完成核心任务。 |

### 2.6 P2 — 会话列表不感知连接态

| 项 | 内容 |
| --- | --- |
| **现状** | `SessionsSheet` 的 props（`SessionsSheet.tsx:40-62`，类型声明在 `:51-61`）没有 `phase` / 连接健康参数；行内也没有任何在线/离线标记。连接态只在 `Banners.tsx:22-45` 的横幅与 `HostManager.tsx:156` 的 `sh-dot-${phase}` 上体现。 |
| **参考** | bitfun `SessionListPage.tsx:1865` 给每行（或列表头）渲染 `session-list__health-dot session-list__health-dot--${connectionHealth}`，`title` 在 `connected`/`checking`/`unreachable`/`unpaired` 之间切换文案；`SessionListPage.tsx:1703` 在列表空态里根据 `connectionHealth === 'unreachable'` 换成"连接不可达"而不是"没有工作区"。`ChatPage.tsx:1387-1389` 把 `remoteUnavailable` 与 `sendBlocked` 分开传给输入条。 |
| **差距** | MusePi 的连接态语义本身比参考更细（`connection-health.ts:26-30` 有 15s 探活、5s 超时、1.2s 重试；`Banners.tsx:22` 的 `blocking = true` 参数还区分了设置页不弹遮罩），但这些判断**没有传导到会话列表**。用户在列表里看到一堆会话，不知道点了会不会连上。 |
| **可落地动作** | ① 把 `phase` 传进 `SessionsSheet`，在 `.ss-card-head` 旁给一个与 `HostManager` 同源的 `sh-dot-${phase}`；② 空态文案在 `phase !== "live"` 且非 `connecting` 时改用"主机不可达"一类语义（需新增 i18n 键）；③ 不要禁用行点击——参考实现也只是标记，不阻断。 |
| **分级理由** | P2：参考实现有、MusePi 缺，但缺失不导致误操作（点了会走既有重连）。 |
| **注** | 这一条不应被理解为"MusePi 连接态做得差"——恰恰相反，协议层更细。缺的是最后一跳的投影。 |

### 2.7 P2 — 错误呈现：原始 `error.message` 直接上屏

| 项 | 内容 |
| --- | --- |
| **现状** | `Composer.tsx:1041` 的 `catch (error) { setSendError(error instanceof Error ? error.message : String(error)); }`，`:1270-1274` 直接把 `sendError` 渲染进 `<p className="sh-composer-error" role="alert">`。没有分类、没有重试入口、没有"是否已提交"的区分。 |
| **参考** | bitfun `chatErrorPresentation.ts:47-70` 的 `describeChatError` 把失败归类并各自给翻译文案：`RemoteHostCommandError`（主机自己的回答，保留原文）、`rpc target unavailable`（`chat.desktopUnavailable`）、`isNotSubmittedFailure`（`chat.notSubmitted`，`:23`）、`isUnknownOutcomeFailure`（`chat.outcomeUnknown`，`:32`）、以及 `classifyRelayFailure` 的 `network`/`relay-unavailable`/`relay-version-retired`/`client-outdated`/`auth` 五档（`:58-64`）。原始 detail 只进 `console.warn`。 |
| **差距** | "消息可能发出去了也可能没发出去"（delivery outcome unknown）与"根本没发出去"对用户是完全不同的决策：前者不能重发。MusePi 把两者都显示成一句原始报错，用户只能自己猜。这直接对应 bitfun `AGENTS.md` 里"Degrade loudly … generic errors are regressions"的约束。 |
| **可落地动作** | ① 在 `packages/client-core/src/lib/` 新增一个 `describeSendError(error): { key, detail }` 分类器，按 `packages/client-core/src/lib/client.ts` 实际会抛的错误类型分支；② 至少区分三档：未提交成功（可安全重试）、结果未知（禁止自动重发，提示"请检查会话后再决定"）、主机主动拒绝（保留原文）；③ 在 `sh-composer-error` 上加一个"重试"按钮，仅第一档显示。需要新增 i18n 键，建议条目见第 4 节。 |
| **分级理由** | P2 偏高的边界：如果 `client.rpc` 能产生"结果未知"，则应升 P1（重复发送会造成重复执行）。**本次未核实 `lib/client.ts` 是否会抛出该状态的错误**，因此定为 P2 并标注待确认。 |
| **未验证** | 上述"结果未知"路径是否存在，取决于 daemon/collab 传输层的超时语义，本次只读 CSS 与 UI 侧，未追到传输层。 |

### 2.8 P2 — 圆角守卫的白名单让 49 处药丸半径绕过了令牌

| 项 | 内容 |
| --- | --- |
| **现状** | `scripts/check-radius-tokens.ts:35` 的 `ALLOWED_RE` 显式允许 `999px`、`9999px`、`99px`、`50%`。因此 `border-radius: 999px` 在 `shell.css` 26 处、`transcript.css` 23 处全部通过检查。`--radius-full` 定义为 `9999px`（`tokens.css:89`），`shell.css` 引用 9 次、`transcript.css` 引用 0 次。 |
| **参考** | 无外部参考；这是仓库内部一致性问题。`tokens.css:79-81` 的注释明确说"`--radius-full` 是 ladder 之外的 pill/circle 别名……一个值同时服务胶囊与小圆点"。 |
| **差距** | 注释说"Reference these tokens only"，守卫却允许裸值。`999px` 与 `9999px` 在超小元素上视觉等价（都会 clamp 到半高），但在 `min-height` 很大的元素上会不同——这是一个潜在的分叉点。 |
| **可落地动作** | 二选一，需产品/架构定：① 把 `ALLOWED_RE` 里的 `999px`/`99px` 移除，只留 `var(--radius-full)` 与 `50%`，然后机械替换 49 处；② 承认 `999px` 是合法写法，把 `tokens.css:79-81` 的注释改成"999px 与 --radius-full 等价"。**不要**只改一边。 |
| **分级理由** | P2：纯一致性问题，无视觉或行为影响。但它让"圆角已令牌化"的结论不成立，所以必须记。 |

### 2.9 已核对但不构成差距的项（避免重复提案）

以下项本次逐条比对后确认 MusePi **不落后**，写在此处是为了阻止后续把"参考实现有"误当成"MusePi 缺"：

- **会话行滑动手势本身**：速度判定、半程吸附、二阶删除确认、`inert` 遮罩、`pointercancel` 兜底，`SessionsSheet.tsx:326-539`（`SwipeableRow` 定义在 `:326`）与 openchamber `MobileSessionSwipe.tsx:126-255` 功能对等（MusePi 的滑动只给重命名与删除两个动作，少归档 / 置顶 / 复制 ID；那是产品取舍而非缺陷，若确需补齐应开独立工单，不在本次体检范围内）。
- **连接健康探测**：`packages/client-core/src/lib/connection-health.ts:23-30` 的 15s/5s/1.2s 三档与前台回探，比 bitfun 的 `useConnectionHealth` 更细。
- **横幅的分场景降级**：`Banners.tsx:22` 的 `blocking` 参数按目的地切换遮罩/状态行（`:38-52` 非阻塞态），参考实现没有等价精度的处理。
- **键盘时序**：`app.tsx:220-238` 已按 `isMobileShell()` 区分 `clientHeight` 与 `visualViewport.height`，并在注释里写明视觉视口差异的原因；`capacitor.ts:175-193` 的 `--mp-keyboard-inset` 与 `sh-ime-open` 类覆盖了 17 处内边距。bitfun `useMobileViewport.ts:10-30` 用三个变量做同类事，精度相当。**未发现可落地的差距。**
- **空态骨架**：`TranscriptSkeleton.tsx:15-28` 已有 layout-only + `role="status"` 的正确写法，问题只出在 `SessionsSheet` 没有复用（见 2.5）。

---

## 3. 分级汇总与建议顺序

| 级别 | 条目 | 一句话理由 |
| --- | --- | --- |
| **P0** | 2.1 滑动动作键盘不可达 | 已实现的功能对一类输入方式完全失效 |
| **P1** | 2.2 行状态对读屏不可见 | 列表页最关键的运行/暂停状态只靠颜色 |
| **P1** | 2.3 动效无障碍 49 处未覆盖 | 违反声明预期 + 常驻无限动画的渲染成本 |
| **P1** | 2.4 4 个控件未被触控兜底 | 鸿蒙有明确规范数字 |
| **P2** | 2.5 空态无出口、加载态与真空态不分 | 可用性瑕疵 |
| **P2** | 2.6 列表不感知连接态 | 协议层已细，缺最后一跳投影 |
| **P2** | 2.7 错误未分类 | 可能升级为 P1，取决于传输层语义是否产生"结果未知" |
| **P2** | 2.8 圆角守卫白名单 | 内部一致性，影响"已令牌化"结论成立 |

**建议执行顺序**：2.3 的「写 `gui-motion-off`」→ 2.4（coarse 块补 4 个选择器）→ 2.1（加 `:focus-visible`）→ 2.2（加 `aria-*`，需先定 i18n 文案）→ 2.5 → 2.6 → 2.7 → 2.8。

理由：前两项是纯 CSS、无新文案、无跨包依赖，可以一次做完并单独验证；2.2 与 2.7 需要新增 i18n 键，应合并成一批走翻译流程；2.8 需要先定方向。

**令牌化本身不要与以上条目混做。** 间距从 91.5% 压到 50% 会触及 6px/10px 是否归并到 4 的倍数这类视觉决策，且改动面覆盖 600+ 处声明，应作为独立工单，并按功能分组（建议从「响应式与断点」开始——它是两份文件里占比最高且规则数最少的组）。

---

## 4. 需要用户可见文案时建议的 CHANGELOG 与 i18n 条目

**本次未改 `packages/coding-agent/CHANGELOG.musepi.md`。** 若上游采纳上述条目，建议在 `[Unreleased]` 下加：

```
- 移动端：滑动会话行可用键盘操作，操作按钮显示焦点框。
- 移动端：会话列表播报会话的运行、暂停与当前选中状态。
- 移动端：开启系统「减少动态效果」后，加载与扫描类动画停止循环。
- 移动端：输入区、后台任务与工作区侧栏的小按钮扩大可点区域。
- 移动端：会话列表区分"加载中""搜索无结果""暂无会话"三种空态。
```

需要新增的 i18n 键（中英成对，键名沿用现有 `settings.*` / `transcript.*` 命名）：

| 用途 | 建议键 | 中文 | English |
| --- | --- | --- | --- |
| 会话运行中 | `settings.sessionRunning` | 运行中 | Running |
| 会话已暂停 | `settings.sessionPaused` | 已暂停 | Paused |
| 主机不可达 | `settings.hostUnreachable` | 主机不可达 | Host unreachable |
| 消息未发出 | `settings.sendNotSubmitted` | 消息未发出，可重试 | Not sent — safe to retry |
| 发送结果未知 | `settings.sendOutcomeUnknown` | 发送结果未知，请先查看会话 | Delivery unknown — check the session first |
| 清除搜索 | `settings.clearSearch` | 清除搜索 | Clear search |

---

## 5. 复算方法

统计脚本按需在 `/tmp` 下临时编写，未进仓库。关键实现选择，供复核者重跑：

1. 先剥离 `/* ... */` 注释（含跨行），再按 `{` / `}` / `;` 切声明。属性名必须匹配 `^[a-z-]+$`。
2. `var(...)` 用括号配对提取，取第一个逗号后的部分作为回退字面量。
3. 分组依据文件中 `/* ---- 分组名 ---- */` 形式的段标记，按声明起始行号归属；段名到功能组的映射见 1.5 的表格。
4. `@keyframes` 内部与 `@media` 条件不参与计数。
5. 动效覆盖率的计算：提取所有声明了 `animation` / `animation-name` 的规则选择器，再取 `@media (prefers-reduced-motion: reduce)` 块内所有选择器做集合差。`@media` 块用大括号配对提取，不能用正则非贪婪——首版即因此把多规则块截断，误报过一次。
