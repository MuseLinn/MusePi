---
layout: default
title: 组件目录
status: living
summary: 可复用 GUI 组件的索引、归属，以及它们消费的 token 族。
scope:
  - apps/desktop
  - packages/client-core
---

# MusePi 组件目录 / Component catalog

[English](gui-components.md) | 中文

> 这是**索引**，不是新契约：每个组件的规则仍以 `docs/gui-design.md`（意图与标准）、`docs/gui-widget-spec.md`、`docs/gui-dialog-spec.md` 和代码本身为准。本文只回答「有没有现成的、在哪、什么时候该用」。

## 怎么用这份目录

1. **先查这里，再写新组件。** `AGENTS.md` 的收敛要求是：同一交互出现第二处是信号，第三处是缺陷，第四次复制前必须抽具名原语。目录里已有的，就用已有的。
2. **归属决定改动方式。** `client-core` 的组件桌面与移动端共用，改动要考虑两端；`desktop` 的组件只服务桌面壳。
3. **样式不写在组件里。** 几何、颜色、动效都读 `tokens.css`；组件文件只承载结构与行为。

## 令牌（唯一事实来源）

`packages/client-core/src/styles/tokens.css` 是全部设计变量的唯一权威，约 500+ 条声明。族与用途：

| 族 | 用途 | 备注 |
| --- | --- | --- |
| `--bg-*` / `--fg-*` | 主题底色与前景 | 由当前主题派生，18 套预设 + 两种明暗自动跟随 |
| `--border-*` / `--glass-hairline*` | 分隔线、卡片描边 | 玻璃层级的一套，别另造 |
| `--glass-*` | L1 卡片 / L2 浮层 / L3 交互态 | 见 `gui-glass.css`，最后加载、单一权威 |
| `--accent-*` | 强调色族 | 主题色或显式覆盖 |
| `--radius-*` | 6 级圆角阶梯 | **禁止字面量**，`scripts/check-radius-tokens.ts` 强制 |
| `--space-*` | 4px 间距节奏 | |
| `--spring-*` / `--gui-motion-*` | 动效曲线与时长 | `prefers-reduced-motion` 与动效开关需同时关闭 |
| `--z-*` | 层级 | 浮层、模态、提示各有档位 |
| `--gui-grip-*` | 分割握柄几何与三态 | 见下方 `SplitterGrip` |
| `--gui-slider-*` | 滑块命中区、凹槽、填充、档位点、滑块、焦点、悬停与禁用态 | 声明在 `gui-chat.css`（该族的权威位置）；覆盖范围内的滑块共用一族——见下方 `LadderSlider` 与紧随其后的例外清单 |

## 桌面壳（`apps/desktop/src/components/`）

| 组件 | 用途 | 何时该用 |
| --- | --- | --- |
| `GuiSelect` | 磨砂下拉选择 | 任何枚举选择；两选项时自动渲染成分段控件 |
| `ContextMenu` | 统一右键/浮层菜单 | **所有**浮动菜单；不要另发明菜单样式 |
| `SplitterGrip` | 可调接缝的胶囊握柄 | 任何新分栏；**不要手写 `<span className="gui-split-grip">`** |
| `WorkspacePageHeader` | 页面级标题头（图标/标题/描述/动作） | 看板、任务中心、能力中心等页面 |
| `RightRail` | 右边缘 44px 图标栏 | 右面板的入口；**面板收起时也必须渲染** |
| `ContextPanel` | 右侧面板本体（标签页、分栏、最大化） | 右面板内容的唯一容器 |
| `LadderSlider`（思考） | 模型思考强度滑块，含 `Auto` 与模型上限 | `components/LadderSlider.tsx`，位于 Agent 标签页模型卡片下方；拖动松手才提交，上限以上档位可见但不可选。标题行只有一行（「思考强度」+ 当前档位），轨道下方没有任何标签行 |
| `LadderSlider`（设置） | 带预设档位的数值设置阶梯 | `components/settings-controls/LadderSlider.tsx`；松手与方向键只能落在已声明档位。与思考阶梯共用同一条轨道，只有标题行不同 |
| `SliderTrack` | 两套阶梯共用的轨道本体 | 由 `components/LadderSlider.tsx` 导出；全仓唯一的轨道标记——新的阶梯只提供标签与标题行，不再画第二条轨道 |
| `--gui-slider-*` 消费方 | 两套自定义阶梯 + 两个自愿接入的原生 range | 两套阶梯渲染同一个 `SliderTrack`；原生 `<input class="gui-range">` 全仓只有两处：通知主音量（`settings-sections/notifications.tsx`）与桌宠尺寸（`settings-sections/companion.tsx`）。适用范围与例外见下 |
| `SplitterGrip` 的宿主命中带 | `.gui-resize-x--side` / `.gui-pane-resize-x` / `.gui-dock-handle` | 三条接缝各自的定位层 |
| `MarketplaceDetailDialog` | 插件详情页（版本、描述、技能、底部动作） | `components/MarketplaceDetailDialog.tsx`；样式表在 `styles/gui-marketplace-detail.css` |

