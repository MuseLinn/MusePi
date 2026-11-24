# 主界面 Spotlight 导览设计

> 日期：2026-11-23 · 状态：待批准 · 涉及包：`packages/client-core`、`apps/desktop`、`packages/client/locale`

## Intent

MusePi 已经有一套**模态式 onboarding**（`apps/desktop/src/components/OnboardingOverlay.tsx`）：首次安装弹出，居中卡片，左栏图文、右栏动画演示。它负责把用户配置好（语言、外观、服务商、会话页签、语音），但不负责解释**日常怎么用** —— 用户在 onboarding 里看到的是一段演示动画，看不到自己的界面，也不知道「侧栏那个开关是干什么的」「输入框旁边那几个按钮能点」。

本次要做的是第二层：**把灯打到真实控件上，让用户当场点一次**。用户看完 onboarding 进到主界面，第一件事就是这条 Spotlight 导览。

## 目标

- 用户首次进入主界面时，自动开始一次 5–7 步的导览，每一式高亮一个真实控件，配一行说明。
- 高亮的控件**可以被直接点击/键入**，用户可以在导览里真的打开设置、真的发一条消息。
- 桌面端（`apps/desktop`）与移动/网页端（`client-core` 三端共用）各有一套步骤编排，共用同一个引擎。
- 导览可以随时跳过、随时重播（设置里给一个入口）。
- 不打断、不阻塞：导览不是模态框，它只是盖一层可穿透的遮罩。

## 非目标

- 不改现有 onboarding 的内容与流程（只新增一个「完成后衔接导览」的事件消费方）。
- 不做分步教学视频、不做多语言配音。
- 不覆盖设置窗口内部（那是另一个议题，未来可以复用同一引擎）。
- 不改任何 motion token 的**值**，也不改它们的名字与语义。
- 不给引擎加「替用户打开菜单再高亮菜单项」的能力；需要高亮的东西必须是常驻可测的 DOM。

## 约束

- 引擎写在 `packages/client-core/src/components/guide/`，从 `packages/client-core/src/index.ts` 导出；`apps/desktop` 以 `@musepi/client-core` 依赖引用，不复制代码。
- 焦点管理接进现有 `lib/modal-focus.ts`（`useModalFocus` / `isTopModal` / `modalStack`），不自建第二套焦点栈。
- Android 返回键接进 `lib/back-stack.ts`（`useBackLayer`）。
- 动效只从 `tokens.css` 取：位置过渡用 `--ease-one-take` + `--duration-one-take`，入场用 `--duration-settle` / `--ease-appear`，退出用 `--ease-dismiss`。禁止用 `--spring-*` 做矩形位置过渡（理由见「动效」一节）。
- 层级沿用 `docs/gui-design.md` 的 tour 家族：层 z 200，卡片 z 210。**不新建 z-index 档**。
- 文案走 `packages/client/locale/src/client/{zh-CN,en-US}`，新增 `guide.ts` 域文件，中英成对。
- 所有锚点用 `data-guide="<id>"` 属性，不用 class 选择器，不改既有 class 命名。

## 方案（已选）

1. **选中：引擎放 `client-core`，两端各自提供步骤表。**
   一份 ~450 行的引擎覆盖桌面、网页、手机、Harmony；两端只写各自的 `data-guide` 锚点与步骤数组。符合仓库既有分工（`useModalFocus` 已从 `client-core` 导出给桌面使用）。
2. **只做桌面端（`apps/desktop`）。** 改动面最小，但手机与网页版没有任何变化；两者共用 `client-core`，将来补齐要写两遍。否决。
3. **只做 `client-core`。** 三条移动端链路都覆盖，但桌面 Electron 走的是 `apps/desktop` 自己那套 DOM，用户日常用的窗口反而看不到导览。否决。

选择理由：用户原话是「主界面比设置界面更需要引导」，而主界面恰恰是两端差异最大的地方。只做一端会让同一款应用呈现「一端有导览、一端没有」的完成度落差。

