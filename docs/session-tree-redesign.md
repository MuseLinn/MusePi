# 会话树节点控制与显示：调研分析与重构计划 v2

## 更新日志
- 2026-08-24 v2：纳入 OMP TUI 分支语义调研 + 三层 Canvas 设计 + 文件操作分析

---

## 一、三个 Bug 的根因分析

### Bug 1: 用户消息撤回有概率把之前的也消掉看不到

**根因：`journal.truncate(-1)` 清空全部 journal（`truncateSession` 中 journal 扫描命中失败）**

`truncateSession` 的 journal 扫描：
```ts
for (const record of await journal.readAll()) {
  const ev = record.event as {...};
  if (ev?.type === "message_start" && ev.message?.role === m[1] &&
      String(ev.message?.timestamp) === m[2]) {
    target = record.seq - 1;  // 保持到 message_start 之前
  }
}
// 未命中 → target = -1（初始值不变）
await journal.truncate(target);  // target = -1 → keep seq <= -1 → 0 条记录!
```

`journal.truncate(-1)` 保持条件 `record.seq <= target` → `seq <= -1` → **0 条** → journal 清空 → `replaySource()` 空 → `MaterializedView.replay(sessionId, cwd, [])` → **空视图** → 所有消息消失。

**触发条件（概率性）**：
1. Compaction 折叠：`message_start` 被折叠进 checkpoint → journal 直读 miss → `target = -1`
2. Checkpoint 路径：`snap.entries.findIndex(e => e.id === messageId)` 中 checkpoint entry 的 id 格式（SDK hex）与 GUI 发送的 view key（`role:timestamp`）不匹配 → `idx = -1` → `return -1`
3. SDK `revertTo` 的 `sdkMessageIndex` 兜底匹配 timestamp，SDK 内部重排后可能 miss → `index = -1` → `return null` → daemon 降级到 view-only truncation

**修复**：`truncateSession` journal 扫描失败时不应 `truncate(-1)`，需加 guards + checkpoint 路径 id 格式兼容。

### Bug 2: Agent 底部重试 ≠ 重新发送用户消息

**两个问题**：
1. `retryTargets` 线性扫描在分支会话中失效（指向错误父节点）
2. `retryFromUserMessage` = `revertTo`（截断）+ `onSend`——当 Bug 1 清空会话后，重发落在空会话里

**TUI 的做法**（关键）：
- TUI `/tree` 选择器用 `navigateTree(targetId)`：**同会话内 in-place 叶移动**（`sessionManager.branch(newLeafId)`）
- 旧分支保留在树上（作为父节点的另一个子节点），新回复成为兄弟分支
- 不是 `revertTo`（不截断）、不是 `forkAt`（不新建会话）
- GUI 当前既没有 `branch` 原语也没有 `navigateTree` parity RPC

### Bug 3: 有概率丢失消息显示

**根因**：与 Bug 1 同源——`journal.truncate(-1)` 清空后 reload 看到空会话。

---

## 二、OMP TUI 分支语义调研（针对用户问题）

### 用户问："对于会话中的文件操作如何处理呢？TUI的做法是什么"

**结论：TUI 分支不隔离文件系统，工作区全局共享。**

TUI 分支切换的完整流程：
```
navigateTree(targetId) →
  1. #bash.flushPending()              // flush 挂起的 bash/写操作
  2. beginSessionTransition()           // bash 层过渡标记
  3. if (user 节点) → 新叶 = parentId   // 回填用户文本到编辑器
     if (assistant 节点) → 新叶 = targetId  // 落在此节点继续
  4. branch(newLeafId)                  // 切 leaf（同会话内）
  5. markSessionTransition()            // bash 层确认过渡
  6. replaceMessages()                  // 重建 agent 上下文
  7. agent 新消息 → appendMessageToBranch → 成为新子节点
```

**文件操作行为**：
- 分支切换 **不回滚文件**——分支 A 写的文件在分支 B 仍然存在（同一工作目录）
- `flushPending()` 确保挂起的写操作在分支切换前完成（不丢失）
- `beginSessionTransition`/`markSessionTransition` 防止跨分支工具状态串扰
- 没有 per-branch 文件快照、没有文件回滚、没有 git stash

**两种分支模型对比**：

| 模型 | API | 范围 | 文件系统 | 适用场景 |
|---|---|---|---|---|
| In-place 叶移动 | `sessionManager.branch(id)` | 同会话树 | 共享 | retry、/tree 重选、继续 |
| 新会话分支 | `createBranchedSession(id)` | 新会话文件 | 共享（同一 cwd） | forkAt、明确分叉 |


### 对 GUI 的语义映射

