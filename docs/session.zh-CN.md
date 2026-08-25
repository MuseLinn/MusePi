# Session 存储与 Entry 模型

[English](session.md) | 中文

本文档是 coding-agent session 的表示、持久化、迁移与运行时重建的唯一权威来源（source of truth）。

## 范围

涵盖：

- Session JSONL 格式与版本化
- Entry 分类体系与树语义（`id`/`parentId` + leaf 指针）
- 加载旧文件或损坏文件时的迁移/兼容行为
- Context 重建（`buildSessionContext`）
- 持久化保证、失败行为、截断/blob 外置
- 存储抽象（`FileSessionStorage`、`MemorySessionStorage`）及相关工具

不涵盖 `/tree` UI 渲染行为（仅涉及影响 session 数据的语义）。

## 实现文件

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — 编排：tree/leaf、append、持久化、blob、生命周期工厂
- [`src/session/session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts) — entry/header 类型、`SessionEntry` union、`CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../packages/coding-agent/src/session/session-migrations.ts) — 版本迁移
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — 文件加载 + blob-ref 解析
- [`src/session/session-context.ts`](../packages/coding-agent/src/session/session-context.ts) — `buildSessionContext`
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — 截断 + 图片 blob 外置
- [`src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts) — 磁盘布局、目录编码、terminal breadcrumb
- [`src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts) — 发现（list/recent/resolve）
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts) — 存储抽象
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) — custom-message transformer
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — 内容寻址 blob store
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) — prompt history（独立子系统）

## 磁盘布局

默认 session 文件位置：

```text
~/.musepi/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl```

`<encoded-cwd>` 由规范化后的 cwd 推导而来（因此 symlink 别名共享同一个 bucket）：home 下的目录为 `-<relative>`，临时根目录下的为 `-tmp-<relative>`，其他情况为 `--<encoded-absolute>--`，路径分隔符替换为 `-`。
访问时，由短命 hashed 方案（`<scope>-<project-basename>-<sha256(canonical-cwd)>`，用于 17.2.5-17.2.8 并在 17.2.9 由 #7397 回退）写入的 bucket 会尽力迁移回路径编码名称，同时一并处理 home 相对 bucket 更早的 `--<home-encoded>-*--` 写法。
Blob store 位置：

```text
~/.musepi/agent/blobs/<sha256>
```

Terminal breadcrumb 文件写入：

```text
~/.musepi/agent/terminal-sessions/<terminal-id>
```

Breadcrumb 内容为两行：原始 cwd，然后是 session 文件路径。`continueRecent()` 在扫描最近 mtime 之前优先使用该 terminal 范围的指针。

## 文件格式

Session 文件是 JSONL：每行一个 JSON 对象。

- 第 1 行永远是 session header（`type: "session"`）。
- 其余行是 `SessionEntry` 值。
- Entry 在运行时只追加；branch 导航移动的是指针（`leafId`），而不是修改既有 entry。

### Header（`SessionHeader`）

```json
{
  "type": "session",
  "version": 3,
  "id": "1f9d2a6b9c0d1234",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "parentSession": "optional lineage marker"
}
```

说明：

- `version` 在 v1 文件中可选；缺失即代表 v1。
- `parentSession` 是一个不透明的 lineage 字符串。当前代码根据流程不同会写入 session id 或 session path（`fork`、`forkFrom`、`createBranchedSession`，或显式 `newSession({ parentSession })`）。将其视为元数据即可，不是类型化外键。

### Entry 基类（`SessionEntryBase`）

所有非 header entry 均包含：

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

根 entry 的 `parentId` 可以为 `null`（首次 append，或 `resetLeaf()` 之后）。

## Entry 分类体系

`SessionEntry` 是以下类型的 union：

- `message`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `ttsr_injection`
- `session_init`
- `mode_change`

### `message`

直接存储一个 `AgentMessage`。

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "timestamp": 1760000000000
  }
}
```

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role` 可选；缺失时在 context 重建中视为 `default`。

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier` 是以 `openai`/`anthropic`/`google` 为键的 per-family 映射（每个值取 `auto`/`default`/`flex`/`scale`/`priority`），无激活 tier 时为 `null`。存储单个字符串的遗留 entry（`"flex"`、`"openai-only"`、`"claude-only"` 等）会在读取时归一化为该映射。

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

若从根分支（`branchFromId === null`），`fromId` 为字面字符串 `"root"`。

### `custom`

Extension 状态持久化；被 `buildSessionContext` 忽略。

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "my-extension",
  "data": { "state": 1 }
}
```

### `custom_message`

