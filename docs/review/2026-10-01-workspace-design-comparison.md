# 工作区 / 项目列表设计对比调研（dsh · openchamber · zcode → MusePi）

> 状态：调研完成，结论待立项。来源：deepseek-harness（dsh 0.2.0-rc.x）、openchamber 本地源码、zcode（本地仅有 CLI 包，GUI 无源码可考）。

## 一、各家怎么做

### dsh（deepseek-harness）

- **Workspace 是一等实体**：`WorkspaceRuntime`（`packages/client/runtime/lib/types/client/workspaces/service.d.ts`）投影 Host 侧 Workspace 对象管理器，列表带 `idle/loading/error` 状态机与 `baselinesReady`（workspace.list + session.list 双基线就绪才允许首帧渲染，避免闪烁重排）。
- **归档语义**：`archivedSessionIds`——分组面（workspace 组、未分组桶）隐藏这些会话，但**会话日志与工作区计数保留**；归档不是删除。
- **最近工作区**：`recentWorkspaceId` 从列表**派生**（按最近活动），不改变 items 顺序。
- **空白会话复用**：`connectWorkspace` 先复用该 workspace 已有的 blank session，没有再创建；按 workspace 做 inflight 合并防双击重复创建。
- **目录浏览创建**：`DirectoryBrowseError` / `DirectoryListing`——新建 workspace 时走 Host 目录浏览器选文件夹，区分 Host 业务错误码。
- **创建失败结构化**：`WorkspaceCreateError` 包装 `RpcError`，UI 按业务码分支提示。

### openchamber

- **会话自带结构元数据**：session 对象上有 `directory` / `parentID` / `project.worktree` 字段，`globalSessionStructure.ts` 把全局会话集索引成 `activeChildrenByParentId` + `activeIdsByDirectory` 两个 Map——侧栏**同时按目录分组和父子层级**两维组织，纯派生、无第二存储。
- **目录冲突兜底**：`mergeSessionDirectoryMetadata` 合并 incoming/existing 的 directory/worktree 元数据，路径归一化（`normalizePath`）防同一目录两种写法分裂成两组。
- **操作集**：ArchiveAll（一键归档当前目录全部）、DirectoryExplorerDialog（目录浏览）、SaveProjectPlanDialog（项目计划落盘）、NewWorktreeDialog（worktree 即 workspace）。
- **mini chat**：任意会话行（含子代理）右键开独立小窗渲染完整聊天容器。

### zcode

- 本地仓库只有 `zcode-cli`，GUI 客户端源码不在本地，无法引用。其 CLI 侧的会话组织无独立 workspace 概念，按 cwd 直挂。

## 二、我们的现状与差距

当前实现：会话落盘 `<agentDir>/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`；**无 workspace 实体**，项目列表 = 扫 slug 目录去重；子代理嵌套靠 history 扫描推导 parentId；无归档。

| # | 差距 | 后果 | 参考 |
|---|------|------|------|
| 1 | 空 slug 目录残留 | 删掉全部会话后项目列表仍显示该工作区（本次手动清了 11 个；`-Downloads-0902` 这类空壳就是这么来的） | dsh workspace 显式实体 |
| 2 | 无归档语义 | 旧项目只能删会话，侧栏越来越长 | dsh `archivedSessionIds`（隐藏但保留日志） |
| 3 | 无「浏览选文件夹」入口 | 想预热一个不常去的项目只能先 cd 过去起 CLI | dsh DirectoryListing |
| 4 | 临时/测试 cwd 直接污染列表 | `daemon-viewkey-*` 等测试工作区曾刷屏（测试已隔离，属历史存量） | dsh 目录浏览 + Host 校验 |
| 5 | 项目列表无加载状态机 | 首次渲染与扫描竞态，可能出现空列表闪烁 | dsh `baselinesReady` |
| 6 | 同一 cwd 多种写法可能分裂 | 符号链接/大小写/尾斜杠造成两个 slug | openchamber `normalizePath` |

## 三、建议（按性价比排序）

1. **空目录惰性清理**（小）：项目列表构建时跳过「无 jsonl 且 mtime 早于 N 天」的 slug 目录；或启动时清空空 slug。立即消掉 #1。
2. **slug 归一化**（小）：生成 slug 前解析符号链接 + 统一大小写（Windows）。消 #6。
3. **归档**（中）：view store 加 `archived` 标 + 侧栏「已归档」分组/过滤，右键归档/取消归档；日志不动。消 #2。
4. **目录浏览添加项目**（中）：daemon 加 `fs.browse` 只读 RPC（分页列目录），GUI 项目列表加「打开文件夹」。消 #3。
5. **workspace 实体化**（大， roadmap 级）：对齐 dsh 的 Workspace 一等实体 + 双基线状态机 + blank session 复用。消 #1/#5 的根，但动存储布局，建议随会话存储改造单独立项。