## 设计

### 1. 触发语义（触发二）

「第一次看到主界面」即弹一次，与「全新安装」解耦。

**已看过标记**：`localStorage["musepi-gui-main-guide-done"] = "1"`。键名带 `-done` 前缀与现有 `musepi-gui-onboarding-done` 保持同一命名族。

判定点（两端同构，各自一个 hook）：

```
shouldStart = !localStorage.has(DONE_KEY)
           && 会话已连接（renderer 已拿到 client）
           && 主聊天表面可见（不是面板、不是设置、不是看板/定时/能力中心）
           && 没有别的 tour 族图层占用（onboarding / announcement / global-pause）
           && !document.hidden
```

- **「主界面」= 聊天表面，不要求已打开会话。** 桌面端首次启动时 `ChatView` 挂的是 welcome 场景（`showWelcome = !store`，`apps/desktop/src/components/ChatView.tsx:820`）；把判定卡在「已选会话」会让导览等到用户真的发出第一条消息才出现，违背「进来第一件事」的意图。因此 welcome 场景也算主界面，步骤表用 `optional` / `fallback` 处理只在会话场景里才存在的锚点。
- **不做版本比对。** 不存版本号，所以升级不会重弹；以后若想让所有人重看新版导览，把键名改成 `...-v2` 即可（与 ds-bot 的 `-v1` 手法一致）。
- **老用户升级**：本地没有这个键 → 升级后第一次进主界面时弹一次。这正是「触发二」的含义。
- **让位给其他 tour 图层。** `AnnouncementOverlay` 对非首次运行用户会按更新日志自动弹出，且会在 `musepi-onboarding-finished` 后再次打开（`apps/desktop/src/components/AnnouncementOverlay.tsx:264,284`），同样在 z 200 这一档并自带 `useModalFocus`。两者若同时满足条件，导览会在公告底下抢焦点。因此：引擎提供一个 `GuideGate`（模块级计数 + 订阅），任何 tour 族图层打开时把闸门关上；`OnboardingOverlay` 与 `AnnouncementOverlay` 在已有的打开/关闭处各加一行 `holdGuideGate()`。导览等闸门放开且判定仍成立再开始；若用户已看过则直接写入 done，不排队补弹。
- **与 onboarding 的关系**：`OnboardingOverlay` 的 `finish()` 会在退出动画后派发 `musepi-onboarding-finished`。桌面端导览起点订阅同一事件并**追加 320ms 延迟**，让公告层先决定要不要出现，避免两者在同一帧争 z 序。事件只负责「早一点开始」，不参与判定。

### 2. 步骤表

两端各一个 `steps.ts`，引擎只消费 `GuideStep[]`。

```ts
interface GuideStep {
  /** data-guide 锚点 id；缺省表示本步没有高亮（纯说明卡片，居中）。 */
  target?: string;
  title: string;        // i18n key
  cue: string;          // i18n key，一句话说明「点这里做什么」
  /** 目标整体缺失时的备选锚点，例如面板被收起时改指打开按钮。 */
  fallback?: string;
  /** true = 目标不存在时静默跳过本步，不做降级。 */
  optional?: boolean;
}
```

**桌面（`apps/desktop`）第一批 6 步**：

1. `sidebar-toggle` — 顶栏左侧会话侧栏开关：「这里收起/展开会话列表」
2. `session-tree` — 侧栏会话树：「每个会话是一条分支，可以在这里切换」（`fallback: sidebar-toggle`，侧栏收起或树为空时改指开关；树为空时文案不变，仍指向这里）
3. `composer` — hero 输入框：「像平时一样打字，Enter 发送」（welcome 与会话场景都存在）
4. `model-picker` — 输入框旁的模型选择：「换模型、调思考深度都在这里」（`optional`）
5. `header-panels` — 顶栏右侧视图/面板入口：「文件、终端、看板从这里开」
6. `settings-entry` — 右侧面板轨或顶栏的入口：「外观、服务商、语音都在设置里」（见下文「设置入口」）

