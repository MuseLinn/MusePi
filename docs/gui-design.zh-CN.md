---
layout: default
title: GUI 设计与交互契约
status: living
summary: 桌面端与共享客户端 UI 的视觉、交互、动效和液态玻璃规范。
scope:
  - apps/desktop
  - packages/client-core
lang: zh-CN
---

# MusePi GUI 设计规范

[English](gui-design.md) | 中文

> 本文规定 `apps/desktop` / `packages/client-core` 的视觉、布局、动效与交互标准：界面长什么样、如何组织、如何运动。只用现在时陈述现行行为；决策与被否决的方案在 `docs/adr/`，用户可见的变化在 `CHANGELOG.musepi.md`。
>
> 本文不拥有：实现契约与验证流程（`docs/gui-implementation.md`）、组件与 token 目录（`docs/gui-components.md`，含玻璃 pane 契约）、弹窗（`docs/gui-dialog-spec.md`）、看板与内联卡片几何（`docs/gui-widget-spec.md`）、设置（`docs/gui-settings.md`）、i18n（`docs/i18n.md`）与移动端（`docs/mobile-design.md`）。本文与代码不一致时以代码为准，并回头修正本文。

## 0. 树 / 轨迹术语表

| 术语 | 指代 | 组件/承载 | 备注 |
|---|---|---|---|
| **会话列表** | 左侧栏按分组/项目/日期/定时任务聚合的**会话**（可多选、置顶、标记状态） | `SessionTree.tsx`（文件名沿旧称，职责是列表） | 不叫「会话树」；文档与注释用「会话列表」 |
| **会话/消息树** | **会话内条目树**：entry 的 id/parentId 层级、fork 分支、叶导航（TUI `/tree` 语义） | TUI `tree-selector.ts` + 会话级 `session-manager.ts`；GUI 侧 `lib/message-tree.ts`（`buildMessageTree`） | 与「会话列表」是两层数据：列表管选哪个会话，消息树管会话里怎么分支 |
| **轨迹** | 当前会话的**事件时间线**：turn 分组 + Overview 时间轴 + 检视 + 跳转 | 右侧 ContextPanel「轨迹」tab（`TrajectoryView` + `TimelineOverview`） | 时间投影轴；与消息树同源但投影维度不同 |
| **/trace（规划）** | TUI 中消息树 × 轨迹的融合视图 | 复用 tree-selector 数据源的新命令 | `/tree` 保持纯结构投影 |

**命名铁律**：代码、文档与 UI 文案中，「会话树」只指消息树（`/tree` 语义）；会话语义的树一律叫「会话列表」；时间轴一律叫「轨迹」。

## 1. 布局

### 1.1 原则

- **主要任务优先**：先明确用户的主要任务与主导操作，再加文案或装饰。用布局、留白、对齐、字体和分组建立结构，不用徽章、分割线、嵌套卡片或解释性文字补救构图。
- **文案必须有其作用**：避免不必要的次要标签与描述。不要每张卡片重复区块标题，不要用徽章和句子复述同一状态，也不要把本可由 tooltip、详情页承载的引导长期摆在页面上。
- **克制不隐藏必要信息**：输入用途、不熟悉的操作、有后果的设置、错误与可访问名称必须清楚。渐进披露用于高级选项、诊断与次要元信息，不能用来隐藏主导操作或安全决策所需的信息。
- **精致度是验收条件**：在代表性宽度下检查完整界面，覆盖长文本、本地化内容，以及空态、加载、错误、禁用与键盘焦点。测试通过不能抵消重复标题、意外换行、对齐冲突、嵌套卡面或拥挤控件。

### 1.2 Shell 几何

- **三栏 shell**：左会话侧栏（会话/分组/项目）+ 中聊天列（transcript + 圆角 composer）+ 右 ContextPanel（始终可见）。`gui-shell` 是 flex row；每个全宽 pane（设置与页面目的地）必须 `flex: 1; min-width: 0`，否则会塌到内容宽。
- **应用 rail**：常驻目的地列（`.gui-rail`，`components/AppRail.tsx`）位于面板槽之前，面板收到零宽也不会让用户无路可走。它是**卡片**，与 `.gui-pane-side` 共用 L1 配方与几何（同圆角、同表面、上下边对齐）——透明竖条贴着圆角面板曾读作「空了一块」，而不是第一层。两种宽度：52px 图标条（`--gui-rail-w`，也是 header spacer 减去的值）与 208px 宽轨（`--gui-rail-w-wide`），由品牌头开合。宽轨行显示文字，折叠行不渲染文字，所以改宽度不会重排文本。按钮有可访问名；`aria-current="page"` 标记面板正在显示的目的地；未读点是装饰。目的地为 首页 / 任务中心 / 看板 / 问题与拉取请求 / 能力中心（插件门控）/ 设置。新建与搜索留在面板：它们是动作。每个目的地拥有自己的左列：首页是会话列表，设置是设置导航，看板与问题折叠会话侧栏，任务中心/能力中心换成各自的二级面板。`computeSettingsShellState` 是唯一决策点。
- **rail 底部**：实例菜单、快捷键与远程访问固定在 rail 底部组，面板折叠或切换目的地都不会消失。`InstanceButton` 的 `compact` 变体保留完整 portal 菜单，只显示连接状态点；几何与其它 rail 按钮一致（36×36、`--radius-md`）。`SessionSidebar.showFooter` 在两级 shell 中关闭重复的侧栏 footer。
- **二级面板**：`gui-side-panel.css` 是首页、任务中心、能力中心共用的唯一表面语言——8px 拖拽带、一个整宽主操作、一行紧凑搜索/过滤、扁平命名分组（不套卡片、不加行分隔线）、整宽 hover 行且选中只用一种强调色、一行空态提示。面板不重复目的地标题，也不重复内容区的插画空态。每个 pane 自带槽位 class；`data-panel` 是唯一显隐权威，绝不切 `display`。
- **卡片几何**：所有目的地的浮起卡片（会话、欢迎页、右面板、终端坞、看板、任务、问题、能力中心）共用一套几何。`.gui-chat-surface` 承担 8px 窗口 gutter，里面卡片再承担同样 gutter，所以卡片距列左/右/下三边都是 16px；顶边把 surface 的不可见 gutter 折进卡片，卡片从顶栏下方一个 8px gutter 开始。圆角 `--radius-2xl`（16px）、阴影 `--gui-card-shadow`、表面 `--color-surface`。`.gui-float-card` 覆盖会话/欢迎/右面板，`.gui-page-card` 覆盖页面目的地。Tailwind `m-2`、`rounded-2xl` 与旧单卡阴影在此禁用。
- **等高卡片**：侧栏面板与 `.gui-chat-column` / `.gui-page-card` 是同一张卡片：从 48px rail/顶栏带下方开始，镜像内容列 gutter，半径、阴影、表面一致。卡片线上方是窗口拖动面。`data-panel` 只决定哪个已挂载 pane 生效，绝不切 `display`，否则宽度折叠会丢。
- **窗口拖动**：`-webkit-app-region` 在整个桌面渲染进程只有一个归属文件（`gui-window-drag.css`）。组件用 `data-gui-window-drag="band"` 或 `"off"` 表达意图；Chromium 把该属性当作继承属性，未声明区域的带是死带，交互子树必须显式 `off`。带只画空 chrome；同一元素既是 `band` 又是 `off` 属于矛盾，类型检查直接拒绝（同一属性两个字面量是 TS17001）。portal 浮层在自身根节点排除。原生覆盖式标题栏画在页面之上，每个窗口预留自己的覆盖层避让（macOS 红绿灯、win32/linux 标题按钮）。归属文件之外有三张样式表声明该属性，守卫要求恰好是那三处。契约：`test/window-drag-contract.test.ts`。
- **顶栏共存与 hover peek**：`--gui-rail-w` 是唯一的 52px 宽度，收起时的 header spacer 减去它，会话标题前不会多出空白。没有左面板的目的地隐藏折叠按钮但保留收起值 spacer。常驻折叠按钮位于会话面板左上角，与「会话」标题和新建 split 按钮同行，折叠后屏幕矩形不变。悬停它只打开对应当前停靠面板的紧凑 `MenuPopup`，绝不展开完整面板：首页最多列出 6 个最近会话与新建入口，任务中心最多列出 6 个任务与新建定时任务，能力中心列出三个能力目的地与添加能力。指针宽限 140ms，Escape 还焦。声明 `panelId` 的 rail 目的地仍保留独立完整面板预览：`top: 56px`、`left: calc(--gui-rail-w + 8px)`、`z-index: 42`；rail 空白带与无面板目的地不浮任何内容。`lib/rail-peek.ts` 只负责这条 rail 预览闸门。
- **会话记忆模式**：新建 split 菜单提供普通、新建分组、隐身、临时与导入。空态 composer 在输入框正上方用 chip 提供同一组记忆模式，切换保留草稿。`persistent` 读取并写入长期记忆；`incognito` 只读现有记忆、不学习；`temporary` 不召回也不学习。两种非普通模式都禁用目标循环，聊天记录仍正常持久化。选择写入会话 JSONL 头并在恢复时保留；普通「新建对话」会把下一次新建重置为 `persistent`。
- **侧栏动效**：rail 宽度按 320ms `--spring` 过渡；面板内容保持展开宽度，文本不会重新折行。两层都走同文档 View Transition，类名 `gui-vt-left-col`（不用共享的 `gui-view-transition`，它会捕获输入框）。面板折叠使用 `morphSurfaceClip`：命名面板从 `inset(0)` 裁回常驻按钮的测量矩形，展开时反向，锚点圆角与按钮一致，并通过 `surfaceOnly` 排除根快照。快速连点以最后状态为准，旧转场不能清理正在生效的新转场。hover peek 按 140ms 过渡 `opacity` 与 `translateX(-8px)`；`data-peek-open` 与 `data-panel` 分离，pane 在退出期间保持挂载。减少动效或不支持 View Transition 时直接切换。
- **头部通知**：每条 action toast 同时写入一条纯文本内存历史，最新在前，上限 100 条；不保存 action 回调，历史只跟随当前应用会话。铃铛位于头部右侧动作组，可访问名称包含未读数；零未读不显示徽标，超过 99 显示 `99+`。打开共享 `MenuPopup` 即全部标为已读，列表显示相对时间，并提供空状态与「全部清除」。
- **窄屏 shell**：窗口放不下侧栏 + 会话最小宽 + 已停靠面板时，侧栏改为覆盖式抽屉；阈值由这些宽度计算（`lib/sidebar-drawer.ts`），不是固定断点。关闭时隐藏且 inert，打开时不压缩聊天列。

### 1.3 表面约定

- **设置**：设置壳复用主布局。设置导航填侧栏槽，内容填聊天列，顶部是 48px 拖动带。真实侧栏与聊天在下面保持挂载，关闭设置即恢复工作区，不重挂。内容列以 `--gui-settings-content-max`（840–1080px）居中。
- **工作区页头**：任务中心、看板、问题与能力中心统一用 `WorkspacePageHeader`：一个前置返回、`h1`、可选描述/元信息/动作、可选 tab 行。页面不重写标题几何，也不在尾部再加第二个返回。
- **空态**：欢迎页是 HeroComposer（品牌、问候、提示 + 输入）；输入即建会话。设置 → 通用可替换问候语；空白输入恢复时间问候。品牌、工作区、模式、建议席位都有内置回退，插件接管一个席位时替换而不是复制该控件。欢迎页与会话 composer 共用指针跟随光晕，纯装饰，减少动效时消失。
- **消息流**：用户消息右对齐圆角气泡；助手消息整宽无气泡。桌面 transcript 传空角色 gutter，让行占满宽度；侧边会话与带发送者徽章的行仍保留 gutter。
- **Composer 与文档面**：`conversation.input.left` 芯片与连接器共用输入框上方的状态行，队列芯片同一前对齐。可视 Markdown 用紧凑横向边距 + 36px 工具栏。受管浏览器用真实 URL 判断可见性，等 renderer 就绪再建 guest，关闭以 target detach 完成。HTML 预览相对资源按当前文件解析，但不削弱 sandbox。
- **特性表面**：连接管理、插件市场、插件/扩展控制中心、问题/PR、任务日历、会话地图与轨迹的现行契约分别在 `docs/gui-implementation.md`、`docs/gui-settings.md` 与各自组件测试中；本文只固定它们必须遵守的共享布局、材质与交互规则。

## 2. 设计 token 与主题

- **三个正交轴**：DOM 始终携带已解析值——`data-theme`（明/暗）、`data-accent`（强调色预设）、`data-ui-theme`（独立 UI 预设）。DOM 层没有「system」值。
- **深色文字对比度**：每个深色预设按自身表面亮度推导文字亮度，而不是共用一个下限；正文、次要、弱文字在四种表面上都满足 WCAG AA（≥ 4.5:1），包括浮层。浅色主题不变。契约：`test/theme-contrast.test.ts`。
- **密度**：`--gui-density` 是无单位系数（`1`、`0.85`），CSS 用 `calc(32px * var(--gui-density, 1))`。触控控件最小命中 44px。
- **几何与层级**：间距、控件尺寸与 `--z-dropdown` … `--z-tooltip` 阶梯在 `tokens.css`。语义文字别名解析到前景层级。组件局部层叠与装饰色在不逃出容器时可留在本地。`scripts/check-css-tokens.ts` 检查语义颜色引用已定义。
- **圆角**：六级阶梯 `xs 2 / sm 4 / md 6 / lg 8 / xl 12 / 2xl 16`，另有 `--radius-full` 服务胶囊与圆形。同心规则：子半径 = 父半径 − 父内边距（16−4→12−4→8−2→6）。授权 CSS 禁止字面量 px 半径；`scripts/check-radius-tokens.ts` 在 `check:tools` 中运行。卡片与面板用 `lg`，弹窗与浮层用 `xl`，全屏 sheet 用 `2xl`。卡片保持 `1px solid var(--border)` 与表面填充。
- **字体**：UI 默认衬线 + 内置 Maple Mono NF CN 等宽；可变 Inter/JetBrains Mono 来自 `@fontsource-variable/*`。代码块字号跟随 `--gui-code-size`。
- **玻璃**：`gui-vibrancy` + `--gui-glass-overlay` 透明度；关闭透明时 overlay 100% 覆盖所有半透明规则。浮层 pane 使用唯一 `gui-liquid-glass` 材质（tint、亮带、暗线、外发丝、18px 抬升），契约在 `docs/gui-components.md` §玻璃 pane。L1/L2/L3 卡片阶梯与弹窗材质也在 `docs/gui-components.md`；换强调色不改玻璃阶梯。
- **主题自带强调色**：每个 `UiThemeId` 提供 `--theme-hue`；`data-accent="theme"` 据此与当前明暗的亮度/前景色解析整族 `--accent`。品牌、单色、海洋、翡翠、自定义 hex 仍是显式覆盖。卡片填充、hairline、rim、hover 与会话羽化带都由当前主题的 `--bg-*` / `--fg` 派生，不写死 hue。契约：`test/theme-palette.test.ts`。
- **渐进模糊**：transcript 上下带叠三层 backdrop（整带 2px、内侧 62% 6px、内侧 34% 14px，mask 逐层更短），模糊强度向边缘递增，而不是画一块不透明色。头部与带共用 `--gui-card-surface-veil`，表面连续。`@supports not (backdrop-filter)` 回退不透明渐变。契约：`test/progressive-blur-dock.test.ts`。

## 3. 动效

| 场景 | 组件 | 机制 |
|---|---|---|
| 条件块（显隐跟随另一个选项） | `<Reveal open>`（`components/Reveal.tsx`） | 240ms `cubic-bezier(0.22,1,0.36,1)` 折叠高度 + 160ms 淡入；关闭态 `aria-hidden` + `inert`，节点常驻（销毁用 `HeightMorph`） |
| 已挂载但高度变化（切 tab、列表增长） | `<HeightMorph morphKey>`（`components/HeightMorph.tsx`） | 记录旧高 → 提交新内容 → 过渡高度 → 落到 `auto`；同样的 160ms 淡入按 key 重来；morph 期间用 `overflow: hidden` 裁剪，否则新内容立即填满、只看到盒子边缘移动；高度不变时跳过 pin，避免滚动条消失 |

- **HeightMorph 铁律**：子节点直接渲染进带 ref 的外层，不包中间 div——调用方传自己的布局 class，包一层会让 grid 只剩一个子节点。morph 由共享 JS 弹簧（`client-core/lib/spring-motion`）驱动，不用 CSS transition：贝塞尔只是时间的函数，无法同时表达过冲与落定。过冲随高度差缩小，以像素封顶（2–12px）。弹簧收敛即释放 pin，不等硬上限。
- **禁止**用 `grid-template-rows: 0fr↔1fr` 折叠（单向动画，见 `useCollapse`）；分区切换是定高容器。**凭据表单这类关闭须销毁的内容改用 `HeightMorph`（key 收敛 `null`）。**- **时长**：高度/morph 240ms `cubic-bezier(0.22,1,0.36,1)`；淡入 160ms ease；KITT 1.7s 同曲线；控件状态 120–140ms `ease`。应用点：条件项、模型 tab、网格、分区切换。

### 气泡入场（已发消息，2026-11-24）

发出的消息就地落下：执行过渡的是转录里出现的那个气泡本身，屏幕上没有任何东西在飞。

- **一次短入场。** 在转录首次绘制之后出现的用户行带着 `data-enter`，只播一次：240ms，上浮 6px 并从 0 淡入到 1，曲线 `cubic-bezier(0.22, 0.61, 0.36, 1)`。结束时就是行的常态，落定后不保留任何变换。
- **只认新行。** 转录把行 key 与上一次渲染做差集；滚回虚拟窗口的历史行本来就有 key，不会被重新标记，切换会话只重新建立基线、不会让历史重播。
- **身份仍然重要。** `entryViewKey` 让用户行按 `requestIdentity`（`msg:<clientId>:<clientRequestId>`）做 key——与 daemon 写在持久化消息上的字符串一致；因此乐观行与 ack 后的权威条目是同一个 DOM 节点，ack 到达时入场不会重播。
- **关闭开关。** `prefers-reduced-motion: reduce` 与 `.gui-motion-off` 直接去掉动画，气泡正常出现。

### 视觉验证改动

`bun apps/desktop/scripts/gui-probe.ts <场景.tsx>` 用真实组件装配真实样式表渲染，返回截图与结构化测量；场景自己声明期望的测量，所以一次运行回答的是「这还对吗」而不只是「这是张图」。改组件或任何 `gui-*.css` 时都用它——盒子和计算属性解释布局，图片只能展示布局。流程、场景写法与已内置的坑见 `.agents/skills/musepi-gui-visual-probe/SKILL.md`。

### 全表面视图切换与关闭开关

`.gui-view-enter` / `.gui-view-leave` / `.gui-slot-leave` 与 keeper 的 `--enter` 修饰符是应用里唯一一次全表面过渡：进场 300ms、退场 150ms，两者都在动 `filter: blur()`。模糊半径每帧变化都会让整个表面重新光栅化，所以这是 GUI 里最贵的一支动画——在此之前它也是唯一没有关闭开关的一支，于是没人分得清是动画卡住还是布局卡住。

- **两个开关都生效。** `.gui-motion-off` 与 `prefers-reduced-motion: reduce` 给进场类设 `animation: none`，切换变成瞬时。
- **退场的表面同时落到 `opacity: 0`。** 退场关键帧收在 opacity 0 且 `fill: forwards`；只去掉动画，离场表面会在 JS 保留它挂载的那 150ms 里完整可见，所以关闭态必须自己写出终值。
- **keeper 永不模糊。** 靠切换 `display` 隐藏自己的元素，每次显出都会重启动画，所以把入场动画放在 keeper 基类上就会每往返一次重播一遍。keeper 的状态靠保留 DOM 维持，而不是靠重播入场：设置栏 keeper 不动任何动画，备选页 keeper 用 160ms 透明度淡入（`gui-keeper-reveal`）显形。它们此前共用 `gui-view-blur-in`，也就是每次关掉设置都要把整列离屏光栅化一次。真正的视图进场保留模糊。
- **由** `apps/desktop/test/keeper-entrance-motion.test.ts` **守住**。

## 3a. 状态过渡

状态文案是固定槽，不是出现又消失的块。`StatusText`（`packages/client-core/src/components/shell/StatusText.tsx`，共享样式在 `shell.css`）是唯一实现：旧串与新串共用一个 grid 单元，按 `--gui-motion-fade-out` / `--gui-motion-fade-in`（160ms）交叉淡入淡出，配 `--gui-motion-slide-y`（6px）。`gui-motion-off` 与 `prefers-reduced-motion` 直接切换，不留离场层。外层拥有 `role="status"` + `aria-live="polite"`，离场串 `aria-hidden`，`text: null` 清空。不重挂、不跳高、不闪烁。

- **每个状态一个计时器，绝不累计**：进入新状态重启窗口，早先状态的时间不计入新状态。预算写在状态旁。可以有与阶段无关的兜底，但必须远长于任何单阶段预算。
- **三级、一条升级路径**：`normal` → `slow` → `stalled`。`slow` 只说明仍在进行，不判定失败、不猜原因、不显示恢复控件。只有 `stalled` 可以提示 daemon 卡住并提供「导出诊断 / 重启」。正常等待绝不读成错误。
- **文案描述当前状态，不描述用户的耐心**：状态行说正在跑什么，异常行说停在哪里。累计时钟不能把进行中的操作写成诊断。

**启动页**（`StartupSplash.tsx` / `useBootStatus`）是参考应用：`probe` / `spawn` / `gate` / `connect` 各有预算（`BOOT_TIMINGS.budgets`：8s / 20s / 15s / 8s），两个阈值在每次阶段切换时重置；某阶段超过 `budget + 15s`，或启动超过 60s，升级为 `stalled`。阶段与提示是两个 `StatusText` 槽，放在固定宽度的居中列里，正常的多秒版本门只显示阶段，稍后显示信息性提示。

## 3b. 转录尾部的在场行

回合在跑、还没有回复时，站在「回复将要落下」那个位置的这一行是 `TailPresence`（`packages/client-core/src/components/transcript/TailPresence.tsx`，样式在 `transcript.css`）：agent 的头像、它此刻在做什么、以及本回合已用的时间。它取代了那个槽位里只有计时的旧行，同一个锚点现在还会说明在做什么。它是唯一实现；再出现第二份这样的行就是缺陷。

- **字形永不动。** 扫光是一个软边遮罩窗口朝一侧扫，窗口里的亮色副本反向补同样多，所以屏幕上只有光在走。只让亮色副本自己动就是走马灯——这正是本设计要避免的失败形态。位移只占周期的前 35%，用 `steps(12, jump-none)` 步进，其余时间静止：跑几分钟的回合不能每帧重绘整页。`background-clip: text` 配动画 `background-position` 同样能让字形不动，但会每帧重绘字形，所以这里不用。
- **永远单行、省略号截断。** 这是状态提醒而不是正文：`nowrap` + `ellipsis`，绝不换行。完整文案在行的 `title` 与展开卡里；live region 承载未截断的规范句，所以截断不会让读屏丢失语义。
- **轮换不重复播报。** 同义句每 4–6 秒换一次，按会话种子错开，同屏两行不会齐步换句。可见文案是 `aria-hidden`；只有一个 live region 承载规范句，并以阶段为 key，所以只有「工作内容变了」才会播报。
- **沉默只陈述，不诊断。** 超过 30 秒没有新输出就加「暂无新输出」，超过 90 秒还会说多少分钟。没有「卡住」、没有重试、没有恢复控件——§3a 的规则原样适用。
- **轨迹分三层读。** `TurnTracePanel`（`packages/client-core/src/components/transcript/TurnTracePanel.tsx`）回答「时间花在哪」，但不画绝对时间轴：先给一个回合总时长，再给一条**按回合跨度**画的分配条（工具 / 模型 / 其余，其余就是排队与等人），然后是回合内的**请求轮**——一次模型请求加上它触发的工具，轮与轮之间一条细线。步骤的条表示**量级，并按本回合最长步骤缩放**：同一个回合里 23ms 和五分钟可以并排，绝对轴会把每一根条都压成看不见的细丝。模型名只在第一次与切换时出现，其余轮显示「请求」——中途换模型是信息，重复同一个 id 是噪音。数据从转录派生（`turn-trace.ts`，纯函数），客户端已持有整轮，所以没有 RPC、没有第二份存储；桌面端只提供弹窗外壳，标题由面板自己给，因为 `DialogFrame` 只带无障碍标签。没有记录的步骤只计数并标注，绝不画成零宽。

- **折叠关闭的回合仍然报出失败与工具耗时。** 活动头会数出失败的调用，并累加工具结果自身的 `durationMs`（「工具耗时 42.0s」，不足一秒不显示）——「这轮用了 90 秒」说不清时间花在哪。两者都只读真正记录了数据的行：早于工具耗时落盘的 journal 不贡献任何值，绝不当作 0 把总数稀释。失败的调用同时从折叠的隐藏区间里豁免——失败是这轮走向的原因，不是过程的一部分——所以不必展开也能看到哪一步断了。

- **身份与详情由宿主注入。** `tailAvatar` 与 `tailDetail` 来自调用方：client-core 不得去取桌面端的 `AgentAvatar`；移动端与子代理面板两个都不传，退化为文案加计时。`approvals` 与 `paused` 同样由宿主提供，因为转录本身不接收它们；不传时那两个阶段就是不可达的。

## 4. 组件与设置模式