**桌面样式表只有一个归属目录：`apps/desktop/src/styles/`。** 那里的每个文件都是 `gui-*` 族的样式表；组件需要样式时从该目录导入（`../styles/gui-<name>.css`），不再自带同级 `.css`。最后一份例外（插件详情样式表）已从 `components/` 迁入，层叠里不再有没有归属的一段。
| `SecretSettingsSection` | 密钥库设置页 | `settings-sections/secret-settings.tsx`；一张静态状态卡、`密钥 · N` + 添加，随后**只有一块正文**（`form ? 表单 : 空态或行列表`，两者绝不并存）；行用 `gui-agent-card`、控件消费 `--control-*`。**不要**为行添加可用性 chip：`secret.list` 只携带元数据 |

**滑块视觉契约（`SliderTrack`，由 `components/LadderSlider.tsx` 导出）。** 两套阶梯都渲染这一个组件，谁也不再自带轨道标记。它画的是紧凑的「内嵌」力道条，而不是表单字段：一条 `--gui-slider-hit`（28px）的命中胶囊，内部凹槽高 `--gui-slider-track`（22px）、上下各内缩 3px，描边用内阴影发丝线而不是 border（轨道的盒子就是指针测量的行程，border 会让指针数学偏移一像素）。它由两层承担：一层不可见、按滑块半径内缩的测量轨道（指针读它的盒子）和一条铺满胶囊、上下各内缩 3px 的可见凹槽——凹槽若只到测量轨道处，就会像一条两头留空的滑轨。档位是落在凹槽**上**的 `--gui-slider-dot-size` 圆点；填充从胶囊左边缘穿过滑块，所以连第一档也在强调色上；滑块是取页面正文墨色的浅色圆盘，悬停与拖动时放大。配色是我们的（`--color-accent` 画轨道与填充；滑块取 `--color-text`，填充内的档位点取不透明的 on-accent 墨色，因为两者都压在强调色上），不是「中性手柄 + 外来蓝」。档位点必须不透明：同样的墨色混到 62% 后，在浅色填充上测得 2.4–3.1:1、深色填充上 3.2–3.4:1，整条带子大部分都低于图形元素 3:1 的下限，填充内的档位会在「已选到这里」的位置上变淡；不透明后浅色 3.7–5.3:1、深色 7.0–8.2:1，每个位置都在下限之上。未到达的档位用 55% 的正文墨色，对凹槽测得浅色 3.2:1、深色 4.1:1，同样在下限之上，又明显弱于已到达的档位，两种状态仍然分得清。由此有两条必须守住的结果：轨道下方**没有标签行**——每一档把名字放在自己圆点的 `title` 上，并配一条加宽的透明悬停带，因为 4px 且 `pointer-events: none` 的圆点根本不可能成为悬停目标；思考阶梯的标题行**只有一行**，分区标签与当前档位并排（选中 Auto 时由 `Auto · <档位>` 取代档位本身），所以数值不会在窄版 Agent 面板里折到标签下面。方向键走的是同一批档位、并和松手走同一条钳制路径，所以模型上限在两条路径上都成立；键盘处理器**故意**只按 `disabled` 拦截，因为顶部档位被上限挡住的阶梯仍然有合法档位，一律拒绝按键会让「正需要解释上限」的那些模型彻底失去键盘操作。设置阶梯共用胶囊、凹槽、圆点和滑块，只有标题行不同：它所在的设置行左侧已经写了设置名，所以数值单独占轨道上方那一行，并保留该行 210px 的宽度。