**移动/网页（`client-core`）第一批 5 步**：

1. `composer` — 输入框
2. `composer-attach` — `+` 附件按钮
3. `composer-model` — 模型/思考档位胶囊
4. `header-title` — 会话标题（点开会话列表）
5. `tabbar-settings` — 底部标签栏的设置页（仅 `isMobileSurface()`；桌面网页版跳过，改用 `header-panels`）

**设置入口（桌面）**：当前桌面侧栏 footer 已关闭（`showFooter={false}`，`apps/desktop/src/app.tsx:5296`），设置只在 AppRail 的账号菜单里（`apps/desktop/src/components/AppRail.tsx:246`）。第一批**不**做「引擎替用户打开菜单再高亮菜单项」——那是新的引擎能力。改为在右侧面板轨上加一个常驻的设置入口并标 `data-guide="settings-entry"`；若实施时发现面板轨没有合适位置，则本步降级为无高亮卡片，不做永久 chrome 改动。

**交互式适配**（可选，第二批）：某一步可以让用户「当场做一次」，做完自动进入下一步。第一个候选是桌面第 3 步 —— 用户发出第一条消息后自动前进。实现方式：`GuideStep.advanceOn?: "prompt-sent"`，引擎订阅一个 App 注入的事件源。第一批先不做，避免把引导和业务事件耦合。

### 3. 引擎结构

`packages/client-core/src/components/guide/`

| 文件 | 职责 |
| --- | --- |
| `spotlight.ts` | 纯函数：`measureSpotlight(container, targetId)` → 相对容器坐标的矩形；`placeCard(rect, cardSize, containerSize)` → 卡片四档避让。无 React 依赖，可直接单测。 |
| `focus-scope.ts` | `useGuideFocusScope(active, interactiveRoots)`：把 body 下除白名单外的元素设为 `inert`，接管 Tab 循环，注册到 `modalStack` 并处理 Esc。 |
| `GuideOverlay.tsx` | 图层、遮罩、高亮框、卡片、键盘（←/→ 翻页、Esc 关闭）。 |
| `useSpotlightGuide.ts` | 触发判定 + 步骤状态机 + 重播入口。返回 `{ active, step, index, next, prev, dismiss, replay }`。 |
| `index.ts` | 导出。 |

### 4. 测量与定位

坐标系**相对引导宿主元素**，不是全屏：宿主由调用方传入（`apps/desktop` 传 `.gui-shell` 根节点，`client-core` 传 `.sh-app`）。理由同 ds-bot：弹窗/面板有入场动画，全屏坐标在动画期间会偏。`data-guide` 锚点与宿主之间若隔着一次 portal（例如 `#root` 下的浮层），该锚点不能用 —— 浮层里的控件走「用户自己点开后由 owner 登记」，不参与步骤测量。

`measureSpotlight` 规则：

1. `document.querySelectorAll('[data-guide="<id>"]')`，**取第一个可见的**（`getBoundingClientRect()` 宽高都 > 0）。同一锚点可能在两处渲染（例如移动端 Overview 和侧栏），屏幕上那个优先。
2. 取 `getBoundingClientRect()`，四周各扩 `PAD = 6`。
3. 若元素位于滚动容器内（`closest('[data-guide-scroll]')`，由调用方在滚动区上标注），按该容器边界裁剪；否则按宿主边界裁剪，留 4px。
4. 宽或高 ≤ 8px → 视为无效，本步不显示高亮。

`placeCard` 规则（与 ds-bot 同序，改名为项目词汇）：

```
目标在左侧窄栏（left < 220）  → 放右侧
下方放得下                    → 放下方
上方放得下                    → 放上方
左侧放得下                    → 放左侧
都不行                        → 宿主右下角兜底
宿主宽 ≤ 640                  → 通栏贴底或贴顶
```