- **设置行**:`gui-settings-row` = label+desc 左、控件右;`PrefToggle`(开关,`storageKey` + 可选 `onClass` 反相挂 documentElement)/`PrefSegmented`(分段选择)是两个标准控件,新设置优先复用。每个设置独占一个兄弟行，不得把一个设置嵌进另一设置的行内。所有数组编辑器(胶囊、优先级、值列表、JSON 列表)按内容定宽且较宽,独占标签下方整行,不再挤压标签列。
- **分段控件 = 单一滑块(2026-09-21)**:所有多选一都渲染共享的 `Segmented`(`packages/client-core/src/components/shell/Segmented.tsx`,样式在 `guest-client/src/styles/tokens.css` § Segmented control)——不要再新写 `.gui-segmented`/`.gui-seg-btn` 一行,也不要让每个按钮各自换背景(N 次重绘 + 硬跳;滑块只是一次合成的 transform)。几何契约:段为 `flex: 1 1 0` 且**没有 gap**,所以滑块宽恰为 `calc((100% - 4px) / var(--seg-count))`,并以自身宽度步进 `translateX(calc(var(--seg-index) * 100%))`;React 只写 `--seg-count`/`--seg-index`,其余几何归 CSS。手感规则:悬停**预览**落点(`thumbIndex = hoverIndex ?? activeIndex`),点击只是落定;transition 在挂载后一帧才 arm(`gui-seg--armed`),否则每个控件都会从第 0 格滑进来;重复点击的抖动动画用独立 `translate` 属性,绝不用 `transform`——`transform` 存着段位移,动画它会让滑块弹回第 0 格;`gui-motion-off`(设置 动效 → 关闭)与 `prefers-reduced-motion` 都会去掉滑动。变体:默认(拉伸到 `max-width: 260px`)、`gui-seg--compact`(贴合内容——弹层、预览条)、`gui-seg--icon`(纯图标,顶栏主题开关)。键盘:roving tabindex + ←/→/Home/End。标签永不被裁:等宽段共享同一个宽度,所以组件量出最宽标签及其 padding、图标和间距（不计入拉伸产生的空闲空间），把内容所需宽度写进 `--seg-min`,CSS 用它把控件下界定成 `var(--seg-count) × var(--seg-min)`(`min-width` 压过 260px 上限)。否则 `flex: 1 1 0` 的自动宽容器分的是各标签宽度**之和**——右栏任务面板的「运行中」+「全部」正是这样被裁的。两选项的 `GuiSelect` 会自动渲染成它,二值设置无需额外处理。不适用:多选 chip 行(一个滑块表达不了 N 个选中);变宽 tab 条不用共享的等宽控件,而是自己的实测滑块——SessionSidebar 的分组/项目胶囊按标签定宽、按当前 pill 实测滑块位置,并用一份隐藏的标签副本判断整行是否还放得下文字,放不下时整条胶囊 morph 成纯图标 pill(tooltip + `aria-label`)。
- **TUI 设置同步(2026-08-11,合并进既有 tab)**:TUI 设置面板 10 个 tab 的 **336 项配置全部并入桌面设置**,不设独立"TUI 设置"页——**有对应 tab 就合并,没有就新增 tab,需要更名的更名**:外观(并入,原生主题卡 + schema 30 项)/模型设置(并入,角色模型 + schema 44 项)/任务与子智能体(原"子智能体"更名,并入 tasks 28 项)/新增 交互(41)·上下文(27)·Shell(16)·工具(60)·供应商(36);文件与 LSP、记忆 保持独立 schema section。全部 **schema 驱动**(daemon `settings.schema` RPC,与 TUI 同源)。控件按设置语义选择(`SchemaSettings.tsx` 的 `settingsControl`):boolean→toggle / enum→select(无 options 的 enum 由 daemon 合成;两项时渲染共享分段控件)/ string→input(凭据掩码保留)/ **带 `ui.options` 的 number→刻度阶梯**(每个预设一个档位,滚轮/拖动/方向键只能落在受支持的值上;当前档位标签常驻,存储值不在预设中时单独成档)/ **自由 number→滚动数字**(数字以滚轮列滚动、滚轮/方向键步进、拖动改值、点击键入;遵循 `ui.min/max/step`,否则每超过四位数字进一档——4 位端口步长 1、6 位超时步长 100)/ **声明式数组成员→胶囊/优先级列表**（优先级行用与右侧面板标签相同的 dnd-kit 拖拽：仅把手起拖、行抬起、落点实时让位；键盘聚焦把手后空格抓取 + ↑↓ 移动） / **自由数组→字符串逐行编辑,`ui.item: "record"` 用 JSON 列表;绝不逗号拼接**(逗号属于值本身:`bash.patterns` 正则、`prompt.sections` 文本)/ record→紧凑 JSON 输入(非法 JSON 内联报错,不提交);改动 `settings.set` 乐观写入、失败回滚。搜索框通过一次 `settings.schema {all:true}` 索引所有 schema 行：匹配的设置项列在页面导航之上，点击后打开所属页并把 `[data-setting-key]` 居中、闪一次高亮。存储值偏离 schema 默认值的行在标签行显示重置箭头（与 TUI 的 `changed` 对齐）；凭据行与无默认值行不显示。条件门控 CONDITIONS 与 TUI settings-defs 对齐(11 个;`hasImageProtocol` 在桌面恒真)。**i18n 全量中文**:从 coding-agent i18n 移植 966 条翻译进 guest-client zh-CN(标签/描述/选项/分组;模型/供应商/音色等专有名词保持原文,与 TUI 一致);未覆盖项回退英文。行为抽查:textVerbosity low≈150 字 vs high≈250 字(GUI→daemon→会话行为链路生效)。**重复定义审计修复(2026-08-11)**:①语言单源——`settings.locale`(config.yml)为唯一源:boot 经 `settings.get` 同步渲染器 locale(daemon 对未配置的 `settings.locale`/`defaultThinkingLevel` 不回填 schema 默认值,防止未配置时把中文 UI 强制切英文),常规语言 select 与交互 tab「界面语言」行均双写 RPC + localStorage 镜像;NAV_GROUPS 改渲染期求值(原模块级常量冻结首语言);②思考层级——删除 `musepi-gui-default-thinking` localStorage 镜像,HeroComposer 预选改为 boot 快照:`modelRoles.default` 的 `:level` 后缀优先(off→关闭思考),否则回退已配置的 `defaultThinkingLevel`(auto 允许),未配置保持 medium;boot 同时剥离后缀给模型预选;③`options:"runtime"` 的 schema 行(theme.light/dark)GUI 渲染为只读输入(防键入非法主题 id 写坏 config.yml),提示「选项由 TUI 运行时提供」。**导航去重合**:「智能体」更名「运行中智能体」(实时 roster,agents.list 2s 轮询)与「任务与子智能体」(tasks schema 配置)明确区分——两者内容本不重叠,命名消除混淆。**设置页 roster 全面移除(2026-08-11)**:「运行中智能体」设置 tab 与「任务与子智能体」内嵌 roster 均删除——live roster 由会话右栏 ContextPanel 的 AgentsPanel 承载(session stream 驱动的实时 HUD:主/子行、状态、活动、相对时间、进度/生命周期,比 agents.list 轮询更丰富);设置页回归纯配置语义。swarm GUI 盘点(对比 kimi-code apps/kimi-web):kimi 有转录内联 SwarmTool 卡片(成员手风琴+阶段点+概览条+done/total)、AgentDetailPanel 详情面板(暂停原因/流式输出/进度组)、ChatDock+TasksPane 底部 dock;我们现有右栏 AgentsPanel HUD + task/yield 工具卡片渲染 agent results,无转录内联 swarm 卡片、无详情面板。**task 工具卡升级为 SwarmTool 级(2026-08-11)**:头部 done/total chip(聚合失败红显)、body 顶部阶段概览(分段条 done/merge-failed/running/failed/aborted 五段 + legend)、成员行首阶段色点(running 脉冲)、每成员手风琴(点击 chevron 展开完整输出/错误/patch;已结束成员默认折叠,有详情才渲染 chevron);数据全部来自既有 TaskToolDetails.results/progress,无新数据管道。SSR 6 测试 + CDP 实测(2/2、3/3 chip、ok/run dots、chevron 展开 alpha 输出)。后续打磨:无内容的任务清单行(只有 #N 无 description)不再渲染空行;live/settle 时 AgentProgress 高级字段(retryState/extractedToolData/inflightTaskDetails)尚未消费。

**桌面子代理操作(2026-08-11, TUI Agent Hub 对等)**:daemon 新增 RPC `agents.kill`(abort + release tombstone→aborted)/`agents.revive`(ensureLive)/`agents.chat`(ensureLive + prompt steer,与 collab host 的 agent-cmd 同构,server.ts agents.list 旁)。GUI 右栏 ContextPanel 的 AgentsPanel 选中行后渲染 AgentControls 操作条(apps/desktop/src/components/AgentControls.tsx):running→停止、parked/aborted→复活、chat 输入框(Enter 发送),错误小字展示。collab guest 走 agent-cmd 帧,桌面走 RPC——两条路语义一致。SDK events.ts 的 agent-progress payload 注释修正为 SubagentProgressPayload 包装(daemon 实际发送形状)。RPC 实测:kill idle→{ok}+ref aborted、kill/revive 错误路径、chat→ensureLive+steer 生效;running 态 kill 时序窗口未抓到(step-3.7-flash 子代理完成过快),abort 路径与 collab host 同构。**i18n 补全**:schema 全部 UI 字符串覆盖 100% 可译项——标签/描述/选项标签/选项描述全量中文(新增 ~240 条手译,复用 coding-agent zh 78 条),仅剩专有名词(模型/供应商/音色/硬件/API key 名/数值)保持英文与 TUI 一致;zh-CN.ts 经 biome --write 全量格式化。
- **设置键名**:一律 `musepi-gui-*`(如 `musepi-gui-chat-usermsg`、`musepi-gui-statusbar-indicator`);类开关类偏好(如 `gui-chat-hide-time`)在 documentElement 上切换,样式写在 gui.css 的偏好区。
- **设置 → 检查更新(2026-08-22)**:行内展示「当前版本 / 状态(检查中·已是最新·发现新版本)」+ 手动检查按钮;发现新版时在 desc 下方展开**更新说明摘要 + 明确的「前往下载」按钮**(不自动 window.open 弹浏览器)。启动自动检查(主进程 12s 后)推送的更新提示是**右下角 toast**(`UpdateToast`):版本(当前 → 最新)+ 说明 + 「前往下载」/「跳过此版本」(按版本 localStorage 记忆,bitfun parity)。**两条说明链路独立**:toast 读 `update-manifest.json.notes`(OTA 渠道),「新功能」弹窗读 `CHANGELOG.musepi.md`,发版都要填。manifest 只有一份中英混排字符串,toast/弹窗/设置里的更新行按当前界面语言用与「新功能」相同的 `- EN:` 规则选一种语言。实现细节见 `gui-implementation.md §17`。
- **预览模式**:配置项带实时预览——外观页把应用场景直接放在页首当**头图**(真实左栏 + 会话卡 + 右侧栏,会话卡内是真实胶囊/转录行/输入卡且用完成回合的收起态折叠行),其余页用聊天或语音预览;一律复用**真实渲染组件** + 示例内容、由选项状态驱动,不要造静态假预览。
- **状态条**:braille/球体指示器(`--gui-status-accent` 会话色,TUI djb2 哈希移植)+ 流光/KITT/简洁文字效果;KITT 是文字渐变亮带(非独立条);扫光颜色可选默认色调/强调色。
- **暂停 UI(2026-08-20,与 TUI /pause 同 gate)**:两级暂停,状态来自 daemon(重连/重启不丢,见 gui-implementation.md §1c)。**全局暂停** = 全屏磨砂遮罩 `GlobalPauseOverlay`(`.gui-global-pause`,active 态遮罩 + 居中卡片:暂停图标 + "已暂停"标题 + 实时计时 `formatPauseElapsed` 分:秒,`data-paused-at` 锚定 pausedAt 不随组件重挂清零);header 暂停按钮发 `daemon.pause/pauseRelease`。**会话级暂停** = ChatView 内 banner + 实时 hold 计时(同样锚定 pausedAt),header 会话暂停按钮发 `session.pause/pauseRelease`。两级互不干扰:会话暂停只冻该会话(每会话独立 AgentPauseGate),全局暂停冻全部会话(进程级 gate,agent loop 先查全局再查会话)。暂停中会话 `working` 显示为 false(列表/树 paused 徽标同源)。恢复 = 重新拉 `pauseStatus` + 订阅流 `pause-state`/`global-pause-state` envelope 驱动。
- **输入框**:Composer/HeroComposer 共享 `autosize`(data-focused 感知);专注模式 morph 必须用 `useLayoutEffect`(passive effect 会先画一帧全宽再回跳)。
- **专注模式输入框形变（⌘⇧E）**：输入框是在**改变形状**——紧凑框长成全高编辑器。浏览器支持 View Transition 时，切换在该 transition 里完成：wrap 在窗口期内带 `view-transition-name: composer-surface`，由一个合成组完成矩形形变，两侧快照各按自身尺寸绘制——这是「一镜到底」标准，不是手写的 height/translate 双动画。不支持该 API 时才走下面的 WAAPI spring 回退；在 transition 内会跳过 WAAPI 并冻结 CSS height 过渡，避免两条动画同时写 height（这正是最初掉帧的原因）。这些转场都是"仅共享面"：root 快照被丢弃，窗口其余部分不参与交叉淡化（整窗淡化看起来就是闪一下）。spring 语言不变：`springEasing({ visualDuration: 0.28, bounce: 0 })` 采样成 `linear()` 停靠点，驱动 WAAPI 动画。这里是**临界阻尼**、刻意不过冲：输入框贴着底边，任何过冲都会把上沿顶出正在长入的表面，收敛过程读作「撞到窗口边缘弹回来」；空态表单同样是 280ms、零过冲，两种状态必须同一种观感。该动画走 WAAPI，CSS 的 `@media (prefers-reduced-motion: reduce)` **管不到它**，所以减少动态效果的判断在 JS 里显式做，并在钉住任何东西之前就返回。快速连按toggle 会 `anim.cancel()` 取消在飞的那个动画，而不只是挡住它的 release 回调——两条动画每帧写同一个 height 正是当初帧率崩掉的原因。`gui-composer-wrap--morphing` 标记则压住 wrap 自身的 CSS `transition` 与 textarea 的自动长高过渡，避免形变期间同一属性被双驱动；它同时让写 composer inset 的 `ResizeObserver` 在形变窗口内静默——逐帧发布会让整个视图重渲染并重新测量虚拟转录（空态没有这个 observer，所以从不掉帧）。目标 inset 在形变开始时（钉住目标高度后）发布一次，release 时再发布一次。

- **图片预览是一镜到底的共享面**：输入框附件、会话图片画廊与「预览→画板编辑」都在 surface-only View Transition 里完成（root 快照丢弃，不会整窗闪）。lightbox 舞台带 `composer-image` / `transcript-image`，画板带 `sketch-stage`；不支持该 API 时回退到 WAAPI 飞行或普通淡出。草稿/画板图片同样预览优先：单击打开预览，编辑按钮（或双击 chip）再进画板。图片组是替换而不是交叉淡化（丢弃旧快照），缩略图的玻璃/强调色不会在入场或出场时盖在照片上；预览→画板由宿主在同一个 update 里关闭 lightbox——lightbox 自己先关会启动第二次转场。欢迎页 ⇄ 会话的输入框是一个常驻宿主（openchamber 的布局）：wrap 挂在场景层之下、按当前卡片实测定位（所以 session-info 侧栏收窄列宽也会跟随），两张卡片只是它背后的表面。翻转时移动的是这一个节点（translate FLIP），卡片在它周围交叉淡化——不会再挂第二个输入框，也不会用 View Transition 去配对两套皮肤；草稿、附件、焦点都留在同一个节点上。欢迎座位把 wrap 撑满卡片，由 hero 根节点自己居中内部区块（与它还住在卡里时一致）；会话座位贴底，专注模式仍留在流内（宿主盒沿用卡片高度，尺寸形变的目标高度与以前一致）。飞行以输入卡本身为锚点而不是座位：欢迎座位比它居中的卡更高，真正被看作移动对象的是卡片自己的矩形。卡片入场只做透明度，也是同一个原因——会让卡片上移的入场动画会在飞行下面拖动被测的宿主。`surfaceOnly` 现在是有命名面的形变的默认值（含对话框）；只有普通布局转场（`withViewTransition`）默认保留整窗交叉淡化。
- **空态强调是一次入场而不是常驻循环(2026-11-07;2026-11-10 改为页面入场触发)**:欢迎页显示后让输入框光带跑 3 秒后停止——聚焦输入框不再重新触发,锥形渐变重绘不再和输入抢帧——专注模式完全不显示。创作类型 chip 各带一个图形,chip 排靠扫视即可区分;产物画廊在扫描到多种类型时才出现类型筛选。
- **右键菜单(统一标准组件)**:所有悬浮右键菜单(会话/分组/项目块/列表项)一律用 `ContextMenu` 组件(`.gui-context-menu`,磨砂玻璃:bg-overlay + blur(24px) saturate(180%) + 分层阴影 + 130ms gui-menu-in/out,portal 到 root)——**不另造菜单样式**;条目 = 图标 + label + 可选 hint/divider/danger/disabled/color 圆点(分组颜色选择器用 `color` 属性 + `gui-dot`)。操作入口归属:会话=固定操作;分组=重命名/颜色/删除;项目块=打开文件夹(文案跟随系统:资源管理器/Finder/文件管理器)、复制路径、工作目录、移除项目(移除入口在右键菜单,不单独放行内删除按钮)。悬停项目行时显示三个紧凑动作——编辑(隐式项目为“转为托管”)、更多、在该项目新建会话——覆盖在计数上,长项目名的截断宽度不因悬停变化。**行内编辑**(如分组重命名)用专用紧凑类(`.gui-group-edit`:13px/500、line-height 20px、padding 1px 4px、透明底 + accent 55% focus 细边)——全局 `.gui-input`(8px padding + 边框 ≈ 38px 高)会让行内编辑态膨胀突变,禁止用于行内重命名。
- **悬停显示的行内操作(单一契约)**:项目行、会话标签、建议行显示尾部操作都遵循同一规则。指针悬停显示;控件获得 `:focus-visible`(键盘)时也显示;菜单打开时用 `data-open` 显式保持。**禁止 `:focus-within`**——鼠标点击后焦点留在行内,指针移开操作条仍常驻。控件在透明时保持 Tab 顺序(`opacity` + `pointer-events`,不用 `visibility`/`display`),键盘仍可到达,聚焦即显示。兄弟读数——项目计数、标签状态点、label 右侧留白——必须使用完全相同的状态集合;操作条显示时不得与仍然可见的读数重叠。现有三个消费者(`.gui-project-actions`、`.gui-session-tab-controls`、`.gui-suggest-row-actions`);第四个必须复用该契约或抽出原语,不得再造变体。
- **搜索框全产品统一(2026-11-20)**:所有列表过滤框都是共享 `SearchField`(`packages/client-core/src/components/common/`)——设置侧栏、连接器、技能(发现/已安装)、插件、市场、会话列表、索引库、伙伴市场、模型供应商、导入、文件目录、PR 面板与移动端会话面板。表面全部来自 `tokens.css` 的 `--control-*` 令牌(`--control-height-field` 34px、`--control-fill`、`--control-fill-hover`、`--control-hairline`、`--control-rim`、`--control-focus-border`、`--control-focus-ring`),组件不再各自手写填充 mix、hairline、内 rim 或焦点环。`size="compact"` 是侧栏/菜单的 28px 行,`size="touch"` 是移动端 44px 触控目标(16px 字号、胶囊);三档表面完全一致。宿主只保留布局类(`flex-1`、外边距)与尾部操作(清空按钮、转圈)。裸 `gui-input` 不再被当作搜索框使用。
- **能力中心控件(2026-11-09)**:技能(发现/已安装)、插件、插件市场共用一套工具行配方。搜索框、`GuiSelect` 触发器与操作按钮统一 34px 高、`radius-lg`,凹陷玻璃填充(`color-mix(text 4%)`)+ hairline + 内 rim + 强调色焦点环;每个面板只保留一个强调色玻璃主操作,不再在玻璃控件旁放实心色块。搜索框统一为「图标 + input」包装(插件市场网格也补上),焦点环使用主题强调色(`--color-accent`),不再使用通用的 `--ring`。工具行不是卡片:只保留共享 `.gui-liquid-glass` 的折射层(位移滤镜提供边缘折射,也是吸顶行下方列表唯一会被真实采样的模糊),卡片皮肤一概不要——无填充、无 hairline、无圆角、无阴影、无镜面 rim——然后吸顶。其下的列表使用三层 progressive blur 边缘带——内容滚到工具行下方后显示顶部带,未到底时显示底部带,滚到底后隐藏以免淡化分页——复用 `--gui-blur-progressive-*` 与 `--gui-card-surface-fade`。不要做成横跨整卡、换了颜色的矩形横带。共享的 `MarketplaceGrid` 只在 `.gui-capability-page` 内换肤,其他宿主保留自己的 token 配方。
- **动态高度:一次状态变更只跑一次补间(2026-11-09)**:内容保持挂载的展开/收起用 `HeightMorph`(纯显隐用 `Reveal`);**禁止用分阶段 reveal 反复驱动同一个 height**。每 90ms 重设一次运行中的高度过渡会让它中途重启、停住再启动,观感就是抖动。子项仍可用 CSS `animationDelay` 做交错入场(只动 transform/opacity/filter),容器高度只补间到最终目标。子项自带进出场动画时传 `fade={false}`,避免容器的 160ms 淡入把仍可见的子项闪一下。列表高度跟随内容时必须**测量真实行高 + padding**,不要用行数常量估算:1–2px 的估算误差就会让本可完整显示的列表出现滚动条。测得的实际高度作为上限(如 200px),超过后才滚动。
- **浮层菜单必须两阶段进入**(2026-08-06 关键修正):`ContextMenu` 与 `Pop` 挂载时先以 **opacity 0 无动画类**上屏,下一帧(rAF 双跳)再加 `--entered`/`--pending` 类启动 `gui-menu-in`——`useFloatingMenu` 早已如此。原因:**挂载即动画(带 transform scale 的 gui-menu-in)会让 Chromium 在真实屏幕合成器上跳过 backdrop 采样,菜单渲染成普通半透明(背后内容直接透出,无磨砂)**;CDP 截图(offscreen 合成)仍显示模糊,极易误导验证(曾误判为"transparent 窗口 blur 全失效"并错误地用 95% scrim 覆盖全部浮层——已回退,切勿再犯)。实现:`.gui-context-menu{opacity:0}` + `.gui-context-menu--entered{opacity:1;animation:gui-menu-in}`;Pop 复用 `.gui-menu-popup--pending/--entered`,**Pop 调用方类(openin/instance/header-title/overlay/creds/view/add-project/proj)不得自带 animation**(已移除,由 --entered 统一提供)。验证必须用真实屏幕截图(screencapture -l),CDP 截图不算数。
- **⌘K 也能搜设置，输入框设置页并入会话与记忆，右侧面板首次展开不再失灵(2026-11-20)**:命令面板的查询现在同时搜索设置——页面名与 schema 行,用的就是设置侧栏那份 `settings.schema {all:true}` 索引(行结果按标题前缀/子串优先,其次描述);选中后打开对应页面并滚动定位到该行(页面 schema 未到时设置页会重试)。独立的“输入框”页只有一行,粘贴图片自动提及现在归入「会话与记忆」,导航行删除,旧 id `composer` 保留为能力别名,历史深链仍能落到该页。右侧面板是懒加载的编译插件,此前在首次展开时才挂载;现在面板折叠时即预热模块,首次点击立刻展开,不再把那一帧花在模块拉取上——加载期间的点击正是“点了没反应”的来源。
- **禁用控件不响应指针(2026-11-20)**:不能执行的控件也不能在悬停时改变外观。连接器的设备码登录主按钮是强调色实底主操作;处在禁用态“正在获取设备码…”时,`.gui-btn:hover` 把底色改成深色而文字仍是深色强调墨色,屏幕上唯一的进度文案因此变得不可读(指针停在上面多久就持续多久)。现在凡定义了 `:disabled` 的类,其悬停规则必须排除禁用态(`:hover:not(:disabled)`)或提供显式的 `:disabled:hover` 复位;`scripts/check-disabled-hover.ts` 在 `check:tools` 中兜底,生成产物里的资源包不在检查范围(契约约束的是源文件)。
- **验证码是复制目标,不是要照抄的文本(2026-11-20)**:GitHub 授权码、连接器设备码与 CLI 授权码统一走一个 `DeviceCode` 控件——出现即写入剪贴板,点击可再次复制(等浏览器标签打开时剪贴板可能已被覆盖),并短暂显示“已复制”。剪贴板工具优先 Electron IPC,其次 `navigator.clipboard`,最后回退旧的 DOM 复制。
- **设备码登录一次成型(2026-11-20)**:点击「连接」立即打开弹窗,不等 daemon;首帧就已具备验证码将要占用的行(状态行、打开页面按钮、等待文案),验证码返回后只替换文字,不会在转场动画几何时把面板撑大。同时堵上两个转场漏洞:在转场中**直接挂载**的 `DialogFrame` 此前不做入场抑制(只有“已挂载后再 open”那条分支做了),于是它会在浏览器转场期间走完 `pending → entered`,并在标记类移除的瞬间把 `--entered` 的入场重播一次——也就是实测的“新弹窗出现后再闪一下”;转场中交出画面的弹窗现在关闭时立即卸载,不再在新弹窗下面跑自己的 180ms 退场。
- **命令面板:排好序、按会话命名、用形变(2026-11-20)**:⌘K 的结果不再按 daemon 到达顺序去重,而是打分排序——标题命中(精确 > 前缀 > 靠前子串)高于仅正文命中;正文命中按匹配消息条数加权;daemon 的内容搜索看不到的标题在本地合并,所以以查询词命名的会话不必等某条消息恰好包含它。查询非空时命令行也一起过滤,与查询毫无关系的建议不会再压在唯一命中的会话上面。标签与分节改称“会话 / Sessions”(项目会话沿用任务中心的“任务”是错的)。tab 切换用 `HeightMorph`(高度形变规范)改变正文高度,而不是用 key 重挂。命令列表分为 建议 / 面板 / 更多操作,覆盖专注模式、快捷键、导入会话与新功能,宿主没给回调时该项隐藏。侧栏会话搜索改为常驻挂载 + `Reveal` 折叠(关闭态 `aria-hidden` + `inert`),开关有出入场动效而不是突然出现。
- **全浮层两阶段统一(2026-08-11)**:新增共享 hook **`useTwoPhaseEnter(active)`**(`lib/use-two-phase-enter.ts`,返回 `--entered` 后缀)——Board 放大(`gui-board-focus`)/小组件任务(`gui-task-modal`)/引导遮罩(`gui-onboarding-backdrop`)/⌘K 命令面板(`gui-palette`)/选区工具条(`gui-select-pop`)此前是**条件挂载 + 挂载帧直接播 `gui-fade-in`**,属 §6.5 风险类(纯 opacity 的轻度变体,未实测失效但违反契约),现全部接入。配套:命令面板改**常驻挂载**(app.tsx 不再条件渲染,`visible`/`closing` 内部状态,退出播 `gui-menu-out` 130ms + backdrop 渐隐);选区工具条补齐入场/退场(`gui-select-pop-in/out`,keyframes 必须烤入内联 `translateX(-50%)`——transform 动画覆盖静态 transform);base 规则统一 `opacity:0` + `--entered{opacity:1;animation:…}`,使 `gui-motion-off` 自然退化为瞬现(无需逐类列 motion-off)。**类名组合陷阱(2026-08-11,5/5 初版全踩)**:基类是 fixed/居中/blur 的唯一来源,必须**保留基类 + 追加完整 BEM 修饰 token**——`gui-foo${entered ? " gui-foo--entered" : ""}`。两种错误拼接:①`gui-foo${entered}` → 只有 `gui-foo--entered`,基类丢失 → 浮层落进文档流(引导卡实测 x=280 y=0,跟在侧栏后);②`gui-foo --entered`(空格直拼后缀)→ 孤立 `--entered` 类不匹配任何选择器 → 永远 opacity:0 不可见。CDP 量 `getBoundingClientRect` 验证:backdrop `position:fixed inset:0 opacity:1` + 卡片 centerDelta [0,0]。
- **首次启动引导居中悬浮(2026-08-11)**:ZCode 两栏卡居中悬浮——`min(1000px, calc(100vw-160px)) × min(620px, calc(100vh-160px))`(每侧 ≥80px 磨砂边,20px 圆角 + 24px 阴影)。**绝不是全屏贴边**:用户实测反馈近全屏(40px 边)右/上贴到软件边缘、整体过大;引导层必须让四周磨砂羽化遮罩明显可见,才有"悬浮在软件顶层"的观感。card `flex column` + grid `flex:1` 撑满高度,左栏内容底部对齐(圆点 `margin-top:auto`),右栏渐变面板内垂直居中示意动画。**各步骤的示意窗口统一 280×190**(此前 236×168 / 244×155 / 244×120 三档,切换步骤右栏会跳变;chat/settings 用 `justify-content:center` 在固定盒内垂直居中内容)。主线为语言与外观、模型、多会话、语音输入、完成五步；第三页提供真实的多会话标签页开关，右侧预览随开关联动。语音输入页仅在用户请求时检查麦克风权限，列出真实 STT 状态返回的全部模型；首次启动在中文界面推荐 SenseVoice，其他语言推荐 Balanced，手动重开保留当前配置。选择与下载分离，只有显式点击下载才获取所选模型；页面显示真实进度并支持失败重试，权限、设备或模型异常均不阻塞下一步。完成页默认展开功能速览，覆盖斜杠命令、上下文引用和语音输入操作。
- **浮层卡面单层归属(2026-08-15,ColorPicker 双画教训)**:`useFloatingMenu` 的 `className` 落在 portal 外层——**菜单类**(proj/todo/queue/creds…)传 className、外层当卡面,内容必须是**无卡面的平铺元素**;**面板类**(quota/context/color-picker)组件根自带卡面 class,调用方**不得再传 className**。同一卡面 class 同时出现在两层 = 背景嵌套双画圆角磨砂容器(内容后面多一层圆角玻璃)。判定:DOM 里卡面 class 只出现一次。
- **点阵品牌背景**(`DotMatrixMark.tsx`,HeroComposer 背后,kimi 参考增强版 2026-08-06):文本栅格化为全矩形点阵——背景点淡(fg 8%)+ 文字点亮(fg)+ ~2% 彩色 accent 点(5 色板)**HSL 色相缓慢流动**(sin 偏移 ±0.12,每点独立相位)+ **羽化边缘**(文字 bbox 外 42px smoothstep 衰减,半径/透明度随距离渐隐,无硬矩形边界)+ **点击涟漪**(pointerdown 生成波前,0.55px/ms 外扩、26px 带宽内径向脉冲推点 + 放大,900px 后消散)+ 呼吸 + 鼠标 halo(吸引放大/active 变色)。**i18n 字体适配**:CJK/JP/KR 自动换字体栈(PingFang/Hiragino/Noto…)。**字形参数(2026-08-06 调优)**:`gridGap 7` + `dotRadius 2.0` + `600` 字重 + 140px 短文本阶梯(>6 字 115、>10 字 85;CJK >4 字 120、>8 字 90)——实测每字符 ≈ **11 列**(比 kimi 参考 140@8 的 ~9.6 列密 ~15%);字重 700 时 M 斜线栅格化成实心块(读作笨重方块),600 保留像素阶梯,经典点阵 M;`fontSize` prop 可覆盖(设置预览传 96)。mark 定位 `top: 17%` 让文字底缘(≈235px)保持在品牌行顶(≈242px)之上。IntersectionObserver 离屏暂停。
- **自定义与预览**(设置 → 常规):`musepi-gui-dotmatrix` 开关 + `musepi-gui-dotmatrix-text` 自定义文字(默认 MusePi,≤24 字符,欢迎页与预览实时联动,事件 `musepi-dotmatrix-changed`);预览 = 同组件小字号实例(`fontSize={96}`)在 `.gui-dotmatrix-preview`(744×170 圆角卡)内,**必须给预览 canvas 设 CSS 尺寸**(`width/height: 100%`)——组件只设像素缓冲不设 CSS 尺寸,无样式时 canvas 按缓冲尺寸显示(300×150×dpr),文字被 2× 放大且贴左上被容器裁剪(欢迎页 canvas 有 `.gui-welcome-mark` inset:0 所以没这问题)。

- **连接器设置页(2026-11-08)**:设置 → 智能体 → 连接器是一条可搜索列表,不是第二套市场壳。每行复用 `gui-agent-card`:字母头像、名称、认证/状态 chip 和一个主操作(连接/断开);示例与文档链接在行内展开,不打开弹窗,浏览始终停留在一个视觉平面。连接可能进入浏览器 OAuth,等待态显示在该行,不用阻塞式遮罩。
- **项目拥有文件，实例拥有守护进程（2026-11-26）**：此前的形状把两条轴并排放进 `InstanceManagerDialog`，并给第二条轴配了四步挂载向导。那是同一个问题的第二个答案——「添加项目」已经在问主目录——而且把实例列表挤进半屏，于是对话框读成「1040px 的框，右半边是空的」。现在按归属切分：**连接位置**只列出与管理实例（一个分区、一个主操作、页脚里那个危险色的断开用一条细线与列表分开），**添加项目**拥有项目的目录与源码文件夹，会话的**运行位置**决定由哪个实例执行。对话框按它实际持有的那一个列表定尺寸——`min(560px, 92vw)`、无最小高度、正文单列、名称列 96px——因为按两个栏位定出的框，在第二个栏位消失后读起来像布局失败。**行结构**不变，仍由 `ConnectionLocationRow` 提供：固定宽度的前导槽位、固定名称列、距行尾固定偏移的状态槽位、行本身即点击目标。「在哪里运行」绝不猜测：目录条目给出真实机器，非回环端点本身就是位置，没有目录条目的回环端点读作「经隧道转发」。添加实例改为先用**传输方式卡片**（SSH / Docker / WSL）开场，而不是让用户在心知所需之前先选一套词汇；每张卡片说明自己的用途并带各自就绪状态，容器或 WSL 用不了就在可选处直接写明，而不是等提交失败。然后只在该问的时候问位置：容器可以在这台机器或某台主机上，WSL 发行版按定义就在本机，SSH 主机本身就是远端位置——三者都问一遍，等于把卡片已经说过的话又说一次，表单读起来像两个互相竞争的选择器。而这组描述「项目在哪台机器上运行」的 chip 归**添加项目**：`workspace.create` 在那台机器上解析根目录，所以目录选择器必须问同一台主机。接收创建请求的那个 daemon 是解析出来的，不是猜的：本机项目归当前 daemon；指名的主机若是已存实例，先把 shell 切过去；主机没有对应实例则带原因拒绝；容器实例不按主机名匹配，因为它的端点是转发出来的容器端口，不是那台主机的守护进程。到达不了的 daemon 让请求失败，而不是退回到「当前恰好连着的那台」——这正是 bitfun 对其工作区 provider 写明的规则，也是那条记录否则会指向接收机器看不见的路径的原因。本版本到达得了的组合都提供：远端容器在对端用同一条 ssh 连接执行 docker，容器发布的端口也由这条连接转发回来，所以它是真选项而不是一句拒绝；远端 WSL 仍带原因禁用，因为 WSL 发行版是本机 Windows 的能力，对端没有东西可连。带主机的容器行**就是**远端容器——位置从主机事实读出，不另存一份，因此已存的记录无需迁移。两个「在别处运行东西」的种类共用主机字段，因为一台构建机上的守护进程与同一台机上的容器回答的是同一组问题。一个值只配一个控件：容器下拉列出探测到的结果，只有列表给不出该名字时才换成输入框。添加表单用共享的 `ConnectionManager` 的 `formOnly` 模式，所以添加实例与断线页由同一个组件渲染。契约：`apps/desktop/test/instance-manager-axes.test.tsx`（一条轴、没有第二个选择器、逐字段标签）、`apps/desktop/test/instance-manager-keyboard.test.tsx`（Escape 关闭对话框、焦点约束、唯一滚动容器、宽度规则只声明一次）与 `apps/desktop/test/connection-locations-geometry.test.tsx`（真实 Chromium 下 1280 与 720：对话框宽度始终低于 700px、内部只有一个分区、行内偏移恒定）。

- **凭证请求卡**：卡片出现在输入框上方，三种形态共用一套骨架——标题行（图标、标题、关闭）、只读的身份行（`密钥名 NAME`，登录卡同样只报条目名，站点在自己的字段里）、模型给的一句用途，然后是形态内容与一行动作。`fill` 有一条遮罩输入和一个交付说明（值只以 `$MUSEPI_SECRET_<NAME>` 或私密文件路径到达 Agent），最小长度只在输入不足时并入同一句出现；`allow` 只有一句「已保存」加允许说明，动作行左起 `替换值`、`取消`、`允许`；`login` 是四个带标签的字段（站点、用户名、密码、两步验证设置密钥）加一个「仅限这个确切地址」复选框。范围由分段按钮表达（`仅本工作区` / `所有会话`），不再用句子复述，只有按钮承载不了的事实用一行锁图标说明：允许会扩展到哪些目录、登录由 daemon 自己填页面。`替换值`改的是值而不是授权：按下后卡片原地变成填写态、标题改为「替换密钥值」、不显示范围选择也不回传范围，条目保留原有授权。页面不是 HTTPS 且不在回环地址时补一行警告，值仍可保存。
- EN: **Credential request card**: it floats above the composer, and its three shapes share one skeleton — a head (icon, title, close), a read-only identity line (`密钥名 NAME`; a login names its entry too and keeps the site in its own field), the model's one-line purpose, then the shape body and one action row. `fill` has one masked input and one delivery note (the value reaches the agent only as `$MUSEPI_SECRET_<NAME>` or a private file path), with the minimum length folded into that same line and only while the input is short; `allow` is one "already saved" line plus the allow note, with `Replace value`, `Cancel`, `Allow` left to right; `login` is four labelled fields (site, username, password, 2FA setup key) and an "only this exact address" checkbox. Scope is carried by the segmented buttons (`this workspace` / `every session`) and never repeated in a sentence; only facts the buttons cannot carry get one lock-icon line — which directories allowing extends to, and that the daemon fills the page itself. `Replace value` changes the value, not the grant: pressing it turns the card into the fill state in place, retitles it, hides the scope pick and sends no scope, so the entry keeps its existing authorization. A page that is not HTTPS off loopback adds one warning line; the value can still be saved.
- **保险库页面（2026-11-24）**：设置 → 智能体 → 保险库 由四段组成，正文只有一个：标题与一句用途、动作行（`已保存 · N`、仅在有条目时出现的搜索、唯一的「添加密钥」主操作、次级的「从 .env 导入」）、然后是唯一的正文（打开中的添加/替换或导入表单取代行列表与空态，而不是叠在它们上方）、最后是一句页脚事实：值在本机加密保存，只以 bash 环境变量到达 Agent，保存后只能替换、不能查看。行是 `ul` 里的 `li`，每行一张 L1 卡：等宽字体的名称在上，下面一条淡色元信息只保留存在的事实（范围仅收窄时、用途仅有值时、最后使用仅用过时），动作在行尾，删除始终可见。搜索无结果是一行淡色文字，不占用虚线空态卡；空态仍负责解释请求卡片。添加时焦点落在名称、替换时落在值、导入时落在文本域；Escape 关闭行内表单并就地截断。导入表单先逐行校验名称与长度再写入，部分失败会报告「已导入 N 个后失败」，成功后主操作变为「完成」。值始终只写不读：遮罩输入、无显示开关，值随表单丢弃。
- **默认形象：内置球体品牌伙伴（2026-11-05）**：`DEFAULT_COMPANION_ART_ID = BUILTIN_VECTOR_ART_ID`（`musepi-note-bot`），由 `CompanionArt.tsx` 的内置分支绘制手绘球体——`.gui-pet-svg__shell` 加 `lib/companion-face.ts` 的表情层（眼动追踪、眨眼、31 态情绪）、`lib/companion-decor.ts` 的 `headphones` 配饰，以及 `pet-gesture` 按压/拖拽弹簧；这张脸的 `happy` 环也是应用与站点 Logo 的表情来源。设置与首次启动的列表以它开头，其后是全部 Petdex 精灵图预设；显式保存的选择优先，未知 id 回落到球体。`ThinkingOrb` 画布不是伙伴形象——它仍是智能体头像与顶栏活动指示器。
- **两种绘制模式（2026-11-08）**：伙伴只有两个渲染器，且选择本身不保存模式。`CompanionArtFormat = "vector" | "sprite"` 由解析出的 id 推导——`artFormatForPackage` 把 `format:"svg"` 映射到 vector、sheet/atlas 映射到 sprite，内置球体是 vector。设置页与首次启动先选模式，网格只显示该模式的形象；雪碧图导入只在 sprite 下出现，vector 列出内置球体与 SVG 导入。切换模式会恢复该模式上次的选择（`musepi-gui-pet-vector-id` / `musepi-gui-pet-sprite-id`），`musepi-gui-pet-id` 仍是唯一活动选择，所以模式出现之前存下的数据按推导归位，不需要迁移写入。
- **预置**:10 个内置 Petdex 预置(`src/lib/companion.ts` 的 `BUILTIN_SPRITE_PRESETS`,sprite 在 `public/pets/`,768×936 = 8×9 网格,96×104 帧,来源 BitFun MIT)。设置页网格按「已导入 → 预设」分组;卡片 = rest 帧缩略图(`zoom: 0.66` 缩放,不裁 transform 动画)+ 名称 + 描述 2 行截断;选中卡 accent 边框 + 14px check(`gui-pet-card__check` 必须显式 width/height——Icon 组件无默认尺寸,漏写会渲染成 219px)。
- **形象选择**:`.gui-pet-trigger` 行显示当前伙伴缩略图 + 名称 + 箭头(展开翻转);预览缩略图用 `zoom: 0.55`。删除按钮只出现在导入卡,hover 显现,`stopPropagation` 防选中。
- **渲染形态**(CompanionArt.tsx + gui.css):`.gui-petdex-sprite` 必须 `image-rendering: pixelated`;帧循环 + 每 mood 一个 transform 动画(`SPRITE_MOOD_ANIM`:rest 2.4s+breathe、working 1.16s+work bob、hover 1.44s+lift、dragging 0.96s+wiggle),两者同时挂同一元素(不同属性不冲突);mood 行映射 rest=0/hover=1/dragging=2/error=5/waiting=6/working=7/analyzing=8。内置球体不使用 Petdex 的悬停/拖拽行和方向镜像：指针速度驱动独立的连续手势层，产生倾斜、拉伸、提起与阻尼落地；该层与会话动作、交互动效和眼动组合。
- **显式状态图集**：`format:"atlas"` 导入包声明帧几何和命名行，不再硬套旧版 8×9 网格。标准行是 `idle`、`running_left`、`running_right`、`working`、`waiting`、`failed`、`idle_random_1`、`idle_random_2`；额外命名行是双击桌面伙伴播放的一次性动作，不占用标准状态。拖拽直接选择对应方向的动画，不重复镜像；空闲动作播放完回到实时会话行；指针、睡眠和会话状态保持优先。包还可提供低饱和气泡配色，但只有三个六位 hex 齐全且前景／背景对比度至少 4.5:1 时才采用；错误／问题语义和默认玻璃几何仍由应用管理。
- **尺寸归一化与大小调节**(2026-08-06):所有 Petdex 形象按 **rest 行内容高度统一渲染**(`PET_CONTENT_TARGET_H = 100`,k = 100/contentH)——导入包的帧尺寸各异(Doraemon 192×208 vs 内置 96×104),不归一化会 2 倍大小、阴影溢出画布。contentH 来源:内置走 `BUILTIN_SPRITE_PRESETS.contentH`(实测写死),导入包 import 时 `measurePetdex()` 测量,旧包由 `migratePetdexContent()`(useCompanionArt 挂载时)自动补测回写。**伙伴大小滑块**(设置 → 伙伴,`musepi-gui-pet-scale` 60–150%,默认 100)乘在归一化之上;桌面宠物窗口由主窗口桥 `pet-activity {scale}` 推送(跨窗口 localStorage 不可靠),输入框内宠物直接读 pref。
- **窗口与阴影边界**：宠物窗口固定为 320×290（`PET_WINDOW_SIZE`），宠物锚定 `bottom: 52px`，并保留足够的投影空间。窗口包含 sprite 和唯一的气泡模式／数量控件。会话卡片位于独立、按内容定尺的 `bubbles.html` 窗口，底边与 sprite 保持 8px 间距，限制在当前工作区内，并随宠物移动。空气泡栈会隐藏该窗口。单击不再打开交互面板。
- **气泡栈**：临时通知最多 5 条（`MAX_VISIBLE_BUBBLES`），非问题通知 8 秒后自动消失。卡片使用 20px 圆角、自绘玻璃材质和宽高双轴形变。三种模式为 `stacked`（优先卡片加「N more」标记）、`expanded`（完整列表）和 `hidden`（只保留桌宠旁的数量控件）。点击折叠卡片正文展开列表；点击展开卡片正文打开对应会话并保持列表展开，通知则打开主窗口。独立的 ↗ 按钮打开会话或主窗口。回复、打开、批准、拒绝、停止、关闭和清除操作不会触发卡片正文。桌宠旁的控件是唯一模式开关，按 `expanded → stacked → hidden → stacked` 循环。
- **气泡通知生命周期**：真正的新完成／出错活动或可操作请求只置顶一次；重复快照保留当前优先项，也不会重新打开计数状态。关闭记忆按会话活动版本或请求 id 隔离：相同活动保持关闭，后续新回合可以重新出现。完成会话卡片的 ✓ 会在主窗口把该会话标记已读，并同步实时提醒、侧栏和桌宠角标。单卡 × 或清除全部只影响本地气泡，不会把会话标记已读，也不会替用户批准或拒绝请求。审批只能由用户显式决定。
- **气泡材质与动效**：卡片、装饰背层、清除胶囊、快捷操作、回复框和计数表面复用共享 `--glass-*` 材质。收起态的近层与远层背卡不参与交互，布局尺寸与 320px 优先卡片一致。344px 外层气泡栈在两侧各保留 12px 阴影空间，保证窗口宽度稳定且控件不被裁切。宽高形变继续用 `--spring-liquid`（已有元素的形变），入场和出场改用贝塞尔阶梯 `--ease-appear-snappy` / `--ease-dismiss`（`--duration-calm` / `--duration-settle`）：内容的到来必须精确停在 0 和 1，而弹簧的残余过冲会把卡片推过窗口已经按内容量好的高度。同时到达的卡片按 32ms 起步、48ms 递进入场，最多累积四条。卡片不能在被关闭的同一帧就从状态里移除：`data-exiting` 让它多留 220ms 把出场播完，六条移除路径共用这一个助手。既无会话也无待批的单行通知是 `pet-bubble--caption`，用 `--ease-caption` 纯淡入淡出，不做位移。短促控件反馈仍用 `--spring-snappy`。减少动态效果时去掉延迟，并跳过全部入场与形变。
- **桌宠脚下的快捷胶囊**：是否显示由主进程的光标轮询决定，而不是 CSS `:hover`——窗口是点击穿透的，收不到用于悬停的指针事件。以精灵矩形（不是窗口，窗口大部分是透明留白）为基准，进入 40px、离开 56px，两者之差就是迟滞；离开不再额外加宽限，因为光标已经离开了控件的邻近范围。收起态不透明度为 0 且 `pointer-events: none`；展开态是三个 24px 圆钮（新聊天／语音输入／打开主窗口），间距 8px。胶囊刻意放在精灵下方：气泡窗口占着上方，在那一侧出现一条控件会在用户伸手去够宠物时正好盖住最新一条消息。分割线是带负行内边距的 flex 项，因此无论控件尺寸如何，细线都落在间隙正中，并在相邻按钮悬停或获得焦点时隐去。所有动作都是转发给主窗口的 `pet:command`；语音走输入框的 `voiceSetup.onToggle()`，首次使用仍会走下载引导。展开后的胶囊会并入上报的可交互矩形，点击穿透轮询才会让按钮收到点击。
- **胶囊与输入框是同一个表面**：点「新聊天」不是弹出第二块面板，而是同一条胶囊就地变形——`width` / `height` / `border-radius` 一起过渡，按钮与分割线淡出、输入框在同一曲线上淡入，因此不会出现「形变到一半」的半成品状态。形变由 **JS spring** 驱动（`client-core/lib/spring-motion`），而不是 CSS 过渡：贝塞尔曲线只能表达「时间是时间的函数」，没法同时说出「过冲多少」和「多久才感觉停稳」，而 spring 的参数恰好就是这两件事，同一组参数还能同时驱动宽度、高度、圆角和透明度而无需逐个手调。spring 的实现是阻尼谐振子的**闭式解**（欠阻尼／临界阻尼／过阻尼三档），任意时刻取值精确，没有积分误差也没有固定步长漂移；这是一套**可复用的设计资源**，任何需要形变的面都可以采用。
  输入框沿用 Codex quick-chat 的排布：**左侧语音钮、中间输入区、右侧发送钮**，发送钮在没有文本时禁用；焦点离开桌宠时输入框还原成胶囊——一个用户已经看不见的输入框比没有输入框更糟。
  输入框是绝对定位而不是 flex 项：不可见的输入框照样占布局空间，作为 flex 项时它会把胶囊撑成输入框的宽度，而表面看上去仍只有三个按钮。桌宠窗口以 `focusable: false` 创建（桌宠不该抢用户正在用的应用的键盘），所以输入框打开期间经 `pet-composer-focus` 临时把窗口变成可聚焦，关闭时再还回去；光标在形变开始 120ms 后才落进去，确保它出现在已经可见的字段里。输入框发送走 `new-chat-send`（**新建**会话），不复用气泡的回复链路——后者是发进当前已打开的会话。
- **主会话可见性**：桌宠气泡、托盘会话项和欢迎页提醒只列主会话，不显示顾问会话与子会话。跳过辅助会话树节点时仍保留其主会话后代；审批收集仍覆盖辅助会话。
- **引导页个性化使用真实桌宠预览**：矢量球体位于第一项，其后是内置 Petdex 预设和导入包。每个选项渲染真实的 `CompanionArt`；光泽和配饰控制只适用于矢量球体。右侧预览跟随所选桌宠和装饰。输入框模式显示挂靠输入框的桌宠；桌面模式显示独立桌宠与玻璃气泡。
- **气泡快捷操作**：鼠标悬停或键盘焦点进入卡片时，操作按钮按横向单行显示。操作行按实际按钮数量确定宽度，包括未读卡片常驻的操作；气泡窗口仍保持固定宽度。
- **气泡 kind 区分**：`bubble.kind`（`completed`／`error`／`question`／`subtask`，`lib/companion.ts`）通过 `--pet-kind` 设置大写 kind 标签（`.pet-bubble__kind`，zh/en i18n `pet bubble kind *`）的颜色。卡片不显示左侧强调色条纹，也不为其预留内边距。`error` 与 `question` 额外给边框上色（55% mix）；未知 kind 不生成标签，避免误导。
- **桌宠常驻普通窗口之上,但给全屏让路(2026-09-19)**:桌宠是桌面伙伴,所以常驻置顶层——但「行为得体」由三条规范定义,且三条都用户可见。① **不能下沉**。置顶断言在可见期间每 5s 重施加一次,因为 Windows 会在边缘吸附与睡眠唤醒时降级该层级且永不恢复;层级用 `pop-up-menu`(高于任务栏级 UI),不是 `floating`。② **不能抢全屏**。当别的应用占满屏幕——游戏、视频、演示——桌宠在该应用退出前退出置顶层,退出后回来。这是「伙伴」与「骚扰」的分界,而且必须对**别人的**应用生效,不能只管自家窗口。桌面本身永远不算全屏:点壁纸、Alt-Tab 都不许把桌宠赶走。③ **必须能回来**。拔掉显示器、DPI 变化、笔记本睡眠唤醒,都不许把桌宠留在屏幕外、被不可见地 cloak、或尺寸错乱(看着被放大、且每睡一次就更大一圈,是用户报成「坏掉了」的那种失败)。以上任一情况之后,桌宠回到合理位置,但**若用户是特意把它停在一个可达处,就不得移动它**——DPI 事件不是给用户手放位置重新居中的许可。
- **宠物手势与睡眠**：单击播放问候动画并将主窗口置前；双击随机播放一种交互，且不重复上一次选择。会话卡片提供回复、停止、确认和打开操作；审批卡片提供批准/拒绝操作，并在待审批期间保留全局 `Ctrl/Cmd+Shift+Y/N` 热键。连续 60 秒没有手势或任务活动后，sprite 调暗并漂浮「z z z」（`.pet-window__pet--sleeping`）；任何手势或 mood 变化都会唤醒。

## 5. i18n 与音效

- **i18n**:文案 key 即英文回退,zh 翻译按域拆在 `guest-client/src/i18n/zh-CN/<domain>.ts`(en 侧 `en-US/` 编译级 parity,详见 §i18n 契约与 `docs/i18n.md`);`t()` 调用点渲染(模块级 const 不随语言切换)。数字/时间格式化显式传 locale,禁依赖浏览器默认。
- **音效(2026-08-07 活动化改造)**:cuelume(Web Audio 合成,14 个 recipe);统一经 `apps/desktop/src/lib/sfx.ts`:
  - **活动分类配置**(opencode per-category sounds parity):10 个活动(`SFX_EVENTS`)——发送消息/首次消息/消息完成(agent_end,stopReason 非 aborted/error 才响)/审批请求/审批通过/审批拒绝/切换会话/停止回合/工具结果/错误;每类可换音色(`soundFor`/`setSoundFor`,持久化 `musepi-gui-sfx:<event>`,无效值回退 `DEFAULT_SFX`)。
  - **调用点用 `sfxFor(event)`**(app/Composer/HeroComposer/ApprovalCard/session-store),不再直接 `sfx(name)`(保留给一次性/预览);总开关 `musepi-gui-sound` gating 全部。
  - **消息完成挂 agent_end 而非 turn_end**(2026-08-07 修正):turn_end 每轮模型调用都触发(多工具任务连响),且中止时与 stop 音叠加——agent_end 每 run 一次。
  - **设置 UI**:通知与音效 tab = 每活动一行(名称 + 触发说明 + 默认音色)+ 音色下拉 + ▶ 预览 + 14 色 palette 网格(`ALL_SOUNDS`/`WIRED_SOUNDS`/`previewSound`);新触发点接入后同步 WIRED_SOUNDS 与中文用途文案。
  - **验证坑**:cuelume 有 `navigator.userActivation` 浏览器策略 gate——CDP 合成输入不产生真实激活,音效播放无法自动化验证(配置读取/持久化可测,播放需真实点击)。

## 5b. 动画与库选型(2026-08-07 评估)

- **原则:CSS 优先 + 自研 hook**。现有动效体系全部手写 CSS/JS(Reveal/HeightMorph/useCollapse、BorderBeam、DotMatrixMark、ThinkingOrbs、KITT 扫光、两阶段浮层、宠伴帧动画)——桌面 GUI 的动效需求是"精致克制的 UI 反馈",CSS transition/keyframes 足够且零运行时开销、天然尊重 `prefers-reduced-motion`(`gui-motion-off` 偏好)。
- **已用第三方**:`cuelume`(音效)、`lucide-react`/`lucide`(图标)、`morphicons`(Composer 发送/停止图标 morph)、`beautiful-mermaid`(guest-client Mermaid 渲染)、`@xterm/xterm`(终端)、`EmbedPDF`(PDF)。**motion(原 Framer Motion)曾依赖但零引用——已移除**(2026-08-07)。
- **GSAP 评估(不引入)**:GSAP 3(现完全免费,含全部插件)是命令式时间轴/ScrollTrigger/SplitText/MotionPath 的行业标准——但其强项场景(营销页滚动、文字逐字特效、复杂多步编排)不在桌面 GUI 核心路径;引入需建立新动画规范(时间轴/插值)且与现有 CSS 动效双轨并存。**保留为候选**:若后续做欢迎页品牌文字逐字动画(SplitText 类)、复杂转场编排,再评估。
- **图标切换 = morphicons,禁自绘交叉(2026-08-14 教训)**:任何"图标 A → 图标 B"的过渡(主题/强调色全屏遮罩、按钮态切换、状态卡)一律用 **`morphicons`**(`morphicons/react` 的 `MorphIcon`,或纯 DOM 场景 `morphicons/element` 的 `<morph-icon>` + `set()`/`morphTo(target, "snappy")`)——**Procrustes 最优旋转 + 极坐标插值 + spring 物理的形状变形**。**禁止**用两个 SVG 叠放 + opacity/rotate 交叉淡入淡出伪装 morph(2026-08-14 主题遮罩曾误用,用户明确要求 morphicons 效果;Composer/Transcript/引导步骤已全部是 morphicons,遮罩必须同款)。
- **store 变更通知必须在 swap 回调内 emit(2026-08-14 教训)**:`setThemePreference`/`setAccentPreference` 经 `withColorTransition` 延时(340ms)执行切换——**`emit()`/`emitAccent()` 必须放在 `withColorTransition(fn)` 的 `fn` 内部**(preference/accent 已更新后),不能放在调用之后:在外部同步 emit 会广播**旧值**,`useSyncExternalStore` 订阅者(设置页 segmented/色板按钮)读到旧 preference——按钮状态**滞后一次点击**(点了浅色、主题已切、按钮还在"跟随系统";下次点击显示的是上一次的选择)。
- **React Bits 评估(源码参考,不装包)**:140+ 开源动画组件(MIT 系,github.com/DavidHDev/react-bits)。与现有"参考仓库抄模式"工作流一致——候选组件(按需复制):`BlurText`/`ShinyText`(欢迎页品牌文字)、`CountUp`(数字滚动:状态栏 token/统计)、`SpotlightCard`(设置卡 hover 光效)、`Aurora`/`Particles`(欢迎页背景备选,现有 DotMatrixMark 优先)。BorderBeam 我们已有自研版(参考 opencode),reactbits 同款可对照参数。

## 5c. 参考资源(设计与实现对照)

| 资源 | 对照用途 | 备注 |
|---|---|---|
| opencode(`../opencode` dev) | 会话树/header/服务器实例/设置 v2 形态 | 音效三分类(agent/permissions/errors)是活动音效配置的蓝本 |
| openchamber(`../openchamber` v1.18.1) | 三栏 shell/设置布局/通知模板/远程实例(SSH+端口转发) | 设置页形态主参考;消息局部选择悬浮/保存为图片/基于回答新会话(2026-08-07 已落地局部选择+保存图片,fork 模态未做) |
| bitfun(`../bitfun` main) | 伙伴(Petdex/帧动画/mood)/SSH 远程工作区/审批 | 桌宠视觉与交互主参考 |
| clawd-on-desk(`/tmp/clawd-on-desk`,rullerzhou-afk,AGPL) | 桌宠浮窗布局/权限气泡/状态指示 | **内容驱动窗口设计参考**(2026-08-11 分析):固定宽度 + 高度自适应(窗口宽度不变→无锚定裁剪);气泡堆布局优先级 下方→侧边(空间多侧,右优先)→角落;入场从桌宠侧滑入(translateX 60→0 弹簧)。当前气泡窗口先测量完整布局再上报尺寸，入场动画不会驱动窗口尺寸反馈循环 |
| kimi-code(`../kimi-code`) | 图标卡中卡 80.5%/点阵品牌背景/供应商网格 | Dock 视觉对齐基准 |
| ZCode | 连接向导 4 步(SSH/Docker) | ConnectDialog 步骤骨架 |
| `../ui-references/aicss/` | AI 界面 CSS 配方(thinking/code-block/comparison-table…) | 消息流细节对照 |
| `../ui-references/cuelume/` `border-beam/` `thinking-orbs/` | 音效/光束/思维球参考 | 自研组件的灵感源 |
| reactbits.dev(2026-08-07 起) | 动画组件源码参考 | 已落地:CountUp/BlurText/ShinyText/SpotlightCard(全部零依赖变体);候选:字体粒子背景(需 WebGL,未采用) |

## 5d. 设计缺口与跟进

2026-08-07 在此处登记的三个缺口现由 `docs/review/0.5.0-roadmap.md` §7 第 8–10 项跟踪。没有排期的清单是工作队列而非规范：条目只有在承载设计决策之后才应回到这里。

## 5f. 设计资产扩展点(插件化,2026-08-16 定稿)

内置设计资产以 **token + 覆盖机制** 组织,第三方/主题/动效包通过覆盖 token 扩展,不 fork 组件。

### 动效参数全表(gui.css `:root`)

| Token | 默认 | 用途 | 覆盖方式 |
|---|---|---|---|
| `--spring` / `--spring-snappy` / `--spring-bouncy` | spring(300,30)/(400,34)/(320,16) linear() | 全部 UI morph 缓动 | 注入 CSS 覆盖 `:root` 变量 |
| `--gui-motion-menu-in/out` | 130ms | 浮层菜单进出 | 同上 |
| `--gui-motion-chip` | 180ms | 芯片/小元素 | 同上 |
| `--gui-motion-fade-in/out` | 160ms | 淡入淡出 | 同上 |
| `--gui-motion-height` / `-max` | 240ms / 480ms | 高度形变(HeightMorph delta/6 封顶) | 同上 |
| `--gui-motion-blur` | 280ms | blur 类动效(BlurText) | 同上 |
| `--gui-motion-roll` | 240ms | 滚动/翻页类 | 同上 |
| `--gui-motion-slide-y` / `-lg` | 6px / 10px | 位移距离 | 同上 |
| `--gui-motion-blur-amt` / `-lg` | 8px / 24px | 模糊量 | 同上 |
| `--gui-ease-out` | cubic-bezier(0.22,1,0.36,1) | 高度/形变缓动别名 | 同上 |

**覆盖机制**:keyframes 与 transition 一律读 token(`var(--gui-motion-*)`);动效包/主题注入样式表(加载在后 wins)覆盖变量即可整体换肤,无需改 keyframes。`gui-motion-off`(prefers-reduced-motion)全局禁用。

### 组件参数化(不 fork 即可定制)

- `BlurText`(`stepMs`/className)、`ShinyText`(`speed`/`spread`/`shineColor`)、`CountUp`(`duration`/`format`)、`SlidingNumber`(`padStart`/`decimals`)、`TextMorph`(`stepMs`/`durationMs`)、`GuiSelect`(options/className)、`SpotlightCard`(`spotlightColor`)
- 玻璃层:`--gui-glass-alpha`(透明度滑杆)+ `--gui-glass-overlay` 派生;`.gui-main`/悬浮卡 blur 读平台类(`[data-platform="win32"]` 关底层 blur,见性能节)

### 新动效组件的接入契约

1. 时值/位移/模糊 **必须读 token**,禁止裸值(裸值 = 无法被主题/动效包覆盖)。
2. 进场动画走两阶段(`useTwoPhaseEnter` 或 `opacity:0` + 下一帧 `--entered`),防 Chromium 跳过 backdrop 采样。
3. 尊重 `gui-motion-off`(禁用态直显,不播动画)。
4. 复用 `gui-menu-in/out` / `gui-fade-in/out` keyframes 或同参数自建(命名 `gui-<name>-in/out`)。
## 5e. 弹窗、键盘与选择器(2026-08-14 定稿)

### 弹窗动画与键盘优先级

- **DialogFrame 契约**:宿主**无条件渲染** + `open` 驱动(`{x && <DialogFrame/>}` 条件挂载会丢退出动画——180ms closing 相位);prompt/confirm(`lib/prompt-dialog.tsx`)同款两阶段 enter + closing,`finish()` 延迟到退出动画完成后才 resolve promise。
- **模态持有键盘**:DialogFrame 打开时在 `document` **capture 阶段**监听 Esc → onClose(赢过背后 handler,composer 不再吞 Enter 发消息),焦点移入弹窗第一个可聚焦元素、关闭后恢复;confirm 框 Enter = 确认(焦点落在确认按钮);引导面板 Enter = 下一步(输入框聚焦时保留输入框自己的 Enter)、Esc = 上一步/第一步关闭,面板打开即聚焦;公告面板 Esc = 关闭。
- **紧凑弹窗**:小内容确认框用 `gui-dialog--confirm`(auto 尺寸 + max-width 380 + 22×24 padding)——基类 `.gui-dialog` 是 600×420 设置框,desc+两按钮装在里面读起来是坏的(看板删除/新建项目/定时删除均踩过)。
- **hooks 铁律**:所有 hook 声明必须在**任何早退 return 之前**(`if (!open) return null` 之后的 hook 会在 open 切换时崩 "Rendered more hooks than during the previous render"——AnnouncementOverlay 回归实测)。

### 浮窗定位规范(2026-08-25 定稿,openchamber v1.20.0 对照)

**单一入口铁律**:所有弹出浮层(菜单/dropdown/上下文菜单/颜色选择器/附件菜单)必须经 `components/Pop.tsx` → `lib/use-floating-menu.tsx`(唯一实现:portal 到 React root + 全局互斥 + `gui-menu-in/out` 动画)。**禁止手写 `position: fixed/absolute` 的弹出浮层**——openchamber 用 @base-ui/react(floating-ui popper 内部引擎),我们手写同语义、不相依:
- **碰撞语义(flip + shift)**:垂直方向 = 锚点下方放不下(或上方空间更多)时向上翻转(flip);水平方向 = 左/右溢出时整体移入视口(clamp 到 `[8, innerWidth − menuW − 8]`,shift 不翻转)——右对齐菜单右缘钉锚点右缘,空间不足时右移保命,不被窗口边缘截断。
- **两阶段测量**:首次 open 时菜单未挂载 → 260×300 估算定位 → 挂载帧一次性重测 `offsetWidth/Height` 精确重定位(`measuredRef` 防循环);右对齐菜单右缘因此仍精确落在锚点上。
- **上下翻转含高度**:`flipUpForBottomOverflow = r.bottom + 6 + menuH > innerHeight − 8` —— 高菜单挂在低锚点下也向上翻,不许底部溢出。
- **常驻浮卡(非弹出)**:btw 侧问卡/角标卡等 fixed 角卡必须自带视口 clamp(`maxWidth: calc(100vw − 48px)` + `max-height: min(60vh,520px)` + body 滚动),禁止裸 fixed 无边界。
- **键盘**:浮卡/浮菜单的 Esc 承诺必须接线(如 btw 卡 hint「Esc closes」↔ onKeyDown Escape),不许提示与行为脱节。
- **四个必须(2026-10-18 定稿;滚动归属 2026-11-19)**:每个浮层合入前必须同时满足——
  1. **可关闭**:外部点击 + Esc 关闭,Esc 还要 `preventDefault` 认领(否则漏到窗口级 bare-Esc,把正在跑的一轮对话打断)。
  2. **视口内**:flip/shift/max-height clamp,永不出窗、永远内部滚动而不是被截断。
  3. **不被裁剪**:逃出所有 `overflow`/`transform`/`backdrop-filter` 祖先(即走 portal),且不被相邻元素盖住。
  4. **滚动归属**:浮层自己拥有滚轮。指针落在浮层内的滚动容器上时由该容器原生滚动,到边界就停住,不转发给背景;指针落在浮层的非滚动部分(搜索框、标题行、内边距)时,滚轮驱动浮层内第一个可滚动容器;只有浮层内没有任何可滚动容器时,才交给菜单所依附的表面。浮层自己的滚动容器声明 `overscroll-behavior: contain`,不依赖祖先。
- **「被裁剪」是这套组件的头号故障,且不是样式写法问题**:`.gui-right-rail` 是 44px 卡片且 `overflow: hidden`(圆角卡片必须裁,否则子元素溢出圆角);任何 `position: absolute` 画在它里面的浮层都会被整块裁掉。这不是某个组件"属性配错了",而是**裁剪容器 + 绝对定位子元素**这个组合本身不允许出现。两条硬规则:
  - **浮层的定位属性(`position/top/right/z-index/animation`)归浮层壳(`.gui-menu-popup`),不归内容类**。内容类只写内部布局(`display/gap/min-width/padding`);壳的 inline `position: fixed` 负责跑出裁剪树。同族先例:`.gui-context-menu` / `.gui-select-menu`。
  - **贴窗口边缘的触发器要往"有空间"的方向开**:右缘 rail 的浮层必须用 `side: "left"`(`useFloatingMenu`)向左 flyout。向下开会被视口 shift 夹成一条——这跟裁剪是两个独立故障,只修 portal 不修方向仍然不可用。
- **dsh / openchamber 的做法(2026-10-18 对照)**:dsh 的 `Menu`/`Tooltip` **默认就地 `absolute`**,靠调用点显式传 `portal` 逃出裁剪树——所以它每个漏传的调用点就是一个潜在裁剪 bug(其 `TabMenu.tsx` 注释正是在记录这个坑);openchamber 用 Base UI,`Portal` 是结构性的、调用点无法写错。**我们的对齐方式是 openchamber**:`useFloatingMenu` 无条件 portal,调用点不需要也不会忘记一个 `portal` 开关。两家都**没有**机械门禁能拦住"就地渲染的浮层被裁"(dsh 只有一条 AST 测试要求 `role=menu/listbox` 包在 `MenuSurface` 里)。

> **范围澄清(2026-09-14)**:「手写同语义、不相依」只适用于**浮层定位**这一域——floating-ui 的 flip/shift/clamp 语义量小、CSS + 尺寸测量足以精确复刻,且与 `gui-menu-in/out` 两阶段入场深度耦合。**拖拽排序不适用此原则**:**务实选型**——`@dnd-kit` 的传感器仲裁(指针/键盘激活阈值)、碰撞检测、可访问性(屏幕阅读器 reorder announcement)、嵌套容器是实打实的状态机,依赖能很好解决这类需求,就用依赖(openchamber 全线 14 处拖拽同库对齐,见下节);**只有**当交互简单到依赖反而是累赘(无排序语义的一次性拖放、纯指针的一维位移)时才手写。判断标准:涉及"顺序"且需持久化 → `@dnd-kit`;单纯"把这个东西放到那里" → 手写 pointer capture。

### 拖拽排序规范(2026-09-14 定稿,openchamber 对照)

openchamber 全线拖拽(14 处:模型收藏/供应商、右栏面板排序、会话标签页、起始提示词 chips、排队消息 chips、会话文件夹/项目排序、TodosSection、移动端项目/会话)统一用 `@dnd-kit`。需要排序的拖拽我们对齐同库:

- **依赖**:`@dnd-kit/core@6` + `@dnd-kit/sortable@10` + `@dnd-kit/utilities@3`(`@dnd-kit/modifiers@9` 按需),装在 `apps/desktop`。
- **传感器约定**:可见排序用 `PointerSensor` + `activationConstraint: { distance: 8 }`(移动 ≥8px 才启动拖拽,避免误触点击);整行 header 拖拽用 `MouseSensor` distance 8;需键盘排序时加 `KeyboardSensor` + `sortableKeyboardCoordinates`。
- **结构**:`DndContext`(sensors + `closestCenter` + `onDragEnd`)包 `SortableContext`(`verticalListSortingStrategy` / `rectSortingStrategy`);行用 `useSortable` + `CSS.Transform.toString(transform)`;拖拽手柄是独立 `<button>`(带 `attributes`/`listeners`),不是整行可拖——行内有按钮/输入框时整行拖会劫持点击。**例外**:纯图标按钮(右栏 rail icon)自身不含嵌套控件,可直接当 activator,8px 阈值已保证点击不被劫持。
- **完成态**:onDragEnd 里 `arrayMove` 后**整表回写**存储(localStorage 或 RPC),不允许只改本地可视顺序与后端不一致。
- **禁用条件**:条目 ≤1 时整块 `draggable={false}`/不渲染手柄;搜索过滤态下按 id 在**完整数组**上重排(不能在过滤子集上 splice,否则丢隐藏项)。

### 右栏 rail 交互(openchamber ContextPanelRail parity,2026-09-14 定稿)

- **拖拽排序**:`@dnd-kit` 全套(PointerSensor distance 8 + TouchSensor delay 200/tolerance 6),在**完整 order** 上 arrayMove 后整表回写 localStorage(`writeSurfaceOrder`)。扩展槽 tab(`ext:`)不进 SortableContext。
- **⌘/Ctrl 长按揭示序号**:按住修饰键 500ms → rail 图标右上角显示 1..N(对应 ⌘1..8 跳转);松开、失焦、或真的按了数字键即消费并消除,下次按住才回来。app.tsx 的 ⌘1..8 处理器不变,这边只负责可视化。
- **角标**:live 计数(当前仅 git 变更文件数,99+ 封顶)优先于序号;序号只在修饰键长按时出现。a11y 标签把计数读进 `aria-label`(「git,3 个已更改文件」)。
- **富 tooltip**:registry 每项带可选 `description`(i18n key);hover 与键盘焦点共用 150ms 延迟,触屏静止长按 500ms 后打开、释放关闭。单个 portal 由 rail 层托管(`RailTooltip`),优先显示在图标左侧,但通过 flip/shift 保持在视口内,并在滚动、滚轮移动和缩放时跟随锚点。提示使用共享 tooltip 层，层级高于受管浏览器页面宿主。窗口失焦或锚点断开时立即关闭。Escape 不移动焦点即可关闭;拖拽中抑制。显隐只过渡透明度,减少动态效果时立即完成。普通提示与富提示共用 L2 玻璃材质，但不改变既有浮层层级。
- **导航 rail 不挂滚动条**:导航 rail 的滚动容器保留 `scrollbar-width: none` + `::-webkit-scrollbar { display: none }` 与 `overflow-x: clip`，折叠与边缘羽化自行处理溢出。原生滚动条不得覆盖图标或在这里生成横向拇指；右侧工具栏同样就地退出。皮肤宽度收在 6–16px，装饰后的条仍退到内容之后。
- **不做**:surface 显示/隐藏配置弹窗(openchamber 的 equalizer 入口)——右键隐藏 + overflow 恢复已覆盖,不做弹窗。
- **rail 右键隐藏(2026-10-15,openchamber 吸收 A2)**:rail 图标右键 →「隐藏表面」(`ContextMenu`;图标按钮仍是唯一的拖拽 activator)。隐藏 id 持久化,rail、⌘1..8 跳转、陈旧顺序回填三处过滤;已打开的面板不强制关闭。从「…」overflow 菜单「显示已隐藏的表面」分区逐个恢复(有隐藏项时 overflow 按钮常显)。
- **单一面板宽度(2026-11-04)**:右侧面板是一个工作区,所有标签共享 `musepi-gui-right-width`(200–1200 钳制);切换标签不再改变宽度。旧 `musepi-gui-right-widths` 中首个有效值迁移到共享键,拖拽结束也只写共享键。`ContextPanel` 是唯一宽度所有者。
- **选中会话自动揭示(2026-11-04)**:选中或新建会话时,展开其项目以及挡住它的父会话链(每个选中 id 只揭示一次)。无关的手动折叠项目与子树保持不变,导航不会退化成「全部展开」。
- **has-content 回退规则(2026-10-15,吸收 A1,仅机制)**:无显式判定的 has-content 退到"有打开 tab 即见"(`openSurfaces` 由 ChatView → RightRail → ctx);暂无内置翻转,翻转是一行产品决策。
- **rail 与面板属于壳层(2026-11-08)**:工作区行同时承载场景栈(欢迎或会话)、面板宿主与 rail,三者是兄弟节点,因此 rail 不随场景切换重建,欢迎页也保留它(openchamber 布局对齐);面板在欢迎页打开即显示零 tab 导航页。registry 描述符可声明 `requiresSession`:无会话时 rail 隐藏这些表面,空态页与「+」菜单把它们列为禁用项并给出 `general.sessionRequired` 提示。会话前的 tab 集以所选项目为键,创建会话后切换到会话键(工作区 tab 不迁移)。

### 模型选择器(provider 复合键)

- **模型身份 = `provider/id`**,绝不是裸 id——两个供应商可提供同裸 id(opencode-go / opencode-zen 都出 `deepseek-v4-flash`):收藏(`musepi-gui-fav-models`)、DEFAULT 图钉(`modelRoles.default`)、选中态、角色行赋值全部按 `provider/id` 键控(旧裸 id 条目兼容匹配、toggle 时清理);`session.setModel` 携带 `provider` 让 daemon 精确解析(daemon 侧 provider 限定查找已加)。
- **composer/欢迎页**模型菜单行 = 模型名 + provider 徽标 + 收藏星 + **DEFAULT 图钉**(target 图标,当前默认实心)——点图钉即写 `modelRoles.default`(设置页 DEFAULT 角色同键,两边一致);菜单 min-width 260 / max-width 344。
- **单胶囊合并(dsh single-trigger parity)**:两个选择器合并为一个胶囊(`ModelThinkingCapsule`),左段显示模型品牌图标 + 模型名,右段只显示思考等级文本——胶囊内两段都不带下箭头,右段也不再带脑子图标;点击各自弹独立菜单(模型搜索/收藏/图钉菜单 + 思考等级 ladder)。胶囊在 composer frame 宽度不足时把模型名收缩为品牌图标(文字通过 `@container` 查询 + `--gui-motion-chip` 180ms 过渡淡出,`gui-motion-off` 直接切换;380px 时模型文本与分隔线让位,以 `.gui-composer-frame` 的 inline size 为基准);思考等级文本不收缩——它是该段唯一的标记;两个阈值之间模型名按 flex 子项直接截断,胶囊因此不会把底排顶到换行。胶囊段之间细竖线分隔,每段 hover 用 `--spring` 150ms 过渡高亮,高亮形状贴合胶囊(首段圆左半、末段圆右半、单段全圆)——与独立 `.gui-model-btn` 的 hover 一致;胶囊先于底排换行而收缩——模型名截断、等级文字保持——拥挤的动作行既不会把它挤没,也不会把控件顶到第二行。
- **模型品牌图标(`@lobehub/icons`,MIT)**:胶囊左段与模型菜单行均按 `provider` 渲染品牌 logo(Mono 单色变体,`size 14`;`model-brand-icon.tsx` 内联 24 个 provider→图标映射 + 按 modelId 子串兜底),未知 provider 回落 oc-icons `ai-agent`;深度导入(`@lobehub/icons/es/<Brand>`)保证 tree-shaking 只打包用到的品牌。
- **角色思考等级动态**:角色行 thinking select 渲染 `resolvedRoleModels[role].efforts`(daemon `getSupportedEfforts`,模型无 thinking 支持则为空)——绝不固定七档;每次角色模型变更经 `applyRoleModels`(set 成功后重拉 resolvedRoleModels)让"自动选择"派生行与等级列表即时刷新。
- **供应商配置入口按真实认证方式归一**：浏览器/设备授权供应商提供「登录」，纯 API Key 供应商只提供一个「导入 API Key」入口，不再用两个按钮打开同一套密钥提示。设置页与首次引导共用该规则；导入失败会留在弹窗中显示。

### 获取可用模型(自定义供应商表单)

- **配置界面形态**:添加自定义供应商是**规范弹窗**(DialogFrame,`gui-dialog--settings`),由「自定义供应商」tab 内点击「添加自定义供应商」打开——**不是独立 tab**(用户反馈:添加自定义供应商应是有设计规范的弹窗;旧 add-tab 已移除)。Base URL 与 API 协议(openai-completions / openai-responses)确定后点「获取可用模型」——**只对 OpenAI 兼容协议可问**:anthropic-messages / google-generative-ai 没有可读的模型列表,错误提示引导手工填写(discover-models 同哲学:配置期对草稿的一次性询问,不写任何配置)。**引导界面(OnboardingOverlay ProviderSetup)的自定义表单同样提供「获取可用模型」**,不必手填 model id。
- **询问即草稿**:RPC 参数 = 表单当前值(baseUrl/api/apiKey/provider 名),**apiKey 仅用于这一次询问、daemon 绝不落盘**;无 baseUrl 时按钮禁用并 hover 提示「请先填写 Base URL」。
- **候选弹窗**(DialogFrame,始终挂载由 `candidates !== null` 驱动,嵌套于配置弹窗内):勾选列表(id + name,端点序)+ 全选/取消全选(全选时「取消全选」)+ 「添加所选」;采纳后候选并入表单模型列表(`adopted`),每行带删除;错误(协议不支持/401/404/端点无模型)内联展示在按钮下方,不弹窗。
- **提交语义**:`models.add` 的 models 数组 = 已采纳列表 + 手工单条(modelId/modelName/compactionModel)合并;校验改为「供应商名称、Base URL 与至少一个模型为必填」——单条与采纳列表至少满足其一。
- **成功反馈**:保存成功关闭弹窗,返回「自定义供应商」tab 在添加按钮原位置显示短暂「供应商已添加」反馈(2.5s 后消失);引导界面显示 added 卡片。

### 看板画布与组光效

- **画布自适应**:`.gui-board-surface` 布局宽固定 BASE_W(1092),`transform: scale(容器宽/1092)` 适配窗口;effect 依赖 `activeId`(挂载时 home 视图 ref null → deps `[]` 时 scale 永驻 1,画布 1092 布局溢出被裁——已修);`overflow-x: hidden` + `overflow-y: auto`(transform 不改布局,窄窗口必出横向滚动条伪影)。
- **ChromaGroup 组光效**(reactbits ChromaGrid parity,`components/ChromaGroup.tsx`):容器 pointermove 写 `--cg-x/--cg-y`(零 re-render),`.gui-chroma-glow` 纯 CSS 三层 RGB 错位径向渐变 + `mix-blend-mode: screen` + hover 淡入 + `gui-motion-off` 隐藏——**一个共享光晕同时照亮组内所有卡片**(看板画布 + 模型供应商网格);伙伴预设/桌宠市场**不适用**(滚动密集小卡网格上整片背景泛光 + 固定 inset-0 在滚动容器被裁——用户实测回退)。
- **合集预览是静态的同心圆角卡面**：预览按宽高共同适配且不放大，内层圆角随预览单元格 padding 递减。行情、历史、音乐和视频卡保留深色辨识度，同时共享标准玻璃高光、边框、阴影与主题强调色。实时请求、刷新定时器、音频分析和播放只属于真实看板，不在合集页启动。

### 设置搜索与新建项目

- **设置搜索**:侧栏搜索过滤**配置项级**(section label 或 `SECTION_SEARCH_TERMS` 关键词命中,双语);内容区匹配行 `.gui-settings-match`(accent 13% 底 + 24% 描边)命令式高亮 + 首个匹配 `scrollIntoView`(新查询/section 切换滚一次,继续打字不滚防抖动);`aria-hidden/inert` 折叠行跳过。
- **搜索规则（2026-11-21）**：列表搜索按用户的输入方式匹配，而不是按数据的存储方式。匹配折叠全半角、大小写与变音符号（`web` 命中 `ＷＥＢ`，`lodz` 命中 `Łódź`），名称接受词首子序列（`cpt` 命中 `Compact`）；描述、配置键与不透明 id 只接受连续子串，散落在长句里的字母不会变成噪声。标签的每种语言都是独立键，所以设置行、设置页、命令与会话标题在任一界面语言下都能用中文或英文命中。结果按「标签优先」分层——精确、前缀、子串、词首子序列、描述——空查询保持列表自身顺序而不是重新排序。唯一实现是 `TextSearchIndex`（`packages/client-core/src/lib/text-search.ts`，契约见 `docs/gui-components.md`）；新增搜索框必须用它，不得再写 `toLowerCase().includes`。会话正文搜索（`session.search`）与插件市场保留各自的索引。
- **新建空白项目**(kimiwork parity):侧栏项目 tab「添加项目/远程」菜单 + composer 项目菜单 → DialogFrame(名称 + 父路径 native picker)→ daemon `fs.mkdir { cwd: 父路径, path: 名称 }` → 打开 + `musepi-gui-project-added`;保存按钮双字段齐备才启用,失败内联展示。字段 = label 上控件下的紧凑布局(`gui-settings-field` 两列 grid 在紧凑弹窗里会把 input 挤到 76px)。

## 5g. 近期落地特性(2026-08-24 → 2026-08-26)

早期章节之后落地的设计决策与模式;实现契约与坑在 `docs/gui-implementation.md` §18,分特性规格见所列文档。

- **右栏改造 Phase 1–2**:右栏 ContextPanel 改为**分组 44px 图标 rail**——surface 注册表(`surfaces/registry.ts`)新增 `group` 字段(primary/secondary/tertiary);高频图标固定,secondary 收进 rail 底部「…」溢出;宽度 clamp 放宽到 **260–1200px**(+ maximize 态);**⌘E** 切换面板,**⌘⇧E** 为 focus mode(输入框铺满);关闭动画为 **220ms 宽度折叠**(非 proma overlay)。第二条 TabBar 行与多实例 tab **已被架构否决**("rail 是唯一导航轴");Phase 3 面板级细化继续。
- **看板/widget 画布**:`BoardPage` + 白名单 `WidgetRegistry`(18 种 widget)——同一 registry 渲染看板网格、transcript 内联卡与 pin 窗,一个 widget 写一处三处复用。画布固定布局(BASE_W 1092)缩放适配窗口(`transform: scale(窗口宽/1092)`),`overflow-x:hidden` + `overflow-y:auto`;ChromaGroup 辉光(`components/ChromaGroup.tsx`)以单份共享 RGB 偏移径向渐变点亮整组(`mix-blend-mode: screen`,`gui-motion-off` 隐藏)。
- **Composer 与状态行设置**(daemon schema,设置「交互」/「Shell」tab 中呈现,§4 TUI 设置同步):`composer.shape`(string,默认 `"box"`)选 composer 形态;`statusLine.contextLine`(enum `CONTEXT_LINE_MODE_VALUES`,默认 `"embedded"`)驱动状态行 gauge——`off`(纯 accent 实线)、`percentage`(已用段 accent、其余 border)、`annotated`/`embedded`(百分比 + 窗口标签)。
- **win32 磨砂玻璃修复(2026-08-26)**:显式 `html:root, html:root body { background: transparent }`——`html` 是被忽略的一层,带着不透明 `var(--bg)` 挡住 DWM Acrylic(Windows)/vibrancy(macOS)透出半透明 scrim。`[data-platform="win32"] .gui-main` 关掉页面 `backdrop-filter`(模糊来自窗口材质,更省 GPU);`[data-platform="win32"][data-theme="light"]` 用薄 22–58% scrim(Acrylic 是亮材质,默认 58–76% 浅色 scrim 会冲掉磨砂)。
- **OTA 更新 UI**:「检查更新」(§4)从「前往下载」(openExternal)升级为 **下载 → 进度 → 重启**(electron-updater,v0.4.4);toast 现在显示百分比 + 「立即重启」。notes 双通道不变:toast 读 `update-manifest.json.notes`、「What's new」读 `CHANGELOG.musepi.md`。**空闲交接**:`update.autoRestart`(默认开启)打开时,校验完成的包会在工作中止后自行重启——toast 说出还有几个请求在跑,而不是只留一个按钮。忙会话、排队消息、后台任务与等待用户的审批都会拦住它;已武装的定时提醒会暂停自动路径(重启会丢掉它们),「立即重启」则始终可以强制交接。
<!-- link-example: bilingual naming convention -->
- **双语文档约定**(`docs/i18n/README.md`):范围内 `docs/**` 每个 markdown 成对 `foo.md` + `foo.zh-CN.md` + `foo.i18n.yaml`(blob 哈希一致性记录);标题后语言切换行(`English | [中文](foo.zh-CN.md)` / `[English](foo.md) | 中文`);`bun run verify-translation-pairing` 执行(`--write` 记录哈希,具名 pair 严格校验);两语言地位平等、结构镜像。
- **画板 Codex 对齐**(2026-09-19):画板新增**文本工具**(真实 `<textarea>` 浮层,按画布像素定位 —— 输入法/粘贴/选区都是原生行为;失焦或切到别的工具时落成 Konva `Text`,所以待输入的插入符不会丢)、用**形状飞出菜单**取代原来平铺的直线/箭头两个按钮(直线/箭头/矩形/椭圆/菱形/三角形/五角星/心形,4 列玻璃浮层;轨道按钮显示**当前选中**形状的图标,让矩形和菱形一眼可辨)、**12 色调色盘**,以及取代 2/4/8/14 四档的**连续粗细滑杆**(1–24)。**全部几何计算搬进 `lib/sketch-geometry.ts`** —— 拖拽归一化、星形/心形取点、文本度量、命中范围 —— 因为 Konva 离开 canvas 无法断言;由 `test/sketch-geometry.test.ts`(42 个用例)覆盖。画板外壳并入**液态玻璃 + 弹簧动效规范**:78% 半透明表面 + `blur(3xl) saturate(170%)`、`--glass-sheen` 走未被占用的 `::before`、`--glass-shadow`,入场用 240ms `--spring-liquid`(关闭时 180ms `--spring` 的缩小回弹不变,画板仍读作"回落进输入框")。这里每个视觉 `position`/`transform` 都只有一个归属(入场由画板 keyframes 独占,遮罩只负责淡化)。
- **画板 chip 重开的是 A0,不是 A1 的副本**(2026-09-20):这里的产品规则是**画的连续**,不是**一张能涂的图**。完成时既交付进入消息的 PNG,**也**交付画板的笔画列表(`scene`,`lib/sketch-scene.ts`);chip 两者都带,所以点击它恢复的是对象——每一笔依旧可选、可拖、可缩放、可擦除——再次编辑就是精确地改用户所指的那一笔。旧行为(把导出的 PNG 当底图挂回)让画板自己的产物一步就变成不可再编辑:之后任何修改都只能在栅格上叠涂,这正是它读作"只是粘贴了图片"的原因。scene 同时也是闭环的关键——完成是像素**与** scene 一起换,所以第十次再编辑和第一次一样可编辑。降级只有一个方向且无感:丢了 scene 的 chip(恢复的草稿、改动前的数据)按旧的整图底图打开,而不是拒绝打开。
- **文字标签是图形,不是说明文字**(2026-09-20):规则是**一套对象模型**,所以文字既无特权也无豁免。它随输入自动换行并增高(标签持有真实盒子,高度跟着换行行数走),用与矩形、图片相同的四个角手柄缩放,单击即选中并拖动——**双击**才是编辑,因为"点标签放插入符"曾让文字成为画板上唯一拖不动的对象。值得守住的不变量:看到的文字与选中框量自同一个行高,所以不断变宽的选中框永远不会和里面的字形对不上。
- **文字要量,不要估;用户选的宽度必须尊重**(2026-09-20):这两条合起来才让文本框像一个对象而不是一次猜测。(1) 标签盒子按**真实画布度量**定尺寸,因为任何固定的"每字符系数"都只是在描述某一种文字:按拉丁文调出来的估算会把中文低估约 1.6 倍,于是中文标签被静默截到只剩前几个字。(2) 用户把盒子拖到某个宽度,这个宽度就要保留——文字在里面换行,盒子不会弹回去贴合自己的内容,因为用户亲手设定的尺寸绝不能被悄悄推翻。唯一的例外是某一行真的放不下,那时盒子变宽而不是藏起字形。
- **系统截图编辑器**（2026-11-13）：两个输入框的系统截图以全屏标注浮层打开，而不是对话框。顶部透明工具条承载原图尺寸、预览缩放、HEX/RGBA 与全选；截图独占舞台；底部一颗悬浮玻璃胶囊放选区、画笔、箭头、矩形、椭圆、文字、马赛克、橡皮与取色，并带撤销/重做/清空和随工具出现的调色板与粗细滑杆。放大镜跟随光标（像素网格、坐标、颜色），取色工具按当前格式复制。坐标始终是原图像素，笔画尺寸按「屏幕像素 ÷ 预览缩放」存储，所以原分辨率导出与预览一致；裁剪会裁掉框外标注，导出按选区原点平移。浮层用 `useModalFocus` / `isTopModal` 自行接管焦点与 Escape，而不用 `DialogFrame`——打开的文字插入符必须先吃掉 Escape；工具栏内部用方向键巡游，取消/完成保持 Tab 可达。
- **菜单行只有一套悬停配方，场景不得裁掉卡片阴影**（2026-11-14）：所有浮层下拉行都用 `--glass-hover-strong` + 发丝边画悬停——也就是右键菜单的配方——因为 `--color-surface-raised` 正是弹层自身的底色，看起来等于没变；选中行在强调色文字下加 `--glass-active`。两个 token 都由 `--fg`/强调色推导，深浅主题自动跟随，不需要第二套规则。欢迎/会话场景必须保持 `overflow: clip` 与 `overflow-clip-margin`，绝不能用 `overflow: hidden`：卡片阴影本来就该溢进留白，普通裁切会把四个圆角切成看得见的直角（后加载的样式表用同一选择器重写 `overflow: hidden` 时，会静默撤销先前的修复）。
- **Markdown front matter 是卡片，不是 Markdown**（2026-11-14）：文件预览与可视化编辑都会在渲染前切出开头的 `---` 块，所以分隔符不会变成分割线或 setext 标题。预览在正文上方显示只读「元数据」卡（标量、列表逐行堆叠、对象回退 JSON）；可视化编辑把 YAML 原文留在 Crepe 之外，每次变更与保存都原样拼回，因为 Crepe 没有 frontmatter 节点、其序列化会改写这个块。修改该块仍走源码模式；解析失败的块也会在卡里显示原始文本，而不是消失。
- **脏标签替换关闭字形，而不是叠加**（2026-11-14）：未保存圆点与 × 共用标签尾部同一个 18px 槽位。脏标签即使处于激活态也显示圆点；悬停标签时换成 × 并让圆点淡出。两者同时渲染会让激活的脏标签读成「圆点 AND 关闭」，也让 7px 的状态标记与关闭操作互相抢位。

## 5h. 悬浮状态卡、浮层与 Git 表格(2026-08-29)

- **浮动状态卡**(会话右上角,ZCode 悬浮卡对齐):紧凑磨砂启动卡(Git / 智能体 / 待办),248px 宽,`gui-menu-in` 入场;可折叠为细药丸(持久化 `musepi-gui-status-cards`);全部为空时整栈消失——不为空闲会话装饰。点击穿透打开对应 surface;除分支切换器外不复刻 surface 内部 UI。
- **奖励票券弹窗**(活动版 what's-new 形态):星空 + 3D 倾斜漂浮票券,变换分层(tilt / float / entrance 各在独立元素——每个 `transform` 只有一个动画源);数额 CountUp 滚动;`gui-motion-off`/`prefers-reduced-motion` 下全部静止。领取反馈耦合完成音效。
- **右侧面板最大化**是模态:遮罩(z-840,自 48px 头栏之下起,点击还原)垫在 z-850 面板之后——浮动 fixed 层(浮层滚动条、tooltip)必须低于遮罩层,否则会被读成面板内容。
- **Git 图谱表格**(提交历史子标签):车道求解 SVG 图轨 + 徽章(HEAD=home/强调色,本地分支=branch,远端=cloud/弱化,tag=琥珀) + 日期/作者/哈希列;点击哈希复制,1.2s 反馈。会话级 i18n key 在 settings 域(`subject/date/author/commit column`、`load more`)。

## 5i. 会话悬浮卡与 design 空态(2026-09-19)

- **会话悬浮卡**:行上悬浮 ~350ms 在行右侧浮出 288px 卡——标题(2 行截断)、模式 chip、fork 来源、任务工作空间(cwd basename,title 全路径)、最后活跃 + 创建时间。架构:行经**模块级 bus**(`SessionHoverCard.tsx` 的 `reportSessionHover`/`clearSessionHover`)上报——不给 memo 化的 `SessionRow` 加任何 props;卡片(每侧栏一实例)从 `sessionMeta` 现查 cwd/modeId 并 **portal 到 document.body**(侧栏的玻璃/transform 祖先会劫持 fixed 定位)。卡片取代行原生 `title` 气泡;滚动(capture)/点击行/离行即收,跨行移动有 120ms 宽限。**表面、字号阶梯、行盒与入场属于共用的悬停卡配方**(`gui-chrome.css` 的 `.gui-hover-card`,部件与两张卡的合理差异记录在 `docs/gui-components.md` → 悬停卡)——本卡只贡献自己的宽度、两行标题截断、只读行与元信息行(模式 chip · 更新于)。第三张悬停卡消费这份配方,而不是再抄六条声明。
- **分叉标记是判据,不是「有父就是分叉」(2026-11-22)**:只有**用户从另一会话分叉出来**的会话才带分支图标,悬浮卡里也才出现「分叉自 …」一行。规则只有一处:`SessionHoverCard.tsx` 的 `isUserFork(entry)`(= 有 `parentId` **且** 既不是 `subagent` 也不是 `advisor`),`SessionList.tsx` 每行算一次,行图标与悬浮卡都读同一个布尔值,不会出现第二份规则各自漂移。会话级的 `parentId` 其实承载三种关系:用户分叉(`session.forkAt` 写 `header.parentSession`)、任务子代理 transcript、顾问 transcript。后两者的父链接来自它们所落的产物目录路径,是归属/溯源而不是分叉,而且两者本来就各有身份标记(`gui-tree-agent` 名字 chip / 顾问 chip)。给它们挂分叉标记等于声称一层用户从未建立的关系。**层级归属不受影响**:`session.tree` 与 `SessionList` 仍按原始 `parentId` 挂子树,顾问与子代理行照旧在父会话下面,只有标记与文案受判据约束。四种形态在 `test/session-fork-badge.test.tsx` 里逐一钉住(真分叉 / 顾问 / 子代理 / 顶层)。
- **项目行悬浮卡——一个项目名下有几个目录,得能看全(2026-11-22)**:项目支持多根目录(`WorkspaceProject.root` + `additionalDirs`,上限 `MAX_WORKSPACE_DIRECTORIES`),但项目行只能写一个名字,于是「这个项目铺在这几个文件夹上」在界面上根本看不见。悬停项目块浮出 240px 卡(`.gui-project-hover-card`,`ProjectHoverCard.tsx`):主目录 + 每个附加目录各一行,主目录带 chip,行内是文件夹名(全路径在行 title),每行一个打开动作,复用侧栏已有的 `openPathInFileManager` 路径;卡头给目录数与该项目的会话数(与行右侧计数同口径)。**表面、行盒与入场属于共用的悬停卡配方**——见 `docs/gui-components.md` → 悬停卡;本卡贡献 240px 宽度、单行标题、可滚动的目录列表与 `--above` 入场方向。**它开在侧栏旁边、与悬停行对齐(2026-11-22)**——kimicode / dsh / ds-bot 的侧栏 popover 就是这个站位,也是用户在看到第一版盖住侧栏之后提出的要求。`placeProjectCard()`(`ProjectHoverCard.tsx`)把卡片左缘放在侧栏右缘外一个间隙处、顶边对齐悬停行;只有右侧真的没地方时才翻到侧栏**左侧**;两侧都放不下时就留在右侧并夹进视口——压住聊天区好过压住那个给项目命名的侧栏本身。**卡片 portal 到 `document.body` 且 `position: fixed`**:侧栏链路带 `backdrop-filter`(`.gui-main`、面板表面),它会成为 fixed 元素的包含块并改掉坐标;而 `absolute` 卡片只能活在块的包含块里——这正是第一版压住侧栏、并被 `.gui-sessions-list` 裁到只剩几像素的原因。因为离开了块的 DOM 子树,**包含关系从 DOM 搬到显式状态**:指针进入卡片时取消块的收卡计时、离开时重启,块的 `blur` 把落在卡片内的 `relatedTarget` 视为仍在内部,块的最后一个控件把 Tab 交给卡片第一个控件,卡片第一个控件把 Shift+Tab 交回(portal 节点在 `body` 末尾,原生顺序够不到)。**展开遵循 hover 契约,绝不用 `:focus-within`**:指针悬停,或键盘焦点落在匹配 `:focus-visible` 的控件上时展开;开关由 React 状态决定(`SessionSidebar` 的 `projectCard`)而不是 CSS,因为卡片里有按钮,鼠标点击会把焦点留在块内,`:focus-within` 就永远关不掉。Escape 与指针/焦点离开(120ms 宽限,块→卡移动不闪灭)收起,它挂靠的会话列表滚动也收起——但**卡片自己的目录列表**滚动不收起:那一列正是看到其余目录的途径(包括焦点落到折叠下方按钮时浏览器自动做的那次滚动),所以 `window` 捕获阶段的滚动监听会忽略目标在卡片内的任何事件。下方装不下时翻到行的上方(`.gui-project-hover-card--above`)。契约:`test/project-hover-card.test.tsx`(状态、portal、翻转决策)与 `test/project-hover-card-geometry.test.ts`(真实 Chromium 的几何与滚动宽度)。
- **溢出契约也适用于这张卡**:`.gui-project-hover-card-list` 同时声明 `overflow-y: auto` 与 `overflow-x: clip`。只声明纵向时横向按规范计算为 `auto`,于是 `nowrap` 的路径行在「内容其实完整」的卡片里长出横向滚动条——这是用户的第二个反馈,也是下面那条规则必须做成仓库级而不是补丁级的原因。

**溢出契约(2026-11-22):** 滚动容器要声明它用哪个轴,以及它**不许**用哪个轴。只设置 `overflow-x`/`overflow-y` 之一时另一个会计算为 `auto`,于是纵向列表悄悄变成横向滚动容器,第一个比内容盒宽的行就长出滚动条。规则是:**一个轴滚动,另一个轴显式声明**(`hidden`/`clip`),**`nowrap` 内容用省略号或换行**(绝不用滚动条去揭示一个本来就完整显示的值),**只有明示并登记的地方才允许横向滚动**。`scripts/check-overflow-axis.ts` 强制执行「声明」这一半,并携带真正需要横向滚动的白名单(每项都写理由);`docs/gui-components.md` 记录契约并指明这份白名单。
- **design 预设空态**(设计稿 08 欢迎页对齐):design 预设 armed 时欢迎页输入框与会话 composer 同款——同一行风格 chips(`composer/design-styles.tsx`,共享 `DesignStyleChips` + `DESIGN_STYLES`)渲染在输入卡上方,点风格即写入 `design style brief update {style}` 句;placeholder 从静态基础提示切为 `design empty placeholder`。模式 chip 背后的数据链:daemon `session.modes`/header → view-store `mode_id` 列(幂等迁移)→ `session.list` → app `sessionMeta` → 悬浮卡。

## 5j. 桌宠眼动、pet 头像预设与主题跟随色板(2026-09-19)

- **眼动跟随(gaze)**:builtin 球的眼睛现在跟着鼠标走——clawd-on-desk 同款能力,也是让球体丰富的状态设计真正值钱的那个交互。桌面桌宠由主进程**复用既有的 120ms 点击穿透轮询**顺带算好"光标相对窗口中心"的归一化向量(`pet:gaze`:420css-px 视距夹到 ±1,0.02 死区节流,零新增定时器)推给渲染进程;引擎以注意力缓动(220ms 渐入 / 380ms 渐出、120ms 滑动时间常数)把实时目标与自带的闲视漂移混合——"注意到你"但不抽搐,保留闲时性格;镜像态(挂靠左侧/拖拽翻面)在写入侧对 x 取反,视线永远对着真实光标。
- **Agent 头像 pet 预设 + 状态绑定**:设置 → 外观 → Agent 头像样式新增"桌宠小球"预设(`avatar-presets.tsx` `CompanionAvatar`)——把桌面那只球放进头像槽,眼睛同样跟随光标。该预设**退出空闲效果轮播**:表情直接绑定会话状态(`THINKING_ORB_TO_SPRITE_MOOD`:composing→working,searching/solving/shaping→analyzing,listening→rest)。缺状态才是真正的病根——头部与聊天视图此前各自用一份重复的三元式派生 orb、都漏了待审批;`thinkingOrbStateFromSession`(lib/companion.ts)成为单一来源,有工具审批待处理时头像钉在新增的第 7 态 `waiting`(wave 动画,钉住不轮播——"暂停等你"),桌面桌宠同步切 waiting 表情。
- **主题跟随色板**:球体此前的石墨壳+品牌金配色只在默认金色主题下成立——ocean 蓝主题下金圈金眼配冷蓝球像三种凑在一起的颜色。现在壳/圈/眼/边缘光/眼辉的绘制全部从实时 `--accent` 派生:chroma.js 只负责解析 accent token,派生本身是纯 oklch 通道算术,值以 `oklch()` 字符串交付、由 Chromium 做色域映射(出 gamut 的亮 tint 保色相降色度)。`companion-palette.ts` 在启动时、data-theme/data-accent 切换时、以及桌宠窗口收到 `petActivity {theme, accent}` 推送时把 8 个变量(`--gui-pet-shell-a/b/c`、`--gui-pet-gold-a/b/c`、`--gui-pet-rim`、`--gui-pet-glow`)写上文档根。默认金色主题下与旧写死配色几乎重合(身份不变);mono 近中性 accent 经染色下限仍有色调。error 脸保留 `--color-danger`(球上唯一的红)。

## 5k. 桌宠交互轴、白脸与 footer 液态玻璃胶囊(2026-09-20)

本轮由四条用户反馈驱动:审批胶囊外圈有颜色、停靠球太大、球渲染成黑色而不是主题色、桌宠状态用得不够。

- **footer 胶囊统一为液态玻璃**(`gui-composer.css`):审批模式胶囊与设计风格胶囊共用**同一套配方**——`--glass-bg` 填充叠在 composer 框的磨砂面上、`blur(var(--gui-glass-blur)) saturate(var(--gui-glass-saturate))`,以及高光边(`--glass-edge-hi` / `--glass-edge-lo`)与 `::before` 上的对角 `--glass-sheen` 水光,按下走 `--spring-liquid`。**这圈边是 inset box-shadow,不是 border**——999px 圆角上真画 1px border 就会渲染出用户反馈的那圈可见环。(`--write` / `--yolo` / `--set`)状态保持同一玻璃面,只让**颜色**承载状态,切换模式不会改变胶囊的材质。底排右侧控件统一为 26px 高——审批胶囊、麦克风、发送与模型胶囊——动作控件落在同一条基线;欢迎页发送此前是 32px,与 26px 的麦克风不齐。
- **审批胶囊色圈是共享 class 的 bug**:`.gui-approval` 同时被审批**卡片**(`ApprovalCard.tsx`,它画 `--color-warning-soft` 是正当的)和 footer 胶囊(`approval-mode-button.tsx`)使用。卡片那条规则给无边框胶囊底下画了一整个警告色胶囊。修法是加 `--pill` 修饰类清掉 padding/radius/background(`padding: 0; border-radius: 0; background: transparent`),而不是把共享类改透明。**教训:改共享 class 前先 grep 全部使用点。**
- **停靠球尺寸**:`.gui-composer-pet` 的 clamp 从 `44px…60px` 收窄到 `34px…46px`。60px 时球比 composer 整行第一排还高,读起来像"粘在窗口上的一颗球";34–46 既在脸还能解析的区间内(眼胶囊 ≥4px、嘴描边 ≥0.75px),又明显从属于它所停靠的框。
- **黑球有两个成因**:(1) SVG 壳渐变的写死 fallback 是冷板岩色(`#4a5768/#26303d/#0e141c`)、不是 accent 派生——色板生效前的每一帧都画黑球;现在回落到达尔文本就该产出的深色 accent 石墨(`#7d7159/#453a24/#1c1408`)。(2) `app.tsx` 只在 `MutationObserver` 上推送 accent 色板,而它**首次加载从不触发**——桌宠窗口在用户换主题前收不到任何 accent。该 effect 现在挂载时也会先推一次。
- **脸在任何主题下都是白的**(`companion-palette.ts`):眼与嘴不再跟随 `--gui-pet-gold-a/b`。随主题变脸意味着 ocean 主题下蓝眼睛配蓝球,脸不再从壳上分离出来。白色守住了吉祥物唯一需要的可读性规则——**球上最亮的东西永远是脸**——主题则由圈来承载,一眼仍能看出配色。新增两个变量(`--gui-pet-face`、`--gui-pet-face-glow`),光晕是中性的所以永不染白脸。error 脸保留 `--color-danger`(唯一的那点红)。
- **眼动幅度**:`GAZE_TRAVEL` 从 13.2/8.4 提到 20.5/13.5(face 单位,眼睛环本身约 26 单位宽,±13 只像轻推不像注视),桌宠窗口的 `PET_GAZE_RANGE_CSS` 从 420 收到 260(视距过宽会把有效偏转带压缩进范围的头三分之一),头像预设的 `GAZE_RANGE_PX` 从 120 放宽到 150。
- **新增:桌宠交互轴**(`companion-face.ts` / `companion-motion.ts`):`CompanionInteraction` 是**第二条轴**——`startled` / `delighted` / `curious` / `dozing` / `peek`——刻意不并进 `CompanionMood`。`CompanionMood` 是 store 写入的会话契约;一次戳弄绝不能被持久化、必须按自己的时钟释放、并且要回落到实时 agent 状态。所以反应是**叠在状态之上**的:引擎按解析出的方向取数据,而 svg 同时带两个 class,好让状态那层的纯 CSS 材质(error 的红眼、hover 的增亮辉光)在反应期间不被重置。`COMPANION_INTERACTION_MOTION` 是全系统唯一允许"闹"的身体运动(戳弄类反应带 `enter` 过冲),因为它们由用户手势触发、约一秒内结束。
  - **composer 桌宠**:戳一下是 startled,900ms 内快速补一下变成 delighted——`ComposerPetState.pokes` 携带连击计数。hover 仍属状态(它是氛围不是反应);旧的拿 `dragging` 冒充戳弄已删除。
  - **桌面桌宠**:戳弄类反应保持 `POKE_HOLD_MS` 1400;新增两个闲时桥段——进入 60s 睡眠闩锁前 40s 开始 `dozing`(让入睡是渐睡而非硬切),以及每 12–26s 一次的 `peek`/`curious` "被抓包"桥段。反应会让位于实时手势与睡眠。
  - 测试:`test/pet-interaction.test.ts`(11 条)钉住这条轴的边界——数据成对完整、两轴名字不冲突、没有 mood 偷偷长出 `enter`、startled 不眨眼(惊到一半眨眼像在抛媚眼)、dozing 是全系统最慢的呼吸。

## 5l. 伙伴尺寸契约、装饰即配置与头像选择器(2026-09-20)

本轮由三条用户反馈驱动:重启后输入框上的小球**仍然**过大(但换任何其他头像都正常)、吉祥物积累了一堆没人要的装饰、设置页的头像行只能切换、什么都区分不出来。

- **输入框上的小球尺寸从来就不是 CSS 定的。** `CompanionArt` 的内置分支在 `.gui-pet` 上写了 inline 的 `width: size * scale` / `height: size * scale * (VIEW_H / VIEW_W)`。**inline 样式优先级高于任何样式表规则**,所以 `.gui-composer-pet` 的容器 clamp(§5k 加的 `34px…46px`)**一直没生效**,小球按创作尺寸渲染——dock 在输入框上沿时就是"一个巨大的球卡在窗口上"。其他头像预设走的是 petdex 分支(`SpriteSheetArt` 自带帧几何)或手绘 `<svg>`,从不经过这条路径,这正是"换其他头像就正常"的原因。**教训:样式表规则看起来没生效时,先排查 inline 声明,再回头调规则。** 这个 clamp 是第三次修这个症状——前两次都在给一个被覆盖的 CSS 重新调参。
- **尺寸契约**(`gui-pet.css`):一个盒子,两种尺寸来源,而"关键的那个数"永远由宿主提供。
  - `width` 主导 → `.gui-composer-pet`(容器 clamp),高度由 `aspect-ratio`(`--gui-pet-ratio`,即 SVG 自身的 `VIEW_W / VIEW_H`)跟随。
  - `--gui-pet--h` 让高度主导 → `.gui-avatar-pet`(调用点传 `--gui-pet-size`:工具栏/顶栏 20、聊天 64)与 `.pet-window__pet`(`--gui-pet-window-scale`,即大小滑杆)。
  - `--gui-pet-fallback`(旧的 `size` prop,改为自定义属性透传)是宿主既不给宽也不给高时的兜底,保证形象永远不会塌成 0。**调用点绝不能再给 `.gui-pet` 写真实的 `width`。**
  - `CompanionAvatar`(聊天头像)采用高度主导还有第二个原因:转录网格为助手头像预留了 **40px gutter**,一个多余的 inline 64px 会溢出布局给它留出的那一列。**定尺寸的槽位必须由槽位来决定尺寸。**
- **装饰现在是配置,不再是默认**(`lib/companion-decor.ts`):
  - **整体删除**——地面系(`__thrust` 悬浮辉光、`__bounce` 底部反光、`__ground` 地面投影)与头顶信标(`__antenna-group` 及其 `gui-pet-antenna` / `gui-pet-beacon` / `gui-pet-halo` 三组 keyframes)。地面系描述的是一具**悬浮在地面之上**的身体,而伙伴 dock 在输入框边沿,那里根本没有地面:这些层会溢进缝隙,读作输入框下方的一条金色污渍。信标在任意 composer 尺寸下都细到不足一像素——一个孤立的金点。**不是默认关闭,是不再渲染。**
  - **保留,但做成可关闭开关**——`gloss`(`__gloss` + `__gloss-dot` + `__sweep`)。它是唯一在每个场景下都成立的装饰:它让一个扁平深色圆读作**被照亮的球**。关闭 → `.gui-pet-svg--flat` 只隐藏光影层;壳渐变、环绕轨道环、边缘轮廓光与白脸全部保留。
  - **留白收紧** `HEADROOM 40 / SIDE 26 / FLOOR 30` → `TOP 24 / SIDE 20 / BOTTOM 22`(约 1.28× → 约 1.04× 球径)。球在同样的盒子里变大,边缘也不再悬空。旧的 `margin-bottom` hack(为补偿"占位但被隐藏的天线"把 composer 盒子往上拉)随之删除。
  - 存储是**标志记录**(`musepi-gui-pet-decor`),**逐键降级**——格式损坏或更新版本写入的键只降级自己,不会把整个形象清空(`test/companion-decor.test.ts`,12 条)。`COMPANION_DECOR_FLAGS` 是设置 UI 的生成来源——**加一个配饰(音符、耳机…)只需一条标志 + 两个 i18n key**,不需要手写新行。写入广播 `musepi-pet-changed`,而 `useCompanionArt` / `useCompanionDecor` 本就监听该事件,所以开关会同时落到 composer、聊天头像与悬浮桌宠。
  - 作用域:装饰只存在于**内置矢量**形象上。导入的 petdex 精灵表是烘焙好的位图——该分组会明确说明并禁用开关,而不是静默无效。
- **设置页的头像选择器能区分选项了**(`gui-settings.css`):`设置 → 外观` 的 Agent 头像样式分组原本是五个无标签的 38px 图标按钮,身份藏在 `title` 悬浮提示里,选中态是一条发丝描边——"只能进行切换"。现在是 `.gui-avatar-grid` + `.gui-avatar-card`:**32px 实时预览台**(小到能judge 出差异的尺寸;固定 40×34 槽位,让宠物的宽盒子与方形图标共享基线)、预设**名称**、以及选中项的**勾选**。外观细节(光泽/配饰)跟在卡片网格下方,只在「桌宠小球」预设下出现。两处都复用 `.gui-pet-card` 的卡片语言,让两个头像界面读作同一套系统。(`.gui-avatar-opt` 只留给引导流程的个性化步骤——git 设置里的用户头像来源已改用分段控件,见 §10。)
- **滑杆对齐**:伙伴大小滑杆步进为 5%,而 `petScale()`/`setPetScale()` 存取并夹取整数百分比,导致存下的值与标签错位(`step=5` → 60/65/70…,却按 1% 的夹取范围读回)。改为 `step=1`。

## 5m. 配饰、用户 SVG 导入与桌宠窗口四 bug(2026-09-20 下午)

本轮由五条用户反馈驱动:头像小球变空白、桌面小球保持石墨色而非品牌金、面板裁切/遮挡角色、拖拽位置恢复偏移,以及——功能需求——配饰(音符/耳机)+ 用户 SVG 导入,参考 clawd on desk / blobstudio。

- **配饰是 pick-one 联合类型,不是标志位**(`companion-decor.ts` 的 `CompanionAccessory = "none" | "note" | "headphones"`):§5l 预言"一条标志 + 两个 i18n key",但穿戴物**互斥**——分段控件(`.gui-pet-accessory-picker`)不会漂移成组合衣柜,clawd-on-desk 的教训("一个状态一套完整动画,不是换贴图")同样适用于穿搭。绘制为 **rig 组内的静态画**(脸部之后):随球缩放、免费骑在身体运动上;两者都按 rig 留白创作(音梁顶点 y≈−4 对 TOP 24;音符杆 r≈112 对壳 R≈114)所以不裁切——头顶漂浮的挂件会复刻已删除信标的"孤立金点"问题,所以音符是**贴在壳面上的贴花**。存储仍是逐键记录;`asAccessory` 把联合类型外的值降级为 `none`。
- **用户 SVG 导入 = 单帧 petdex 包**(`PetdexPackage.format: "svg"`):渲染端文件选择(≤512KB、`<svg` 嗅探、带 viewBox 文本兜底的 Image 解码以对付无尺寸 SVG)存为 `format:"svg"`、`rows:[1]`、`contentH = height`——预设网格、触发器、composer 与桌面桌宠全部经**现有** SpriteSheetArt 路径渲染(`backgroundPosition` 钉在 `0 0`;行偏移会在 hover/拖行时把整张图移出盒子)。心情系统对单静态帧降级为 transform 行(bob/lift/wiggle),与缺行的精灵表一致。
- **头像小球空白**——`.gui-pet-svg` **自身没有尺寸规则**(gui-pet.css 用 `.gui-pet svg` 后代选择器定尺寸);任何不套 `.gui-pet` 包装就渲染精灵的调用点会塌成 0。该规则升级为组件:`CompanionArtBox`(包装器 + 两个变量),包装器从导出的 `PET_BOX_RATIO` 发布 `--gui-pet-ratio`——样式表字面量只作水合兜底,重调 VIEW 不再静默失同步每个宿主。
- **石墨球**——桌宠窗口从不加载 `tokens.css`,根上不存在 `--accent`,`applyPetPalette` 落到硬编码暖石墨兜底("黑色带点黄")。从源头修:`pet-window.css :root` 携带品牌金 `--accent` 字面量(主窗口的主题推送仍会覆盖它)。教训:**推送管线需要在接收端有正确默认值**,而不只在发送端。
- **历史面板裁切 + 遮挡**——已移除的窗内 `.pet-panel` 对自己上报的高度设置上限，形成窗口尺寸反馈循环；开关订阅在重注册时也可能执行旧 handler。当前契约没有窗内面板。独立的 `bubbles.html` 卡片上报未钳制的内容尺寸，由主进程把独立窗口限制在工作区内。
- **历史拖拽位置偏移**——已移除的单窗口会随浮层改变高度，只恢复左上角位置会移动 sprite。当前桌宠窗口保持固定尺寸，气泡窗口跟随它，但不改变它的边界。`pet-drag-client` 从同一组光标/窗口锚点推导拖拽位置；持久化的 `{x,y,w,h,dock}` 在恢复前按显示器工作区校验。
- **当前窗口架构**——`pet.html` 只包含 sprite 和隐藏气泡栈角标；独立的 `bubbles.html` 窗口承载会话与审批卡片。两个窗口都不会改变对方的尺寸。

## 5n. 语音输入交互:只承动效的麦克风按钮与输入框内状态条(2026-09-20)

本轮由三条用户反馈驱动:中文听写输出繁体、转录很慢且全程无反馈(按钮的状态在文字出现前就结束了)、以及麦克风胶囊"装不下那么多文案——更应该承载动效"。

- **30px 胶囊是动效预算,不是文案预算**(`composer/action-buttons.tsx` 的 `VoiceButton`):按钮只通过染色 + 脉冲(录音中)与 spinner(转写中)承载状态——秒数时钟、相位文案、取消提示永不回灌。控件装不下自己的反馈时,把反馈挪到装得下的地方;在胶囊里缩小字号读作坏了,不是紧凑。
- **反馈长在输入卡内部，但不再套一层方框**(`VoiceStatusStrip`,composer children、textarea 上方——与错误胶囊同位)：紧凑状态带以玻璃麦克风、阶段文案和实时识别文字为主，波形只辅助显示音量；右侧使用 Esc 键帽与取消文案。录音显示红色麦克风和计时，转写切换为品牌色处理环，整个等待期都保留反馈。经 `role="status"` / `aria-live="polite"` 播报。
- **真实音频驱动视觉状态**：麦克风 RMS 直接缩放波形与多层声环，不播放自主循环假波形；转写阶段移除波形，避免误认为仍在录音。临时识别文本优先占据弹性预览区，无文本时显示当前阶段提示；窄输入框先隐藏辅助波形，再收起取消文字。减少动态效果时保留静态状态、进度和全部文字，停止波形过渡与处理环旋转。
- **预览与正式文本分流**（`use-dictation.ts`）：`partial` 只更新临时预览，`segment` 才插入正式文本。任一分段为 `uncertain` 时整段只保留草稿并禁止自动提交；`reject` 不产生转写。取消后迟到事件全部失效。停止录音后仍立即进入转写相位。
- **声纹录入使用固定且垂直居中的 `DialogFrame`**：四段朗读加一次独立验证，显示真实进度，只保留一个主操作。液态玻璃圆球区分准备、录音、处理、单段通过、失败和完成；录音由真实 RMS 驱动，处理态旋转，通过与完成提供短促的落定反馈。失败保留当前段并提供重试，完成后显示明确的完成操作。减少动态效果时保留静态进度、状态文本与错误。音频计算向量后立即释放，本机只保存声纹向量。
- **语音设置保持完整且可管理**：权威的 `voice` 标签与 `Speech` 分组统一承载语音输入、朗读、语音供应商和 Live Voice 控件，不再拆分到供应商与交互页面。语音包详情与完整设置页共用同一输入设备控件：设备菜单旁直接显示实时 RMS 电平，支持热插拔刷新以及内联权限或可用性反馈。不需要独立检测按钮，也不增加另一块录音面板；关闭或隐藏所属界面立即停止采集。停用 STT 或 TTS 包只隐藏对应依赖控件、模型选择器和测试操作，持久化的领域设置保持不变，重新启用后恢复显示。已缓存 STT/TTS 模型经确认后可删除；先停止对应 worker 再清缓存，当前页面不会立刻重新下载刚删除的模型。

## 5o. 状态轴措辞与导入 SVG 成为完整伙伴(2026-09-20 晚)

本轮由一条方法论指令及其功能落地驱动:「我们以后不能靠语义来复刻,而是直接吸收源码——语义相似但效果千差万别,完整复现后我们的伙伴形象才精致完好」,以及让导入的 SVG 伙伴与内置球体支持同一套状态、特效与参数。

- **吸收,不是神似**:运动表、dash 飞行公式与 settle 时序全部换成源站的字面值,逐字对照反解出的引擎源码(注释完整)核验。"语义相似"的 sway 并排一看就是两种东西;数字完全一致,伙伴才读作同一物种的运动。数值由测试钉死。
- **状态轴天然 shape-agnostic——导入 SVG 伙伴直接继承**:此前 `format:"svg"` 的 petdex 包退化到 transform 行 mood;现在经 `PetdexStateStage` 渲染,获得与内置完全相同的 31 态运动、七类特效与 dots/glyph 身体消解,全部按 face-unit(228.541 盒)归一,任意宿主尺寸下比例不变形。这正是源站自己的契约:"an uploaded logo behaves exactly like the built-in circle"。
- **耳机是 AirPods Max,也是身体的成员**:白色阳极氧化板 + 玫瑰金轨/滑杆/Digital Crown,固定身份(从 accent 派生的配色会溶进金色壳;中间的炭灰版被读作秃头)。blobstudio 没有配饰系统——附属于身体的东西都活在身体组里——所以整套耳机住在 `bodyRef`:dash 飞行带着耳机,dots 消解连球带耳机一起化掉。旧炭灰头梁、滑杆、耳罩与麦克风臂全部移除(AirPods Max 没有麦克风臂;Crown 才是签名)。
- **特效层以兄弟身份夹住 rig**:后层轨迹被球正确遮挡,前层火花浮在上方,两层都不继承身体的 motion transform——尾巴要采样飞行路径,不是搭车在里面。

## 5p. 定制跟着预览走,挂靠小球长回来(2026-09-21)

本轮由三条用户诉求驱动:「这个小球的定制放到常规Agent头像那里去?」「挂靠输入框时的小球稍微大一点?」「耳机稍微大一点?」。

- **外观细节组住在预览旁边**:光泽开关 + 配饰选择器从伴侣页尾部搬到外观页 Agent 头像样式分组正下方。宠物头像卡就是活的 `BuiltinCompanionArt`——拨动开关立刻在上方网格里读到反馈,而不是跑到另一个页面去看。该分组只在选中的头像样式是「桌宠小球」时挂载(这些图层不存在于别的样式上);组件自持状态(自己解析、订阅 `musepi-pet-changed` 重解析),挂哪都成立。伴侣页保留形象选择/尺寸/导入。
- **挂靠球保留清晰的响应式盒子**：容器查询 clamp 为 48–64px；≤380px 的输入框保持 46px，即完整面部的下限，不进入 micro 变体。矢量球体填满盒子的 100%，不再停留在 fallback 尺寸，因此图形与可点击包装层同步缩放。宿主仍通过 `--gui-composer-pet-size` 覆盖尺寸，不在 JS 中指定像素几何。
- **耳机作为整体绕球心缩放**(`HEADPHONE_SCALE` 1.08):耳罩、canopy 与轨是按一个刚体授权的,放大就是引擎每帧配件 transform 里的一次 scale——不是重新绘制。1.08 是所有极值都留在 rig padding 内的最大系数;尺寸与 gaze 倾斜搭乘同一属性,因为该属性归引擎所有。

## 5q. M1 轮渲染语义在 desktop 的落地（2026-09-21，roadmap M1.9）

**架构事实（先明确，避免重复建设）**：desktop-app 的消息渲染不是自有实现，而是直接复用 guest-client 的 React `Transcript` 组件（`ChatView.tsx` 以 `@musepi/guest-client` 包引入，daemon JSON-RPC 只负责供数）。因此 M1.1/M1.2 落在共享组件上的能力——**turn header、工作段折叠、tail/hook 行折叠豁免——desktop 天然全量继承**，无需移植编码。

本章节只登记 desktop 侧的三处接线与等价物映射：

1. **model prop 接线（已落地）**：`<Transcript model={snap.state.model ? provider/id : undefined}>`（`ChatView.tsx`），与 DetailsPanel 同一 compound key 约定；render-units 语义取 turn 内最后一个 model_change，轮内切换仍显示实际产出回复的模型。缺省（无 snap）时 header 不显示模型段。
2. **审批等待反馈——等价物映射，不照搬**：guest-client 用 ApprovalCard 底部 accent 进度线；desktop 的 ApprovalCard 已有 pulse border beam（`BorderBeam`）+ 提示音，且 ChatView 有 "paused for you" wave 语义（审批 pin waiting）。设计裁决：**desktop 保持 beam/wave 现状**，进度线不跨面照搬——两个面各自已有"卡片承担进度反馈"的实现，语义同构即可，视觉允许面差。
3. **loading 收敛**：desktop Composer 无 guest 式聊天 loading pill，工作态指示走 `snap.working` 既有链路；M1.2 的抑制矩阵（审批/ask/compact 期间抑制聊天 loading）在 desktop 无对应物可抑制，记为无需移植，仅保留语义对照。

**M1.3 滚动锚定**：将落在共享 `Transcript` 组件内（现有 followKey/lockRef 机制上补 timelineScrollAnchor 语义），一处落地 guest + desktop 两面同时生效，不设 desktop 单独验收。

**液态玻璃统一（roadmap M1.10 前置说明）**：turn header/折叠段 CSS（`.tr-turn-head`/`.tr-seg` 系列）已在 guest-client transcript.css 内以液态玻璃 token（`--glass-*`）实现，desktop 随包继承同一套样式；M1.10 的全产品统一设计稿将以 guest-client tokens.css 暗色段 + desktop gui.css 液态玻璃段为双基准做映射，不动本章节组件语义。

**验收**：desktop-app `tsgo --noEmit` + biome 全绿（已达成）；人工走查：折叠态/展开态/审批等待三视图（desktop 真机 daemon 会话）。

## 5r. 轮渲染视觉语言（M1，2026-09-21 转正）

参照 ZCode v4 轮渲染单元语义（`zcode/packages/ui/src/v4/conversationTurnRenderUnits.ts`）。**设计基线**：全部视觉值取自 `packages/client-core/src/styles/tokens.css` 暗色段，禁止发明新 token；品牌 accent #d9a441 金禁止改。

**轮结构（`ConversationTurnRenderUnit` 对齐）**：

```
turn
├── turn header        轻边界：turn 序号 · 模型 · 时间 · 聚合状态(✓/进行中 + 耗时)
├── user bubble        现有 tr-user 语言
├── workSegments[]     语义折叠单元（核心新增）
│    折叠态(默认历史)  单行：chevron + 段摘要 + 工具数 + 段状态 + 段耗时
│    展开态            工具行全序列表（各自状态+耗时）
├── latestAssistantTextRow  轮尾最终正文（复制/重试/分支操作栏）
├── tail rows          重试失败 / 异步结果 / token 用量 —— 永不进折叠
└── hookInvocations    hook 行（mono 细条 + 左边线）—— 永不进折叠
```

**折叠边界规则**：① 段划分 = 原始输入 + 每条 accepted guide 各一段（ZCode `workSegments` 语义），段内保持 CLI row 全序；② 历史轮一律折叠，当前轮工作段默认展开随流式追加；③ 聚合状态取段内最差（任一 err → err；否则 running；否则 ✓），耗时为段内工具耗时之和；④ 折叠的是"工作过程"不是"信息"——latestAssistantTextRow / tail rows / hook 行 / 用户气泡，以及产出物（`widget` / `board` / `schedule_task` 卡片，工具产出的图片——内容 image 块与 `generate_image` 的 `details.images` 同一条路径）所在行一律不参与折叠，折叠关闭态与回言行只收起卡片外壳；⑤ 展开/收起 `--spring-liquid` 0.25s，chevron 旋转同步。与既有 pre-compaction 折叠（`collapseCompacted`，按时间切）独立共存。

**IRC 流量行（`irc:*`）**：每条消息一行，不并入工作段折叠。路由（`from → to`）由 `details` 组成，`content` 里的 `[IRC …]` 头与 incoming 的 `<irc>` 模板都不渲染；三种 kind 只差视觉权重——`relay`（旁观的双方流量）最轻，`incoming` 读作发给当前会话，`autoreply` 带 `auto` / `reply` 标签。同一对 agent 的连续消息共享一次路由头，正文超过 3 行截断并提供显式展开——一段往返问答不再逐条重复发言人。展开/收起复用共享 collapse morph：clamp 在开始展开时摘下、收起结束后再挂回，高度按 220ms `--spring` 过渡，不会瞬跳。


**过程行的折叠锚点**：思考块、活动/运行汇总与工具卡片共用左侧折叠字形（`.tr-round-fold-icon` / 前置 `.tv-chev`）；思考块流式输出显示「思考中」，结束后显示「思考过程 · 时长」或「思考完成」。后台完成卡改为用户侧锚定（右对齐、与用户气泡同右缘），卡片头即折叠锚点，输出/payload 可整体收起。

**运行中后台任务 HUD（`AsyncJobBar`）**：会话有运行中的 job 时，输入框上方出现一张卡片，逐行列出命令、状态点、实时时长、取消与详情入口；收起后只留「后台 Bash · N」chip。桌面端点详情打开右侧「后台任务」surface（`JobsPane`：运行/全部过滤、实时输出尾部、取消）；web / Android / 鸿蒙没有右侧面板宿主时，同一卡片就地展开详情 sheet。读数只来自 `session.jobs` / `session.jobOutput` / `session.jobsCancel`，1s 轮询且仅在文档可见时进行；没有运行中的 job 时组件不渲染，也不轮询。

**设置开关（2026-09-26 补齐，Kimi Code 桌面端 parity，入口：外观 → 聊天设置）**：

- **消息自动折叠**（默认开）：回合完成（非流式 in-flight）时该轮工作段自动收为折叠态、仅展示总结——这是 §5r 折叠的默认行为，开关控制渲染默认态（`defaultRoundFoldExpanded` 取反，纯渲染偏好，不改折叠内核）。**流式中当前轮永不收**（in-flight 轮豁免，`working` 边界同 `buildRoundFolds`）。关闭 = 已完成轮的活动摘要默认展开、逐条呈现工具过程。存储键沿用 `musepi-gui-chat-roundfold` 的反义映射（键语义仍是"默认展开"），原「活动默认展开」开关由此替换，旧设置值无缝迁移、无需新存储通道。
- **工具调用汇总**（默认开，键 `musepi-gui-chat-toolsummary`）：回合内 ≥2 次连续工具动作（toolResult / bashExecution 行，按 `classifyTranscriptRow` 的 work 口径）聚合为**一行摘要**——`读取了 N 个文件 · 编辑了 N 个文件 · 运行了 N 个命令`（按工具类别聚合计数，i18n 双档；纯函数 `round-collapse.buildToolRuns`，摘要行 `.tr-run-summary` 复用 `.tr-round-fold` 的 token 语言）。单次工具调用不汇总（自有卡片已足够）；摘要行点击展开该段的完整行序、再点收回（折叠的是过程不是信息，展开态必须可回）；流式中延伸到条目末尾的 run 保持逐条（spinner 即进度，§D），已完结的 run 照常汇总；关闭 = 现状逐条渲染工具卡。与消息自动折叠正交：折叠关闭态由 活动 头承担摘要，汇总行只在展开态/当前轮生效。

**loading 可见性（判定表）**：权限确认 pending → 聊天 loading 隐藏，由 ApprovalCard 进度线承担（2px，`--glass-border` 轨道 + accent 40% 滑块，`plslide 1.6s var(--spring-liquid)` 无限，文案"等待用户决定"）；AskUserQuestion pending → 提问卡自身承担；compact 进行中 → compaction divider 承担；goalVerifier 活跃 → verifier 卡片承担（挂接点待确认）；正常流式 → 显示；pending resolve 后恢复。

**tail/hook 行**：tail rows 保持 CLI 全序原位渲染，chip 用 `--glass-bg-strong` + inset rim；hook 行 turn-local，mono 细条 + 2px 左边线（`--glass-border`），`hook 名 · 事件 · 耗时`，hover 出详情——永不并入工作段折叠（hook 是轮的"事后审计信息"）。

**流式进行态（D）**：turn header 圆点 accent + 旋转 spinner + "进行中"，耗时 `…`；当前轮工作段 `.tr-seg--open.tr-seg--live`（`--glass-bg-strong` 底，与历史段 `--glass-bg` 区分）；进行中工具行 spinner + `…`，完成立即转 ✓ + 实际耗时；滚动锚定视口钉在 `latestAssistantTextRow` 末行；流式 caret 8px×1.1em accent 块 0.9s steps(2)。

**遗留决策点**（随实现推进裁定，未裁定前按现状执行）：① turn header 是否保留模型名段（多模型场景有用，单模型是噪声——现状：接线后缺省不显示）；② 段摘要的 i18n 模板句 vs 规则拼接；③ token 用量行 settings 开关；④ hook 行是否默认聚合 "N 个 hook · 展开"。

## 5s. 液态玻璃材质与动效语言——全产品视觉总纲（M1.10，2026-09-21 转正）

> 总纲：**整个产品统一液态玻璃视觉与交互效果，动效丰富流畅，一镜到底。** 双基准：client-core `tokens.css`（web/安卓/desktop 共享渲染层，`--glass-*`/`--spring-liquid`）+ desktop-app `gui.css`（桌面壳，`--gui-motion-*`）。收敛方式是**单向映射层**而非合并词汇：desktop 壳保留 `--gui-motion-*`（motion-pack 皮肤机制是产品特性），取值与曲线锚定 client-core 玻璃语言；client-core 不引入 `--gui-motion-*`。

### 玻璃 = 四层配方（缺一不可，blur 缺席时后三层独立成立）

1. **底** `--glass-bg` / `--glass-bg-strong`（卡面 7% / 浮层 11%；亮色 55%/72%）
2. **缘** `--glass-border` + 内 rim（edge-hi 上缘高光 30% / edge-lo 下缘收 7%）——"液态"读感主要来自 rim 的 1px 高光，不是 blur
3. **泽** `--glass-sheen` 线性渐变（对角 45°，仅浮层/活动卡）
4. **影** `--glass-shadow` 双层（近环 + 远落地）

**层级表（新增组件必须按级取值，禁止跳级发明）**：L0 pane（滚动面板底/输入条：全无）/ L1 card（折叠段、消息卡、工具卡：底+缘）/ L2 float（ApprovalCard、TurnNavigator 预览、回到底部钮、lightbox：强底+缘+rim+泽+近环）/ L3 overlay（对话框、GlobalPause、导览：双层全量）。

**活态**（玻璃随会话状态呼吸）：streaming/进行中 → rim 高光换 accent、底升 strong；审批等待 → 进度线（guest）/pulse beam（desktop）+ 底升 strong；冻结态回落 L1。

### 动效语言

- **曲线统一锚点**：常规变形 `--spring`（linear()）；entrance"弹入" `--spring-liquid = cubic-bezier(0.34,1.56,0.64,1)`（两面对齐到此，写进规范防漂移）；退出 `--spring-snappy`（无 overshoot）；俏皮（宠物/彩蛋）`--spring-bouncy`。
- **时长阶梯**（desktop `--gui-motion-*` 保留，取值成规范）：130ms 菜单浮层 → 160ms 淡入淡出 → 180ms chip/小件 → 240ms 高度形变/滚动 → 280ms 模糊 → 480ms 大高度形变上限；高度形变一律 delta/6 capped；位移 6px（小）/10px（大）；模糊量 8px/24px。
- **一镜到底（核心交互原则）**：场景切换不许黑场/闪白/整屏淡入淡出——共享元素持稳定 identity（data-morph-id）从原位置连续变形（desktop `morphFrame` 先例收编：单 rAF 链 translate+scale 插值）；非共享元素就地收缩/滑出（高度形变到 0 + 8px 下滑），整屏 opacity 动画禁用（系统级 overlay 除外）；会话切换（welcome→chat、chat→chat）按此执行，聊天内发送视为同场景增量；场景 morph 总长 300-420ms。
- **降级**：`gui-motion-off`/`prefers-reduced-motion` → morph 与浮层 entrance/exit 都即时完成（玻璃材质保留，材质不是动效）；`prefers-reduced-transparency`、不支持 `backdrop-filter` 与 `[data-platform="win32"]` → 浮层 blur 归零，切换不透明可读底色并保留 border/sheen/rim/shadow。

### Token 映射表（落地契约）

| 统一语义 | client-core | desktop-app |
|---|---|---|
| 玻璃底/强底 | `--glass-bg(-strong)` | `--gui-glass-alpha` 派生 overlay（对齐 7%/11% 两档） |
| 玻璃缘 | `--glass-border` | 同名对齐，否则 gui.css 引 client-core 值 |
| entrance 曲线 | `--spring-liquid` | 同名（已天然一致） |
| 淡入淡出 | 160ms ease（不新建变量） | `--gui-motion-fade-in/out` 时长语义 |
| 高度形变 | delta/6 capped | `--gui-motion-height(-max)` 同一规则 |

**纪律**：新组件先查本表与层级表；两表没有才提案新增，新增必须双面上报（更新本章）。

### 批次计划（随里程碑推进）

A（顺手带）：M2-2.10 设置面板审计对齐玻璃层级；回到底部按钮（L2 规格，已落地）。B（guest/安卓壳）：ConnectScreen→会话 morph、移动端列表↔会话 morph、composer 浮层升 L2。C（desktop 壳）：面板浮层（ContextPanel/DetailsPanel）层级审计到 L2/L3；会话切换 morph 推广到 chat→chat。D（收口）：映射表 CI lint（check-radius-tokens 先例）、双平台截图对比报告。

**验收**：映射表与层级表即本章（已合入）；逐面板收敛 biome+tsgo 全绿、无"表外" token、motion-off 无中间帧；Windows blur 缺席下与 macOS 并排截图对比可读性；动效抽查（无黑场、entrance 全走 `--spring-liquid`、时长落阶梯）。

## 5t. 顶栏（titlebar）架构定稿：避让三件套与"无 tab"原则（2026-09-22，替代 §3.1 A2 的内联 tabs strip）

> 背景：A2 批次曾在顶栏内联加入会话 tabs strip（与会话标题 pill 并排），评审认定"四不像"——tab 与标题挤在顶栏同一层级、折叠侧栏时标题 pill 与浮动控制簇重叠。本章为顶栏的最终设计约束，后续顶栏改动以本章为准。

### 设计依据（来自参考实现的实测结论）

- **openchamber**（`packages/ui/src/components/layout/TitlebarLeftControls.tsx` + `Header.tsx` renderDesktop）：浮动控制簇（侧栏开关 + ProjectActions）是 drag header 的 fixed 子节点；簇用 ResizeObserver 实测自身宽度，发布为 CSS 变量 `--oc-titlebar-controls-width`；头部内容区左侧放两个 spacer——① 红绿灯 drag inset、② no-drag carve spacer（宽 = controls-width，220ms 宽度过渡）。侧栏顶部另有 `SidebarTopBar` 预留条（drag inset + no-drag carve + drag 剩余）。
- **openchamber `sessionTabsEnabled` 默认 false**：会话 tab 是实验功能；开启时由 SessionTabsStrip **承载标题**（活动 tab 内嵌标题列，是"替换"而非"与标题并排"）。
- **zcode（zai-org/ZCode）桌面端 GUI 存在于 `packages/desktop` + `packages/ui`**（本地 `zcode/` 克隆即含，初始开源提交即有；2026-09-22 实证）：顶栏模型 = `WorkspaceHeader`（TitleSection + ActionSection 两段，**无 tab 条**；`DesktopWindowFrame` 的 `tabBar` 插槽语义是"渲染在 header 内标题**后面**"，不与标题并排）；Win/Linux 用**内联自绘窗口控制按钮**（`DesktopWindowControls`，min/max/close 在 ActionSection 最右，`[app-region:no-drag]`，最大化态经 platform 事件同步换 restore 图标）而非原生 `titleBarOverlay`；mac 避让 = 状态感知 padding 类（pl-38/48/58/66，按全屏 × 更新就绪角标取值，更新角标占红绿灯区），过渡显式限定 `transition-[padding]`（注释说明：限定 transition-property 避免非合成动画拖慢大会话 resize）；Linux 外壳 16px 圆角 + `clip-path` 合成裁切防圆角丢失 + win/linux 不透明根底（mac 才有 vibrancy 透明底）。
- 结论：**tab 若未来要做，走 openchamber 模式（tab 承载标题）或内容容器内的 tab 条（zcode tabBar 插槽同属此类），必须先出设计稿评审；顶栏本身永远不放与标题并排的 tab。** 窗口控制：维持我们的原生 `titleBarOverlay` + 150px 右避让（零维护、白得系统 snap/贴边布局）；zcode 内联自绘按钮列为已评估替代方案——若未来要主题化窗口按钮或在标题栏塞更新角标再切换。

### 我们的窗口 frame 配置（`apps/desktop/electron/main.cjs`）

主窗 `titleBarStyle: "hidden"`；macOS `trafficLightPosition: {x:16, y:17}`；Windows/Linux 用原生 `titleBarOverlay {height: 48}`（右上原生最小化/最大化/关闭，命中区约 138–150px，内容右避让取 150px）。

### 避让三件套（落地契约）

1. **左浮动簇** `.gui-float-controls--overlay`：fixed，`left: 84px`（mac，红绿灯避让）/ `16px`（win/linux），`top: 11px`，z 50，header 子节点保证 no-drag 生效。簇内容 = 侧栏开关 + openin 胶囊（自动发现/停止 + 预览 + 项目动作），对应 openchamber toggle + ProjectActionsButton。
2. **折叠 spacer** `.gui-header-spacer`：仅 `data-collapsed="true"` 时渲染宽度——win/linux `calc(var(--gui-float-controls-width, 86px) + 8px)`；mac `calc(68px + var(--gui-float-controls-width, 86px) + 8px)`（84 − 16 基础 padding + 簇宽 + 8 间隙），220ms 宽度过渡。**禁止**再用内联 `paddingLeft` 凑数（已删除的 mac 172 / win 16 hack 即为反面教材——win 折叠态 16px 让标题 pill 被浮动簇压住）。
3. **簇宽变量** `--gui-float-controls-width`：GuiHeader 内 ResizeObserver 实测簇宽发布到 `document.documentElement`。簇宽随运行态变化（devRunning 时多出预览按钮），必须实测而非常量。

右侧避让：`hasOverlay`（win/linux）时头部 `paddingRight: 150`，与 `titleBarOverlay` 命中区对齐；右侧功能簇（暂停组 → mini-chat → openin）层级与 P-tier 退避维持 §3.1 既有约定，不在顶栏加新常驻项。**2026-10-21 减法**：「终端」「board」「右侧面板」三个按钮已移出顶栏——终端开关改居会话右缘 RightRail 底部组（与面板折叠钮相邻，dsh 位置）；board 入口在侧栏菜单；右侧面板折叠仍由 RightRail 底部钮兜底。原实例按钮（本地/远程守护进程、版本、延迟、浏览器桥诊断）整块迁至侧栏底栏左侧（`InstanceButton`，状态点 + 「本地」胶囊，菜单内容不变），侧栏 footer 呈「实例在左、设置在右」两段布局。

### 会话导航回归 switcher

会话切换 = 标题 pill 的 switcher 下拉（openchamber SessionSwitcherDropdown parity：新建会话 + recent sessions，折叠侧栏时尤为关键）。`surface-tabs.tsx` 的 SurfaceTabStrip 保留——那是多实例面板的 tab，属内容容器语义，与本章不冲突。

### 验收

- 折叠侧栏：标题 pill 与 `.gui-float-controls--overlay` bounding rect 不相交（走查脚本 step 04 断言此条）。
- 展开侧栏：spacer 宽 0，头部无多余留白。
- 簇宽变化（dev server 启动出现预览按钮）后 spacer 自动跟随，无重叠帧。
- mac/win 双平台 data-platform 分支各自生效。

## 5u. 弹窗动效与样式规范（2026-09-26 定稿，评审决策①-⑧全按默认建议执行）

> 对桌面 GUI 全部模态弹窗 / 全屏覆盖层生效。**以下全部取值为现存值收编**——§5s M1.10 阶梯 + 各组件现行值；禁止为弹窗发明新 token、新曲线、新 scrim 配方。组件盘点依据 `.workbuddy/tasks/2026-09-26-installer-update-dialogs.report.md` §3.3。

### 浮层选择：六类表面

| 类别 | 用途与示例 | 材质 | 键盘与焦点 | scrim |
|---|---|---|---|---|
| Tooltip | 共享 `gui-tooltip`、`RailTooltip` | **L2 float**：强玻璃底、边框、完整上下缘、sheen 与阴影 | 不移动焦点；触发器持有 `aria-describedby`；提示内容不是操作面 | 无 |
| Toast | `ActionToast`、`UpdateToast`、client-core `Toasts` | **L2 float**，中性底色，状态由图标/accent 表达 | 非模态；动作与关闭钮可键盘到达；悬停或焦点暂停过期，错误须手动关闭 | 无 |
| Alert / approval | `ApprovalCard`、需要决策的工具调用 | **L2 float**，共享玻璃上叠语义状态色 | `alertdialog` 语义但不全页锁焦；批准/拒绝控件各自处理激活键 | 无 |
| Drawer / sheet | `AgentDrawer`、`SessionsSheet`、能力抽屉 | 仅容器取 **L2 float**；内容行保持纸面感 | 共享 modal 栈：仅栈顶处理 Tab 与 Escape；关闭后归还可连接的 opener | 标准 |
| Modal / palette | `DialogFrame`、`TaskModal`、看板/媒体覆盖层、`CommandPalette` | **L3 overlay** 完整玻璃配方 | 共享 modal 仅在栈顶锁焦；palette 聚焦输入框、支持方向键导航并以 Escape 关闭 | 标准；仅全屏导览/系统面使用重玻璃 |
| Confirmation | Promise confirm、client-core `ConfirmDialog` | **L3 overlay** 紧凑尺寸；`ss-card--confirm` 与 L2 sheet 区分 | 普通确认 Enter 提交；危险确认 Enter 永不提交且初始焦点在 Cancel；仅栈顶 Escape 取消 | 标准 |

`gui-motion-off` 与 `prefers-reduced-motion` 同时取消入场和出场动画。`prefers-reduced-transparency`、不支持 `backdrop-filter` 以及 Windows 无 blur 时，保留边框、上下缘、sheen 和阴影，底色切换为不透明可读表面；常驻 transcript 与 composer 不得新增浮层 blur。

### 出入场动效阶梯

| 场景 | 曲线 | 时长 | 说明 |
|---|---|---|---|
| 弹窗/覆盖层**背板入场** | ease（纯 opacity） | **160ms**（`--gui-motion-fade-in` 档） | DialogFrame / onboarding / TaskModal / palette 背板均为 160ms |
| 弹窗**卡片入场** | `--spring-liquid` | **240ms**（高度/位移档） | DialogFrame 与 TaskModal（`gui-focus-zoom 240ms`）；palette 保留 130ms `gui-menu-in`——菜单浮层语义，成文例外；UpdateToast 保留 260ms spring（非模态浮件，非弹窗卡） |
| **出场（背板+卡片）** | `--spring-snappy` | **140ms**，宿主保持挂载 **180ms** 后卸载 | DialogFrame 为基准（140/180）；onboarding 系（Onboarding/Announcement/Reward）已对齐 140/180。例外：UpdateToast 180ms ease-in（非模态 chip 档）、palette 130ms `gui-menu-out`（菜单档） |
| GlobalPause（系统级例外） | `--spring` transition | 进入 240ms / 退出 320ms | 整屏接管属 M1.10 §3.3 明文的整屏动画例外 |
| 位移幅度 | — | 出场下滑 **4px**（小位移子档，6px 内）；入场无位移（scale 0.94→1 承担） | `gui-dialog-out` translateY(4px) 保持——决策⑥：弹窗出场是"收拢"不是"位移"，阶梯的 10px 大位移档对弹窗不适用 |

### scrim 规范（两档制）

| 档 | 配方 | 适用 |
|---|---|---|
| **标准 scrim** | `color-mix(in oklab, var(--color-bg) 55%, transparent)` + `blur(6px)` | DialogFrame 系全部模态、TaskModal、CommandPalette（自裸黑 35% 迁入，决策⑦） |
| **重玻璃 scrim** | bg 42-55% + `blur(24px) saturate(150%)` | 仅"接管全屏"的系统级/导览面：Onboarding、Announcement、Reward、GlobalPause、（预留）强制更新层 |

判据：需要继续感知被覆盖内容的用重玻璃（导览、冻结）；纯阻断注意力的用标准 scrim。**禁止第三种配方。**

### 圆角与尺寸档位

| 档 | 圆角 | 尺寸 | 适用 |
|---|---|---|---|
| compact | `--radius-xl` | max-width 380px、auto 高、padding 22×24 | confirm / prompt / 更新决策卡（`gui-dialog--confirm`） |
| standard | `--radius-2xl` | 600×420（`min(600px, 90vw)` × `min(420px, 80vh)`） | 设置类/表单类弹窗（`gui-dialog` 基类） |
| wide | `--radius-2xl` | 内容定义（SaveImage 760px、palette 620px、Connect 向导、技能抽屉 480px 侧边抽屉） | 预览/多列/向导/侧边抽屉 |
| 导览 | `--radius-2xl` | 居中浮动、四边留 ≥80px 玻璃边；各卡自定阅读宽度：引导 `min(1000px, vw−160)` × `min(620px, vh−160)`、新功能 `min(680px, vw−160)` × `min(560px, vh−160)`、奖励 `min(520px, vw−120)` × auto | Onboarding / Announcement / Reward |

### z-index 层级表

| 带 | z | 内容 |
|---|---|---|
| 内容浮层 | ≤120 | 历史容器内浮层（现无成员） |
| 导览/系统覆盖 | 200 / 卡 210 | onboarding 系、GlobalPause 卡（GlobalPause 背板 9999 见下） |
| 非模态浮件 | 900 | UpdateToast |
| 模态弹窗 | **3000** | DialogFrame 系全部、TaskModal（自 120 迁入） |
| 命令面板 | **4000** | CommandPalette——必须压过一切模态：它可能从模态内唤起 |
| 系统级阻断 | **9999** | GlobalPauseOverlay（及未来强制更新层） |

新增弹窗类组件**只允许落 3000/4000/9999 三带**；120/200/210/900 是历史存量带，迁移或废弃时随手归带。既定例外：onboarding 系保持 200，为其内部 portal 浮层（卡 210）保留越出背板的能力——说明写在 gui-widgets.css 对应规则处。

### 键盘契约

1. **只有共享栈顶模态拥有键盘**：Escape 在 `document` **capture 相位**认领；嵌套底层保持打开，但不处理 Tab 或 Escape。
2. **焦点进出**：打开移焦至首个可聚焦元素（prompt 类聚焦输入框，危险确认聚焦 Cancel）；关闭栈顶后归还可连接的 opener，关闭底层绝不抢焦点。
3. **普通 confirm 弹窗 Enter=确认、Escape=取消**；prompt 输入框内 Enter=提交。**危险确认绝不以 Enter 提交**——初始焦点在 Cancel，必须显式激活确认按钮；栈顶 Escape 仍取消。
4. **强制/系统级覆盖层吞 Escape**：GlobalPause 的 Escape=恢复（语义等价关闭）；未来强制更新层 Escape 无效且需吞掉按住的 Enter/Space。
5. **DialogFrame 常驻挂载驱动 `open`**；prompt/confirm 关闭延迟 promise 兑现至 180ms 出场完毕——AGENTS.md GUI 规则原样重申，作为本规范第 5 条。

### 材质与降级

- Dialog、TaskModal、palette 与确认卡均为 **L3 overlay**（§5s 层级表）：`--glass-bg-strong` + 边框 + 完整上下缘 + `--glass-sheen` + `--glass-shadow`。玻璃只属于容器，卡内内容保持纸面感。
- `gui-motion-off` / `prefers-reduced-motion` 同时取消入场和出场，不留中间帧。`prefers-reduced-transparency`、不支持 `backdrop-filter` 以及 Windows 无 blur 时使用不透明可读底色，保留边框、上下缘、sheen 和阴影；scrim 也转为不透明。

## 5v. 右栏标签带：tab-primary 补全（M1.12，2026-09-29 批复；交互原型 `docs/review/tab-primary-prototype.html` v2）

> 背景：tab-primary 模型（`lib/panel-tabs.ts`，openchamber ContextPanel parity——一条标签带容纳所有表面的视图，rail 只是 launcher）自 2026-09-15 已在架构层落地，但交互层一直缺位：rail 点击开出的是无 target 的占位标签（身份恒 `surface::`），每个表面永远只有一个 rail 开的标签，标签带退化成 rail 的一对一镜像。M1.12 补的就是交互层，模型层不动。**中心浮面多表面容器已评估并否决**（2026-09-29，小袁总）：产品维持 codex 式布局——主会话独占中心浮面，终端/代码/看板/预览等附加表面全部由右侧面板标签承载。

### 布局契约（不变）

面板内容在左，44px `RightRail` 贴客户端工作区右缘（`ChatView.tsx` ~2507，与面板互为兄弟节点）。结构零改动，本章只加交互、删一个视觉态。

### rail 语义——纯 launcher

- **取消常态高亮**。rail 不再随活动标签保持点亮（仅悬停高亮）。"当前哪个标签在活动"只由标签带表达。理由（小袁总，原型评审）：点亮的 rail 图标读起来像实例标签，而它不是。
- 单击 = open-or-focus：该表面已有标签则聚焦最近一个；否则开其占位标签。活动表面的 rail 项在面板已开时再点 = 收起面板（沿用现有 RightRail 语义，Chrome 侧边栏式），不变。
- **中键或 ⌘/Ctrl+点击 = 新实例**（永不聚焦）：新开一个该表面标签并立即选 target（文件→目录选择、笔记→新建、浏览器→地址输入、其他→表面默认）。修饰键分支不得触发收起面板。
- 键盘 `Mod+1..N` 维持现有 jump 语义（focus-or-open）；本批次不加新实例快捷键。

### 标签带契约

- 身份仍是 `surface::target`（`panelTabId`，`lib/panel-tabs.ts:64`）：target 为实例地址（文件路径 / note id），浏览器则使用受管标签 id。`surface::`（空 target）仍是支持占位表面的占位标签——无打开标签时 rail 点开占位，首个真实打开替换占位。浏览器标签始终解析到受管标签 id，不再打开占位。
- 标签带头部「**+**」开新实例菜单，按表面分组：每项带表面图标 + 新实例动作与其 target 选择器（文件→目录、笔记→新建、浏览器→新建空白受管标签）。位置：标签带第一个子节点，常驻不被挤出（标签在其下横向滚动）。
- 默认每表面预算维持 `PANEL_TABS_MAX_PER_SURFACE = 12`（openchamber parity）：逐出消耗该表面最旧的非活动标签。「+」遇预算打满时聚焦最旧标签并 toast 提示，不静默逐出。浏览器投影不设该上限，因为关闭投影也会关闭对应受管 guest；纯展示预算不得静默销毁浏览器会话。
- 溢出横向滚动，沿用现有左右羽化（`--gui-fade-x`，gui-chat.css horizontal 段）；标签带永不折行。

### 标签交互

- **右键菜单**：浏览器标签提供随状态变化的动作列表——在右侧新建、刷新、复制、重命名、复制网址、外部打开、静音/取消静音、关闭、关闭其他、关闭右侧。空白页禁用页面动作；外部打开额外要求 HTTP(S)；最右侧标签禁用关闭右侧。复制浏览器标签按源 URL 新建受管标签而不是复制面板身份，用户重命名在本次运行内覆盖后续页面标题。其他表面保留复制、关闭、关闭其他与关闭全部。菜单动效与材质走 §5u（L2 float 配方 + `--spring-liquid`）。
- **面板状态按会话隔离(2026-11-05)**：右侧面板标签布局以聊天会话为存储键，受管浏览器标签带 owner 会话。切换会话恢复该会话自己的分栏、标签顺序和浏览器标签；其他会话的标签与 webview 保持挂载但不可见，因此 A 会话的网页不会出现在 B 会话。Agent 揭示只在活动目标属于当前会话时生效。
- **标签拖拽护盾(2026-11-05)**：拖动面板标签时挂载与面板宽度拖拽相同的固定手势护盾，层级高于页面宿主。指针越过浏览器 guest 时 dnd-kit 仍持续收到 move，因此浏览器标签也能正常同列排序并拖到右半区分栏。
- **两种布局共用一个头部行(2026-11-06)**：单栏与每个分栏都经同一个头部行（`PanelHead`）渲染标签带，行高、内边距、分隔线与底部留白由该行持有；标签盒是其中唯一可收缩的部分，加号与窗口按钮保持自身宽度。标签带不再重复声明这套几何，因此开关分栏不会再改变标签行的高度。新列从分隔线处滑入，拖拽时右半区的分栏目标淡入，被拖动的标签呈现抬升；`gui-motion-off` 与 `prefers-reduced-motion` 会同时关闭这三处动效。
- **落点判定(2026-11-06)**：`lib/panel-tab-dnd.ts` 为每个指针位置给出唯一判定，避免 `closestCenter` 在标签与整列区域之间来回跳。命中最小的包含盒优先，所以标签胜过包含它的整列；在拖动标签自己所在列的空隙松手时，重排到该列最近的其他标签；右半分栏目标不会回退成标签，因为它表示“新建一列”；在标签带外侧松手仍可落在 48px 内最近的标签上。跨列判定仍以列区域为准。
- **分栏分隔线(2026-11-06)**：两列之间是一条 7px 命中带、中间一条 1px 细线（VS Code sash / dsh divider 语义）。拖动按指针位置换算列 0 占轨道的比例，每列至少保留 160px；面板窄到放不下两列最小值时，下限退化为各占一半（另有 15% 的结构下限）。双击回到均分，聚焦后 ←/→ 每次 2%、按住 Shift 为 10%。比例随该会话的面板布局持久化，旧布局缺少该字段时按均分处理。拖动期间挂载与面板宽度拖拽相同的全屏手势护盾，指针越过浏览器 guest 也不会中断。
- 拖拽排序沿用现有 dnd-kit 实现；drop 只重排，不改变表面归属。
- 每个标签的关闭钮（×）：悬停显现，沿用现有样式；关闭活动标签激活其右邻（既有行为）。关闭浏览器投影也会关闭对应受管 guest，宿主侧发起的关闭则移除投影。

### 受管浏览器投影与控件

- 受管浏览器宿主仍是运行时与重启持久化权威。每个受管标签恰好对应一个右侧面板标签，`target` 与 `dedupeKey` 都使用受管 id；浏览器面板不再渲染内部标签条。新增/打开、激活、关闭、复制、分栏位置与 Agent 揭示都经该 id 双向协调，稳定 webview 宿主不会重挂。恢复面板时过滤持久化的 `browser` 与旧 `settings.browser` 项，由宿主恢复后重建有效投影。
- 每个内置面板标签显示注册表图标。浏览器标签使用页面 favicon，失败时回退到浏览器图标，这些视觉均为装饰。受管 id 处于忙碌或有已派发 Agent 操作时，对应标签即使在后台也显示 Agent badge，并提供可读的运行状态文本。
- 浏览器菜单根据活动受管标签派生可用性。无标签或位于 `about:blank` 时，页内查找、打印、缩放、设备工具栏显隐、页面保持焦点、截图、复制网址与硬刷新均禁用；在系统浏览器打开额外限定 HTTP(S)。下载、历史、清除浏览数据与浏览器设置保持全局可用。打印、截图、下载目录与清数据失败会显示反馈。
- **受管与外部扩展**：受管工具栏的扩展弹层只列出 `persist:musepi-managed-browser` 中实际加载的扩展，并提供真实空态。安装解压扩展必须显式选择目录并再次确认权限；移除只卸载，不删除源目录。持久化记录仅含 id/名称/版本/路径/权限，重启时重新加载，启动失败保持可见。设置 → 外部浏览器集成分别管理 Relay 状态/操作与共享 Chromium 扩展清单，这些外部内容不会出现在受管弹层。完整网址显示共用浏览器偏好 store。面板不超过 480px 时，标注、开发者工具和新建标签移入更多操作，避免重复的工具按钮把地址栏压到不可用。
- **外部 Profile 数据**：设置 → 浏览器通过共享 `Segmented` 分为常规、外部浏览器集成、数据三视图。导入只把默认 Chrome Profile 的 Cookie 和 LocalStorage 复制到共享自动化 Chromium，不包含密码、右栏 Electron 分区、Profile 选择或持续同步。
- **结构化 Agent 浏览器结果**：`status`、`read`、`screenshot` 使用与 Agent 收到的结构化结果相同的专用卡片。状态区分受控与可见标签并展示导航事实；文本展示范围、段数、截断、续读和捕获时间；截图在实际图片旁展示尺寸、字节数、路径和捕获时间。原始 JSON 收入折叠区，既有 `run` 时间线继续负责交互过程。
- **整轮来源**：每轮只用一张去重来源卡，区分读过的页面与经过的页面。结构化 `read` 和旧 `observe` 计为已读，`open`/`goto` 计为经过；重复 URL 保持首次顺序并累计打开次数，截图、点击和 `status` 不会虚构经过页面。
- **快照操作**：元素与视觉快照包含 id、捕获时间、有界分页和 60 秒标签级有效期。ref 操作与坐标操作展示独立快照卡和成功/失败回执，过期 ref 不会触发盲点。提示词要求导航或重渲染后重新快照。
- **原图裁剪、路径与设备配置**：视觉裁剪读取原始截图，展示来源快照、区域和捕获时间，不生成新的可点击快照。连续路径拖拽复用普通操作回执。设备目录/配置卡片区分 CSS 视口、移动端/触摸身份与显示比例；Agent 在设备变更后重新观察页面。
- **历史与下载留存**：历史与下载卡片读取返回给 Agent 的同一份 Profile 记录，最新优先且不依赖当前打开的标签。历史展示标题、URL 和访问时间；下载展示文件名、状态、字节进度和可选保存路径。保存路径只是证据，不代表文件仍存在。
- **导航与可观察等待**：导航卡在 navigate、搜索、历史移动、刷新、停止或加载状态等待后展示实际操作和当前 URL/标题。条件等待展示匹配/超时与 lastObserved，让失败等待可检查，而不是只有泛化错误。
- **对话框与标签控制**：待处理和已处理的 JavaScript 对话框使用紧凑卡片展示类型、消息、prompt 文本、结果，以及由 Agent、用户还是自动策略应答。`activate` 只选择控制目标而不显示页面，`switch` 同时显示真实目标，`release` 释放 Agent 控制但不关闭页面，并明确显示页面保持打开。
- 设备栏是一条 36px 的紧凑控件行，全部使用带当前值文本的 `GuiSelect`：尺寸预设、可选的模拟宽高、页面背景（常驻色点 + 当前值，不再依赖悬停显示选中）与显示比例。预设覆盖响应式、当前 iPhone/Pixel/Galaxy 手机、折叠屏、iPad 与 1280/1440/1920 桌面；旧 phone/tablet/desktop 键保持可选以兼容持久化。宽高旁提供滑块浮层，除文本输入外可实时拖动调节。背景是单选菜单，不是三个悬停色块。隐藏即整个设备栏不渲染，页面模拟同时回落到自适应/自动；浏览器菜单是唯一显隐入口。窄面板依次让出显示比例、背景与尺寸，绝不折成两行。
- 通用 tooltip 在每次悬停/聚焦交互时读取最新 `title`，仅在未出现外部新标题时恢复旧值。最大化控件的 React 所有者同步维护最大化/还原的图标、tooltip 与可访问名称，命令式 FLIP 控制器不再写入过期文案。

### 动效

全部新增走 §5s 阶梯：标签打开 = 从发起处（rail 图标 / + / 菜单项）共享元素生长 + `--spring-liquid`；focus-or-open 闪烁 = 700ms accent-muted 渐隐（原型 `flash` 关键帧先例）；新实例菜单 = §5u 进出场。不新增 token、曲线或 scrim。

### 验收

- 同表面多实例端到端可用：两个不同目录的文件标签、两个不同 URL 的浏览器标签、复制的笔记标签——各有独立 `surface::target` 身份与内容。
- 任意状态下 rail 零常态高亮、仅悬停高亮；单击/中键/⌘点击语义符合上文。
- 「+」菜单可达且可键盘操作（↑↓ Enter Esc，焦点回标签带，`use-floating-menu` 四态契约，M2-2.6 AttachMenu 先例）。
- 右键菜单复制/关闭其他/关闭全部可用；预算逐出以 toast  surfaced，不静默。
- desktop-app biome + tsgo 全绿；i18n key 落 rail/panel 域文件，en 侧 `as const satisfies Record<ZhKey, string>` 配对；契约测试覆盖 id 生成与 open-with-target 路径（禁静态 echo）。

### 实现锚点

- `lib/panel-tabs.ts` / `lib/use-panel-tabs.ts`——模型；`open(descriptor)` 已接受 `target`/`dedupeKey`。预期模型零改动。
- `ChatView.tsx:796-808`——`setActiveView` 是今天丢 target 的唯一收口；新实例流把 target 穿过去（或直接带 descriptor 调 `panelTabs.open`，`setActiveView` 只留 focus 路径）。
- `components/RightRail.tsx`——删常态高亮；加 `onAuxClick` 中键与 meta/ctrl 修饰分支调新实例流。
- `components/surface-tabs.tsx`（SurfaceTabStrip）——「+」按钮、右键菜单、复制/关闭其他动作。
- 新实例 target 选择器复用 M2-2.6 plus-menu 的 picker 模式（目录选择 / 笔记新建 / 地址输入）——不另造浮层机制。

### Android 模拟器标签

内置 `android-emulator` 插件复用现有标签模型，不新增第二套面板或顶栏标签。它由会话提供：未使用时不出现在 rail、空状态或新建菜单中，Agent 成功截图后打开对应设备标签。内容区以实时设备画面为主，设备/AVD 选择和调试操作使用带标签的原生控件。画面随可用宽度缩放，但坐标仍映射到设备像素。主指针点按与拖拽直接操作设备，Pointer Capture 保证拖出画面后手势不丢失；只有画面禁止原生触摸滚动和选择。返回/主页/最近任务、文本、APK/Activity、UI 树、logcat 和截图操作均保留键盘焦点，错误通过 alert 区域呈现。单行文本输入仅支持可打印 ASCII。

## 5w. Composer 统计行：「性能与用量」丸条（M1.10 批次 C 增补，2026-09-29 批复；源 `.workbuddy/tasks/2026-09-29-m1.10c-composer-stats-pills.md`，dsh-v0.2.0-rc.1 StatsPills 对标）

> 范围：一条跟随 composer 常驻的统计行——时间/用量两颗丸，把会话性能与 token 账目摆在输入框旁，吸收 dsh 0.2.0 的 composer-dock 统计，**零新增统计 RPC**。

### 布局与落点（决策①——方案 A）

- `ContextRing` 留在原胶囊排（`footerRight`）不动。统计行是 composer footer 排**下方的一条独立新行**，经 `ComposerFrame` 新增的 `belowRow` 插槽渲染在输入卡磨砂面之外（与 `aboveRow` 对称），与 `footerRight` 同一网格右对齐；初始、空数据和两丸皆隐时保留 32px 最小行高并显示 `—`。
- 挂载跟着 composer 走（不挂聊天 transcript），transcript 滚动时数字保持可见——dsh `conversation.composer.dock` 同款。

### 玻璃与动效（§5s 层级，零新 token）

- 丸休眠态：**L1 card**——基材+缘取自 footer-pill 家族配方（`.gui-stats-pill` 加入 gui-composer.css 的家族选择器组；状态由颜色承载，遵守批次 C1 纪律）。
- 浮层：**L2 float** 走唯一 `.gui-menu-popup` 配方（`useFloatingMenu`，两阶段仅 transform 入场）——与批次 C2 同一收口契约；丸不得自声明 background/backdrop-filter/box-shadow。
- 动效：丸入场 180ms `var(--spring)`（§5s 时长阶梯的 chip 档）。浮层定位与动画分层：外层锚点始终保留 `translate(-50%, -100%)`，内层执行匹配的进入/退出 morph。

### 两颗丸（决策②）

- **时间丸**——`N 轮 M 步 · tok/s`（轮数 · 步数 · 解码速度）。popover 明细行：模型用时（请求墙钟合计）/ 工具用时（tool-call→tool-result 墙钟合计）/ TTFT（均值）/ 输出速度——有数据才开行；窗口**完全无计时数据**时退化为纯读数、不开 popover（dsh 契约）。
- **用量丸**——`总 tok · 缓存命中 %`。popover：input / cacheRead / cacheWrite / output 精确分桶（cacheWrite 为 0 时该行消失，dsh 同款）。

### 数据契约（决策③——零新 RPC）

- **token 数字读 daemon 持久投影**：`session.contextUsage` 已返回 `usage { input, output, cacheRead, cacheWrite, totalTokens, cost, cacheHitRate }`（TUI `cache_hit` 同款，daemon 侧计算）。Composer 已为 ContextRing 轮询该 RPC——统计行消费同一份 state。总量 = input + cacheRead + cacheWrite + output（计费输入三桶 + 输出）。分页/压缩永不改写这些数字。同会话 RPC 失败或返回 null 时保留最后有效读数；切换会话立即清空，等待新会话响应。
- **时间/轮/步数字走可见窗口 fold**（`deriveWindowStats`，`apps/desktop/src/lib/derive-window-stats.ts`）：daemon 没有逐轮计时投影，fold 回答「屏幕上有什么」，字段名刻意与 dsh `WindowStats` 同形，便于日后整体替换。
- **Fold 口径（契约测试守在 `apps/desktop/test/derive-window-stats.test.ts`）**：
  - `turns` = 窗口内非 synthetic 用户消息数；`steps` = **已 settled** 的 assistant 消息数（有 `stopReason`——流式中的条目还不算一步）。
  - `llmMs` = 已 settled 步的 `AssistantMessage.duration` 之和；`ttftMs`/`ttftSteps` = 记录了 ttft 的步的和/计数。
  - `decodeMs` = 兼有 duration 与 ttft 的步的 `max(0, duration − ttft)` 之和；`decodeTokens` = 这些步的 `usage.output` 之和；展示速度 = `decodeTokens / (decodeMs / 1000)`。
  - `toolMs` = `toolCallId` 配对且**双方都在窗口内**的 `max(0, toolResult.timestamp − 宿主 assistant.timestamp)` 之和；配对不全的不计入。
- **性能边界**：fold 对可见尾部 O(n)（≤ ~200 条）。允许每渲染重算（字段读取很便宜），但行组件以派生数字 + usage 身份做 `memo()` 门控——流式 delta 不改任何 settled 数字，比较器判等即不重渲染（契约测试守护）。

### 简洁/详细两档（决策④）

- 设置项「性能与用量」（设置 → 外观 → 聊天分区 `ChatSection`）：Segmented **简洁 / 详细**，渲染端 localStorage 键 `musepi-gui-stats-mode`（默认 `detailed`）+ `musepi-stats-mode-changed` 窗口事件——与 `musepi-gui-chat-*` 同款偏好模式（GUI 专属偏好，零 daemon 改动）。
- **详细**（默认）：两颗丸带 popover，如上。
- **简洁**：只剩两个纯读数——解码速度与缓存命中——且各有数据才显示；无 popover、无计数。两者皆空 → 稳定行显示 `—`。

### 交互契约

- 两个 popover 共享一个 open 位——开一个关另一个（`useFloatingMenu` 模块级互斥已全应用强制）。
- 全空（无步数、无 token）→ 稳定行显示 `—`；纯用户消息的窗口只把计数丸显示为纯读数。
- 数字不随分页/压缩跳动：token 数字有投影背书；窗口数字只在窗口 settled 内容变化时变化。

## 5ac. Composer 周边修正：dock 座位回到下方、连接器面板设计、tail-inset 暖机（2026-10-21）

composer 周边的四个回归，同一个根因模式：布局没有为异步挂载的行预留位置。

- **`conversation.composer.dock` 是输入框下方的座位**（修订此前一切「上方」措辞）：宿主把它挂在 `ComposerFrame` 的 `belowRow`，自成一行（`.gui-composer-below-dock`），位于输入卡正下方并自居中。读数类插件（性能与用量）属于 composer 的页脚行；上方 dock（`gui-composer-dock`）只放状态 chip（连接器、todo/排队、swarm）。座位表在 `collab-proto/extension-slots.ts` 里标注位置，daemon 侧契约保持一致。
- **插件平台面**：编译后的插件模块把 `React` 绑定到 `window.MusePiReact`，现在它是宿主命名空间展开 + `react-dom` 的 `createPortal`（react 命名空间里没有——用 portal 弹自己浮层的插件一打开就崩，报 "React.createPortal is not a function"）。guest-client Web 入口的同名暴露同样修正。
- **Tail-inset 暖机**（`lib/composer-tail-inset.ts`）：resting 高度的最小值只在首个真实测量后的 2 秒窗口结束后才开始锁存。结构性行（连接器 chip 在其 RPC 之后、插件行在 registry import 之后）都在该窗口内落地；把异步前的最小值锁存会冻结预留高度过小，转录区最后一行会整个会话藏在那些行下面。暖机期内只预留当前高度；暖机结束后恢复原「史上最小」语义（打字增长仍吸进 80px 间隙）。
- **连接器面板设计**：弹窗行换自绘复选框（accent 底 + clip-path 勾选，`appearance: none`——原生蓝色方块破坏玻璃材质），头部带标题（面板名 + 服务器数，操作链接右对齐），280px 上限。收窄态 chip 只读 `{已选}/{总数}`——「连接器」字样只留在默认态。

## 5x. 查找栏、撤销 toast、命令面板增量（2026-10-02，openchamber v2.1.0 parity）

三件低风险吸收同批落地。实现契约与它们暴露出的工具链陷阱见
`gui-implementation.md` §45。

### 查找栏（⌘F，会话内）

- **位置**：绝对定位于 transcript **顶边**之上、右对齐（`.gui-find`，`gui-chat.css`），
  两侧都让开 TurnNavigator 的标记槽与原生滚动条。
- **硬规则——绝不让 transcript 重排**。查找栏是 `.gui-transcript-wrap` 内的
  `position: absolute`；若放进常规流，打开瞬间会重测每一个虚拟行。
- **材质**：§5s 玻璃配方，`--color-surface-raised` 82% + `backdrop-filter`
  blur/saturate。零新增 token。
- **控件**：输入框（打开时自动聚焦并全选）、命中计数（`n/total`，tabular-nums；搜索中为
  `…`；无命中显示 无结果）、↑ / ↓ / ✕。Enter 下一个、Shift+Enter 上一个、Esc 关闭。
  查找栏用 `stopPropagation` 独占 Esc/Enter —— 未被认领的 Escape 会中断正在生成的回复
  （`lib/escape-stop`）。
- **预览行**：单行、超出省略、点击即跳。它的职责是标明命中，不是变成第二份 transcript。
- **渲染在滚动容器之上**，以免遮住它自己要揭示的那一行。

### 撤销 toast（归档）

- **位置**：右下角——与更新 toast 同柱共存（`.gui-toast-corner`，z 910）：OTA 卡片落在角落，
  撤销小药丸叠在它上方，二者不再争夺同一角落，因此**绝无重叠**（不再是「底居中避开右下」
  的两角分居）。这个角落是应用主动通知的唯一归处；`.sh-toasts`（底部条带，z 60）保持让开。
- **种类**：每条 toast 带一个 `kind`——`info`（默认）/ `success` / `warning` / `error`——画成前导图标，
  图标与描边按 kind 微染，玻璃底色保持中性。应用级 `musepi-gui-toast` 事件改路由进这条
  栈（此前走顶部错误横幅）：detail 接受共享 toast 输入或纯字符串，缺省 `error` 以保留
  旧横幅语义；守护进程连接类错误仍用顶部横幅。
- **内容**：可选标题、正文、独立换行的详情和可选 accent 动作按钮。L2 强玻璃底 + 完整上下缘 + sheen + glass-shadow，
  200ms 入场（`translateY(8px)` → 0）。
- **替换与容量**：相同 `dedupeKey` 替换先前内容；未提供时使用正文作为 key。最多同时显示三条，优先移除临时通知，再移除持续显示的错误。来源恢复后可只关闭自己的通知。这些约束由 store 保证，而不是由视图各自处理。
- **单一共享 store（2026-11-08）**：store 位于 `client-core`（`lib/action-toast.ts`），桌面模块只做 re-export，因此桌面角落与 guest 底部条带共用同一份列表、同一张 TTL 表和同一个容量。会话级 daemon 事件（`notice`、自动重试、自动压缩）经 `session-notice.ts` 映射进来，不再被丢弃。详见 `gui-notification-spec.md`。
- **堆叠交互（2026-11-08）**：两条及以上仍是一列完整高度的卡片——任何一行都不会被裁成细条，因为裁掉同级的那一行等于隐藏了用户还没读到的消息。单张卡的高度上限是窗口三分之一，更长的正文在卡内滚动（见 `gui-notification-spec.md` §4）。用户主动关闭、点动作或取消时，行继续挂载 180 ms 播退场；会自行关闭的通知在关闭钮外有一圈倒计时环，整个栈暂停时环也一并冻结；可选取消按钮先执行再关闭。减少动态效果时关闭过渡动画并隐藏倒计时环。
- **每一次归档都给撤销**，包括「归档并立即跳走」的头部动作 —— 这是全应用最不可恢复的
  一条路径。之所以不需要确认对话框：归档本身是 localStorage 列表编辑
  （`client-core/session-archive.ts`），反向操作同步且零成本。

### 命令面板增量

- 面板组新增 **Reload UI** —— 所有渲染进程侧的恢复路径（失效的扩展插槽、热重载冲掉的
  派生状态）最终都归结为一次整页重载；没有这条命令，用户只能手动重启窗口。
- **粘贴完整 session id 精确命中该会话**。模糊搜索做不到这点：id 是一长串 hex，
  永远匹配不到标题。这类行会把 id 作为自己的副标题显示，让这次命中读起来是刻意的，
  而不是像出了 bug。
- **面板记住上一次的 query**（关闭时捕获、打开时回填），所以重新打开不会抹掉敲了一半的
  搜索词。
## 5y. 表面 keep-alive 纪律 + 入口/Escape 不变量（2026-10-15，openchamber A4 审计 + A6）

- **keep-alive 铁律——必须活过表面切换的状态不得放在 pane 组件内部。**`ContextPanel` 的
  `renderPanelBody` 只挂载当前 tab 的 body，pane 内 `useState` 跨表面切换即死。清单（已审计，
  非推断）：
  - 终端 dock：首次打开即挂载、永不卸载（`ChatView`——折叠是高度归零，pty + 回滚在会话切换后存活）。
  - 浏览器：`<webview>` guest 常驻 `ManagedBrowserHost`，面板只是槽位矩形，面板关闭不丢导航/会话。
  - 设置页往返：chat 列 + 侧栏 `display:none` 常驻，回来状态全在（见 §1 settings-shell 条目）。
  - 编辑器未存文本：宿主 `lib/file-workspace.ts` 的 `filePreviewBuffers`（绝对路径键；保存/改回 saved 即删条目）
    在 files→他表面→files 导致文件插件卸载后仍保留草稿。Cordis 插件只消费这份存储，不建立第二个草稿所有者。
    Monaco 只拥有编辑视图，不拥有文件缓冲：编辑器修改更新 `edit.text`，但 React 不得把任何值回写到已挂载的 model，
    从而保留光标、选区、撤销历史和 IME 组合输入。切换到其他路径时通过重挂编辑器创建新文档。
    初始 CRLF 和末尾换行保持不变。纯文件树标签选中首个文件后直接成为该文件页；文件页展开的非模态树再选其他文件时
    新开标签，保留原文件。单击打开可替换的预览标签，双击将其固定；跨文件定义跳转打开固定标签。同文件和跨文件定义跳转都会进入
    按工作区隔离的编辑位置历史。文件头按钮和 Alt+←／Alt+→ 执行后退／前进，并恢复精确光标位置。普通光标移动只更新当前历史项，
    普通标签点击不新增历史项。后退后发生新定义跳转会截断前进历史。历史仅在运行时保存，切换工作区后清空。
    Alt+F12 或 Ctrl/Cmd+Shift+F10 在当前位置内嵌打开定义速览，Shift+F12 打开引用速览；两者都不切换当前文件标签，也不写入位置历史。
    多个定义或引用可在速览结果列表中切换。速览编辑器可直接编辑；Ctrl/Cmd+S 通过同一文件缓冲和保存链路保存当前结果，
    保存期间继续输入仍保持未保存状态。Escape 关闭速览。F12 保留跳转并记录历史的原有行为。Ctrl/Cmd+F12 跳转到实现，Ctrl/Cmd+Alt+F12 跳转到类型定义；
    两者都会记录编辑位置历史。两种速览在明暗主题下都使用共享的液态玻璃圆角、描边、光泽、模糊和阴影；结果列表与编辑器表面保持透明，
    以透出玻璃材质且不改变 Monaco 的列表几何尺寸。F2 打开 Monaco 原生重命名输入框，跨文件应用符号修改且不切换当前文件标签。
    每个受影响文件分别保留未保存草稿并独立保存；各自执行保存前不写入磁盘。包含文件创建、删除或移动操作的重命名编辑会整次拒绝。
    定义速览、引用速览、重命名、实现和类型定义快捷键在快捷键注册表的固定「编辑器」组中展示。草稿缓存键统一斜杠方向并忽略 Windows 盘符大小写，
    因此未打开文件中的重命名修改在后续读取和标签切换后仍然保留。文本直接进入编辑，不再有预览到编辑的切换。HTML 在全宽实时预览与全宽 Monaco 之间切换，
    不再强制左右分栏。相对样式表经工作区文件 RPC 读取并内联到 opaque sandbox；引用 TypeScript／JSX 源码模块的页面显示明确的构建提示。Markdown 默认进入带顶部格式工具栏的单栏可视化编辑器；工具栏始终保持一行，放不下的命令收进锚定的「更多操作」菜单。
    切换源码时以全宽 Monaco 替换可视化界面，不显示左右分栏预览。模式切换保留当前草稿；可视化文档未发生实际修改时保留原始源码。
    YAML Front Matter 会显示提示和立即查看源码的操作。Markdown 还可把当前缓冲区导出为真正的 `.docx`。空间不足时，路径栏可横向滚动。
    点击路径层级会打开贴着该层级的可搜索非模态目录菜单。在该菜单里右键文件行提供「加入对话」：文件以与 `@` 引用同型的原子 chip
    暂存，其 token 落在保留的选区之后——草稿文本与选区都保住，也不发送。路径本身不进入草稿，所以含空格或方括号的文件名也不会破坏 token。
    目录行、或当前无法接收引用的输入框，会把该菜单项禁用并写明原因，而不是点击后静默失败。主聊天与侧边会话同时存活时，引用落入持有焦点的那个输入框，其次是最近操作过的那个；关掉其中一个，只要另一个还能接收引用，菜单项就不会变灰。展开的文件树与编辑器共享内容行，不改变路径行；长代码行横向滚动，不重新换行。
    在文件树中点击当前已打开文件不会再打开标签。编辑器选区接入完整五项选区工具栏；内容区上方空间不足时，工具栏改到选区下方，
    不得遮挡文件头。没有选区时，头部引用操作引用整文件。关闭未保存标签必须确认；确认关闭会丢弃缓存草稿，后续重开不得恢复。Monaco 中的 Escape 只关闭编辑器自身的
    悬浮提示、补全、诊断、定义速览或引用速览浮层。PDF 使用内嵌阅读器，支持缩略图、页码跳转、缩放、旋转、搜索和外部应用打开。
    工具栏始终保持一行，放不下的尾部命令收进「更多操作」。PDF 文字选区接入同一组五项操作；跨页引用保留起止页码、字符索引和每页矩形几何，
    点击后回到起始页并恢复原选区。输入框将文件引用与会话引用分别折叠为带数量的芯片，点击芯片在弹层中查看完整引用。
    选区高亮只存在应用层，不修改 PDF 文件。Word、Excel 和 PowerPoint 文件在内嵌页面中打开，
    并接入同一组五项选区操作。仅当包结构允许安全的定向文本写入时，Word 段落、工作簿单元格和演示文稿文本形状才可编辑；
    公式、复杂或超大工作簿保持只读。PowerPoint 明确标注为文本版式预览，不冒充完整视觉渲染器。
    Office 草稿沿用宿主的未保存标记、标签关闭确认、跨标签缓冲、顶部保存和 Ctrl/Cmd+S。
    引用保留 Word 段落、工作簿工作表／单元格范围或 PowerPoint 页码／形状位置；激活后恢复目标表面和文本选区，
    输入框的分组引用卡片同步显示该位置。
  - 明确不保留（接受现状）：文件树 `scrollTop`、trajectory 列表滚动——重挂即重置；进会话默认落尾，
    jump-to-entry 按需滚动。加滚动缓存须另立设计说明。
- **入口不变量（openchamber 对等，只记文档）**：表面只许从 rail、命令面板、内容内链
  （jump/reveal）、composer 菜单四处打开。别处浮钮不得直链表面。
- **Escape 不变量（现状追认）**：弹窗在 `document` 捕获阶段认领 Escape（`DialogFrame`、
  prompt-dialog 前例）；无人认领的 Escape 中断当前轮次（`lib/escape-stop`）；portalled 菜单自理
  关闭。新层按此顺序来，不自创新语义。
## 5z. 顶栏会话标签页：多会话工作集（2026-10-21）

对 §5t「顶栏不放内联标签带」原则的修订——开一个**可选**逃生门：默认仍是单会话标题，现状不变；打开设置后，最近使用的会话以标签带形式进入顶栏。

- **设置**：外观 → 聊天 → 「多会话标签页」（`PrefToggle`，localStorage `musepi-gui-session-tabs`，`"1"`=开，默认关）。设置页与顶栏分属两棵子树，切换经 window 事件 `musepi-gui-session-tabs-changed` 生效（`lib/session-tabs.ts` 的 `useSessionTabsEnabled`，`useSyncExternalStore` 订阅 storage + 伴随事件）。
- **标签是纯客户端投影**：`musepi-gui-session-tab-ids` 以 JSON 数组存会话 id 与顺序，`musepi-gui-session-preview-tab-id` 独立存唯一 preview id；标题、工作/未读状态、存活与否全部在渲染期由 `sessionMeta` + 会话树解析。关标签永不删会话；删会话会摘掉对应标签并清除其 preview 标记。
- **生命周期**：新打开的会话成为 preview，并在原位置替换旧 preview；重开固定标签不会降级。点击已打开的 preview、双击或选择「保持打开」都会固定。没有现存 preview 时新标签追加在末尾；软上限 `MAX_SESSION_TABS = 10` 溢出时挤掉**最旧**的标签，永不挤正在打开的那个。客户端解析不了的 id（`sessionMeta` 与树双双缺失）保留存储但不渲染——会话列表只加载了一半时不得摧毁工作集（「幽灵」id）。
- **关闭语义**（`lib/session-tabs.ts` 的 `closeTabAndActivateNeighbour`）：关闭当前标签激活其右邻（无右邻取左邻，皆无返回 `null` → 调用方经 `startNewTask` 开全新草稿）；关闭非当前标签仅移除。中键关闭不激活；关闭钮悬停出现，标题宽度不变。
- **快捷键**：快捷键注册表新增 `tab-next` / `tab-prev`（默认 ⌘Tab / ⌘⇧Tab，可改键，分组「会话」）。每标签 ⌘1–9 直达 v1 刻意不做——与 `panel-surfaces` 的裸 ⌘1–8 冲突。
- **标签带行为**：dnd-kit 横向排序（整个标签即拖拽把手，8px 触发距离保证单击仍是单击）；纵向滚轮映射为横向滚动（Shift/Cmd-滚轮与原生横向增量放行）；滚动容器两端 24px 渐隐（`SESSION_TAB_EDGE_FADE_PX`），激活标签自动滚入视野且在渐隐前停住（`lib/session-tab-reveal.ts`）。
- **状态**：`working` 在标签上转小加载图标；`unread`（非当前）显示强调色小圆点——两者与侧栏同源（`sessionMeta` / `unreadSessions`）。
- **统一标签尺寸与标签带滚动**：当前与非当前标签共用 176px 宽度（`--gui-session-tab-w`）、padding、字号和标题元素；选中只增加 accent 背景与前景，hover 不清除选中色。草稿与 preview 标题斜体。标签带外的紧凑最近会话按钮在折叠侧栏时保留新建与最近会话导航，并与非 tab 标题共用同一个 switcher 菜单。
- **标签带：等宽、保留滚动、隐藏指示器（2026-11-22）**：顶栏标签带与右栏 `.gui-surface-tabs` 遵循同一契约，规则只写在 `gui-chat.css` 的「Header session tabs」一处。① 每个标签持有一个固定宽度（`--gui-session-tab-w` = 176px；面板 `--gui-surface-tab-w` = 132px，因为它的面板最窄可到 260px），拥挤时不再挤压标题——过长的标题在自己的标签内省略。② 拥挤时标签带仍然滚动：`overflow-x: auto` 保留，指示器只用 `scrollbar-width: none` + `::-webkit-scrollbar { display: none }` 隐藏。用取消滚动来隐藏滚动条正是本契约要防的回归；指针在标签带上的纵向滚轮映射为横向滚动（`scrollTabsWithWheel`）。③ 激活标签会把它带入视野——顶栏经 `lib/session-tab-reveal.ts`（在两端渐隐前停住），面板经 `scrollIntoView`。拖拽重排不受影响：槽位保持固定宽度，落点与插入间隙的几何不变。面板的固定宽度写在 `max-width` 上，因为进出场关键帧动画的就是该属性；关闭中的标签仍可收拢。测试：`test/tab-strip-geometry.test.ts`（真实层叠）与 `test/session-tabs-strip-wheel.test.tsx`。
- **共享菜单**：尾部「⋯」与右键渲染同一组 `ContextMenu` 项，右键不激活标签。保持打开、重命名、复制 ID、导出、mini chat、工作树、归档、删除、关闭其他与关闭均按菜单所属标签 id 执行；归档非当前标签不切换会话。
- **测试**：六个会话标签/Markdown 测试文件（每种入口 locale 各 43 例：preview 迁移、持久化、尺寸、固定手势、共享菜单、tab 模式导航、跨文件 locale/DOM 隔离与精确 pre-seed locale 恢复）。

## 5aa. PR/问题面板：侧栏入口 → 主视图整页（2026-10-21）

PR/问题中心是**主视图整页**，不是右侧面板页签（右栏 Git 面板只保留「工作区改动 + 提交历史」两页签）。侧栏菜单新增「问题与拉取请求」入口（git-pull-request 图标，打开时按下高亮），经应用既有的视图切换机制把聊天列换成面板页——与看板 / 定时任务 / 能力中心同一套模式（聊天保持挂载在底下、`ChatSurfaceShell` 模糊过渡、`leavingView` 让页面撑过 150ms 退出）。

- **页面拆分**：`PrBoardPage.tsx` 是页面骨架（页头 + 返回工作区）；`pr-center.tsx` 承载共享主体（`PrCenter`，PR / 问题两个子页签，选择记在 `musepi-gui-prcenter-tab`）。主体使用可用宽度承载双列主从工作区。搜索与 PR/问题子页签共享一个 `.gui-pr-toolbar`；筛选器独立成行并明确左右区域，不再依靠多层 auto margin 自然换行。
- **PR 子页签**：一次 `Promise.all`（prStatus + prs + git.status + git.branches）。当前分支的 PR 卡片（状态徽章、检查圆点、可合并性、评审结论、打开/复制操作）；分支没有 PR 时是创建表单（标题从分支名预填、目标分支偏好 main→master→第一个、记住的草稿开关、先推送后创建且推送失败即中止、待推送计数提示）；下方是仓库打开的 PR 列表，每行带检查圆点和 head→base 分支。
- **问题子页签**：`Segmented` 打开/已关闭/全部过滤；标签按各自原色着色；带评论数；点击在系统浏览器打开。
- **搜索**：共享主体顶部一个搜索框同时过滤两个子页签——标题子串（不分大小写）或 `#编号`
  精确命中；粘贴一条 PR/问题链接会在列表上方浮出钉住的「打开链接」行（`isLinkQuery` 只认
  http(s)）。纯函数 `matchesQuery` / `isLinkQuery` 在 `pr-center.tsx`，`test/pr-search.test.ts`
  覆盖。i18n：`general.prSearchPlaceholder`、`general.prOpenLink`。
- **刷新行为**：重新加载时沿用上一份数据继续渲染、后台重取；骨架行（`.gui-skeleton-row`）
  只在首次加载且无任何缓存时出现——刷新绝不把面板清空。
- **daemon RPC**（`packages/coding-agent/src/daemon/server.ts`）：共享助手 `runGh(cwd, args, timeoutMs)`（token 注入 + 默认 15s 超时；`exitCode === null` 表示 gh 未安装）。`github.prStatus`（当前分支 PR；无 PR 返回 `{pr: null}` 而非报错）、`github.issues`（打开/已关闭/全部，支持 `--label`/`--author`）、`github.prCreate`（标题必填；正文缺省用标题；可选 `--draft`；30s 超时；PR URL 用正则从 stdout 解析）、`git.push`（报无上游时以 `-u origin HEAD` 重试）。
- **纯函数助手**（`apps/desktop/src/lib/pr-status.ts`）：`rollupCheckState`（FAILURE/TIMED_OUT/ACTION_REQUIRED/CANCELLED/STARTUP_FAILURE → 失败；SUCCESS/SKIPPED/NEUTRAL → 通过；畸形/缺省 → 进行中/null）；`prVisualState`（{isDraft, state} → draft/open/merged/closed 徽章档）；`branchToTitle`（分支名 → Title Case，含 `/` 的分隔符都转空格）。`test/pr-status.test.ts` 覆盖。

## 5ab. 顶栏减法：按钮归位与实例入口迁移（2026-10-21）

顶栏右上角只留工作状态与运行控制。本轮减法：**「终端」挪进会话右缘 RightRail 底部组**（与面板折叠钮相邻，dsh 同款位置；`RightRail` 新增 `terminalOpen`/`onToggleTerminal` prop，app.tsx 把 `toggleTerminalDock` 改喂 ChatView）；**「board」「切换面板」按钮移除**——board 入口仍在侧栏菜单，右侧面板折叠由 RightRail 底部钮兜底。**实例信息（本地/远程守护进程、版本、延迟、浏览器桥诊断）迁出顶栏**，落成自包含组件 `apps/desktop/src/components/InstanceButton.tsx`（状态全自管：meta 轮询、hosts 表单、browserHost 外部 store；props 只有连接事实与增删改回调），挂**侧栏 footer 左侧**（`justify-between`，右侧仍为设置/协作/断开组）；GuiHeader 卸下 `connected/daemonUrl/onReconnect/hosts/onSwitchHost/onAddHost/onRemoveHost` 七个 prop。header 的开发服务器按钮与项目动作仍保留 `terminalOpen/onToggleTerminal`（运行命令要先开 dock）。EN 版 §5t 右侧功能簇条目已同步。
- **子页签持久化**：`musepi-gui-prcenter-tab` 存储键；PR 草稿勾选记在 `musepi-gui-pr-draft`。
- **i18n**（general 域）：`pr board`、`open pull requests`、`issues`、`state open/closed/all`、`no open issues`、`no pr for branch`、`pr no checks`、`pr checks passing/failing/pending`、`pr mergeable`、`pr has conflicts`、`pr review approved/changes/required`、`pr title placeholder`、`pr base branch`、`pr description`、`create as draft`、`push and create`、`pr ahead count`、`pr search placeholder`、`pr open link`。
- **CSS**（`gui-workspace.css`）：`gui-pr-card`、`gui-pr-meta`、`gui-pr-check(--success/--failure/--pending)` + `gui-pr-check-dot`、`gui-pr-merge--ok/--conflict`、`gui-pr-review`、`gui-pr-actions`、`gui-pr-create*` 表单族、`gui-issue-label`、`gui-prboard-title/body`、`gui-pr-search-row` + 复用 `gui-ext-plugins-search` 胶囊、`gui-skeleton-row`（首载骨架，与 `gui-cap-diag-skeleton` 同配方）；徽章档复用 `gui-changes-badge` + `gui-pr-badge--{open,draft,merged,closed}`。圆角只用 token（`--radius-xl/lg`，胶囊 999px）。

## 5ak. PR/问题看板：行内详情预览 + 行操作（2026-10-22）

看板列表行不再是「跳外部浏览器」的发射钮——点击行在列表下方切换展开**行内详情预览**（`pr-center.tsx` 的 `PrDetail` / `IssueDetail`），与参考看板「列表 → 预览」的约定对齐：

- **点击行 = 切换展开，绝不跳转**：选中态（`selectedPr` / `selectedIssue`）各自存于子页；激活行加 `gui-changes-row--active`；再点一次收起。外部打开/复制链接放在详情的操作行上，而不是列表行。
- **详情载荷**：选中时拉取 `github.prView` / `github.issueView`（加载中显示骨架行；传输层失败显示 `general.requestFailed`，绝不伪装成空）。PR 详情显示正文（`gui-pr-detail-body`，pre-wrap、限高）、按本色着色的标签、审查者/处理人、逐项检查列表（`CheckItemList`——gh 的 `statusCheckRollup` 是异构的 CheckRun/StatusContext；`checkItemState` 把两种形态都折成 success/failure/pending，最多 20 项），以及共享的 `CommentList`（作者 + 时间 + 正文，最多 20 条）。审查结论与行级讨论各自独立分区；线程保留回复与可折叠 diff。当前 RIGHT 侧行可在固定文件标签中打开并定位 Monaco 行号，diff 与评审正文可引用给 Agent。过期或删除侧评论、缺失当前行及不安全路径会禁用本地打开，但讨论与 GitHub 链接仍保留。
- **行操作**（合并仅限打开且非草稿的 PR）：合并走方式选择（`merge`/`squash`/`rebase`）+**两步确认**（第一次点击进入 `pr merge confirm` 确认态，第二次才真正执行）→ `github.prMerge`；关闭/重开 → `github.prState`；逗号分隔的输入框回车即加标签/审查者 → `github.prEdit`。问题关闭/重开 → `github.issueState`。任何变更成功后都通过子页的 `load` 同时刷新详情和父列表。
- **问题过滤**：过滤行里的标签/作者输入框（`.gui-issue-filters`，窄屏自动换行）原样传 `--label`/`--author` 给已有的 `github.issues` RPC；顶部搜索框仍是在此之上的客户端标题/#编号过滤。
- **daemon RPC**（全部走共享 `runGh` 调 gh CLI）：`github.prView`、`github.prMerge`（30s 超时）、`github.prState`、`github.prEdit`（标签/审查者增删列表，全空时 no-op）、`github.issueView`、`github.issueState`。全部返回 `{ok: true}` 或 `{error: gh stderr}`；每个处理器都拒绝非正整数 `number`。六个方法都进了 `legacy-routes.ts` 白名单，紧挨既有 `github.*` 路由。
- **圆点配色修复**：列表行用的 `gui-pr-check-dot--{success,failure,pending}` 类在标记里早就有，但样式表缺对应规则（行上的圆点一直是无色的）；修饰规则现与 `gui-pr-detail` 并排放在 `gui-workspace.css`，颜色与卡片里的父级选择器一致。
- **i18n**（general 域，中英同 key）：`pr merge`、`pr merge method merge/squash/rebase`、`pr merge confirm`、`pr close`、`pr reopen`、`pr reviewers`、`pr assignees`、`pr add labels placeholder`、`pr add reviewers placeholder`、`pr comments {count}`、`pr no description`、`filter by label`、`filter by author`。

## 5al. 右栏 git 面板：储藏页签、同步行、看板状态过滤、账号卡来源（2026-10-22）

右栏 git 面板补齐与完整 git 客户端的差距，全部落在现有子页签壳内：

- **储藏页签**（`StashPane`，第三个 `GitPaneTab`）：说明输入框 + `git.stashPush`（含未跟踪；干净工作区返回 `{ok, empty}` 而非报错）、`git.stashList` 列表（`%gd%x1f%gs%x1f%cr%x1f%H` 格式——ref、主题、相对时间、hash）、每行「恢复并移除」（`git.stashPop`，冲突时 git 保留储藏、stderr 透出）和「删除」（**两步确认**：× → 对勾）。储藏行复用 `gui-changes-row`，与改动页视觉一致。
- **更改差异**：现有文件树展开为只读 `MonacoDiffEditor`，不替换文件树、暂存操作或面板页签。编辑器沿用 `musepi-gui-chat-difflayout`：内联和并排是固定模式，动态模式在宽度低于 720px 时转为内联。长段未修改区域折叠；工具栏显示当前差异位置，并提供上一处／下一处导航。二进制、过大或无法读取的内容保留原有补丁视图。
- **同步行**（`GitSyncControls`，挂在子页签栏上，三个 git 页签都够得到）：获取/拉取/推送图标钮 + 上游 `↑n ↓m` 计数（每次操作后重读 `git.status`；错误截断显示在按钮旁）。拉取**永远走变基**（`git pull --rebase --no-autostash`）——不产生合并提交，脏树大声报错而不是静默 autostash。
- **daemon RPC**（模块级 `runGit(cwd, args, timeoutMs)` 助手，与 `runGh` 同构）：`git.fetch`（`fetch --all`）、`git.pull`、`git.stashList`、`git.stashPush`、`git.stashPop`、`git.stashDrop`；`github.prs` 新增透传 `state` 参数（`open|closed|merged|all`）。`legacy-routes.ts` 白名单顺带补了之前漏掉的 `git.push` / `git.identity`（漂移修复——列表落后于处理器）。
- **看板状态过滤**：`PrPane` 按选中状态拉取（`PR_STATE_SEGMENTS` 在打开/已关闭/全部之外加了 已合并/`merged`）——gh 原生支持 `merged`，无需客户端过滤。详情里的标签/审查者变成可移除芯片（`gui-chip-x` 上的 × → `github.prEdit removeLabels/removeReviewers`，仅限打开的 PR）。
- **设置 Git 页账号卡**：`github.authStatus` 现在返回 `source: "oauth" | "gh-cli"` 和 `updatedAt`；卡片区分 设备授权 / gh CLI 两种来源（以前两种都写 gh CLI——是实打实的显示错误），设备授权连接的还显示连接日期。

本轮明确的非目标：hunk 级暂存/丢弃（需要字节级补丁校验）、历史里的合并/变基/cherry-pick、分支删除/重命名、GitHub 多账号（daemon 单 token）、GitLab/Linear 供应商。

## 5ab. 会话列表渲染稳定性：字段级 meta 合并 + 管线 memo 化（2026-10-21）

侧栏会话列表此前在 `SessionSidebar` **每次**渲染时都对全部会话重新排序、重新分组——搜索键入、右键菜单、悬停状态、5 秒状态轮询，各自都会触发每个日期分组的一次完整 `sortSessionTree`（递归重建节点 + 每组排序）、折叠剪枝、扁平化、子计数 map 和 fork 父级查找。此外轮询每 5 秒把整个 `session.list` 载荷 JSON 序列化一遍，且只要任何后台会话的 messageCount 变化，就重建**每一条** meta 行对象，使侧栏里所有下游 `useMemo` 全部失效。修复分三层：

- **轮询合并（app.tsx）**：`pollRowEquals` 按字段比对轮询写入的字段（working/live/messageCount/paused/title/timestamp/updatedAt/cwd/modeId/agentCount）与已有行；未变化的行保持对象引用不变，全部无变化时 `sessionMeta` **map 本身保持引用**，React 直接跳过整棵子树。JSON 快照 key 已删除（字段比较取而代之）。`status`/`model` 仍归 `refreshSessions` 全量替换所有，id 集合漂移检查仍会强制刷新树。
- **列表管线（SessionList.tsx）**：排序/扁平化/剪枝/子计数链 memo 化到 `[nodes, sort]` / `[ordered, effectiveCollapsed]`，组件外包 `memo`——无关的侧栏重渲染不再重排任何分组。行组件本就 memo 在原语 props 上，该契约不变（调用方仍需保持回调引用稳定）。
- **分组（GroupedSessionList.tsx）**：日期分桶 memo 化到 `[nodes, locale]`（`useLocale()` 为非响应式 `t()` 订阅语言切换），组件同样 memo 化。

明确不做的事：不做列表虚拟化（memo 行 + memo 管线已让单次渲染开销随可见行数线性增长；仅当数百会话的 profile 仍显示吃紧时再回头做）；不做 `session.list` 的守护进程侧分页（载荷本就很小，成本在客户端重复派生，不在 RPC）。

## 5ad. 统一标注工具：浏览器页面与 widget 卡片共用一套（2026-10-21）

一套标注界面服务所有可视宿主——受管浏览器的实时页面和任何 HTML widget 卡片——工具相同（选元素、框选区域、自由绘制）外加带序号的注释钉。浏览器里"选元素"不再是独立的一次性拾取模式，已并入同一套叠加层。

- **内核在 client-core**（`packages/client-core/src/annotation/`）：注入脚本在访客文档内构建叠加层 DOM（类名全部带 `musepi-ann-` 前缀）。提示词正文不论界面语言恒为英文。载荷契约（`contract.ts`）在到达时逐字段校验——半合法的载荷直接丢弃并拆除叠加层，不做半吊子应用。
- **截图合成在 client-core**（`screenshot.ts`，纯 canvas）：先铺底基础截图，再按载荷自身坐标重描每个形状，注释扛得住压缩；长边上限 1600px。宿主只提供底图——浏览器走新增的 `managed-browser:capturePage` IPC，widget 卡片走 `ToolRenderHost.rasterizeCard`（ChatView 实现，底色取 computed style，pixelRatio 2）。
- **元素悬停框形变**：指针在元素间移动时，悬停框的 transform/width/height 以 110ms 共享 ease-out 补间，而不是直接跳变；框选与已选轮廓保持即时/稳定。减少动态效果时直接跳变，不延迟命中测试。
- **附图通道**：标注完成时在宿主 window 上派发 `musepi-gui-attach-annotation`。`Composer` 与 `HeroComposer` 监听后把注释文本追加进草稿、经 `addFiles` 登记 PNG——监听 effect 必须写在 `addFiles` 定义之后（前向引用会以 TDZ 错误暴毙），且双方经 ref 注册，避免每次渲染都重挂 DOM 监听。
- **浏览器栏**：受管浏览器主行新增三个玻璃图标按钮——标注（铅笔）、开发者工具（code-slash，对 webview 调 `openDevTools()`）、外部打开（external-link，`shell.openExternal`）——归入 `gui-browser-tools` 组；缩放三件套收进 ⋯ 菜单（`gui-browser-menu-zoom`）。旧的选元素菜单项、选中选择器 chip 与 `pickElement` 宿主导出已删除。
- **卡片入口**：`HtmlCard` 右上角挂液态玻璃悬浮按钮（`.gui-widget-annotate-btn`）；srcdoc 卡片经 postMessage 握手。ContextPanel 回退面板的旧拾取器不动。
- **所有展示面都有入口（2026-11-08）**：只要宿主提供 `ToolRenderHost.rasterizeCard`，按钮就渲染，内联工具卡、独立小组件卡与全屏浮层都会传这个能力（独立卡此前漏传，所以标注入口只出现在展开的工具卡里）。截图在点击时解析卡片元素，而不是渲染时读取 ref。取消标注现在会经同一条 `musepi-widget-annotated` 通道回传空结果：此前 iframe 内的 `__musepiAnnotateRunning` 守卫在取消后不复位，按钮之后的每次点击都被静默丢弃。
- **收起行（2026-11-08）**：小组件工具的括号内显示小组件标题，没有标题才回落到类型。此前重复卡片标签与类型（「组件 · html」），而摘要槽是 `flex: 1`，文字被拉满整行、右括号被顶到行尾。
- **一个面，原位替代（2026-11-08）**：开启独立展示后，小组件卡片**替代**工具调用行，而不是渲染在它下面——同一份 payload 此前被画两遍（折叠行 + 消息末尾的卡片）。`ToolCard` 对成功的 `widget` 结果直接返回共享的 `WidgetCard`，位置、菜单、全屏与标注都属于这一张卡；回合折叠时该行仍被保留（`round-collapse` 把 widget 调用列入 exempt）。产物卡（`widget`/`board`/`schedule_task`）不再默认收起，`musepi-gui-widget-expanded` 只作用于关闭独立展示时的内联卡。
- **全屏一镜到底与折叠按钮悬停（2026-11-08）**：打开小组件全屏时测量卡片矩形，面板从该矩形放大（`computeMorph` + WAAPI，`MORPH_MS`）；关闭时按重新测量的卡片位置缩回再卸载；减少动效时两段都跳过。飞行期间内容层加模糊并暂停命中测试，合成层只缩放一张栅格，页面与 iframe 不必在每个中间尺寸重排重绘，落位瞬间恢复清晰。三处面板按钮各归其位：标题栏保留 panel-close/open，右侧栏改用镜像的 panel 图标（原来是箭头），会话信息卡换成 info 图标。三者都在展开/收起之间形变，并共用一条悬停规则：`data-collapsed` 决定轻推方向（左栏展开态向左、收起态向右，右栏镜像），悬停/聚焦位移，按下略微缩小，`gui-motion-off` 去掉位移。折叠的「查看更多（N）」是整行文字按钮，不再塞进 20px 的图标位。
- **工具条行与高度记忆（2026-11-08）**：标注入口归入卡片自己的操作组（`WidgetHeadActionsSlot`）：face 把按钮 portal 进卡片头，与复制、菜单、全屏同一行，铅笔↔关闭经 `MorphIcon` 形变。只有没有卡片头的宿主（看板画布、HTML 导出）才保留页面上方那一行（`.gui-widget-html-tools`），且无论按钮是否出现都占位。入口是 22px ghost 图标，卡片悬停与键盘聚焦时出现，触屏常显。iframe 实测高度按页面内容记住（有界 Map，键是页面字节的哈希），虚拟列表卸载再挂载时恢复原高度，不会从 320px 下限重新长一遍。卡片本身撑满消息列（`.tr-widget-inplace`）：它此前是 `align-items: flex-start` 的 flex 列子项，横向尺寸取标题的 max-content，iframe 于是停在 300px 固有宽度。overlay 通过注入内联 `<script>` 进入沙箱：渲染进程 CSP 允许 `'unsafe-inline'` 但没有 `'unsafe-eval'`，srcdoc iframe 继承该策略，原来的 `eval` 被静默拦截——按钮只会回传一个空结果，看起来毫无反应。注入的源码必须是裸表达式：它原先自带结尾分号，包装后成为语法错误，沙箱只能回「overlay did not start」。
- **iframe 生命周期与交互（2026-11-08）**：首次 load 或尺寸上报之前保持 `opacity: 0`，深色主题下虚拟列表重挂不再白闪（空间按记住的高度占住）。页面按内容高度显示（下限 48px、上限 20000px）——启动样式不再给 html/body 设 `height:100%`，那会让上报高度变成循环——根字号跟随对话正文，并同步 `--page-rem`，让 kit 样式与 rem 标记一致。页面获得焦点时保留所有按键，bootstrap 把自己没有处理的 ⌘/Ctrl 组合键转发出去（复制/全选/撤销除外，页面自己的输入框内除外），宿主在 frame 元素上回放；滚轮或滑动被页面自己的滚动容器处理掉时不上报，其余情况宿主回放，让对话围着页面滚动。需要用户选择的页面（`awaitAnswer`）在下方保留「等待你的选择」，直到页面提交回答。
- **i18n**：`annotation.*`（13 个 key）+ `tools.browserDevTools`，tools 域，中英同步。

## 5ad.2. 用户消息的附件卡（2026-11-08）

- 非图片附件以参考行 `[Attachment] blob://<hash> (name)` 传输，因为模型就是靠它寻址。transcript 只在**渲染时**把这些行剥离（存储与提示词逐字节不变），改渲染成一排文件卡：扩展名徽标、文件名、`attachment.stat` 的大小、预览、复制引用。`[Attachment:名]`（只有名字、没有地址）不生成卡片，原样留在正文。
- 预览按 8 MiB 分页走 `attachment.get`。首字节含 NUL 或 UTF-8 解码失败的内容判为二进制，不解码；宿主提供 `save` 时该状态变成另存动作。
- 能力是可选的（`ToolRenderHost.attachment`：stat/read/save）。缺失时卡片照常渲染、预览动作不出现，guest 与 HTML 导出不会因此报错。
- 手机与浏览器访客的输入框用同一套 RPC 发附件：8 MiB 以内 `attachment.put`，更大走 `attachment.begin/chunk/commit`（3 MiB 分片）。远程客户端不能用 `attachment.putFile`——路径在设备上，不在 daemon 宿主机上。

## 5ad.1. 浏览器 Agent 控制与操作转录（2026-10-25）

- **控制界面**：agent 驱动当前可见受管标签时，accent 细环框住页面，底部液态玻璃胶囊显示当前动作、已控制时长和「我来接管」按钮。细环不是装饰：环内铺着一层指针拦截层，点击、双击、右键与拖拽都停在这里，不会作用到 agent 正在操作的页面上。被拒绝的交互由胶囊自己回应——细环与胶囊转成危险色，胶囊抖一下，第二行改成「Agent 正在操作此页，接管后才能点击」，1.4 秒后回到实时动作。滚动与键盘不拦：阅读页面是被动的，而在 agent 驱动的标签上键盘输入本来就在主进程里完成同一次移交。后台标签的工作显示同一胶囊与「Agent 正在使用浏览器」「查看 Agent 标签页」动作，不在当前页面上绘制细环，也不拦截任何东西——那张页面属于用户。细环绝不移动、隐藏或重挂 webview。动作变化经 polite live region 播报，每秒计时只做视觉更新、不重复播报。窄容器收起次要文字；减少动态效果时去掉入场、退出位移与抖动（危险色保留）。接管是控制权移交，不是终止回合：胶囊消失、标签归用户，agent 在这张标签上的下一条命令会带着可读原因失败，让它等待用户而不是和指针抢。已接管的标签保留「你已接管此标签 / 交还控制」胶囊，交还是 agent 重新获得该标签的唯一方式（不会自动恢复）。
- **接管**：按钮把现有页面交给用户，并结算该标签上进行中的 agent 命令；回合继续。它绝不关闭 agent 标签、重载文档或丢弃登录/DOM 状态。后续新消息开启新的自动化回合，不伪造暂停/恢复协议。
- **视口工具条**：设备预设、数字宽高、显示比例和外框背景集中在一行。显示比例（fit 或 25–200%）只改呈现；页面缩放仍是独立的 per-tab WebContents 设置，设备仿真负责布局尺寸和 UA 身份。放大后的页面允许滚动而不是裁切。背景只影响外框和留白，不改网页自身颜色。
- **操作转录**：浏览器卡片在流式和重载后显示同一份累计高层操作，包括观察元素数、目标、失败和截图。连续调用汇总页面和最高频的两类操作，其余失败与已恢复重试分别计数。展开保留每次原始调用；只有后续出现同 agent、同 tab、同规范化 run 输入和同操作目标的成功，才把先前失败归为已恢复。
- **动作结果**：视觉坐标检查只找到附近交互候选时，卡片明确显示「未执行点击」并列出候选，绝不把它们呈现成已点击目标。元素文本卡保留范围与快照身份；面板激活卡展示宿主权威可见性，不暗示标签已切换。这些状态沿用现有紧凑行与按需展开的原始数据，不增加新的卡片层级。
- **材质**：胶囊使用 `.gui-liquid-glass`、玻璃边缘/光泽/阴影和 190ms 入場。操作结束后保留最后一条活动，经过 180ms 淡出/滑动退出再卸载；接管按钮在取消期间进入单个进行中的暂停状态，防止重复请求。玻璃关闭时由全局 overlay token 提供不透明回退，不另造主题或模糊开关。

## 5ae. 工作态尾部预留与悬浮面板 clearance（2026-10-21）

"最新消息被悬浮输入框盖住"的两个修复：一个处理工作态，一个处理提问卡。

- **工作态尾部**（`ChatView.tsx` 尾部 spacer）：会话工作中，预留带不再跟随增长余量，改为预留 `max(--chat-composer-tail-inset, --chat-composer-inset + 8px)`——输入框玻璃与最后一行的间距重新等于悬浮间隙。状态条（工作中 / 实时尾部渐隐）住在那个间隙里；没有这条 max，长进余量区的输入框（排队消息、状态条）会让最后一行整场回合都压在玻璃下。
- **悬浮面板 clearance**（`lib/composer-inset-readers.ts`）：提问卡位于输入框上方，`position: absolute; bottom: calc(100% + 4px)`——高度永远进不了 wrap 的 ResizeObserver 测量，不另开通道就会在它弹出时盖住末尾消息。面板挂载期间发布 `ceil(height + 4px)` 为 `--chat-floating-panel-clearance`（ResizeObserver 监听面板，卸载时 withdraw）；尾部 spacer 与末尾渐隐带都加上这个变量。两条通道都只写到 reader 叶子上，绝不写列（列上的自定义属性会让每个虚拟行重排样式）。
- **回到底部按钮 clearance**：按钮叠加同一组实测 composer inset 与浮动面板 clearance，再保留 24px 安全间距。输入文本、附件/引用卡和统计行改变整个 composer 高度时，按钮始终位于其上方安全区。工作条是被测 wrap 的子节点，因此不需要单独的 `--chat-status-row-clearance`。

## 5af. 连接器进工作状态面板 + 空态选择（2026-10-21）

连接器在输入框上方胶囊之外有了第二个宿主，欢迎页（无会话）输入框也能选连接器了。

- **两宿主并存**：会话输入框上方胶囊与欢迎页 dock 胶囊不变；工作状态卡（StatusCards）在 git 与 agents 之间新增连接器 section，复用 connector-row 的 label + checkbox + transport + 状态点行结构。`useConnectors(rpc, sessionId, cwd)` 优先按 sessionId 解析快照，回退到纯 cwd 查询——daemon 侧 `connectorsSnapshotForCwd` 与创建会话同一条代码路径构建/复用每 cwd 的 MCP manager。
- **空态（pending）采纳**：没有 sessionId 时选择无处持久化，因此该状态下的 `setSelection` 把按 cwd 的条目写入 localStorage（`musepi-gui-connectors-pending`）并乐观更新快照。sessionId 出现（草稿 → 正式会话）时，hook 把 pending 条目原样经 `connectors.setSelected` 写回（暂存 `null` 表示「全量」）后清除。边缘场景，接受：首条消息之前做的选择可能赶不上当回合的工具列表。
- **选择态唯一来源**：`selected` 仅在存在 sessionId 时读取；cwd 回退快照不带选择态，也从不虚构。
- **展开面板头部预留**（`ChatView.tsx`）：工作状态卡绝对定位锚在会话视图右上角，展开面板原先会盖住右侧最新几行消息。面板展开时按 `46px（卡的 top 偏移）+ 实测面板高 + 8px` 在 transcript 滚动器顶部插入 spacer（static 包装 div 上挂 ResizeObserver），收回胶囊时撤掉——折叠态不预留，常态全宽。滚动内容从面板下经过可接受（与一切悬浮面板同性质）。

## 5ag. 液态玻璃边缘折射配方（2026-10-21）

磨砂玻璃只模糊背景；液态玻璃还会在边缘弯折背景。通过 `.gui-liquid-glass` 工具类（gui-base.css）+ `lib/liquid-glass.ts` 应用到输入框卡与工作状态卡。

- **弯折层**：工具类把承载面的 `backdrop-filter` 迁到专门的 `::before`（`isolation: isolate` 下 z-index −1）；元素自身只保留半透明Tint，文字与控件保持锐利，只有背景采样被弯折。
- **位移滤镜**：`ensureLiquidGlass()` 注入 0×0 SVG，`feImage` → `feDisplacementMap`（R/B 通道，scale 24，20% 外扩）。位移图在运行时以 256×256 canvas 生成——内部全为中性灰（#808080 = 不移位），仅边缘 ramp 内沿径向外弯（t² 缓动，角上 14 px）。不打包图片资源；`slice` 保证非方形承载面的边缘仍呈圆形。
- **边缘高光**：`::after` 用 `mask-composite: exclude` 画 1.5 px 渐变环。
- **安全门**：warp 的 `filter: url(#…)` 只在 `html.gui-liquid-glass-ready` 下生效，由模块在 SVG 进入 DOM 后置位——Chromium 会隐藏滤镜引用了不存在 id 的元素，所以注入失败时降级为普通磨砂而不是把承载面清空。非 Chromium 引擎跳过效果，渲染同样的磨砂回退。

## 5ah. 尾部预留移进滚动容器 + 边缘渐变革新（2026-10-22）

悬浮输入框的预留间距只有成为滚动内容的一部分，才能真正护住最后一行。

- **根因**：`gui-chat-tail-spacer` 一直是 `.gui-transcript`（滚动容器）**下面**的兄弟节点，而不是它的子节点。滚动容器的 scrollHeight 从不包含这段预留，钉底时最后一行贴死在滚动容器底缘——正落在悬浮输入框底下——而流外的垫片只是白白溢出 wrap。任何重新钉底（拖窗口、新开会话、切布局）都会重新暴露；切走再切回恰好落在一个可用位置，让这 bug 看起来飘忽不定。
- **修复**：垫片移进 `.gui-transcript`，紧跟 `</CodeHighlightProvider>` 之后。reader-channel 契约不变（`registerComposerInsetReader`；`--chat-composer-tail-inset` + `--chat-floating-panel-clearance`；高度仍由 §5ae 的 working/rest 公式驱动）。
- **边缘渐变革新，取代 scroller mask**：会话列表两端的渐隐以前是直接画在 `.gui-transcript` 上的 `mask-image`，它有两个毛病：(a) 滚动容器每滚一帧、每长一帧，GPU 都要把整个会话列表重新合成一遍；(b) 永远跟不上输入框——实测的 `--chat-composer-inset` 只写到注册的 reader 叶子上，mask 读到的 `--chat-tail-fade` 永远是 32px 兜底值，流式输出时把最新一行的下缘切掉（96px 的 mask 带对上 80px 的预留间距）。现在渐隐由滚动容器的两个绝对定位后置兄弟（`.gui-chat-fade--top` / `.gui-chat-fade--end`）用 `--color-surface`（滚动容器背后唯一的颜色）绘制。end 带是第二个注册 reader：输入框观测器把实测 inset 直接写到它身上。静止时该带在 `inset + clearance + 24px` 上渐变——消息滑入玻璃下方时溶进底色；`data-live-tail` 时渐变收短到 8px、带子在输入框区域变为纯色，流式输出的最新一行不会有鬼影从玻璃里透出来。top 带照旧由 `[data-top-scroll="true"]` 驱动，与被替换的 mask 同一套属性契约。
- **层级**：两条带子 `z-index: 1`，位于所有悬浮控件之下——回合导轨（20）、Chat/Canvas 切换（30）、会话树触发钮/面板（20/40）、sticky 的回到底部钮（5），recap 行补了显式 `z-index: 3`（不补的话，常亮的 end 带会盖过绝对定位的 recap）。
- **测试**：`floating-composer.test.ts` 的 "fades the transcript's end with a band fed by the composer inset" 经计算样式断言：`data-live-tail` 下带子变浅（纯色短边）、静止时变深（完整渐变），并断言 top 带默认 `display: none`。

## 5aj. 设置壳层边角：折叠导航、芯片编辑器归属、插件面板位置（2026-10-22）

- **设置导航折叠（≤900px）**：导航列与侧栏槽一起折成 64px 图标栏（两条宽度必须在同一条媒体查询里——分开写就是当年漂移的根因）。搜索框不能被挤成「放大镜加一条缝」：`SettingsNav` 用 `matchMedia` hook 镜像断点，把行内 `<label>` 搜索换成居中的放大镜按钮；点击弹出 React 渲染的悬浮面板（输入框 + 实时过滤的分区列表，自带标签/分组样式——图标栏会隐藏 `.gui-settings-nav-label` / `.gui-settings-nav-group`），点外部或按 Esc 收起。纯 CSS 的 `:focus-within` 下拉试过又放弃：点图标根本不能可靠聚焦到隐藏的输入框。
- **侧栏拖拽柄随所属面板一起隐藏**：设置页保留会话侧栏挂载（display:none）。`.gui-resize-x--side` 以前在它隐藏时照常渲染，在设置页上留一条贯穿的细线（位置 `left: sideWidth - 3`）。现在只有侧栏真的可见时才挂载拖拽柄。
- **数组芯片编辑器的两条纪律**：声明成员制的数组设置渲染成芯片。(a) 芯片容器用专用类 `.gui-settings-chips`，不用工具类——否则芯片宽度跟着构建产物的风吹草动走（分段控件给 `.gui-seg-btn` 的 `flex: 1` 会把每颗芯片拉成行宽等分；图片 URL 后端约 50 个候选时退化成每芯片一个字）。(b) 候选超过 8 个就收进「已选芯片 + 一个添加下拉」——优先级链，不是芯片云。可排序列表只在已选芯片上保留 ←/→ 移动钮。
- **插件设置面板的三个家**：`settings.tab.<id>` 整页进设置导航；`settings.extensions`（插件自带管理面板）与 `settings.item.*` 紧凑卡进插件详情弹窗的「插件设置」区；「扩展与插件」清单底部只放每行 `settings.item.*` 卡——整页面板永不出现，卡片标题一律经扩展注册表解析显示名，不用入口文件 basename。
- **设置槽位只有两种：页，或某页里的一行——命名空间说了是哪种**：页是 `settings.section` 列表里的一个条目，自带导航身份（`id`、`label`、`order`、`icon`、`keywords`）；同名内置页存在时接管它那一行（内置行的 id、关键词与深链都保留，只有真正新出现的 id 才补一行 `ext:`）。页内行是 `settings.item.<page>.<row>`：由**被点名的那一页**在自己内容之后渲染，永远不会单独得到导航行。这条规则防的是插件自己的卡片出现两次——一次在所属页里，一次变成同名的第二个设置页（`ui-theme` 旧的行座位，标签「滚动进度轨」，就曾在「外观」旁边这样多出一页）。

## 5ak. 远程主机管理

Guest／移动端顶栏使用 `HostManager` 统一完成已保存电脑的切换、重命名、删除和添加。宽屏使用液态玻璃对话框，手机使用底部玻璃 Sheet，最大高度为 `min(76dvh, 680px)`，内容在内部滚动；共享焦点、Escape 和 Android 返回键层栈保持一致。删除当前电脑或选择添加电脑会回到连接页。列表只显示电脑名称、连接地址和已知路径类型，不显示房间密钥或写入令牌。手机上的会话标题保持单行省略，顶栏以轻量玻璃动作组保留面板、电脑、子代理和退出；外观控件仍可在连接页调整。连接页是开放的远程工作区页面，不再是一整块技术表单卡：品牌与任务导向的大标题在前，随后是已保存电脑、扫描桌面二维码主按钮，以及折叠的配对码／链接次级入口。主题、强调色和语言控件放在同一行。点阵和 accent 洗光保留在内容后方，只使用装饰性对比度。桌面分享对话框命名为 `RemoteAccessDialog`，当前 RPC 使用 `remote-access.*`；旧 `collab.*` RPC 和旧链接继续兼容。

原生壳与远程浏览器共享三档宽度布局：compact 为宽度 `<600px`（也包括高度 `<480px` 且宽度 `<1024px` 的短横屏），medium 为 `600–839px`，wide 从 `840px` 开始。compact 使用两段式 Composer：收起时只保留附件、文字和语音／发送；聚焦、附件、模型 Sheet、语音活动或多行文本会展开完整模型、思考等级与编辑控制，textarea 始终挂载。Sheet 沿用桌面客户端的玻璃材质、圆角阶梯和弹簧动效。子代理栏在 `<840px` 时为覆盖层，只有 wide 才允许常驻；首个子代理出现时不得在 compact／medium 自动遮挡 transcript。远程桌面网页保留 Workspace 目录与宽屏多栏行为。

桌面侧栏的实例入口统一打开 `InstanceManagerDialog`，在同一个管理面中处理 daemon 连接和 SSH 远程工作区；侧栏独立的「断开」按钮移除。新 daemon 连接只有通过元数据探测后才保存。设置、新功能弹窗和实例管理分别呈现桌面壳与已连接 daemon 的版本：两者不一致时提示完全退出并重启应用，不误报为应用更新。

待发送消息在桌面使用内联队列面板，在 compact／移动壳使用底部玻璃 Sheet。两端都支持暂停／恢复、取回、删除、立即发送和清空；桌面另支持编辑和同组拖拽排序。暂停只停止队列投递，不中止当前回合。消息文本、附件、稳定行 ID、顺序和暂停状态在应用重启后保留，空闲会话也能继续查看和操作队列。只读协作链接可以查看宿主队列，但不能修改。

## 6. 品牌图标

上线的标识是已认可的香槟金球加修订后的耳机，放在官方 S5 超椭圆卡上，再从这张 1024 母稿缩放。`apps/desktop/build/icon.png` 就是这张母稿（1024×1024 RGBA，四周 100px 透明边）。`build/icon-dock.png` 与它字节相同。`build/icon.png` 同时是打包源和 win32 窗口图标（`ICON_PATH`）。

- **卡面**：1024 画布，边距 100px（824/1024 = 80.5%），超椭圆 n=5，球心 `(608.5, 616.8)`，半径 `381.4`。官方 81 枚点阵（`r=4.2`，`fill=rgba(236,232,233,0.09)`）已经烤进光栅。不画轨道环。卡面保持 80.5%，以便和旁边的卡中卡应用一样大；不要把卡铺满整块 tile。
- **缩放**：32px 及以上是 1024 母稿的 Lanczos 纯缩放。16px 只在 64→32→16 的过程中，给已经存在的白色特征（眼、笑、头箍和耳罩）加浅暗缝和轻微反锐化。耳机和脸都保留，没有另一张 16px 形象。
- **容器**：`build/icon.icns` 含 icp4/16、icp5/32、icp6/64、ic07/128、ic08/256、ic09/512、ic10/1024。`build/icon.ico` 含 16/24/32/48/64/128/256，全部 32 位。两者里 16px 是轻描边那一档，更大的尺寸都是纯缩放。`installerSidebar.bmp` 与 `uninstallerSidebar.bmp` 是同一张 164×314 位图；`installerHeader.bmp` 为 150×57；`apps/desktop/installer/ui/assets/brand-mark.png` 为 280×280。
- **SVG 嵌入的是光栅，不是新描的脸。** 嵌入 1024 卡面母稿的有：`build/icon.svg`、`assets/icon.svg`、`packages/client-core/public/favicon.svg`、`web/assets/musepi-mark.svg`、`apps/harmony/AppScope/resources/base/media/app_icon.svg`、`apps/harmony/entry/src/main/resources/base/media/app_icon.svg`。`web/assets/musepi-mark.svg` 和两份鸿蒙 `app_icon.svg` 与 `build/icon.svg` 字节相同。同一角色完整放进卡内、双耳罩都可见的有：`build/icon-mini.svg`、`build/icon-mini-plain.svg`（同一张母稿，不是第二张脸）、`build/icon-android-fg.svg`。由该角色派生的剪影嵌入有：`build/icon-android-mono.svg`、`build/icon-stat.svg`、`build/icon-orb-lineart.svg`、`build/icon-tray-solid.svg`、`build/icon-tray-hollow.svg`。
- **Favicon** 在 `packages/client-core/public/`（`favicon.svg`、`favicon.ico`、`favicon.png`，以及 16/32/180/192/512 的 PNG）使用这张母稿。16px 仍保留耳机。`assets/icon.svg` 是站点标记用的同一张母稿。
- **Android** 启动图标、圆形启动图标、自适应前景、单色和闪屏 PNG 都在 `apps/mobile/android/app/src/main/res/` 下，是同一角色在原有画布上的缩放。`mipmap-anydpi-v26/*.xml`、`drawable/ic_launcher_background.xml`、`values/ic_launcher_background.xml` 保持原样（`#1B191F`）。
- **鸿蒙** `media/` 仍然只接受 SVG——放进 PNG 文件会让应用白屏（见 `docs/mobile-design.md`）。两份 `app_icon.svg` 保持 SVG，并在其中嵌入光栅母稿。ArkUI 会不会把这张嵌入图画出来，还没有在真机上验证。
- **打包**：开发态 Dock 调用 `app.dock.setIcon(build/icon-dock.png)`。打包版使用 bundle icns，所以只换 png、不重打包，打包版 Dock 仍是旧图标。手动同步 icns 之后必须重签：`codesign --force --deep --sign - release/mac-arm64/MusePi.app`。
- **不要用 `scripts/regen-brand-icons.py` 重生成这套文件。** 该脚本仍把 SVG 当成按尺寸分开的矢量母稿，并会改写 favicon PNG、Android 光栅，以及 `apps/desktop/electron/tray.cjs` 里的托盘 base64 帧。仓库里的文件就是已认可的字节。32px 及以上是 1024 母稿的缩放；16px 是轻描边帧，不是重新光栅化的矢量。
- **不属于这张母稿**：`apps/desktop/build/ic_stat_musepi.xml` 与 `apps/mobile/android/app/src/main/res/drawable/ic_stat_musepi.xml` 仍是 24dp 矢量。`apps/desktop/electron/tray.cjs` 里嵌着的托盘帧不会因为 `build/icon-tray-*.svg` 更新而改写。营销横幅和 OG 图（`assets/banner.png`、`assets/readme-banner.png`、`web/assets/og-card.png`、`web/assets/og-card.jpg`、`packages/client-core/public/og-image.png`）是另一套图。鸿蒙的 `connect_*.svg` / `tab_*.svg` 是界面图标，不是应用图标。

## 7. 图标 morph 与色彩管线（定稿 2026-09-18）

### 图标 morph 三则（StateIcon，规范板「图标 morph 规范与缺口清零」）

- **形状互换 → `<StateIcon on pair>`**（`components/StateIcon.tsx`）：凡随运行时状态翻转的图标对（play/pause、eye/eye-off、展开/收起、已存/下载、面板方向、全屏切换）一律弹簧交叉形变而非硬切换。两个形状常驻 inline-grid，出场收缩（scale .4 / −90° / 120ms fade）同时入场从对侧长出，`--spring` 计时。纯 CSS 是刻意的：`.gui-motion-off` / `prefers-reduced-motion` 全局降级零接线。已迁移 29 处（commit d55086d6d）；三态类别图标保持普通 `<Icon>` + TODO(P1) n-ary 变体。
- **同形旋转 → 保持 transform**：chevron 旋转 180° 不是图标变化——旋转本身是最短路径。只旋转的不 morph。
- **渲染期选型 → 普通 `<Icon>`**：按静态事实（条目类型、配置）选的图标永不 morph——没有状态翻转可言。
- **为什么 sprite 世界不直接用 MorphIcon**：`MorphIcon`（morphicons）渲染单条 stroke 插值路径（lucide 语言）；全应用 sprite 是 fill 造型（Remix 系 `<use>` 形状）。路径形变会把实心图标变描边轮廓——StateIcon 是 sprite 世界的同读感等价物。stroke 图标（引导页步骤图标）直接用 `MorphIcon`。
- API：`<StateIcon on={cond} pair={["开时图标", "关时图标"]} className="h-4 w-4" />` —— `on` 为真显示 `pair[0]`。

### 色彩管线判定（chroma.js PoC，规范板「色彩管线 · chroma.js 评估」）

- **chroma-js（guest-client）负责**：自定义强调色派生（`theme.ts deriveCustomAccent` —— OKLCH hover ±0.07 远离静止态、降 chroma 色域钳制、按对比度选前景）与 ColorPicker 未来的对比度门禁（chroma.contrast，WCAG）。冷路径：仅 accent 偏好变更时调用（约 19KB gzip，一次调用，非逐帧）。
- **CSS `color-mix(in oklab, …)` 负责**：全部逐帧运行时混色——原生零成本，已有 60+ 处。那里永远不要上 JS 库。
- **tokens.css 手调 oklch 值负责**：静态真相（预设、表面、图表色）。不要用脚本生成它们——这些值本身就是设计决策。
- **回归锁**：`packages/client-core/test/derive-custom-accent.test.ts` —— 8 组强调色 × 双主题 accent-fg ≥ 4.5:1；旧 sRGB 派生在品牌金上只有 2.2:1。

## 5ad.2. 引用、会话层级与角色模型

结构化引用、子会话折叠、会话阅读状态和角色/回退模型思考等级见 **`docs/gui-context-and-session.md`**。批注现在暂存 display context，不再把原始 prompt 直接插入输入框。

## 8. 文件工作区、导入面板与浏览器设备栏（2026-11-04）

- **文件树行**：文件夹与文件共用 28px 行高、14px 展开槽与 14px 图标槽；只有左侧缩进移动文字列，跨层级文件名因此对齐。图标按文件族选择（代码、配置、数据、图片、表格、文档、音视频、压缩包），不再统一用通用文档图标。行操作仍放在悬停操作区，不加逐行文字标签。
- **打开方式胶囊**：一个控件——左侧胶囊用记住的应用打开，右侧 chevron 展开应用菜单。胶囊显示记住应用的真实图标（已知应用有回退字形），菜单标记当前应用，选择经 `musepi-gui-openin-app` 与顶栏打开方式共享。「用默认应用打开」与「重新扫描」是菜单行，不占页头。
- **Markdown 文件预览**：以文件所在目录为 base path 渲染 Markdown，README 的相对图片因此可解析并内联；共享渲染器为聊天安全会转义 HTML，所以预览先把 README 常用的原始 HTML（图片、链接、`<br>`、`<kbd>`、居中包装）归一化为 Markdown。网页链接交给系统浏览器，工作区内路径在文件面板打开。
- **导入会话面板**：两步（来源 → 会话），选择来源后才扫描。结果先按来源、再按工作区分组，支持搜索、按工作区全选，已导入行就地标记并禁用；底部固定区域承载进度、失败与主操作。引导弹窗的导入分支内嵌同一组件（`embedded`），不重复标题与说明，除只读安全提示外不再堆叠次要描述。每一行按「源标题 → 首条消息 → id」取名，工作区取自源会话自己记录的 cwd（`session` 头的 `cwd`、Kimi 的 `state.json`、OpenCode 的 `directory`），不从会话目录的编码名反推；选择键是源路径而不是 id，因为不同源的 id 可能重复，同一个 id 会命中另一条会话。列表一次列全，不再静默截断。每个来源在选择器与结果分组头共用一个图标：Kimi Code、Codex 与 DeepSeek Harness 用 `@lobehub/icons` 的 Mono 品牌标志，其余来源经 `MorphIcon` 沿用 lucide 字形，未知来源保持通用机器人；品牌标志导入的是叶子模块 `@lobehub/icons/es/<Brand>/components/Mono`——品牌目录入口还会拉起 `Avatar` / `Combine`，它们又回引 `features/agentConfig`，在渲染该对话框的文件里会让品牌模块在求值阶段死锁。品牌 SVG 是普通组件，因此不走 `MorphIcon`——它只 morph lucide 风格的路径节点。来源记录了参考根（主目录之外的额外工作目录）的会话，行上多一条淡色读数「将一并加入 N 个目录」，悬停给出完整路径：导入后这些目录一并可达，没有这一行时多目录会话看起来与单目录无异。只有主目录的行不显示，窄容器下这条读数与其余次要元信息一起隐藏。
- **浏览器设备栏**：一行共享控件——仅图标的 `Segmented` 预设、尺寸胶囊（fit 预设下隐藏）、`GuiSelect` 显示比例，以及支持方向键的背景色板。可折叠为一行提示条，折叠状态按窗口存于 `musepi-gui-browser-device-toolbar`。粗指针环境目标 44px。
- **插件市场界面**：卡片、元信息与空态图标都用矢量组件（不用表情符号）；空目录与筛选无结果使用不同的图标与文案，加载失败时不显示空态。
- **引用工具栏**：五动作胶囊按手势落点定位，而不是选区包围盒——拖选取鼠标松开位置，键盘选择取最后一行矩形；材质走共享液态玻璃（`--glass-sheen`、`--glass-border`、`--glass-shadow`、液态弹簧入场）。
- **浏览器 Agent 控制**：设置 → 浏览器 统一管理 Agent 开关、搜索引擎、下载策略（询问 / Agent 目录 / Agent 大小上限）、默认缩放、自定义 UA，以及应用内上传确认卡。Agent 下载不弹框；用户下载在开关开启时询问。站点发起的文件选择器由 tab worker 拦截、面板卡片处理，不再出现 Chromium 原生对话框。操作行显示元素坐标、页面标题与操作后缩略图（每次运行最多 24 张）。
- **插件入口按层级分工**：能力中心的「插件」只列用户可启停或可配置的官方插件（排除预设专用，以及没有配置/组件声明的只读包）与已安装/自建插件；设置 → 扩展与插件保留完整库存，包含只读提示词/渲染包与预设专用 persona，并在行内给出 id、只读/预设专用标签与配置/组件数。插件图标来自清单 `musepi.icon`（emoji、字形或 URI），画在 32px 透明细边框内——声明图标不再垫色块，URI 解码失败回退名字字形。
- **会话列表与输入区**：子会话引导线画在折叠槽里（标题与父会话同列；最后一个子会话用 ⌊ 收口，不再延伸进下一个根会话，祖先分支结束后也不再画多余竖线），无标题的顾问行显示「顾问会话」，思考标签不再竖排，运行中插件 chip 与连接器同处输入框上方一行。设置的插件管理是带分隔线的紧凑清单，能力中心保持带图标磁贴与安装动作的发现式卡片。


## 9. KimiCode 对齐:消息附件、右侧面板与浏览器浮层(2026-11-05)

- **拖拽文件到会话添加附件(2026-11-06)**:从系统拖文件到窗口任意位置时，当前会话卡上浮出一条虚线提示「松开鼠标添加附件」，指针位于卡片（或欢迎页卡片）内才显示；松手即把文件交给当前挂载的 composer，图片按既有规则在前端缩放成 data-URL chip，其他文件成文件 chip。整个窗口里无人认领的文件拖拽都由这个锚点接管：已处理 `dragover` 的表面保留自己的 `dropEffect`，指针位于弹窗表面时不落盘；在卡片外松手不会产生附件，也不会让 Chromium 把窗口导航到该文件；按 Esc 或移出卡片即撤销提示。提示层本身不接收指针，覆盖范围随活动场景（会话 / 欢迎页）切换。
- **拖入锚点的浮层约束（2026-11-06）**：提示层不是 dialog-like 浮层，用 `--z-overlay`（低于 `--z-modal`），入场 130ms 对齐 menu 浮层档；Esc 必须 `preventDefault()` 认领按键，防止裸 Esc 中断正在运行的轮次。每次 `dragover` 用同一次布局读取同时得到命中判定与绘制矩形，右栏弹簧或场景切换移动卡片时，虚线卡不会留在旧位置。两个输入框各自阻止 `dragover` 默认行为，锚点是兜底而不是它们唯一的拖入通道。
- **视频附件与媒体块**:在输入框选择、拖入或粘贴的视频，只要桌面桥能读到文件路径，就以原生 `video` 内容块（`file://` URL）随消息发出，而不是变成工作区文件引用；粘贴的片段没有路径时仍走工作区文件通道，字节不会被丢弃。transcript 的用户消息与工具结果都就地播放。内联视频字节在持久化时外置到会话 blob 存储、加载时还原，与图片同一机制；模型声明支持视频输入的供应商直接接收该块，其余以 `[video omitted]` 占位。全新会话的首条消息由欢迎页 composer 使用同一规则。仅当所选模型声明支持视频输入（Gemini）时，`file://` 本地片段会在会话边界读成内联字节，请求无需上传服务即可带上视频。
- **缺图要说出来，而不是留一块破图**：`ImageCardStack` 是会话里所有图片的唯一卡片——用户消息、工具结果、桌面截图都走它。当字节已经不在（过期的 `blob:sha256:` 引用、无法解码的负载），卡片保留原槽位与 4:3 几何，重读历史时版面不会跳动，同时画出不可用面而不是浏览器的破图图标：细虚线边框、4% 墨色斜纹、居中的 `ImageOff` 图标和一行「图片已不可用」。这里不用告警色——图片缺失是一种「没有」，不是错误——视觉语言沿用会话的待定占位（`.tr-mermaid-async`）。这一面是惰性的：没有 `role="button"`，也不挂指针与键盘处理，灯箱永远不会在它上面打开。卡片栈会自动落在下一张还能加载的图上，滑动与方向键只在可显示集合里循环，计数报出的是能看到的张数（两张里坏一张读作 `1 / 1`），而不是卡片总数。契约见 `test/image-card-stack.test.tsx`。
- **来源卡**:每轮末尾以折叠卡汇总本轮浏览,头部按状态显示「只读 N 个页面」或「读了 A 个页面 · 经过 B 个页面」;展开后分「读过的页面」「经过的页面」两组,行内是标题、已读/经过标签、重复访问次数与完整 URL。右侧打开、系统浏览器打开、复制链接三个动作按能力可用性禁用,复制后显示短反馈;无页面时整卡不渲染。
- **本轮修改文件卡**:标题为「N 个文件已修改」并带本轮 `+A/−R`,默认展示前 5 行,「还有 N 个文件」展开、「收起」收回;每行给文件路径与增删数,无法逐项统计时显示说明文案,「打开文件」在文件面板定位。与来源卡一样只在有数据时出现。
- **工具标题**：工具头从「已使用 终端命令(命令摘要)」改为动作名加参数摘要（`运行命令（bun check）`、`读取文件（…/types.ts:2980-3010）`），运行与完成只由 spinner/状态点表达，不再每行重复「正在使用/已使用」；参数摘要复用各渲染器已有的摘要节点，不另起一套；失败时摘要槽追加结果首行（红字），不展开也能看到原因。扩展与动态插件的生命周期工具（`extensions_list` / `extension_load` / `reload` / `status` / `validate` / `rollback`、`cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` / `cordis_inspect`；旧的 `ext_*` 名字作为历史 transcript 别名）有专属卡片：路径、插件名与用途、插件/版本/运行 ID、新增或移除的工具、错误列表与原始负载；这些工具以 `write xd://<tool>` 到达时，运行期就按真实工具分派，不再先显示成「写入文件」。运行汇总把这类调用单独计为「插件操作 N 次」，不再计入「编辑了 N 个文件」，`inspect_image` / `web_search` / `ast_grep` 这组下划线 wire 名也按其真实类别计数。未知工具保持原名与无括号。
- **进展更新与工具状态**：`notify_user` 是一条可折叠的进展行——折叠箭头、标题、右对齐的发布时间（本地 `HH:MM`），运行中默认展开并显示脉冲点，完成后默认收为一行；点标题可展开/收起，正文始终挂载。工具卡右端给出可见状态读数：运行中为 `运行中 · 3s`（每秒走表，结算即停），失败为红色 `失败`，被截断的调用为 `已中断`；成功不另加文字，由绿色状态点与结果体表达。
- **会话信息卡**:不在右侧面板标签里。它是聊天列与右面板之间的一个工作区列(288px、内容自适应高度、圆角玻璃、内部滚动),不覆盖 transcript;面板展开时,整行还放得下两者(`sessionInfoSeat`)就留在原位,否则折叠、面板占满整行,卡片不换座位,transcript 随之推开/收回;这一列与面板共用一条宽度动效,会话列每次开合只朝一个方向动一次。可见性是每会话一个偏好、默认展开,面板开合从不改写它。对话/地图切换与信息卡开关同处会话卡顶部一行(切换在左缘、开关在右缘),都不再浮在消息行上。行宽不足、无法停靠时,浮卡只在用户显式点开后才出现,按 Esc 或点外部即收起且不改写偏好——它盖住所汇总的 transcript:它停在 transcript 右缘、从顶部行之下开始、止于输入框上方,层级低于菜单与 tooltip,关闭先淡出再卸载。项目目录、连接器、运行中插件、子代理、待办与资源读数统一收进卡内,输入框不再保留第二套入口。主目录与每个附加目录使用同一种可折叠行(分支、文件数、±,展开后是逐文件列表),只有主目录带徽标;点击文件或“打开改动”打开聚焦该根的 Git。标签与可打开表面全部列出、卡片自身滚动,不再用“查看更多”隐藏任何一项;连接器是可折叠分区,折叠时头部操作仍可用。资源分区三行「标签 / 细条 / 数值」——MusePi 进程的常驻内存与 CPU、整机 CPU、内存已用/总量;还没测到的 CPU 显示破折号与空条而不是 0%,空闲因此不会被读成一次测量。
- **项目与工作目录**:侧栏项目来自 daemon 注册表(托管/隐式两种),支持新建、重命名、删除、设为主目录;项目菜单可管理附加工作目录,重复目录就地提示。文件面板的根目录下拉在多个目录间切换,附加根使用绝对路径注册标签。隐式项目只读,可一键转为托管项目。
- **浏览器网页右键菜单**:页面内右键提供复制、粘贴、标注、检查元素、复制选中文字的链接;不可用项禁用。菜单与 rail tooltip 属于同一浮层栈:打开时在网页宿主上铺透明关闭层,点击网页即关闭,不再需要先点面板空白处。
- **启动页诊断**:加载页以交叉淡入淡出的状态槽显示当前阶段。每个阶段独立计时(§3a):超过本阶段预算只显示「仍在继续」的信息提示;仅当单阶段超过「预算 + 15s」或整次启动超过 60s,才提示 daemon 可能卡住并提供「导出诊断」与「重启应用」。导出在 daemon 未连通时也可用,连接失败页同样提供这两个入口。
- **插件市场状态**:卡片区分已装版本与可更新(`v旧 → v新`),提供升级与全部升级;市场分「已装 / 目录 / 自定义源」,源可添加、刷新、移除并显示逐源失败;安装、卸载、升级前用同一确认框展示来源与版本。- **会话管理页**:设置中的「会话」改为完整管理页。顶部是项目/状态/更新时间筛选与查询/重置,下面是搜索框、可排序分页表格(会话名、项目、状态、最后一条 prompt、最后更新、完成时间、操作)与多选批量归档/恢复/删除;行内可直接打开会话。会话默认值与保留策略仍留在同页底部,不因页面重构而丢失。
- **项目显示名**:所有面向用户的项目名称都显示文件夹名,不再显示完整路径或磁盘工作区键。两目录重名时自动补父级(如 `a/demo`、`b/demo`),完整路径只放在悬停标题里。
- **引用评论**:选中文本后的浮条新增「评论」。点击后在同一条浮层里展开引用预览、评论输入与取消/添加;回车添加、Esc 关闭、点外部只丢弃草稿。评论随引用卡进入输入框,可继续编辑,发送时作为引用正文的一部分。
- **HTML 文件在侧边面板浏览器打开**:HTML 预览头部提供一个侧边面板浏览器按钮,用受管浏览器的本地预览通道完整渲染页面(样式、脚本、相对资源),相对链接与锚点在页面内继续导航,而不是只在文件面板的沙箱 iframe 里查看。
- **引用锚点与原文高亮**:引用记录选中文本及其上下文位置,源消息中被引用的文字以强调色高亮;点击引用卡滚动到原文并闪烁一次,锚点失效时退回按消息跳转。
- **表格与复制**:表格工具栏可加宽/恢复默认宽度,复制与下载仍提供 CSV/TSV/Markdown;会话菜单可复制全部对话为 Markdown 或仅复制最终总结。
- **结构化标注卡**:元素标注显示标签/类名、定位与几何、语义与状态、data-* 属性、页面与捕获信息，评论区与「引用发送截图」开关在同一张卡内；区域与手绘只保留几何与评论。分区可折叠，关闭开关后发送内容不含截图。
- **连接器管理归 MCP 设置**:不设独立「集成」页或集成概念;MCP 连接器在设置 → MCP 服务器管理与启停,插件在扩展与插件市场中安装。需要平台专属工具/面板的能力以 Cordis 插件发布并默认关闭,由用户按需启用。
- **粘性当轮提问**:向上滚动后,当前轮次的用户提问以单行玻璃胶囊钉在消息区顶部,点击回到该提问并释放底部跟随;提问行本身可见、滚到顶部或该轮由顾问开启时不显示。
- **MCP 设置可完成浏览器授权**:设置 → MCP 服务器列出已配置连接器的传输、地址与认证方式;OAuth 类显示「登录」,在系统浏览器完成授权后自动回到应用并刷新连接,不需要手工粘贴 token;Token 与 stdio 凭据仍由 `mcp.json`/子进程管理,页面不提供假输入框。
- **当前分支 PR**:信息卡在改动统计下显示当前分支关联的 PR 编号与状态(开放/草稿/已合并/已关闭),点击用系统浏览器打开;没有 PR 时不占位。
- **复制会话快捷键**:`Mod+Alt+C` 复制全部对话为 Markdown,`Mod+Alt+Shift+C` 只复制最终总结;输入框、文本域和可编辑区域内保持原生复制。
- **会话行以年龄读数（2026-11-24）**：侧栏行尾时间改成紧凑的最后活跃年龄——`刚刚`、`5m`、`12h`、`3d`、`2w`、`4mo`、`1y`（Kimi Code 对齐），不再对今天显示时钟时间、对更早的行显示月/日。阈值统一由 `compactAge`（`packages/client-core/src/lib/format.ts`）决定；`.gui-session-time` 是 `3.4em` 右对齐的 `tabular-nums` 固定槽，单位变化不会移动标题的截断位置。模块级 30s 时钟（`useSyncExternalStore`）让空闲行在两次 `session.tree` 刷新之间继续走时；行 tooltip 仍保留最后活跃与创建的完整时间戳。

## 10. 设置页分段控件与用户头像来源(2026-11-07)

- **三选换成真正的分段控件**(`settings-sections/git.tsx`):这行原本把 `自动 / 像素脸 / 首字母` 塞进三个 38px 见方的 `.gui-avatar-opt`——那是给图标按钮定的盒子(引导流程的个性化步骤仍在用),文字在里面竖排折行,「自动(GitHub → 像素)」被切成四段,三个选项读成一团色块。现在直接复用下方「更改视图」的 `Segmented`:等宽分段、单一滑块位移、方向键/Home/End 键盘路径,两行的控件宽度与位置因此对齐。标签压成 `自动 / 像素脸 / 首字母`,回退链(GitHub 照片 → 身份派生的像素脸 → 首字母)交给行描述,不再由一个被截断的按钮承担解释。
- **选项改为每次渲染构造**:`t()` 读的是当前语言,而模块级常量在 bundle 导入时就固化了文案——切换语言后控件仍显示旧语种。两个分段列表(更改视图、头像来源)都改成函数,渲染时现取。
- **写本地存储要广播**:GitHub 头像地址只在 `github.authStatus` 返回时写进 `musepi-gui-user-avatar`,却从不发 `musepi-user-avatar-changed`;而聊天气泡是同步读该键、只在这个事件上重渲染。连接、禁用、注销账号后,已挂载的气泡继续挂旧头像,要等一次无关的重渲染才对上。现在写入前后比对,变化才广播(避免每次进设置页都惊动全部气泡)。
- **气泡侧的读取也要是状态**:`UserAvatar` 原先在渲染期直读 localStorage,失败闩锁只在挂载时复位——图片一旦 404,换账号后仍然停在兜底脸,直到重启。现在 URL 与模式一起进 state,在 `musepi-user-avatar-changed` 与 `storage` 上同步,键一变就清闩锁;存坏的模式值在读取时归一化成 `auto`,控件不再悬空在没有选中项的状态。

- **顶栏分组与单一外观入口（2026-11-15）**：宽屏顶栏用细线把面板按钮组与工具控件分开，图标目标收到 32px、字形 15px，841–1199px 之间收起模型/上下文元信息，并把主题分段、强调色、语言三个控件合并为一个调色板弹层。十二个同权重的控件原本像工具栏倾倒；分组后标题与会话状态先被读到。输入区模型名的上限从 108px 提到 168px，行内有空时不再截断 “Claude Haiku 4.5”。
- **角色名保持横排（2026-11-15）**：transcript 的 gutter 是 28–40px 的窄栏，中文昵称会在气泡边缘被折成竖排。名称现在单行并在放不下时省略（桌面 12px），完整值保留在格的 title 里。
- **代理栏有标题（2026-11-15）**：顶部新增粘性 `智能体 · N` 行；此前列表直接从窗口边缘开始，没有名称。

- **一对一会话去掉角色栏与真正的平板带（2026-11-16）**：会话只有两个具名参与者时，角色 gutter 输出空串并撤掉整列（`:has(> .tr-gutter:empty)`），助手正文从内容边缘开始而不是缩进 40px。600–839px 之间正文与输入区限制在 760px 阅读列，文件面板恢复两栏，toast 抬到底栏之上。鸿蒙原生 Tab 图标改为描边感的填充环（ArkUI 只给 fill 着色），设置从“录音圆环”改成三条滑杆。

## 11. 一段会话只有一个身份：智能体胶囊与账户入口

会话胶囊打开 Agent 标签页，并把头像形变为该页身份；账户入口承载设置、快捷键与远程访问。完整几何、交互与设计记录见 [Agent 身份 ADR](adr/2026-11-21-agent-identity.md)。

## 12. 会话未读与失败标记（2026-11-21）

- **两个标记，一个位置。** 普通未读行保留标题后的 6px accent 点（`.gui-session-row--unread .gui-session-title::after`）；未读且最近完成轮失败的行走另一条路：`SessionList` 撤掉未读类，改画 `.gui-session-failed`（共享 `.gui-dot .gui-dot-danger` 原语，8px、`--color-danger`），并带 `role="img"` 与「未读 · 最近一轮失败」的可访问名称。两个标记不共存——一个失败行同时画 accent 点和 danger 点，会让「未读」和「未读且失败」读成两种可叠加状态。移动端 `SessionsSheet` 用行首同一个 8px 槽位：`.ss-item-dot--unread` 取 `--accent`，`.ss-item-dot--failed` 取 `--err`（行首点几何不变，行不左右跳），状态名并入行按钮的名字。
- **失败来自阅读状态，不来自生命周期。** 危险点只在「未读 + 最近完成轮失败」时出现；`session.list` 的持久化生命周期状态可能描述更早一轮，不能用它推导失败标记。打开会话或显式已读后，两个点一起消失；之后成功的一轮也会清掉失败。
- **权威端是 daemon。** 记录（完成轮计数、已读游标、`lastFailed`、手动未读）由 `SessionReadStateService` 保存并持久化，因此桌面窗口、手机壳、重启后的 daemon 看到同一个答案。语义与 RPC 细节见 `docs/gui-context-and-session.md#会话阅读状态`；GUI 不再保存消息计数游标。
- **标记动作。** 侧栏右键菜单的 标记为已读/未读 发送 `sessionStatus.mark`，行立即更新、5 秒轮询再对账；「全部已读」发送 `sessionStatus.markAll` 并同时清掉两个本地集合，桌宠角标与欢迎页提醒面板消费同一集合。手机端打开行即发送已读，桌面点随之消失。

## 13. 流式听写直接落在输入框里

听写预览在落稿前不进入文档，写入只作用于一个冻结区间；全局听写在 MusePi 内驱动当前输入框，在外部应用使用不抢焦点的 HUD。完整协议与设计记录见 [实时听写 ADR](adr/2026-11-27-live-dictation.md)。
