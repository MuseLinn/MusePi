# Blob 与 artifact 存储架构

[English](blob-artifact-architecture.md) | 中文

本文档描述 coding-agent 如何将大体积/二进制载荷存储在 session JSONL 之外、截断后的工具输出如何持久化，以及内部 URL（`artifact://`、`agent://`）如何解析回已存储数据。

## 为什么存在两套存储系统

运行时针对不同数据形状使用两套不同的持久化机制：

- **按内容寻址的 blob**（`blob:sha256:<hash>`）：全局存储，用于将大体积图片 base64 载荷和 provider 图片 data URL 从持久化的 session 条目中外部化。
- **Session 级 artifact**（位于 `<sessionFile-without-.jsonl>/` 下的文件）：per-session 文本文件，用于完整工具输出和子代理输出。

两者被刻意分开：

- blob 存储通过内容哈希优化去重和稳定引用，
- artifact 存储通过本地 ID 优化 append-only session 工具链以及人工/工具检索。

## 存储边界与磁盘布局

### Blob 存储边界（全局）

`SessionManager` 构造 `BlobStore(getBlobsDir())`，因此 blob 文件存放在共享全局 blob 目录，而不是 session 文件夹内。

Blob 文件命名：

- 文件路径：`<blobsDir>/<sha256-hex>`
- 规范文件没有扩展名；当提供了扩展名（图片 MIME 类型）时，会在其旁硬链接（或复制）一个带类型的 sidecar `<sha256-hex>.<ext>`，以便操作系统按类型识别
- 条目中存储的引用字符串：`blob:sha256:<sha256-hex>`

影响：

- 跨 session 的相同二进制内容解析为相同的 hash/path，
- 写入在内容层面是幂等的，
- blob 可以比任何单个 session 文件活得更久。

### Artifact 边界（session-local）

`ArtifactManager` 从 session 文件路径派生 artifact 目录：

- session 文件：`.../<timestamp>_<sessionId>.jsonl`
- artifacts 目录：`.../<timestamp>_<sessionId>/`（去掉 `.jsonl`）

Artifact 类型共享此目录：

- 截断的工具输出文件：`<numericId>.<toolType>.log`（用于 `artifact://`）
- 子代理输出文件：`<outputId>.md`（用于 `agent://`）
- 子代理 session JSONL sidecar：当 task execution 接收到 artifacts 目录时生成 `<outputId>.jsonl`

子代理可以复用父级 `ArtifactManager`；这种情况下父级与子代理树共享一个 artifact 目录和数字 artifact ID 空间。

## ID 与名称分配方案

### Blob ID：内容哈希

`BlobStore.put()` / `putSync()` 对其接收到的字节计算 SHA-256，并返回：

- `hash`：十六进制摘要，
- `path`：`<blobsDir>/<hash>`，
- `displayPath`：提供了扩展名时为 `<blobsDir>/<hash>.<ext>`，否则为规范路径，
- `ref`：`blob:sha256:<hash>`。

不使用 session-local 计数器。

### Artifact ID：session-local 单调整数

`ArtifactManager` 在首次目录支持的分配时扫描现有 `*.log` artifact 文件，找到最大现有数字 ID 并设置 `nextId = max + 1`。

分配行为：

- 文件格式：`{id}.{toolType}.log`
- ID 是顺序字符串（`"0"`、`"1"`、...）
- resume 不会覆盖现有 artifact，因为扫描在分配前进行
- 目录在首次保存/分配时懒创建

如果 artifact 目录缺失，扫描返回空列表，分配从 `0` 开始。

没有 adopted manager 的 non-persistent session 可以将 `saveArtifact(...)` 内容以数字 ID 形式存储在内存中，但 `artifact://` 解析是通过注册的 artifact 目录文件化支持的。

### Agent 输出 ID（`agent://`）

`AgentOutputManager` 按请求的名称分配子代理输出 ID，首次使用时原样使用，仅在同一名称重复时才加后缀（`-2`、`-3`、…）（例如 `Anna`、`Anna-2`）。嵌套输出按父级前缀分组（例如 `Parent.Child`）。它在初始化时扫描现有 `.md` 文件，因此 resumed session 永远不会重用会覆盖先前输出的名称。

## 持久化数据流

### 1）Session 条目持久化重写路径

在 session 条目被写入之前——增量追加（`#appendToSessionFile`）或全文件重写（`#rewriteSynchronously` / `#rewriteAtomically`）——`SessionManager` 通过 `#lineFor()` 将其序列化，该函数在截断管道上运行 `prepareEntryForPersistence()`。