**滑块拖动契约（`useSliderDrag`，由 `components/LadderSlider.tsx` 导出）。** 两套阶梯都调用这一个 hook，设置阶梯自己不再持有任何指针数学。指针驱动的是**连续的**位置——`--gui-slider-p` 是 `position / last`，从来不是档位序号——所以滑块跟着指针走，而不是在档位之间跳。档位是吸附而不是绑定：最近的**可达**档位就是磁性目标，指针停在两档之间时，数值读数、高亮的档位圆点与 `aria-valuenow`/`aria-valuetext` 都指向这个目标，标签与读屏不会互相矛盾。滑块只在手势结束时落到目标上：松手（或按键步进）恢复 `left` 上的 `--gui-slider-ease` 过渡，档位把滑块吸进去；手势期间 `[data-dragging]` 关掉过渡，滑块不会落后指针。「减弱动效」下过渡被去掉，吸附立即到位、不做动画。滑块从按下的第一帧起就停在指针处——在两档之间按下不会先跳到某一档再回来；没有位移的单击也会落在指针下的档位，因为松手时才解析最后的指针位置。手势期间不写任何值——一次手势只触发一次 `onSettle`，因此设置阶梯不再每个指针事件写一次 `settings.set`，思考阶梯也保持「一次手势一次 RPC」。取消手势不写值，并回到已提交的档位。方向键 / Home / End 仍是逐档步进，但走同一条落位路径，键盘与指针因此共享同一个视觉过渡。模型上限以上的档位在轨道上和提交时一样不可达；指针停在其中时报的是上限档位。

**滑块适用范围。** 该族覆盖两套阶梯与上述两个原生 range。有四处已发布滑块**有意**留在族外，各自属于独立表面：`.gui-sketch-range`（画板笔宽，`gui-composer.css`）、浏览器设备栏的宽高 range（`gui-browser-toolbar.css`）、截图编辑器的描边宽度（`.gui-shot-weight input`，`ScreenshotEditorDialog.tsx`）与 `.tr-ui-range`（`packages/client-core/src/ui-blocks/ui-blocks.css`）；移动端 `VoicePanel` 的语速是第五处。它们可以在各自的 scope 内收敛到该族；在此之前不得手抄族内几何。桌面端语音设置没有滑块——`tts.rate` 是 schema 数值，渲染成滚动数字。

## 共享组件（`packages/client-core/src/components/`）

桌面与移动端共用，改动需两端同时验证。

| 分组 | 组件 | 用途 |
| --- | --- | --- |
| `shell/` | `Segmented` | 分段控件（单个滑块），**所有**多选一都用它 |
| `shell/` | `Composer` | 输入区（桌面与移动共用） |
| `shell/` | `HeaderBar` / `MobileTabBar` / `MobileSettings` | 壳层导航 |
| `shell/` | `ConfirmDialog` / `Banners` / `Toasts` / `ApprovalCard` | 确认、横幅、提示、审批 |
| `shell/` | `DotMatrixMark` / `MatrixLoader` / `ShinyText` / `BlurText` | 品牌与加载动效 |
| `common/` | `FoldRegion` | 可折叠区域 |
| `panels/` | `BoardPanel` / `FilePanel` / `ScheduledPanel` / `VoicePanel` / `WorkspacePanel` | 右面板各视图 |
| `agents/` | `AgentsPanel` / `AgentDrawer` | 子代理 HUD 与详情 |
| `marketplace/` | `MarketplaceGrid` / `MarketplaceCard` / `MarketplacePanel` | 市场网格（能力中心只重皮肤，不复制） |
| `charts/` | `BarChart` / `LineChart` / `Donut` / `Gauge` / `KLine` / `Sparkline` | 图表 |
| `progress/` | `ProgressMeter` | 进度 |
| `transcript/` | `BranchSummaryDivider` | 继承历史的分界行；以共享 `GitFork` 图标打头，文案仍是可访问名 |
| — | `image-lightbox` / `image-morph` / `image-zoom` | 图片查看 |

