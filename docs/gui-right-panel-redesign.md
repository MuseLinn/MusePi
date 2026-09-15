# 右侧面板改造方案

> 对比分析 openchamber / proma / bitfun / opencode 后，对 MusePi 右侧面板的重新设计。

- **日期**: 2026-08-24
- **状态**: 草案（部分已落地，2026-08-25 核对）
- **参考**: `gui-design.md`（既有布局规范）、`gui-implementation.md`（实现笔记）

---

## 0. 实现状态（2026-08-25 核对）

> 核对方法：逐项 vs `packages/desktop-app/src/`。

- **Phase 1 核心改造 — ◐**：registry `group` 字段 ✅（`surfaces/registry.ts:27-57`）；Rail 分组+溢出折叠 ✅（`RightRail.tsx:96-261`，但保持 44px 纯图标、secondary 不折叠，作者偏好）；宽度 260–1200 ✅（超出规格，`ContextPanel.tsx:229-244`）+ maximize。**TabBar 第二 tab 条 ❌ — 已架构否决**（`ContextPanel.tsx:283-284`、`RightRail.tsx:42-44`："rail is the single navigation axis — no second tab row"）；多实例 tab ◐ **（2026-09-15）**：通用组件已落地 ✅（`components/surface-tabs.tsx`：`SurfaceTabStrip` / `useSurfaceTabs` / `SurfaceTabPanels` + `test/surface-tabs.test.tsx` 17 用例），**files surface 已接入**（`FilePane.tsx`：树节点点击注册 tab、激活跟随已加载预览、关闭跟随邻居、按 cwd 持久化 `musepi-gui-file-tabs-{cwd}`）；其余 surface 接入时必须走「surface 内实例 tab」形态（见 §3.3 边界修订），不得做成面板头部的全局导航条。
- **Phase 2 体验优化 — ◐**：⌘E 面板开关 ✅、⌘⇧E=focus mode ✅（语义与文档不同，属设计漂移）；关闭动画 ✅（220ms 宽度折叠，非 proma overlay）。snap points ✅（`ContextPanel.tsx:247` `SNAP_POINTS=[300,480,800]`，释放吸附，0a51f37788）、上下文 gating ❌、Mod+1..9 ✅（2026-09-07：⌘1..8 按 rail 可见顺序直达 surface，`app.tsx` 快捷键 + `ChatView.panelSelectRequest` nonce 通道，折叠时自动展开）、pop-out ❌。
- **Phase 3 面板细化 — ◐ 持续**：Context（用量环+维护 ✅，跨会话切换 ❌）；Files（搜索+预览 ✅，二级 tabbar ❌；.md 预览渲染态默认 + 渲染/源码切换 + 预览头复制路径/默认应用打开 ✅ 2026-09-07）；Git/Diff/PR 合并为单一 `git` surface（子 tab：Changes/Commits/PR，视图内导航，rail 仍唯一导航轴）✅；Notes/Browser 单实例；Usage 浮动卡 ✅（composer 侧，非 openchamber 形态）；Pet 独立窗口 ✅；Agents 轨迹 ✅。配套（2026-09-07）：轮次折叠头聚合更改条「更改 N 文件 +A −R」+ 一键回退到轮起点（`round-collapse.ts` 聚合 edit/apply_patch diff 统计，ZCode 更改 chip parity）；终端 dock 标签按项目持久化（`musepi-gui-terminal-tabs-{cwd}`，重开恢复为全新 pty）。
- **结论**：核心改造主体已落地（分组/宽度/折叠），TabBar（作为第二导航轴）仍为架构否决项；surface 内多实例 tab 通用组件已落地（2026-09-15，`surface-tabs.tsx`；files surface 已接入），剩余为 Phase 3 面板级细化。实施下一批时更新本表。

---

## 1. 现状

### 布局

```
┌──────────────────────────────────────────────────────┐
│  [SessionSidebar]  [ChatView]  [ContextPanel] [44px] │
│                                               [rail] │
└──────────────────────────────────────────────────────┘
```

- **44px icon rail**（`RightRail.tsx`）：7 内置 surface + 扩展槽注入的 surface，共 **15+** 个图标
- **单面板**（`ContextPanel.tsx`）：所有 tool 视图共享一个面板区域，无多实例 tab
- **宽度范围**：200–560px，默认 300px
- **持久化**：全局顺序 + 每目录宽度，localStorage

### 内置 surface