Extension 提供的消息，参与 LLM context。`content` 可以是字符串或 text/image content block，`attribution` 记录是由用户还是 agent 发起。

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined` 清除 `targetId` 上的 label。

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": "...",
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" },
  "spawns": "*",
  "readSummarize": false
}
```

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFile": "/tmp/plan.md" }
}
```

## 版本化与迁移

当前 session 版本：`3`。

### v1 -> v2

当 header `version` 缺失或 `< 2` 时应用：

- 为每个非 header entry 添加 `id` 和 `parentId`。
- 按文件顺序重建线性 parent 链。
- 迁移 compaction 字段 `firstKeptEntryIndex` -> `firstKeptEntryId`（存在时）。
- 设置 header `version = 2`。

### v2 -> v3

当 header `version < 3` 时应用：

- 对 `message` entry：将遗留的 `message.role === "hookMessage"` 重写为 `"custom"`。
- 设置 header `version = 3`。

### 迁移触发与持久化

- 迁移在 session 加载时运行（`setSessionFile`）。
- 若有任何迁移执行过，session 会被标记为需要完整重写（`#rewriteRequired`），而不是立即重写。
- 迁移先修改内存中的 entry；被标记的重写在下一次写入时持久化更新后的 JSONL（下一次 append 时同步完整重写）。

## 加载与兼容行为

`loadEntriesFromFile(path)` 行为：

- 文件缺失（`ENOENT`）-> 返回 `[]`。
- 无法解析的行由宽容 JSONL 解析器（`parseJsonlLenient`）处理。
- 若首个解析出的 entry 不是有效 session header（`type !== "session"` 或缺少 string 类型 `id`）-> 返回 `[]`。

`SessionManager.setSessionFile()` 行为：

- loader 返回 `[]` 视为空/不存在的 session，并在该路径替换为新的已初始化 session 文件。
- 有效文件会被加载、按需迁移、解析 blob ref，然后建立索引。

## 树与 Leaf 语义

底层模型是 append-only tree + 可变 leaf 指针：

- 每个 append 方法恰好创建一个新 entry，其 `parentId` 为当前 `leafId`。
- 新 entry 成为新的 `leafId`。
- `branch(entryId)` 只移动 `leafId`；既有 entry 保持不变。
- `resetLeaf()` 将 `leafId` 置为 `null`；下一次 append 创建新的根 entry（`parentId: null`）。
- `branchWithSummary()` 将 leaf 设为 branch 目标并追加一条 `branch_summary` entry。

`getEntries()` 按插入顺序返回所有非 header entry。正常操作中不会删除既有 entry；重写在保留逻辑历史的同时更新表示形式（迁移、move、定向重写 helper）。

## Context 重建（`buildSessionContext`）

`buildSessionContext(entries, leafId?, byId?, options?)` 决定发送给模型的内容。传入 `options.transcript: true` 则改为构建全历史展示 transcript（compaction 内联在其触发位置输出）——仅用于展示，绝不发送给 provider。

算法：

1. 确定 leaf：
   - `leafId === null` -> 返回空 context。
   - 显式 `leafId` -> 找到则使用该 entry。
   - 否则回退到最后一个 entry。
2. 从 leaf 沿 `parentId` 链走到根，再反转为 root->leaf 路径。
3. 沿路径推导运行时状态：
   - `thinkingLevel` 取最新 `thinking_level_change`（默认 `"off"`）
   - `serviceTier` 取最新 `service_tier_change`
   - model map 由 `model_change` entry 构建（`role ?? "default"`）
   - 无显式 model change 时，从 assistant message 的 provider/model 回退得到 `models.default`
   - 从所有 `ttsr_injection` entry 收集去重后的 `injectedTtsrRules`
   - mode/modeData 取最新 `mode_change`（默认 mode `"none"`）
4. 构建 message 列表：
   - `message` entry 直接透传
   - `custom_message` entry 经 `createCustomMessage` 变为 `custom` AgentMessage
   - `branch_summary` entry 经 `createBranchSummaryMessage` 变为 `branchSummary` AgentMessage
   - 若路径上存在 `compaction`：
     - 先输出 compaction summary（`createCompactionSummaryMessage`）
     - 输出从 `firstKeptEntryId` 开始到 compaction 边界为止的路径 entry
     - 输出 compaction 边界之后的 entry

`custom`、`session_init`、`service_tier_change` 和 `ttsr_injection` entry 不直接注入模型 context。

## Daemon 暂停状态（独立于 session 文件）

Daemon 的 per-session 暂停门控（`AgentPauseGate`）是 host 层状态，
**不是** session 事件流或 transcript 文件的一部分。它会镜像到
sidecar `<journal>/<sessionId>.pause.json`（daemon `JOURNAL_DIR`，存在即暂停），
并在 idle 归档（>30min）后或 daemon 重启后重新激活 session 时恢复——暂停的
session 在休眠/重启后保持暂停。删除 session 同时也会删除 sidecar。
进程级全局暂停（`daemon.pause`，与 TUI `/pause` 对等）刻意只在内存中保存，
不会在 daemon 重启后存活。RPC 契约见 `gui-implementation.md` §1c。

## 持久化保证与失败模型

### 持久化 vs 内存

- `SessionManager.create/open/continueRecent/forkFrom` -> 持久化模式（`persist = true`）。
- `SessionManager.inMemory` -> 非持久化模式（`persist = false`），使用 `MemorySessionStorage`。