## 搜索（`packages/client-core/src/`）

- **`SearchField`**（`components/common/SearchField.tsx`）是唯一的搜索输入框——见上表那一行；匹配不是它的职责。
- **`TextSearchIndex`**（`lib/text-search.ts`）是搜索框背后唯一的匹配器：
  - **两类键。** `fuzzy` 放短标识文本（名称、标题、标签、可读 id），按子串或词首子序列匹配；`substring` 放长文本与不透明 id（描述、配置键、路径、UUID），只按连续子串匹配。
  - **一次折叠。** 两类键与查询都不区分大小写、全半角（NFKC）、U+0300–U+036F 变音符号与字母笔画（`ł`、`ø`）；改变字母的符号（如日语浊音点）保留。于是 `web` 命中 `ＷＥＢ`，`lodz` 命中 `Łódź`。
  - **词首模糊。** 子序列必须从词首开始——分隔符之后、驼峰处、或任意 CJK 字符处——所以 `cpt` 命中 `Compact`，而 `fab` 不会命中 `Refactor build` 内部。
  - **词项与层级。** 查询按空白切分，每个词项都必须命中某个键；每个词项取其最高层级：fuzzy 精确、fuzzy 前缀、fuzzy 子串、fuzzy 词首子序列，最后是 substring 键命中；总分相同保持构建顺序。`search` 对空查询返回构建列表本身，`rank` 返回带分数的命中、空查询返回空。
  - **每种语言都是独立键。** 同时传入译文与源文——设置搜索传入 en-US、zh-CN 与当前语言——任一语言的查询都能命中。
  - **不可变、无 DOM。** 列表或标签语言变化时构建索引，不要每次按键重建；设置搜索按 rows 数组与语言缓存一份，命令面板按查询构建小索引。

**消费者：** 设置导航与其 schema 行结果（`apps/desktop/src/lib/settings-search.ts`）和命令面板（`apps/desktop/src/components/CommandPalette.tsx`——双语命令、设置页与 schema 行、会话标题）。会话正文搜索（`session.search`）与插件市场保留各自的索引，不经过这个原语。

## 对话框与看板

- 对话框统一走 `DialogFrame`，规则见 `docs/gui-dialog-spec.md`（尺寸档位、滚动容器、焦点、修饰类特异度）。
- 看板与内联卡片的几何、注册对等、源文本规则见 `docs/gui-widget-spec.md`。
- **位置行（`ConnectionLocationRow`，`.gui-loc-row`）**：连接两条轴共用的唯一行结构——`InstanceManagerDialog` 的实例列表与 `ConnectDialog` 的主机列表由**同一个组件**渲染，所以两边的单元格落在同一横坐标。差异是 props 而不是布局：`leading` 为 `"dot"`（在线状态点）或 `"glyph"`（类型图标），两者都放在**固定宽度的 `.gui-loc-lead` 盒子**里，因此名称的起始偏移完全一致。`status` **始终渲染**，这正是让每一行的尾部槽位距行尾保持同一偏移的原因；`action` 是可选的尾部控件，作为行按钮的**兄弟节点**渲染在始终预留、固定宽度的 `.gui-loc-action` 槽位中，因此没有控件的行不会把按钮撑宽。行本身是 `<button>`（`.gui-loc-row-main`）——悬停底色与命中区是同一个矩形（M86）——删除类控件绝不嵌套在它要删除的目标内部。名称列占行的**固定份额**（`--gui-loc-name-w`）而非按内容宽度：按内容宽度时，名称自身的长短会把 `where` 推右，导致两个列表的位置列起始 x 不同。`where` 说明的是机器，绝不是隧道的回环地址。列表是 `<ul class="gui-loc-list">`；`.gui-loc-list--scroll` 只用于向导的独立对话框——在管理器里正文才是唯一的滚动容器（见「溢出契约」）。几何契约**通过组件**（`renderToStaticMarkup`）渲染行，而不是手写标记，因此夹具无法与真实产物漂移；它精确比较两个列表中名称/位置列的 x，以及状态槽位距各自行尾的偏移。契约：`apps/desktop/test/instance-manager-axes.test.tsx` 与真实 Chromium 的 `apps/desktop/test/connection-locations-geometry.test.tsx`。