| id | icon | 说明 |
|---|---|---|
| context | `pie-chart` | 上下文用量/配额 |
| files | `folder` | 文件浏览 |
| git | `git-branch` | Git 状态 |
| diff | `file` | Diff 对比 |
| pr | `git-pull-request` | PR 查看 |
| notes | `book-open` | 笔记 |
| browser | `global` | 内嵌浏览器 |

### 扩展 surface（扩展槽注入）

settings、sessions、mcp、roles、computer、updates、search、board、friend、usage、pet、chat-settings、scheduled-tasks、agents（轨迹）、trajectory 等

### 问题

1. **Rail 过载**：15+ 图标平铺在 44px 窄条，大量高频低频混排，扩展槽 surface 在 rail 上无区分层级
2. **无多实例 tab**：openchamber 的 file/chat/browser 各支持多 tab 水平切换，MusePi 只能单面板单内容（切换 surface 即切换整个面板内容）
3. **无显示模式**：bitfun 的 collapsed/compact/comfortable/expanded 四档 + snap points；MusePi 只有开/关
4. **无 pop-out**：bitfun 可将 tab 弹出到独立窗口
5. **无上下文 gating**：proma 仅在 agent 模式 + 有会话时显示面板；MusePi 恒显（即使无会话时 rail 仍占位）
6. **宽度范围偏窄**：200–560px 对比 openchamber 380–1400、bitfun 300–1200
7. **无面板分组**：proma 只有 3 个 tab（files/changes/chat），MusePi 15+ 平铺
8. **无拖拽分组**：bitfun 的 primary/secondary/tertiary group 三层 tab 调度

---

## 2. 参考对比

### 2.1 OpenChamber（最接近 MusePi 现状）

**架构**：registry-driven rail + panel split，与 MusePi 的 surface 注册表同构。

**关键模式**：
- **多实例 SortableTabsStrip**：file/chat/browser 模式支持水平可排序 tab 条，带动画 pill 指示器
- **px 宽度过渡**：CSS 自定义属性 `--oc-context-panel-width` + `transition-[width]`，resize 3px 拖柄
- **宽度范围**：380–1400px，每模式每目录手动宽度
- **悬浮 WorkStatusPanel**：不占 rail 的浮动面板，面板打开时自动隐藏
- **键盘切换**：按住 modifier 500ms 显示数字徽标 → 按数字切换
- **懒加载**：重型 surface 通过 `lazyWithChunkRecovery` 代码分割
- **响应式**：768px 以下转换为右侧 drawer，spring 动画

**可借鉴**：
- 多实例 tab strip（取代当前单面板模型）
- px 宽度 + CSS 过渡（平滑动画）
- 悬浮工作面板（减少 rail 拥挤）
- 键盘快捷切换（数字徽标）

### 2.2 BitFun

**架构**：ContentCanvas 复用组件，mode（agent/project/git/bottom-terminal）控制内容。

**关键模式**：
- **三组 tab**：primaryGroup（高频）/ secondaryGroup（中频）/ tertiaryGroup（低频），按组调度
- **显示模式**：collapsed → compact(300px) → comfortable(540px) → expanded(900px)，snap points
- **Pop-out**：tab 弹出到独立 PanelViewScene 窗口
- **自动展开/收起协调器**：`usePanelTabCoordinator` — tab 打开自动展开面板，清空自动收起
- **每 workspace 快照**：切换 workspace 时保存/恢复 canvas store
- **宽度范围**：0–1200px，SNAP_POINTS [300,400,540,700,900]

**可借鉴**：
- 显示模式 + snap points（取代连续宽度拖拽）
- 三组 tab 调度（解决 rail 过载）
- Pop-out 到独立窗口
- 自动展开/收起（减少手动操作）

### 2.3 Proma

**架构**：3 列 flex `[LeftSidebar][MainArea][RightSidePanel]`，仅 agent 模式 + 会话存在时显示。

**关键模式**：
- **紧凑 tab 分组**：只有 3 个 tab（files/changes/chat），不搞平铺 rail
- **上下文 gating**：仅 agent 模式 + 有会话时显示面板
- **文件二级 tabbar**：files tab 内嵌 session/project 切换
- **Preview/Scratch split**：在主区域右侧 split（不占 rail），可拖拽分割比
- **关闭动画**：absolute overlay + transform transition（避免布局跳动）
- **宽度范围**：300–560px，rAF 鼠标拖拽