### 5. 焦点与键盘（接现有栈，但不接管浮层）

- 打开时把 `layer` 推入 `modal-focus.ts` 的 `modalStack`，使 `isTopModal(layer)` 为真，Esc 只在栈顶生效。
- **白名单**：`[当前步的目标元素, 引导卡片, 目标元素弹出的浮层]`。「浮层」由一个轻量的 owner 注册表解决（`registerPopupOwner(owner, popupRoot)`），因为桌面端的菜单、模型选择器都 portal 到 `#root`（`.gui-shell` 的兄弟节点），不登记就会被 `inert` 一起封死。引擎复用与 ds-bot 相同的 `ownedPopups(roots)` 递归思路。
- **浮层不进模态栈。** 桌面 `use-floating-menu` 自己在 `document` 上抓 Escape（`apps/desktop/src/lib/use-floating-menu.tsx:383`），若把浮层也推入模态栈，会与它自己的关闭逻辑打架。所以浮层只享受两件事：**不被 `inert`**、**Tab 可循环**。Esc 在浮层打开时由浮层自己消费（关闭菜单），导览不关；浮层关掉后 Esc 才落回导览。
- Tab 键接管：只在白名单里循环；`disabled`、`inert` 祖先、零尺寸、`visibility: hidden` 跳过。
- 打开时焦点落到卡片；关闭时焦点回到打开前的元素（`useModalFocus` 已有的行为）。
- ←/→ 翻页，仅在焦点不在输入框/文本域/`contenteditable`、且无修饰键时生效。
- Android：`useBackLayer(95, active, () => { dismiss(); return true })`，优先级高于面板（60）低于抽屉（100）。

### 5b. 用户点了高亮控件之后

导览允许真的点，因此必须定义「点了之后表面变了」的三种情况：

- **表面还在**（点开关、点模型选择器）：重新测量当前步，导览保持原位。
- **表面被替换/隐藏**（点设置、点面板入口、点会话树进入会话）：目标在 DOM 里消失。引擎在连续两帧测不到目标时**暂停**——保留卡片与遮罩，把高亮框淡出；表面回来且原目标重新可见时**自动恢复**当前步。用户也可以随时跳过或关闭。
- **点了第 1 步的侧栏开关把侧栏收起来**：第 2 步的目标随之消失，按「目标缺失 + fallback」规则改指开关本身，导览不中断。

暂停/恢复不额外记账，也不要求用户重走已看过的步。判定一律是「目标现在可测吗」。这两个是 `GuideStep` 之外的引擎状态，步骤表不需要新字段。

### 5c. 重播

重播入口在设置里，而设置打开时中间栏被替换、侧栏被隐藏，所有锚点都是 `display:none`。因此 `useSpotlightGuide` 的签名带一个调用方提供的 `returnToChat(): void`：`replay()` 先调用它把聊天表面换回来，等下一帧再测量。移动端 `replay()` 还需要把底部标签切回「聊天」，由调用方在 `returnToChat` 里一并做。重播总是从第 1 步开始，不复用上次的索引。

### 5d. 与「开始使用」清单卡的关系

桌面侧栏底部已经有一张清单卡（`apps/desktop/src/components/GettingStartedCard.tsx`，键 `musepi-gui-getting-started-v1`，四项：外观 / 服务商 / 导入 / 定时任务）。两者都是首次引导，同屏会读成两套指引。

处理方式：**互斥共存**。

- 导览活跃期间，清单卡收起（复用它的 `collapsed` 状态，不改它的持久化语义）。
- 导览结束（走完/跳过/关闭）后，清单卡按自己的状态恢复。
- 两者各自记「已完成」：导览记 `musepi-gui-main-guide-done`，清单卡记自己的键，互不影响。
- **不删除、不合并**清单卡：它指向的是「去配置」的入口，导览指向的是「界面怎么用」，职责不同。