## 已知缺口（记录在案，不是已完成）

这份目录暴露了三处还没收敛的地方，改动时注意：

1. **控制高度没有 token。** 搜索框在基础规则是 32px、在 `.gui-capability-page` 覆盖为 34px，各自写死；没有 `--control-h-*`。
2. **交互态命名未统一。** `--glass-hover*` 覆盖了通用悬停，但握柄这类「组件自有三态」是新加的 `--gui-grip-*`；新组件需要先判断该复用前者还是按命名规则新开一族。
3. **CSS 契约测试只覆盖了圆角、握柄与滑块族。** `scripts/check-radius-tokens.ts` + `test/splitter-grip.test.ts` + `test/slider-tokens.test.ts` 之外，多数组件的样式没有守护。

新增组件时，请同时更新本目录的这一行，并在 `docs/gui-design.md` 记录它遵守的契约。

## 悬停卡（同一份配方）

侧栏的两张悬停卡——会话卡（`SessionHoverCard.tsx`，288px）与项目卡（`ProjectHoverCard.tsx`，240px）——在 `gui-chrome.css` 里是**一份**配方：`.gui-hover-card` 及其 `-title` / `-meta` / `-dot` / `-rows` / `-row` / `-icon` / `-label` / `-text` / `-chip`。紧随其后的两张卡的区块只声明各自内容改了什么；新的浮层从这些部件起步，而不是再抄六条声明。

| 部件 | 取值 | 为什么 |
| --- | --- | --- |
| 表面 | L2 玻璃：`color-mix` 覆盖层 + `backdrop-filter` + 六层阴影 | 与 `.gui-menu-popup` 同层；不另造玻璃家族 |
| 标题 | `--ui-font-size`、600、`line-height: 1.35` | 两张卡同一个标题档位 |
| 元信息行 | `--ui-font-size-xs`、2px 分隔点、一个 accent chip | 一行可读的短事实，而不是标签/值堆叠 |
| 行盒 | `--ui-font-size-xs`、`var(--color-text-muted)`，名字格用 `var(--color-text)`、6px 间距、`3px 4px`、12px 图标 0.75 不透明度、单行省略 | 4px 横向内边距既是命中区，也是与标题对齐的文字栅格。行与图标是次要色调，只有名字是正文色——卡片自己的规则不能重新声明行的 `color`，否则特异性打平、按源码顺序胜出 |
| 行组 | `.gui-hover-card-rows`：`1px` 步进 | 一叠事实行读成一片栅格，而不是五个独立块 |
| 入场 | 两阶段：基础 `opacity: 0`，`--entered` 把 opacity 一步翻到 1 **并**启动 `gui-hover-card-in`，关键帧只动 **transform**（140ms `--spring`）；方向由 `--gui-hover-card-shift-x` / `-y` 给出 | 两阶段揭示上的一个滑动手势。在 `backdrop-filter` 表面上动画 opacity 会让 Chromium 在真实合成器上跳过 backdrop 采样，整段淡入期间磨砂消失（见下文） |
| 隐藏态 | 基础规则里的 `opacity: 0`，由 `--entered` 取消 | 减弱动效或 `.gui-motion-off` 下 `animation: none` 时，`--entered` 已经把 opacity 设为 1，卡片照常落位可见，不会停在透明 |
| 减弱动效 | `prefers-reduced-motion` 与 `.gui-motion-off` 下对 `.gui-hover-card--entered` 设 `animation: none` | 只去掉滑动；opacity 的翻转不是动画，所以仍然生效 |