| TUI 操作 | GUI 当前映射 | 需改动 |
|---|---|---|
| `navigateTree(userMsg)` → re-answer | `revertTo`（截断） | **新增 `session.branchAt` RPC**（同会话叶移动，不截断） |
| `navigateTree(assistantMsg)` → 继续 | `forkAt`（新会话） | 可复用 forkAt 或新增 branchAt |
| 树上分支可视化 | 仅 MessageTree 浮动面板 | 三层 Canvas |
| 文件状态 | 共享 cwd（同 TUI） | 无需改动，但 UI 应提示"分支共享文件系统" |

---

## 三、设计建议

### 三层布局（用户确认）

```
┌──────────────────────────────────────────────────────────────┐
│  Chat  │  Canvas  ●                                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─── 第一层：时间线主路径 ───────────────────────────────┐  │
│  │  user: "优化查询性能"  ──→ 当前路径，沉浸式               │  │
│  │  assistant: 分析结果                                │  │
│  │  ── 此节点有 3 个分支 ──  ← 多子节点分支横条            │  │
│  │  toolResult: 工具调用结果       │  ← 当前子路径继续      │  │
│  │  assistant: 方案A深度调优                               │  │
│  │                                                          │  │
│  │  [面包屑] 根 > 优化查询 > 工具调用 > 方案A > 深度调优    │  │
│  │  ↑ 点击任意段快速 /tree 跳转                             │  │
│  │                                                          │  │
│  │  [输入框] 将从"方案A"创建新分支 → 发送后形成兄弟分支     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─── 第二层：右侧轨迹 + 悬浮卡片 ─────────────────────────┐  │
│  │  TrajectoryView 增加 Tree 模式：折叠/展开树节点        │  │
│  │  - 分支点（多子节点）样式图标 + 子节点数量角标           │  │
│  │  - 当前叶子脉冲点阵 / 背景高亮                           │  │
│  │  - 右下角 MessageTree 悬浮卡片增强（同 Tree 模式视图）   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─── 第三层：dagre 地图视图（独立 tab 等宽）──────────────┐  │
│  │  回答：我在树的哪个深度？附近有哪些活跃分支？            │  │
│  │  哪条分支最长/最近有更新？                               │  │
│  │  自动分层布局，分支并排，连线清晰                         │  │
│  │  缩放/平移/拖拽，节点操作同上（fork/revert/continue）    │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 第一层：时间线主路径（主聊天区）

**原则**：保持沉浸式线性阅读，只渲染当前路径完整消息。

**分支横条**：在每个有多个子节点的消息下方插入细横条：
```
── 此节点有 3 个分支 ──
```
点击展开快速切换分支（同级兄弟节点列表）。

**侧边颜色标识**：非当前分支的节点在消息左侧用不同颜色标识（如灰色竖线标记"这是历史分支"）。

**面包屑**：输入框上方显示路径摘要：
```
根 > 优化查询 > 工具调用 > 方案A > 深度调优
```
- 每段可点击 → 跳转到对应节点（/tree 语义）
- 根据父节点链从 `buildMessageTree` 实时构建

**输入框提示**：
- 当前在叶子节点：正常输入 → 追加子节点
- 当前在历史节点（非叶子）：显示提示
  ```
  将从「优化查询」创建新分支，发送后该历史节点会新增一个子节点，形成兄弟分支
  ```
- 用户明确知道"我这条消息挂在哪个父节点下"

### 第二层：轨迹 + 悬浮卡片

**TrajectoryView 树模式**：现有 Timeline/Tree 切换按钮
- Tree 模式复用 `buildMessageTree` 渲染缩略树
- 折叠/展开节点，支持虚拟滚动
- 分支点（多子节点）样式图标 + 角标数字
- 当前叶子脉冲点阵或背景高亮
- 点击节点操作：跳转 transcript / fork / revert / 继续

**MessageTree 浮动面板增强**：同上树模式，但自适应尺寸

### 第三层：dagre 地图视图

**独立 tab**（与 Chat 同级，在顶部分组标签中切换）

**功能**：
- 回答定位问题：我在树的哪个深度？当前路径附近有哪些活跃分支？哪条分支最长/最近有更新？
- dagre 自动分层布局
- 缩放/平移/拖拽
- 节点操作：fork / revert / 继续 / 跳转 transcript
- 当前路径高亮，分支用不同颜色

### 性能策略

| 策略 | 实现 |
|---|---|
| 虚拟化滚动 | 第一层（时间线）用现有虚拟列表；第二层（树面板）用 `react-window` 或自定义虚拟树 |
| 默认折叠非当前分支 | 第二/三层初始只展开当前路径，其他分支折叠 |
| 懒加载分支 | 点击展开分支时再加载该分支的详细节点 |
| 骨架屏 | 打开会话先渲染骨架（`sessionLoading` 已有），再增量同步 |
| 本地缓存 | 复用 TUI 的树拓扑缓存在 indexeddb 中（`session.tree` 返回的完整树结构），增量更新 |
| 增量同步 | 打开会话后后台拉取 `session.tree`，与已有缓存 diff 更新 |

---

## 四、实施计划

### Phase 0: 新增 RPC：`session.branchAt`（P0，2 天） （**已完成**：`b6d31253a1`）

**目的**：GUI retry 和树导航需要 TUI `navigateTree` 同款 in-place 叶移动，而不是截断或 fork 新会话。

**RPC 签名**：
```ts
session.branchAt({ sessionId, messageId, includeTarget? = false })
// 返回: { ok: true, leafId: string }  // 新 leaf 位置
```

**实现**：
- `packages/coding-agent/src/daemon/server.ts`：新增 `case "session.branchAt"`
- 调 `live.agentSession.navigateTree(messageId)`（AgentSession 已有此方法）
- 返回 `session.tree` 刷新后的状态

**验证**：daemon 单元测试（mocked live session）+ bun test

### Phase 1: Bug 修复（P0，1 天） （**已完成**：`e23abadc70` + `8049b5b28f`）

**Step 1: `journal.truncate(-1)` guard**（~1 文件，2 小时）
- `server.ts` `truncateSession`：`target < 0` 时 return error 而非 truncate
- `journal.truncate` 加负值保护

**Step 2: Checkpoint 路径 id 格式兼容**（~1 文件，30 分钟）
- `truncateSession` checkpoint 路径的 `findIndex` 增加 `messageKey` 匹配

**Step 3: 修复 retryTargets 树感知**（~2 文件，2 小时）
- `Transcript.tsx`：`retryTargets` 改用 `buildMessageTree` 查找 direct parent
- `ChatView.tsx`：retry 按钮改为调 `session.branchAt` + 回填文本 + `onSend`（不截断）

### Phase 2: 第一层——时间线主路径（P0，3 天） （**已完成**：`b6d31253a1`）

**Step 4: 分支横条**（`packages/gui/src/components/Transcript.tsx`）
- 检测每个消息的子节点数量（`buildMessageTree` 结果）
- 多子节点时插入 `<BranchBar count={n} siblings={nodes} onSwitch={openBranch} />`
- 点击展开兄弟节点列表，点击切换分支

**Step 5: 面包屑**（ChatView 上部）
- 从 `buildMessageTree` 构建当前路径链
- 渲染为 `<Breadcrumb path={[{id, label}]} onJump={scrollToEntry} />`
- 每段可点击 → `scrollToEntry` 对应消息

**Step 6: 输入框分支提示**
- 检测当前 leaf 是否为历史节点（leaf 不是树中最后一个子节点）
- 显示提示文案 + 确认

### Phase 3: 第二层——轨迹 + 树面板（P1，2 天） （**已完成**：`6a2a8a69ab`）

**Step 7: TrajectoryView 树模式**（`TrajectoryView.tsx`）
- 加切换按钮 `Timeline | Tree`
- Tree 模式用 `buildMessageTree` + 虚拟列表
- 分支点样式 + 角标 + 当前叶子高亮

**Step 8: MessageTree 增强**（`MessageTree.tsx`）
- 同步 TrajectoryView 树模式的视觉改进

### Phase 4: 第三层——dagre 地图视图（P1，3 天） （**已完成**：`825b4ab8a0`，零 dagre 依赖手写分层布局）

**Step 9: SessionTreeCanvas**（新组件 `SessionTreeCanvas.tsx`）
- dagre 自动布局 + 缩放/平移 (react-flow / custom)
- 卡片节点 + 连接线 + 操作栏
- ChatView 顶部加 `Chat | Canvas` 切换

### Phase 5: 性能（P2，1 天） （**部分完成**：默认折叠非当前分支 ✓；indexeddb 缓存跳过（见更新日志））

**Step 10: 虚拟化 + 懒加载 + 缓存**
- 第二/三层树面板虚拟化滚动
- 非当前路径分支默认折叠，点击展开时 lazy load
- 骨架屏 + 增量同步
- 会话树拓扑 indexeddb 缓存（复用 TUI 方案）

### Phase 6: 验证（P2，2 天） （**部分完成**：组件级视觉冒烟通过；完整 GUI 隔离测试链路待后续）

**Step 11: E2E 自动测试**
- 隔离 daemon + headless Electron
- 回归：revert / retry / 消息显示 / 树导航 / 分支切换
- 现有 48 gui 测试 + session-store 测试

---

## 五、风险与权衡

| 风险 | 缓解 |
|---|---|
| `session.branchAt` 新增 RPC 与已有 `session.forkAt` 语义重叠 | branchAt = in-place 叶移动，forkAt = 新会话复制——互不重叠 |
| dagre 布局在大树（~100 节点）上性能 | 虚拟化 + 折叠懒加载 + 只渲染展开分支 |
| 面包屑长度（路径深） | 截断到 5 段 + "...更多" |
| 文件共享（分支不隔离）的认知负担 | UI 提示"分支共享工作区，文件修改不会随分支切换回滚" |
| 跨分支切换时工具状态串扰 | 复用 TUI 的 bash transition + flushPending 机制 |