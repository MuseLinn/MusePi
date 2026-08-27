# 右侧面板改造方案

> 对比分析 openchamber / proma / bitfun / opencode 后，对 MusePi 右侧面板的重新设计。

- **日期**: 2026-08-24
- **状态**: 草案（部分已落地，2026-08-25 核对）
- **参考**: `gui-design.md`（既有布局规范）、`gui-implementation.md`（实现笔记）

---

## 0. 实现状态（2026-08-25 核对）

> 核对方法：逐项 vs `packages/gui/src/`。

- **Phase 1 核心改造 — ◐**：registry `group` 字段 ✅（`surfaces/registry.ts:27-57`）；Rail 分组+溢出折叠 ✅（`RightRail.tsx:96-261`，但保持 44px 纯图标、secondary 不折叠，作者偏好）；宽度 260–1200 ✅（超出规格，`ContextPanel.tsx:229-244`）+ maximize。**TabBar 第二 tab 条 ❌ — 已架构否决**（`ContextPanel.tsx:283-284`、`RightRail.tsx:42-44`："rail is the single navigation axis — no second tab row"）；多实例 tab ❌。
- **Phase 2 体验优化 — ◐**：⌘E 面板开关 ✅、⌘⇧E=focus mode ✅（语义与文档不同，属设计漂移）；关闭动画 ✅（220ms 宽度折叠，非 proma overlay）。snap points ✅（`ContextPanel.tsx:247` `SNAP_POINTS=[300,480,800]`，释放吸附，0a51f37788）、上下文 gating ❌、Mod+1..9 ❌、pop-out ❌。
- **Phase 3 面板细化 — ◐ 持续**：Context（用量环+维护 ✅，跨会话切换 ❌）；Files（搜索+预览 ✅，二级 tabbar ❌）；Git/Diff/PR 合并为单一 `git` surface（子 tab：Changes/Commits/PR，视图内导航，rail 仍唯一导航轴）✅；Notes/Browser 单实例；Usage 浮动卡 ✅（composer 侧，非 openchamber 形态）；Pet 独立窗口 ✅；Agents 轨迹 ✅。
- **结论**：核心改造主体已落地（分组/宽度/折叠），TabBar 与多实例为架构否决项，剩余为 Phase 3 面板级细化。实施下一批时更新本表。

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