**按内容合理不同的部分：** 宽度（会话卡 288px、标题两行截断，因为会话标题长；项目卡 240px、标题单行，因为项目名是一个名字）、列表（项目卡的目录列表有自己的高度上限并自己滚动，由 `fitProjectCard` 按实测空间夹取；会话卡是一小叠事实行，从不滚动）、入场方向（会话卡从行的右侧滑入，项目卡从上方或下方滑入，包括 `--above` 翻转）。

**命中区是诚实的。** 只有真的会响应的行才带 `.gui-hover-card-row--action`，而且铺底色的元素就是执行动作的元素。项目卡的目录行**本身就是**一个填满行盒的 `<button>`（图标、名字、主目录 chip 与行尾装饰箭头都在里面），所以底色覆盖的正是会导航的那 212px——点左侧内边距或名字右边的空白同样打开文件夹，光标是 pointer，焦点环也在行上。会话卡的行是只读的，且整张卡是 `pointer-events: none`，里面的任何元素都不会 hover。`.gui-hover-card-chip` 两张卡共用（主目录 / 会话模式），chip 的文案来源各自保留。

**入场为什么不做淡入。** 配方的隐藏态是基础 `opacity: 0`，`--entered` 一步翻到 1，关键帧只动 transform。这是仓库里每张磨砂浮层共同的实测规则：在 `backdrop-filter` 元素上动画 opacity，会让 Chromium 的真实屏幕合成器跳过 backdrop 采样，卡片整段淡入期间读起来就是普通半透明，动画结束才"突然变毛玻璃"。CDP 截图走离屏合成，仍然显示模糊，所以这件事用样式探针测不出来——见 `docs/gui-design.md`（两阶段入场）与 `docs/gui-implementation.md` §6.5，以及两个在用样例（`.gui-menu-popup`、`.gui-board-focus`）。配方是之后每个浮层要照抄的东西，所以它承载这条规则，而不是重新推导。

**不透明回落也是配方的一部分。** `packages/client-core/src/styles/overlay-fallback.css` 在所有组件样式表之后加载，在三种情况下把半透明填充换成 `--color-surface-raised` 加 sheen 并去掉 `backdrop-filter`：`[data-platform="win32"]`、`prefers-reduced-transparency: reduce` 与 `@supports not (backdrop-filter: …)`。它写的是 **`.gui-hover-card`** 而不是某一张卡，所以第三张用配方的卡不需要改这个文件。win32 与减弱透明度两个分支由 `hover-card-geometry.test.ts` 按计算样式对两张卡逐一验证（同一条测试还验证离开这些分支时玻璃态保持不变）；`@supports` 分支在支持该特性的浏览器里无法强制触发，但它与其他两个分支共用同一份选择器列表。

契约：`apps/desktop/test/project-hover-card.test.tsx`（状态、portal、翻转）、`apps/desktop/test/session-fork-badge.test.tsx`（会话卡的「分叉自」行）与 `apps/desktop/test/hover-card-geometry.test.ts`（真实 Chromium：两张卡的内边距、行步进、标题截断、入场只动 transform、两阶段隐藏帧、减弱动效直接落位、目录行整行可点，以及 win32 / 减弱透明度下的不透明回落）。

### 它背后的收敛规则

用户的反馈不是「把会话卡做漂亮点」，而是「项目卡怎么看起来更精致？」——两个在不同时间建成的同类组件之间的**完成度分叉**。由此得出的规则，对下一张浮层同样适用：