关键行为：

1. **大字符串截断**：超大字符串被截断并附加 `"[Session persistence truncated large content]"`；签名字段（`thinkingSignature`、`thoughtSignature`、`textSignature`）被清空而不是截断。
2. **瞬态字段剥离**：`partialJson` 和 `jsonlEvents` 从持久化条目中移除。
3. **图片外部化到 blob**：
   - `content` 数组中的图片块在 `data` 还不是 blob 引用且 base64 长度至少达到阈值（`BLOB_EXTERNALIZE_THRESHOLD = 1024`）时被外部化，
   - provider 风格的 `image_url` data URL 在以 `data:image/` 开头且包含 `;base64,` 时被外部化，
   - 图片块 `data` 以解码后的二进制字节存储，
   - provider data URL 以原始 UTF-8 data URL 字符串存储，
   - 持久化值被替换为 `blob:sha256:<hash>`。

这使 session JSONL 保持紧凑，同时保留可恢复性。

### 2）Session 加载回填路径

打开 session 时（`setSessionFile`），在迁移之后，`SessionManager` 运行 `resolveBlobRefsInEntries()`。

对于带有 `blob:sha256:<hash>` 的 message/custom-message 图片块，以及带有 blob 引用的持久化 provider `image_url` 字段：

- 从 blob store 读取 blob 字节，
- 将图片块字节转换回 base64，
- 将 provider `image_url` blob 转换回原始字符串，
- 在内存中变更条目字段以供 runtime consumer 使用。

如果 blob 缺失：

- 图片块解析记录警告并在内存中保留原始 `blob:sha256:` 引用字符串，
- provider `image_url` 解析记录警告并保留原始引用字符串，
- 加载继续。

### 3）工具输出溢出/截断路径

`OutputSink` 为 bash/python/ssh 及相关执行器提供流式输出。

行为：

1. 每个数据块通过 `sanitizeWithOptionalSixelPassthrough(..., sanitizeText)` 清理并追加到内存记账中。
2. 可选的实时 `onChunk` 接收清理后的列上限前数据块，如果配置了则做节流。
3. 每行列上限可能会丢弃面向 LLM 的缓冲区中长行的字节；此时会启动 artifact 镜像，使磁盘文件保留完整的清理后流。
4. 当内存尾缓冲区超过溢出阈值（`DEFAULT_MAX_BYTES`，50KB）时，sink 标记输出已截断，并在 artifact 路径可用时启动 artifact 镜像。
5. 如果文件 sink 已打开，它会先写入当前缓冲区，然后写入所有排队/后续的清理后数据块。
6. 内存缓冲区被修剪为尾窗口，或者在配置了头保留时修剪为头 + 省略标记 + 尾。
7. `dump()` 仅在文件 sink 创建成功时返回包含 `artifactId` 的摘要。

实际效果：

- UI/tool 返回值显示有界输出，
- 完整的清理后输出保留在 artifact 文件中，并在基于文件的 artifact 镜像成功时以 `artifact://<id>` 引用。

如果文件 sink 创建失败（I/O 错误、路径缺失等），sink 回退到仅内存截断；完整输出不会被持久化。

## URL 访问模型

### `blob:` 引用

`blob:sha256:<hash>` 是 session 条目载荷内的持久化引用，不是由 router 处理的内部 URL scheme。解析在 session 加载期间由 `SessionManager` 完成。

### `artifact://<id>`

由 `ArtifactProtocolHandler` 通过注册的活动 session artifact 目录处理：

- 要求数字 ID，
- 在每个已注册 artifacts 目录中搜索文件名前缀 `<id>.`，
- 从匹配的 `.log` 文件返回原始文本（`text/plain`），
- 缺失时，错误包含现有 artifact 文件中的可用数字 artifact ID。

失败行为：

- 如果没有注册 artifact 目录：抛出 `No session - artifacts unavailable`，
- 如果注册的目录存在但磁盘上不存在：抛出 `No artifacts directory found`，
- 如果 ID 不是数字：抛出 `artifact:// ID must be numeric, got: <id>`。

### `agent://<id>`

由 `AgentProtocolHandler` 通过注册的活动 session artifact 目录和 `<artifactsDir>/<id>.md` 处理：

- 纯形式返回 markdown 文本，
- `/path` 或 `?q=` 形式执行 JSON 提取，
- path 和 query 提取不能组合，
- 如果请求提取，文件内容必须可解析为 JSON。