### 6. 动效（不弹）

| 元素 | 曲线 | 时长 | 说明 |
| --- | --- | --- | --- |
| 遮罩入场 | `--ease-appear` | `--duration-settle` (200ms) | 纯透明度 |
| 高亮框位置/尺寸 | `--ease-one-take` | `--duration-one-take` (280ms) | 矩形匹配矩形 |
| 高亮框初次出现 | `--ease-appear` + 轻微 scale .96→1 | `--duration-settle` | 只出现一次 |
| 卡片位置 | `--ease-one-take` | `--duration-one-take` | 与高亮框同步 |
| 退场（全部） | `--ease-dismiss` | 160ms | 图层保持挂载到 180ms 再卸载（对齐 `docs/gui-design.md` 的 Exit 梯子） |
| `gui-motion-off` / `prefers-reduced-motion` | 全部改为 0ms | — | 直接跳到终态 |

**为什么位置过渡不用 `--spring-liquid`**（这条是硬约束，后续改动不得违背）：

1. `--spring-liquid` 是 `cubic-bezier(0.34, 1.56, 0.64, 1)`，过冲约 15.6%。它作用在 `left/top/width/height` 上时高亮框会越过目标再退回，框边会露出下面的界面，按钮与框错位 —— 这不是「弹一下」，是「没对准」。
2. `tokens.css` 已经把两类动效分开：`--spring-*` 表达「已存在的元素形变」；`--ease-appear` / `--ease-one-take` / `--ease-dismiss` 表达「内容到达和离开，两端必须精确落在 0 和 1」。原注释还写明 `--spring-liquid` 的 +15.6% 被四段关键帧依赖，不得重指。
3. `--ease-one-take` 的注释原文是「It owns both ends of a rectangle match」—— 正是这个场景。
4. 这套 token 已经和 `lib/motion-tokens.ts` 的 `oneTakeMotion()` / `motionDisabled()` 打通，动效关闭是全局一致的，不需要引导自己再写一遍判断。

### 7. 视觉

- 遮罩：`color-mix(in oklab, var(--color-bg) 55%, transparent)`，不加 `backdrop-filter`（导览期间用户要看清真实界面，模糊会让人误以为界面不可操作）。
- 挖洞：遮罩自身 `clip-path: polygon(evenodd, ...)` 抠出高亮区；高亮框只画 `1.5px` 的 `--color-accent` 边框 + 外圈 3px 的半透明同色光晕。
- 卡片：L2 float 材质（`--glass-float-bg` + `--glass-hairline` + 卡片阴影），圆角 `--radius-2xl`，宽度固定 304px，内容为 `标题 + 序号 + 一句话 + 跳过/上一步/下一步`。
- 卡片不显示冗余的说明性副标题，只用标题与一句说明（遵循 AGENTS.md 的「层级、克制、精致」约束）。

### 8. 状态持久化

| 键 | 写入时机 | 读取方 |
| --- | --- | --- |
| `musepi-gui-main-guide-done` | 跳过 / 关闭 / 走完最后一步 | 两端的触发判定 |

重播入口：桌面 `SettingsNav` 已经在 footer 放了「引导」按钮（当前打开 onboarding），在同一个位置下方增加一行「界面导览」；移动端放在设置页「通用」分组。重播无视 done 标记，且 `replay()` 会把步骤索引归零（不复用上次的位置）。

### 9. i18n

`packages/client/locale/src/client/zh-CN/guide.ts` + `en-US/guide.ts`，键名：

```
"guide.title"            // 主界面导览
"guide.counter"          // {index} / {total}
"guide.skip"             // 跳过
"guide.back"             // 上一步
"guide.next"             // 下一步
"guide.done"             // 完成
"guide.desktop.sidebar"  title/cue
"guide.desktop.sessions" ...
...
"guide.mobile.composer" ...
```