1. **看起来更精致的新组件成为基准。** 新建的表面明显比老兄弟更完整时，老的那个向它收敛；新组件的选择成为下一个表面的起点，而不是每次重新发现。兄弟之间的完成度分叉本身就是缺陷，即使两者单独看都说得过去。
2. **说清要素，而不是说品味。** 造成这次差距的三个要素具体且可复用：**有真实命中区的紧凑行栅格**（真实的纵向步进 + 4px 内边距，且落在执行动作的元素上）、**一条结构化的元信息行**（分隔点 + 一个 accent chip）而不是标签/值堆叠、以及**两阶段揭示上的一个滑动手势**——卡片以 `opacity: 0` 挂载且无动画，`--entered` 一步翻转 opacity，关键帧只滑动 4–6px。抄要素，不抄像素；注意要素是**滑动**而不是淡入——在磨砂玻璃上动画 opacity 会破坏磨砂（见上文「入场为什么不做淡入」）。
3. **在第二份副本时就抽取，而不是第四份。** 这两张卡已经把同样的六条声明抄进了同一个文件。配方（`.gui-hover-card` 及其部件）就是那次抽取，所以第三张悬停卡消费它，而不是再加一份副本。
4. **反向规则：收敛不改行为。** 只有当点击一行真的会做事时，这一行才获得 hover 提示。项目卡的目录行会打开，会话卡的行是只读的，这个不对称是正确的，保持不变——收敛的是行栅格，不是命中区。收敛只关乎完成度，绝不等于给一个表面加上它并不具备的动作。

## 按压手势（居中的控件在原地按压）

按压只是**缩放，不是位移**。若控件静止态的 transform 同时承担居中（`left: 50%` 下的 `translateX(-50%)`），两者必须放进各自独立的自定义属性——`.gui-agent-capsule` 用 `--gui-capsule-shift` 承担居中、`--gui-capsule-press` 承担手势——这样改用**布局**居中的表面只需把位移清零，仍保留按压。设置里的效果预览（`.gui-effect-preview-identity`）就是这种表面：一行 flex 居中同一个真实药丸，此前因为 `:active` 重新声明了完整 transform，点击时会左跳半个自身宽度。清零要写 `translateX(0)` 而不是 `none`——`none scale(0.97)` 是非法 transform，会把手势整个丢掉。`test/agent-capsule-geometry.test.ts` 通过 CDP `CSS.forcePseudoState` 驱动**真实**的 `:active`（注入一条只设置 `--gui-capsule-press` 的规则只能证明变量可用，把 bug 还原后照样全绿），断言两处按压后的药丸中心 x 不变、且两处都确实变窄。任何新的、把居中 transform 与按压组合在一起的药丸都遵循同样的拆分。

## 打开成本（点击挂载的表面先出首帧）

因点击而挂载的表面，不得在挂载帧里构建它的重子树。Agent 标签页的实测得出两条规则：**重列表在首帧绘制之后或按需挂载，绝不能在挂载时就躲在折叠的披露区里建好**（`session.agent` 的模型目录改为首次展开时挂载并保持挂载；260 个模型的目录实测 316ms → 22ms），以及**可能被重新挂载的列表要用缓存快照播种、同时仍然重新读取**（`ModelSelector` 的 `catalogCache`，按读取键索引：`session:<id>` / `registry`）。播种绝不能比事实活得更久：读取失败时删除该键并清空行，缓存本身有上限且按最近使用淘汰——因为没有任何事件会报告某段会话已关闭。改变 `width` 的折叠/展开动效会逐帧重排面板及其 flex 兄弟——改为在内容上动 `transform`/`opacity`，盒子（宽度**与外距**）只落一次，并把自带动效的子元素（`.gui-pane-resize-x`、`.gui-agent-dock`）排除在内容规则之外。守卫：`test/agent-info-pane-open-cost.test.tsx`（首帧不读目录、不建行；列表只在展开后出现；重新挂载由缓存播种；读取被拒绝后不留行、也不污染后续挂载）与 `test/panel-fold-reflow.test.ts`（宽度、左缘与外距保持到那一次切换；抽屉退出全程可见）。

