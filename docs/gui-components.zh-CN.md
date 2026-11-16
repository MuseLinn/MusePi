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

English | [中文](gui-components.zh-CN.md)

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

## 桌面壳（`apps/desktop/src/components/`）

| 组件 | 用途 | 何时该用 |
| --- | --- | --- |
| `GuiSelect` | 磨砂下拉选择 | 任何枚举选择；两选项时自动渲染成分段控件 |
| `ContextMenu` | 统一右键/浮层菜单 | **所有**浮动菜单；不要另发明菜单样式 |
| `SplitterGrip` | 可调接缝的胶囊握柄 | 任何新分栏；**不要手写 `<span className="gui-split-grip">`** |
| `WorkspacePageHeader` | 页面级标题头（图标/标题/描述/动作） | 看板、任务中心、能力中心等页面 |
| `RightRail` | 右边缘 44px 图标栏 | 右面板的入口；**面板收起时也必须渲染** |
| `ContextPanel` | 右侧面板本体（标签页、分栏、最大化） | 右面板内容的唯一容器 |
| `SplitterGrip` 的宿主命中带 | `.gui-resize-x--side` / `.gui-pane-resize-x` / `.gui-dock-handle` | 三条接缝各自的定位层 |

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
| — | `image-lightbox` / `image-morph` / `image-zoom` | 图片查看 |

## 对话框与看板

- 对话框统一走 `DialogFrame`，规则见 `docs/gui-dialog-spec.md`（尺寸档位、滚动容器、焦点、修饰类特异度）。
- 看板与内联卡片的几何、注册对等、源文本规则见 `docs/gui-widget-spec.md`。

## 已知缺口（记录在案，不是已完成）

这份目录暴露了三处还没收敛的地方，改动时注意：

1. **控制高度没有 token。** 搜索框在基础规则是 32px、在 `.gui-capability-page` 覆盖为 34px，各自写死；没有 `--control-h-*`。
2. **交互态命名未统一。** `--glass-hover*` 覆盖了通用悬停，但握柄这类「组件自有三态」是新加的 `--gui-grip-*`；新组件需要先判断该复用前者还是按命名规则新开一族。
3. **CSS 契约测试只覆盖了圆角与握柄。** `scripts/check-radius-tokens.ts` + `test/splitter-grip.test.ts` 之外，多数组件的样式没有守护。

新增组件时，请同时更新本目录的这一行，并在 `docs/gui-design.md` 记录它遵守的契约。

## 护栏(代码胜于文字)

文字规则只是建议,检查才是契约。能被机械验证的标准都配了护栏并接进 `bun run check:tools`,破坏它会让 CI 失败,而不是靠评审发现:

| 护栏 | 强制内容 |
| --- | --- |
| `scripts/check-radius-tokens.ts` | 禁止字面量 `border-radius`;每个 `--radius-*` 都必须有定义 |
| `scripts/check-splitter-grip.ts` | 只有 `SplitterGrip.tsx` 能输出握柄类名;拖动态挂在胶囊自身的 `data-resizing` 上,绝不用全局 `body.gui-resizing`;已退役的 `.gui-resize-grip` 不得回归 |
| `test/splitter-grip.test.ts` | 握柄原语的 token、三态与接缝几何 |

新写的护栏必须先证明它在未修复的代码上会失败,才可信任(见 `.agents/rules/testing.md`:双向都通过的守卫什么都没守住)。