**可借鉴**：
- 紧凑 tab 分组（3 个 tab 覆盖核心场景）
- 上下文 gating（减少无用 chrome）
- Preview/Scratch split（不占 rail 的预览区域）
- 关闭动画

### 2.4 OpenCode

**架构**：右面板 + 相邻文件树 sidebar，split pane 布局。

**关键模式**：
- **Split pane**：review panel + file tree 并列
- **底部 stacked terminal**：60% 视口高度 cap
- **预览 tab**：preview-before-commit 行为
- **tab 拖拽排序**：solid-dnd
- **桌面端 gated 可见性**

**可借鉴**：
- 拆分面板 + 相邻文件树
- 底部终端（非 rail surface）

---

## 3. 设计方案

### 3.1 总体架构（Phase 1 — 核心改造）

```
┌──────────────────────────────────────────────────────────┐
│  [SessionSidebar]  [ChatView]  [Panel] [26px] [52px]    │
│                                          [tab]  [rail]   │
└──────────────────────────────────────────────────────────┘
```

- **Rail 精简**：52px 宽（44px→52px，给图标+标签留空间），仅显示**高频 surface**（≤6 个）
- **新增 tab 条**：26px 水平 tab 条，列出当前 surface 类别下的具体 tab 实例（多实例 + 分组）
- **面板容器**：原 ContextPanel 扩展为支持多实例 + 多分组

### 3.2 Surface 分组（解决 rail 过载）

将当前 15+ surface 分为三组，参考 bitfun 的 primary/secondary/tertiary：

| 组 | 位置 | 包含 | 特征 |
|---|---|---|---|
| **Primary**（高频） | rail 显式图标 | context, files, git, notes, browser | 始终可见，图标+文字 |
| **Secondary**（中频） | rail 折叠菜单 / 扩展 icon | settings, sessions, mcp, roles, search, board, usage | 点开 rail 底部「...」展开 |
| **Tertiary**（低频） | 设置内 / 具体场景触发 | updates, pet, friend, chat-settings, computer, scheduled-tasks | 不占 rail，由具体操作触发 |

### 3.3 多实例 Tab 条（解决单面板内容切换）

参考 openchamber SortableTabsStrip + bitfun three-group：

- **Primary group tab 条**：26px 水平滚动 tab，每个 surface 可开 N 个实例（如同时打开 2 个文件 tab + 1 个浏览器 tab）
- **Tab 类型**：
  - `surface` tab（context/files/git 等）：单例，切换 surface 时替换
  - `instance` tab（文件/浏览器/聊天）：多实例，可拖拽排序
  - `preview` tab（临时文件预览）：自动关闭，不持久化
- **Tab 操作**：关闭（×）/ 拖拽排序 / 弹出为新窗口 / 固定

#### 3.3.1 边界修订（2026-09-15，实施回写）

原 3.3 把 `surface` tab（导航职责）和 `instance` tab（内容职责）放进**同一条** tab 条——这正是 Phase 1 被架构否决的根因：那会让面板头部出现第二导航轴。

修订后的边界（与 `RightRail.tsx:57`、`git-panel.tsx:807` 的既有注释一致）：

| 形态 | 职责 | 归属 | 状态 |
|---|---|---|---|
| rail 图标 | 切换 surface（导航轴，唯一） | `RightRail.tsx` | ✅ 已落地，**不变** |
| surface 内实例 tab 条 | 同一 surface 的多个实例（WorkBuddy 文档 tab / openchamber file tabs） | surface 组件内部 | ✅ 组件已落地并接入 files surface（`FilePane.tsx`）；notes/browser 待接入 |
| 视图内子 tab（Changes/Commits/PR） | 单实例内的视图切换 | `git-panel.tsx` `gui-pane-subtabs` | ✅ 已落地（既有先例） |

落地组件（`packages/desktop-app/src/components/surface-tabs.tsx`）：

- `SurfaceTabStrip`：水平可拖拽排序 + 关闭（含中键关闭）+ dirty 标记 + 溢出滚动 + 激活 tab 自动 `scrollIntoView`；roving tabindex + `role="tablist"/"tab"`，左右方向键切换（键盘拖拽走 dnd-kit KeyboardSensor）
- `useSurfaceTabs(storageKey)`：状态 + `localStorage` 持久化（key 约定 `musepi-gui-<surface>-tabs-{cwd}`，对齐终端 tabs 惯例）；序列化**只存标签不存内容**，带 `v1` schema 版本，未知版本/未知 id 丢弃而非误恢复
- `SurfaceTabPanels`：面板体渲染，**默认 keep-mounted**（`display:none` 隐藏，保光标/滚动/iframe 状态），`unmountIds` 显式列出可安全卸载的实例——终端/画布/文档都必须 keep-mounted