## 溢出契约

滚动容器要声明**它用哪个轴、以及它不许用哪个轴**。只设置 `overflow-x` / `overflow-y` 之一时另一个会计算为 `auto`(规范不允许 `visible` 作为配对值),于是纵向列表悄悄也变成横向滚动容器——第一个比内容盒宽的行就会在**本来已经显示完整**的内容下面长出滚动条。项目悬浮卡就出过这个缺陷(用户原话:「内容明明显示完整却出现了不该出现的横向滚动」),同样的形状在桌面样式里还有约 70 处,所以这是一条带护栏的类别规则,而不是单点补丁。

1. **一个轴滚动,另一个轴显式声明。** `overflow-y: auto; overflow-x: clip;` 是标准的纵向列表形状。容器内可能有 `position: sticky` 子元素时用 `clip` 而不是 `hidden`:`hidden` 会让盒子变成滚动容器,悄悄破坏吸顶偏移,`clip` 不会。
2. **`nowrap` 内容用省略号或换行。** 不换行的单行行,文本格声明 `overflow: hidden; text-overflow: ellipsis`,并用 `title` 带上完整值。绝不用横向滚动去揭示一个本来就已显示的值。
3. **只有明示且登记的地方才允许横向滚动。** 真正需要横向的容器(标签条、代码块、数据表)两个轴都声明,并按选择器登记在 `scripts/check-overflow-axis.ts` 的 `HORIZONTAL_SCROLLERS` 里,每项一句理由。那份列表是唯一事实来源,本文只指明它而不复制它,所以不会出现「文档里的白名单过期、护栏还在按旧表放行」。
4. **简写可以。** `overflow: hidden` 按定义设置两个轴,不需要配对值。

护栏会失败于:只声明一个轴的规则、未登记的横向滚动容器、以及已经不再横向滚动或已不存在的白名单项(过期的豁免正是白名单变成 bug 藏身处的方式)。契约:`scripts/check-overflow-axis.ts` + `scripts/check-overflow-axis.test.ts`;卡片的真实 Chromium 证明(两个 `scrollWidth === clientWidth` 以及它开在侧栏旁边)在 `apps/desktop/test/project-hover-card-geometry.test.ts`。

## 护栏(代码胜于文字)

文字规则只是建议,检查才是契约。能被机械验证的标准都配了护栏并接进 `bun run check:tools`,破坏它会让 CI 失败,而不是靠评审发现:

| 护栏 | 强制内容 |
| --- | --- |
| `scripts/check-radius-tokens.ts` | 禁止字面量 `border-radius`;每个 `--radius-*` 都必须有定义 |
| `scripts/check-overflow-axis.ts` | 样式规则必须同时声明两个溢出轴(或用简写);横向滚动容器要在护栏的白名单里带理由登记;不得留下过期白名单项。它自己的测试在 CI 里跑 |
| `scripts/check-changelog-i18n.ts` | 已发布条目的 `- EN:` 子行有且只有一条;`[Unreleased]` 的每一行都是分类标题、条目或其缩进子行——没有条目的段落会带行号失败 |
| `scripts/check-splitter-grip.ts` | 只有 `SplitterGrip.tsx` 能输出握柄类名;拖动态挂在胶囊自身的 `data-resizing` 上,绝不用全局 `body.gui-resizing`;已退役的 `.gui-resize-grip` 不得回归 |
| `test/splitter-grip.test.ts` | 握柄原语的 token、三态与接缝几何 |
| `test/slider-tokens.test.ts` | 共享滑块 token 族、两套阶梯、原生 range 配色与模型折叠卡片的焦点契约 |

新写的护栏必须先证明它在未修复的代码上会失败,才可信任(见 `.agents/rules/testing.md`:双向都通过的守卫什么都没守住)。
