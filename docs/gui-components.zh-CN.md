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
| `--gui-slider-*` | 滑块轨道、填充、档位点、滑块、焦点、悬停与禁用态 | 声明在 `gui-chat.css`（该族的权威位置）；覆盖范围内的滑块共用一族——见下方 `LadderSlider` 与紧随其后的例外清单 |

## 桌面壳（`apps/desktop/src/components/`）

| 组件 | 用途 | 何时该用 |
| --- | --- | --- |
| `GuiSelect` | 磨砂下拉选择 | 任何枚举选择；两选项时自动渲染成分段控件 |
| `ContextMenu` | 统一右键/浮层菜单 | **所有**浮动菜单；不要另发明菜单样式 |
| `SplitterGrip` | 可调接缝的胶囊握柄 | 任何新分栏；**不要手写 `<span className="gui-split-grip">`** |
| `WorkspacePageHeader` | 页面级标题头（图标/标题/描述/动作） | 看板、任务中心、能力中心等页面 |
| `RightRail` | 右边缘 44px 图标栏 | 右面板的入口；**面板收起时也必须渲染** |
| `ContextPanel` | 右侧面板本体（标签页、分栏、最大化） | 右面板内容的唯一容器 |
| `LadderSlider`（思考） | 模型思考强度滑块，含 `Auto` 与模型上限 | `components/LadderSlider.tsx`，位于 Agent 标签页模型卡片下方；拖动松手才提交，上限以上档位可见但不可选 |
| `LadderSlider`（设置） | 带预设档位的数值设置阶梯 | `components/settings-controls/LadderSlider.tsx`；松手与方向键只能落在已声明档位 |
| `--gui-slider-*` 消费方 | 两套自定义阶梯 + 两个自愿接入的原生 range | 两套阶梯共用完整轨道；原生 `<input class="gui-range">` 全仓只有两处：通知主音量（`settings-sections/notifications.tsx`）与桌宠尺寸（`settings-sections/companion.tsx`）。适用范围与例外见下 |
| `SplitterGrip` 的宿主命中带 | `.gui-resize-x--side` / `.gui-pane-resize-x` / `.gui-dock-handle` | 三条接缝各自的定位层 |
| `SecretSettingsSection` | 密钥库设置页 | `settings-sections/secret-settings.tsx`；一张静态状态卡、`密钥 · N` + 添加，随后**只有一块正文**（`form ? 表单 : 空态或行列表`，两者绝不并存）；行用 `gui-agent-card`、控件消费 `--control-*`。**不要**为行添加可用性 chip：`secret.list` 只携带元数据 |

**滑块拖动契约（`useSliderDrag`，由 `components/LadderSlider.tsx` 导出）。** 两套阶梯都调用这一个 hook，设置阶梯自己不再持有任何指针数学。指针驱动的是**连续的**位置——`--gui-slider-p` / `--gui-ladder-p` 是 `position / last`，从来不是档位序号——所以滑块跟着指针走，而不是在档位之间跳。档位是吸附而不是绑定：最近的**可达**档位就是磁性目标，指针停在两档之间时，数值读数、高亮的档位名与 `aria-valuenow`/`aria-valuetext` 都指向这个目标，标签与读屏不会互相矛盾。滑块只在手势结束时落到目标上：松手（或按键步进）恢复 `left` 上的 `--gui-slider-ease` 过渡，档位把滑块吸进去；手势期间 `[data-dragging]` 关掉过渡，滑块不会落后指针。「减弱动效」下过渡被去掉，吸附立即到位、不做动画。滑块从按下的第一帧起就停在指针处——在两档之间按下不会先跳到某一档再回来；没有位移的单击也会落在指针下的档位，因为松手时才解析最后的指针位置。手势期间不写任何值——一次手势只触发一次 `onSettle`，因此设置阶梯不再每个指针事件写一次 `settings.set`，思考阶梯也保持「一次手势一次 RPC」。取消手势不写值，并回到已提交的档位。方向键 / Home / End 仍是逐档步进，但走同一条落位路径，键盘与指针因此共享同一个视觉过渡。模型上限以上的档位在轨道上和提交时一样不可达；指针停在其中时报的是上限档位。

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

## 已知缺口（记录在案，不是已完成）

这份目录暴露了三处还没收敛的地方，改动时注意：

1. **控制高度没有 token。** 搜索框在基础规则是 32px、在 `.gui-capability-page` 覆盖为 34px，各自写死；没有 `--control-h-*`。
2. **交互态命名未统一。** `--glass-hover*` 覆盖了通用悬停，但握柄这类「组件自有三态」是新加的 `--gui-grip-*`；新组件需要先判断该复用前者还是按命名规则新开一族。
3. **CSS 契约测试只覆盖了圆角、握柄与滑块族。** `scripts/check-radius-tokens.ts` + `test/splitter-grip.test.ts` + `test/slider-tokens.test.ts` 之外，多数组件的样式没有守护。

新增组件时，请同时更新本目录的这一行，并在 `docs/gui-design.md` 记录它遵守的契约。

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
| `scripts/check-overflow-axis.ts` | 样式规则必须同时声明两个溢出轴(或用简写);横向滚动容器要在护栏的白名单里带理由登记;不得留下过期白名单项 |
| `scripts/check-splitter-grip.ts` | 只有 `SplitterGrip.tsx` 能输出握柄类名;拖动态挂在胶囊自身的 `data-resizing` 上,绝不用全局 `body.gui-resizing`;已退役的 `.gui-resize-grip` 不得回归 |
| `test/splitter-grip.test.ts` | 握柄原语的 token、三态与接缝几何 |
| `test/slider-tokens.test.ts` | 共享滑块 token 族、两套阶梯、原生 range 配色与模型折叠卡片的焦点契约 |

新写的护栏必须先证明它在未修复的代码上会失败,才可信任(见 `.agents/rules/testing.md`:双向都通过的守卫什么都没守住)。