接入顺序建议：notes（同项目多笔记，低风险）→ files（多文件，需与 `openFileReq` 通道打通）→ browser。dnd-kit 传感器配置与 `RightRail.tsx:112` 保持一致（distance 8 / touch delay 200），复用 `@dnd-kit/*`（已在 desktop-app 依赖内，无新增包）。

### 3.3.2 架构决策修订（2026-09-15，**取代本节此前的「无第二 tab 条」否决**）

产品决策（作者拍板）：右侧面板升级为 **tab-primary 模型**——openchamber `ContextPanelMode` 形态（生产验证）：

- **一条面板级 tab 条承载全部已开视图**，异构共存：files / notes / browser / git / board / context…（Kimi Work 与 WorkBuddy 的实际形态）
- **rail 从「切换 surface」降级为「打开或聚焦该 surface 的 tab」**——快捷启动器，不再是排他导航轴
- **零 tab 空态**：显示导航页（Kimi「从这里开始」parity：浏览器 / 打开文件 / 看板 / 应用），由 rail 同款入口组成
- 旧否决的根因（surface tab 与 instance tab 混进同一条、形成第二导航轴）在 tab-primary 模型下**不再是问题**：tab 条就是导航本体，rail 不再承担排他切换职责

参考实现取证（openchamber `stores/useUIStore.ts`）：

- tab 描述符 `{ mode, targetPath?, dedupeKey?, label?, readOnly? }`，id 由 mode+target（或 dedupeKey）派生 → 天然去重
- **空占位 tab**：rail 可先开无 target 的 `file` tab；第一个真实文件打开时**替换**占位而非并存
- **`reveal:false` 后台注册**：agent 替用户打开页面时不抢焦点、不强制展开面板，tab 保持挂载待手动聚焦
- `CONTEXT_PANEL_MAX_TABS = 12` **按 mode 分配配额**；淘汰取该 mode 内 `touchedAt` 最老且非激活者；若只剩激活 tab 可牺牲，则宁超预算不丢正在看的
- 状态按目录分桶（`contextPanelByDirectory`），根数 clamp 20

已落地（本轮，零接线）：

- `packages/desktop-app/src/lib/panel-tabs.ts`：纯逻辑库——`panelTabId` / `upsertPanelTab`（含占位替换、reveal 语义、按 surface 配额淘汰）/ `closePanelTab(s)`（右邻优先）/ `serialize/restorePanelTabs`（v1，id 在恢复时重派生，dedupeKey 随行保留）
- `packages/desktop-app/src/components/panel-tabs-empty-state.tsx`：空态导航页（props 驱动，无 i18n/registry 耦合）
- `packages/desktop-app/test/panel-tabs.test.ts`：17 用例

**接线状态（2026-09-15，已落地核心）**：

1. ✅ `ChatView.activeView` 改为**从 `usePanelTabs` 派生**（activePanelTab.surface）；`setActiveView(x)` 语义不变但改为 `upsertPanelTab({surface:x})` —— 全部既有调用点（panelSelectRequest、agents、StatusCards、rail、BrowserGuiHint）零改动直通
2. ✅ `ContextPanel` 收 `panelTabs` prop，**`view` prop 已删除**（内部从 activePanelTab 派生，view/tab 不一致在类型上不可表达）；面板顶部渲染 tab 条（复用 `SurfaceTabStrip`）
3. ✅ 零 tab 空态挂载 `PanelTabsEmptyState`，入口 = registry primary + always surfaces
4. ✅ files surface 收敛：`FilePane` 改受控（`activeFile` / `onOpenFile`），文件实例 tab 由面板条承载，**无双层 tab**；`openRequest` 中继链 = `onViewChange("files")`（占位）→ FilePane 载入 → `onOpenFile(path)`（真实 tab 替换占位）
5. ⏳→✅ **extension `panel.tab.*` 槽迁移为 tab —— 由设计达成，无需迁移代码**：rail 的 ext 项 id 本就是 `ext:<slot>`（`RightRail.tsx:90`），tab-primary 后 `setActiveView("ext:<slot>")` 直接 upsert 成面板 tab；面板体的 `ext:` 分发分支（`ContextPanel.tsx`）按 view 渲染槽内容。rail 项保留 = 启动器角色，符合模型
6. ⏳→**有意例外（不改）**：**终端 dock tabs 不并入面板条**。取证：终端是 ChatView 的独立 dock（`ChatView.tsx` `<TerminalPanel>`），不在右面板 surface 体系内；每个内部 tab 拥有一条 daemon pty + xterm 实例，带 resize 观察者（隐藏 tab 0×0 跳过）与命令广播语义。强行并入 = 终端失去底部全宽 dock 的形态（UX 倒退）+ 需对 pty 生命周期做运行时验证。dock 内部 tab 条是承重结构，保留
7. ✅ tab 标签本地化：`setActiveView` 解析 registry display name / ext 槽 label，裸 surface id（如 `ext:settings`）不会出现在 tab 标题上