### 写入管线

Append 通过 `SessionStorageWriter`（来自 `storage.openWriter`）在函数体内同步写出，因此 append 返回的那一刻 entry 即已持久化。异步磁盘操作（flush、close、原子重写）通过内部 promise 链（`#diskTail`)串行化；append 不经过它。

- `append*` 立即更新内存状态。
- 持久化延迟到至少存在一条 assistant message。
  - 首条 assistant 之前：entry 保留在内存中；不发生文件 append。
  - 出现首条 assistant 时：内存中的完整 session flush 到文件。
  - 之后：新 entry 增量追加。

代码中的理由：避免持久化从未产生 assistant 回复的 session。

### 耐久性操作

- `flush()` 清空异步磁盘链和打开 writer 的排队 append（无 `fsync`）；`flushSync()` 为无法 await 的退出路径执行同步完整重写。
- 原子完整重写（`#rewriteAtomically`）委托给 `storage.writeTextAtomic`：先写临时文件再 rename 覆盖目标（带 EPERM 安全的 move-aside 回退）。
- 用于 `setSessionName`、`rewriteEntries`（tool-output 裁剪/取代 pass）以及 move/fork 操作。加载期迁移和其他内存分歧（`#rewriteRequired`）则在下一次持久化时触发同步完整重写（`#rewriteSynchronously`）。

### 错误行为

- 持久化错误会被锁存（`#diskFailure`）并在后续操作中重新抛出。
- 首个错误附带 session 文件上下文记录一次日志。
- writer close 尽力而为，但会传播首个有意义的错误。

## 数据体积控制与 Blob 外置

在持久化 entry 之前：

- 大字符串截断到 `MAX_PERSIST_CHARS`（500,000 字符）并附提示：
  - `"[Session persistence truncated large content]"`
- 移除瞬态字段 `partialJson` 和 `jsonlEvents`。
- 若对象同时具有 `content` 和 `lineCount`，截断后重新计算行数。
- `content` 数组中 base64 长度 >= 1024 的 image block 外置为 blob ref：
  - 存储为 `blob:sha256:<hash>`
  - 原始字节写入 blob store（`BlobStore.put`）

加载时，blob ref 会为 message/custom_message 的 image block 解析回 base64。

## 存储抽象

`SessionStorage` 接口提供 `SessionManager` 用到的全部文件系统操作：

- sync：`ensureDirSync`、`existsSync`、`writeTextSync`、`statSync`、`listFilesSync`
- async：`exists`、`readText`、`readTextSlices`、`writeText`、`writeTextAtomic`、`rename`、`unlink`、`deleteSessionWithArtifacts`、`openWriter`

实现：

- `FileSessionStorage`：真实文件系统（Bun + node fs）
- `MemorySessionStorage`：map 支撑的内存实现，用于测试/非持久化 session

`SessionStorageWriter` 暴露 `append`、`flush`、`isOpen`、`close`、`getError`。

## Session 发现工具

发现 helper 位于 `session-listing.ts`；`SessionManager` 以薄静态包装的形式重新暴露项目范围的列表：

- `getRecentSessions(sessionDir, limit?)` -> 面向 UI/session picker 的轻量元数据，受 `limit` 上限约束（默认 4）
- `findMostRecentSession(sessionDir)` -> 按 mtime 最新的 session
- `listSessions(sessionDir, storage)`（即 `SessionManager.list(cwd, sessionDir?)`）-> 单个项目范围内的 session
- `listAllSessions(storage)`（即 `SessionManager.listAll()`）-> `~/.musepi/agent/sessions` 下所有项目范围的 session
- `resolveResumableSession(sessionArg, cwd, sessionDir?)` -> 先本地后全局的 resume/fork 目标查找

`getRecentSessions` 的元数据提取通过 `readTextSlices(..., 4096, 0)` 读取前缀。`listSessions`/`listAllSessions` 对每个文件用一次 `readTextSlices(...)` 调用读取 4KB 前缀加有界的 32 KiB 尾部，前缀用于元数据，尾部用于生命周期状态。Resume 匹配不区分大小写，接受 session id 前缀、完整文件名前缀，或 `<timestamp>_<sessionId>.jsonl` 中时间戳之后的 id 后缀。

## 相关但不同：Prompt History 存储

`HistoryStorage`（`history-storage.ts`）是独立的 SQLite 子系统，用于 prompt 回溯/搜索，而非 session 回放。

- DB：`~/.musepi/agent/history.db`
- 表：`history(id, prompt, created_at, cwd, session_id)`
- FTS5 索引：`history_fts`，由 trigger 维护同步
- 通过内存中的 last-prompt 缓存对连续相同 prompt 去重
- 插入经异步 drain 队列批量执行（约 100 ms 延迟），使 prompt 捕获不阻塞 turn 执行

session 文件用于对话图/状态回放；prompt history UX 使用 `HistoryStorage`。