失败行为：

- 如果没有注册 artifact 目录：抛出 `No session - agent outputs unavailable`，
- 如果注册的目录存在但磁盘上不存在：抛出 `No artifacts directory found`，
- 缺失输出抛出 `Not found: <id>`，目录列表成功时附带可用 `.md` 输出 ID。

Read 工具集成：

- `read` 对非提取内部 URL 读取支持 offset/limit 分页，
- 对 `agent://` 提取使用拒绝 offset/limit。

## Resume、fork 与移动语义

### Resume

- `ArtifactManager` 在首次分配时扫描现有 `{id}.*.log` 文件并继续编号。
- `AgentOutputManager` 扫描现有 `.md` 输出 ID 并继续编号。
- `SessionManager` 在加载时将 blob 引用回填为 base64/data URL。

### Fork

`SessionManager.fork()` 创建具有新 session ID 和 `parentSession` 链接的新 session 文件，然后返回旧/新文件路径。Artifact 复制由 `AgentSession.fork()` 处理：

- 首先刷新当前 session，
- 尝试将旧 artifact 目录递归复制到新 artifact 目录，
- 旧目录缺失被容忍，
- 非 ENOENT 复制错误记录为警告，fork 仍然完成。

fork 后的 ID 影响：

- 如果复制成功，新 session 中的 artifact 计数器在新的 `ArtifactManager` 首次扫描时继续在最大复制 ID 之后编号，
- 如果复制失败/跳过，新 session artifact ID 从 `0` 开始。

fork 后的 blob 影响：

- blob 是全局且按内容寻址的，因此不需要 blob 目录复制。

### 移动到新 cwd

`SessionManager.moveTo()` 将 session 文件和 artifact 目录重命名为新的默认 session 目录，如果后续步骤失败则回滚。这保留了 artifact 身份，同时 relocated session scope。

## 失败处理与回退路径

| 情况 | 行为 |
|---|---|
| 图片块回填时 blob 文件缺失 | 警告并在内存中保留 `blob:sha256:` 引用字符串 |
| provider `image_url` 回填时 blob 文件缺失 | 警告并在内存中保留 `blob:sha256:` 引用字符串 |
| 通过 `BlobStore.get` 读取 blob 时 ENOENT | 返回 `null` |
| Artifact 目录缺失（`ArtifactManager.listFiles`） | 返回空列表（可以从头开始分配） |
| 没有注册 artifact 目录（`artifact://`） | 抛出 `No session - artifacts unavailable` |
| 没有注册 artifact 目录（`agent://`） | 抛出 `No session - agent outputs unavailable` |
| 注册的 artifact 目录在磁盘上缺失 | 抛出明确的 `No artifacts directory found` |
| Artifact ID 未找到 | 附带可用 ID 列表抛出 |
| OutputSink artifact 写入器初始化失败 | 继续使用仅内存的有界输出 |
| Non-persistent `saveArtifact` | 将文本存储在 `SessionManager` 内存映射中；非文件化 URL 数据 |

## 二进制 blob 外部化与文本输出 artifact 的对比

- **Blob 外部化**用于持久化 session 条目内容中的图片载荷和 provider 图片 data URL；它将 JSONL 中的内联载荷字符串替换为稳定的内容引用。
- **Artifacts** 是用于执行输出和子代理输出的纯文本文件；基于文件的 artifact 可通过内部 URL 按 session-local ID 寻址。

这两套系统仅有间接交集：两者都减少 session JSONL 膨胀，但它们的身份、生命周期和检索路径不同。

## 实现文件

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob 引用格式、哈希、put/get、externalize/resolve 辅助函数。
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — session artifact 目录模型以及数字 artifact ID/path 分配。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink` 截断/溢写文件行为及摘要元数据。
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — `BlobStore`/`ArtifactManager` 构造、persistence-transform 和 blob-rehydration 调用点、session fork/move 交互。
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — `prepareEntryForPersistence()`：大字符串截断、瞬态字段剥离以及同步图片 blob 外部化。
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — `resolveBlobRefsInEntries()`：加载时将 blob 引用回填为 base64 / data URL。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — interactive fork 期间的 artifact 目录复制。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://` 解析器。
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` 解析器 + JSON 提取。
- [`src/internal-urls/router.ts`](../packages/coding-agent/src/internal-urls/router.ts) — internal URL router 接线。
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — `agent://` 的 session-scoped agent output ID 分配。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — 子代理输出 artifact 写入（`<id>.md`）和 session JSONL sidecar。