注意：面板初始为空（空态导航页），不再默认打开 context —— 这是 tab-primary 的预期行为。

**UI 修订（2026-09-15 晚，运行时反馈）**：

- **旧标题栏移除**：激活 tab 本身就是标题，标题栏成为重复。最大化按钮移入 tab 条右侧控制区，tab 条右侧加「+」按钮 —— 新建空白占位 tab（激活 surface 为 notes/browser 时开其占位，否则开 Files，其文件树即选择器）
- **最大化显示修复**：`.gui-pane-right--maximized` 原本同时声明 `left + width + right`（超约束，LTR 下 `right` 被忽略），且 width 取自 surface 矩形 —— 而 surface 矩形含外壳内边距，导致最大化面板右缘停在 surface 右边界，**右侧露出一条约 20px 的底下聊天列缝隙**（滚动条 + 头部按钮透出，用户报告的「显示有问题」）。修复：最大化时宽高直接顶到窗口右/下缘（`calc(100vw - --pane-max-left)` / `calc(100vh - --pane-max-top)`），left/top 仍取 surface 矩形，侧栏与聊天头部保持可见

### 3.4 显示模式（Phase 2 — 体验优化）

参考 bitfun 的 snap points + display mode：

| 模式 | 宽度 | 触发 | 行为 |
|---|---|---|---|
| collapsed | 0 | 快捷键 / 点击 rail 图标第二次 | 面板关闭，rail 保留 |
| compact | 300px | 面板打开 + 窄窗口 | 图标+文字紧凑，scroll |
| comfortable | 480px | 默认宽度 | 当前面板样式 |
| expanded | 800px | 拖拽超过舒适阈值 / 宽屏 | 富内容展示（如 PR 全宽 diff） |
| pop-out | 独立窗口 | 右键 tab → 弹出 | 独立 PanelViewScene |

### 3.5 面板内容改造（Phase 3 — 逐一优化）

#### 3.5.1 Context（上下文）— 当前

**现状**：`pie-chart` 图标，显示上下文用量圆环 + 配额。

**改造**：保持现状，增加：
- 单会话/跨会话切换
- 用量详情展开（类托盘面板）
- 上下文管理操作（清除/压缩）

#### 3.5.2 Files（文件）— 高度复用

**现状**：文件浏览 + 编辑。

**改造**：参考 proma，增加：
- 二级 tabbar：会话文件 / 项目文件 / 搜索结果
- 多实例 tab：同时打开多个文件
- 文件树上下一体：拖拽文件到聊天区域

#### 3.5.3 Git / Diff / PR — 合并或分组

**现状**：三个独立 surface。

**改造**：参考 openchamber，git 作为 rail 入口，切换时在 tab 条显示：
- Working tree（diff）
- Staged（diff）
- PR view
- Commit history

即 rail 一个「git」图标，tab 条展开 3-4 个子 tab。

**实现（0a51f37788 后）**：以 3 个子 tab 落地 —— Changes / Commit history / Pull requests；其中 Working tree 与 Staged 由 DiffPane 的合并视图（同屏分 staged/unstaged 两区 + stage/unstage 动作）覆盖，故不再拆两 tab。rail 只剩一个 `git` 图标（`registry.ts`），GitPanel（`ContextPanel.tsx`）是视图内导航，rail 仍是唯一导航轴。

#### 3.5.4 Notes（笔记）— 保持

**现状**：markdown 笔记编辑。

**改造**：增加多实例 tab（同时打开多篇笔记）。

#### 3.5.5 Browser（浏览器）— 保持

**现状**：内嵌 WebView 浏览器。

**改造**：多 tab 支持（当前是单例）。

#### 3.5.6 Settings（设置）— 不占 rail