在 `en-US/index.ts` 与 `zh-CN/index.ts` 注册新域；`satisfies Record<ZhKey, string>` 会保证中英键集合一致。

## 失败行为

- **目标缺失**：`fallback` 存在则改指备选；否则 `optional: true` 的步跳过，非 optional 的步仍显示卡片（无高亮，居中），并允许前进。
- **目标在导览中途消失**（用户点了高亮控件、表面被替换）：导览暂停且保持打开，表面回来后自动恢复；不自动关闭、不写 done。
- **宿主未挂载**：整次导览延后到宿主存在，不静默标记为已完成。
- **localStorage 不可用**（受限 context）：视为「已看过」，不自动弹；手动入口仍然可用。
- **浮层未登记 owner**：被 `inert` 封住，表现为点不动 —— 由契约测试保证每个带 portal 的菜单都登记了 owner。
- **导览中窗口缩放到另一个布局档**（桌面 wide → compact）：重新测量并保持当前步骤；若当前步在紧凑布局下不存在，跳到下一步，不中断。

## 验证

**单元 / 契约（`bun test`，随 `packages/client-core` 与 `apps/desktop` 各自的 test 目录）**

- `measureSpotlight`：正常矩形、滚动容器裁剪、零尺寸返回 null、同锚点多处取可见者。
- `placeCard`：四档避让顺序、窄宿主贴底、兜底。
- `focus-scope`：白名单外全部 `inert`、白名单内可聚焦、Tab 不逃逸、关闭后 `inert` 全部还原、浮层打开时 Esc 不被导览吃掉。
- `useSpotlightGuide`：首次触发一次、跳过写入标记、replay 从 0 开始、目标缺失走 fallback/optional、目标中途消失暂停并在恢复后回到同一步、`GuideGate` 关闭期间不启动。
- 锚点完整性：遍历两张步骤表，断言每个非 optional 的 `data-guide` 在对应源码里存在（与 ds-bot 的 `settings-redesign.test.js:530` 同一手法）。

**真实场景（手动 + 桌面打包版）**

1. 全新 profile 启动桌面 → 看完 onboarding → 进入主界面 → 导览自动出现，高亮在侧栏开关上。
2. 点「下一步」→ 高亮框滑到会话树，**过程中不越过目标、框边不露底**。
3. 在高亮区域里真的点一下模型选择器 → 菜单弹出且**没被遮罩挡住**（portal owner 生效）。
4. 按 Tab → 焦点只在「模型选择器 + 卡片按钮」之间循环，不会跑到背景里的输入框。
5. Esc → 导览关闭，设置页出现「界面导览」入口；重开从第 1 步开始。
6. 手机端（`client-core` 构建）同样跑一遍 1–5，确认底部标签栏那一步只在移动壳出现。
7. `prefers-reduced-motion: reduce` 下所有过渡为 0ms，导览仍可用。

## 留待实施者决定

- 卡片按钮是否用项目既有的圆角/尺寸 token（`--control-*`）还是沿用 L2 float 的按钮样式 —— 跟随 `docs/gui-design.md` 的按钮规范即可。
- 桌面第 5 步指向「视图/面板入口」还是「右侧面板轨」更贴合日常操作，实施时以真实布局截图为准。
- 是否需要在导览期间临时禁用 `PullToRefresh`（移动端下拉刷新会和遮罩冲突），实施时实测后决定。

## 我的判断（实施者可自行调整）

- 导览卡片不提供「上一步 → 下一步」以外的手势（不响应滑动），以免和移动端的 tab 切换手势混淆。
- 遮罩不做模糊（`backdrop-filter`）—— 用户需要看清背后真实界面；这一点与 `docs/gui-design.md` 里「heavy glass 用于 tour」的例外**分开处理**：那一档用于把界面盖住的模态 tour（onboarding），本导览不盖界面，所以不用。定位是「跟用户一起看界面」，不是「挡在界面前面」。