**改造**：rail 不显示设置图标。设置由 `⌘,` 或菜单触发，打开为全窗口覆盖层（当前已是）。

#### 3.5.7 Sessions（会话列表）— 不占 rail

**改造**：rail 不显示会话列表。左栏已有 SessionSidebar。

#### 3.5.8 MCP / Roles / Computer — 合并入 Settings

**改造**：MCP、Roles、Computer 专注配置，移入 Settings 对应 tab。rail 不显示。

#### 3.5.9 Usage（用量）— 悬浮面板

**改造**：参考 openchamber WorkStatusPanel，用量作为悬浮卡片（非 rail surface），面板打开时自动隐藏。

#### 3.5.10 Pet（桌宠）— 独立窗口

**现状**：桌宠是独立窗口，不在 rail 中展示。保留。

#### 3.5.11 Agents（子智能体轨迹）— 保持

**现状**：`AgentsPanel` 在 ContextPanel 内，选中会话时显示。

**改造**：保持，增加 pop-out 到独立窗口选项。

### 3.6 上下文 Gating（Phase 2）

参考 proma 的模式：

- **无会话时**：rail 隐藏或仅显示 files/notes/browser
- **有会话时**：全面板
- **设置/全屏模式**：rail 自动隐藏（当前已实现 focus mode）

### 3.7 键盘快捷键（Phase 2）

参考 openchamber 数字徽标：

- 按住 `⌘` 或 `Ctrl` 键 500ms → rail 图标显示数字徽标（1-9）
- 按数字键切换对应 surface
- `⌘+E` 切换面板开/关
- `⌘+Shift+E` 切换面板展开/折叠

---

## 4. 实现路线

### Phase 1 — 核心改造（预计 2-3 天）

1. **Surface 分组**：registry 增加 `group` 字段（primary/secondary/tertiary）
2. **Rail 精简**：只渲染 primary group，secondary 放入折叠菜单
3. **Tab 条**：新增 `TabBar.tsx` 组件（26px 水平滚动 tab 条），接入 ContextPanel 上方
4. **多实例**：files/notes/browser 改为多实例模式（`useTabStore`）
5. **宽度扩展**：clamp 上限从 560 提升到 900（按窗口宽度动态）

### Phase 2 — 体验优化（预计 2-3 天）

6. **显示模式**：snap points [300, 480, 800]，拖拽吸附
7. **上下文 gating**：无会话时隐藏或缩减 rail
8. **键盘快捷键**：数字徽标 + 快捷键
9. **Pop-out**：tab 弹出到独立窗口（electron BrowserWindow）
10. **关闭动画**：panels 增加 absolute overlay 关闭过渡

### Phase 3 — 面板细化（持续）

11. 逐个 surface 内容优化（参考各参考项目）
12. Git/Diff/PR 合并为 git 组
13. Settings 从 rail 移除
14. Usage 改为悬浮卡片

---

## 5. 未决问题

1. **扩展槽兼容性**：当前 `panel.right` / `rail.right` 扩展槽注入的 surface 应归入哪个组？（默认 tertiary，由扩展声明 `group`）
2. **Tab 条高度**：26px 是否足够兼容 中文/英文 标签？可能需要 28px
3. **Pop-out 窗口**：Electron BrowserWindow 与 daemon RPC 的生命周期管理（关闭 pop-out 窗口时是否销毁 tab 状态）
4. **迁移策略**：现有用户 localStorage 中的 surface 顺序如何迁移到新分组模型
5. **i18n**：新增的 tab 分组/模式文案需要补充翻译

---

## 6. 参考对照表

| 特性 | 当前 | OpenChamber | BitFun | Proma | OpenCode | 目标 |
|---|---|---|---|---|---|---|
| Rail 图标数 | 15+ | 11 | — | 3 | — | ≤6 primary |
| 多实例 tab | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| 显示模式 | 开/关 | 开/关/展开 | 4 档 | 开/关 | 开/关 | 4 档 snap |
| 宽度范围 | 200-560 | 380-1400 | 0-1200 | 300-560 | 344+ | 0-900 |
| Pop-out | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ |
| 上下文 gating | 无 | 部分 | 有 | 有 | 有 | 有 |
| 分组调度 | 无 | 无 | 3 组 | 无 | 无 | 3 组 |
| 键盘切换 | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| 关闭动画 | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| 悬浮面板 | ✗ | ✓ | ✗ | ✗ | ✗ | ✓（usage） |
| 懒加载 | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |