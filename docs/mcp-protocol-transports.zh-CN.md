# MCP 协议与传输机制


[English](mcp-protocol-transports.md) | 中文
本文档说明 coding-agent 如何实现 MCP JSON-RPC 消息传递，以及协议关注点如何与传输关注点分离。

## 范围

涵盖：

- JSON-RPC 请求/响应与通知流程
- 服务端到客户端请求处理（`ping`、`roots/list`）
- stdio 与 HTTP/SSE 传输的请求关联与生命周期
- 超时、取消和认证刷新行为
- 错误传播与畸形载荷处理
- 传输选择边界（`stdio` vs `http` vs `sse`）
- 哪些重连/重试责任属于传输层，哪些属于 manager/tool-bridge 层

不涵盖扩展作者体验或命令 UI。

## 实现文件

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/transports/stdio.ts`](../packages/coding-agent/src/mcp/transports/stdio.ts)
- [`src/mcp/transports/http.ts`](../packages/coding-agent/src/mcp/transports/http.ts)
- [`src/mcp/transports/sse.ts`](../packages/coding-agent/src/mcp/transports/sse.ts)
- [`src/mcp/transports/index.ts`](../packages/coding-agent/src/mcp/transports/index.ts)
- [`src/mcp/json-rpc.ts`](../packages/coding-agent/src/mcp/json-rpc.ts)
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)

## 层次边界

### 协议层（JSON-RPC + MCP 方法）

- 消息形状定义在 `types.ts` 中（`JsonRpcRequest`、`JsonRpcNotification`、`JsonRpcResponse`、`JsonRpcMessage`）。
- MCP 客户端逻辑（`client.ts`）决定方法顺序与会握手顺序：
  1. `initialize` 请求
  2. 对 Streamable HTTP 传输，在 `initialize` 响应建立 session id 后，启动可选的背景 SSE listener
  3. `notifications/initialized` 通知
  4. `tools/list`、`tools/call` 等方法调用

### 传输层（`MCPTransport`）

`MCPTransport` 抽象投递与生命周期：

- `request(method, params, options?) -> Promise<T>`
- `notify(method, params?) -> Promise<void>`
- `close()`
- `connected`
- 可选回调：`onClose`、`onError`、`onNotification`、`onRequest`

传输实现拥有帧格式与 I/O 细节：

- `StdioTransport`：通过子进程 stdio 传输换行分隔的 JSON
- `HttpTransport`：通过 POST 进行 Streamable HTTP JSON-RPC，支持可选的 SSE 响应/监听
- `LegacySseTransport`：2024-11-05 协议修订版的 HTTP+SSE，使用持久 GET stream 以及从 `endpoint` 事件发现的 POST endpoint

### Manager/Client 接线

`connectToServer()` 始终为标准的服务端到客户端请求安装 `onRequest` handler。`MCPManager` 安装通知 handler、HTTP-like OAuth server 的 OAuth 刷新钩子，以及受管连接的 `onClose` 重连处理。

## 传输选择

`client.ts:createTransport()` 根据配置选择传输：

- `type` 省略或为 `"stdio"` -> `createStdioTransport`
- `"http"` -> `createHttpTransport`
- `"sse"` -> `createSseTransport`

`"sse"` 使用遗留 HTTP+SSE 传输：用 GET 打开配置的 URL，读取 `endpoint` 事件的纯文本 URL/path，将 JSON-RPC 请求 POST 到该 endpoint，并从 stream 接收 JSON-RPC 响应。

## JSON-RPC 消息流与关联

## Request IDs

每个传输使用 `Snowflake.next()` 生成每请求 ID。ID 是传输本地关联令牌。

## Stdio 关联路径

- 出站请求被序列化为一个 JSON 对象 + `\n`。
- `#pendingRequests: Map<id, {resolve,reject}>` 存储进行中的请求。
- 读循环从 stdout 解析 JSONL 并调用 `#handleMessage`。
- 如果入站消息有匹配的 `id`，请求 resolve/reject。
- 如果入站消息有 `method` 且无 `id`，视为通知并转发到 `onNotification`。
- 如果入站消息同时有 `method` 和 `id`，视为服务端到客户端请求并通过 `onRequest` 回答；如果没有 handler，传输回复 JSON-RPC `-32601 Method not found`。

未知响应 ID 被忽略（不 reject，不 error callback）。

## HTTP 关联路径

- 出站请求是带 JSON body 和生成 `id` 的 HTTP `POST`。
- 非 SSE 响应路径：解析一个 JSON-RPC 响应，成功返回 `result`/失败抛出 `error`。
- SSE 响应路径（`Content-Type: text/event-stream`）：流式消费事件，返回第一条 `id` 匹配预期请求 ID 且带有 `result` 或 `error` 的消息。
- SSE 消息有 `method` 且无 `id` 视为通知。
- SSE 消息同时有 `method` 和 `id` 视为服务端到客户端请求，并以 POSTed JSON-RPC response 回答。

如果 SSE stream 在匹配响应前结束，请求以 `No response received for request ID ...` 失败。在捕获到匹配响应后，传输在后台清空剩余的 SSE 消息。

## Notifications

客户端通过 `transport.notify(...)` 发出 JSON-RPC 通知。

- Stdio：通过 `writeFrame()` 将通知帧写入 stdin（`jsonrpc`、`method`、`params`）加换行；写入失败会关闭传输并抛出。
- HTTP：发送不带 `id` 的 POST body；成功接受 `2xx` 或 `202 Accepted`。

服务端发起通知通过 transport `onNotification` 暴露；`MCPManager` 消费已知的 MCP list/update 通知，并可通过自身回调转发所有通知。

## Stdio transport 内部

## 生命周期与状态转换

- 初始：`connected=false`、`process=null`、pending map 为空
- `connect()`：
  - 以配置的 command/args/env/cwd 生成子进程
  - 标记 connected
  - 启动 stdout 读循环（`readJsonl`）
  - 启动 stderr 循环（读取/丢弃；当前静默）
- `close()`：
  - `#handleClose()`：标记 disconnected，reject 所有 pending 请求（`Transport closed`），发出 `onClose`
  - kill 子进程
  - 分离 read loop 且不 await（它可能无限挂起）

如果 read loop 异常退出，`finally` 触发 `#handleClose()`，执行同样的 pending-request rejection 与 close callback。

## 超时与取消

每个请求：

- timeout 来自 `resolveMCPTimeoutMs`：`OMP_MCP_TIMEOUT_MS` 环境变量覆盖，否则 `config.timeout ?? 30000`；`0` 禁用
- 可选 `AbortSignal` 来自调用方
- abort 与 timeout 都会 reject pending promise 并清理 map entry

取消仅本地生效：transport 不会向服务端发送协议级取消通知。

## 畸形载荷处理

在读循环中：

- 每个解析后的 JSONL 行被传入 `#handleMessage`，并在 `try/catch` 中处理
- 畸形/无效消息处理异常被丢弃（`Skip malformed lines` 注释）
- 循环继续，因此一条坏消息不会杀死连接

如果底层 stream parser 抛出，`onError` 被调用（当仍 connected 时），然后连接关闭。

## 断开/失败行为

进程退出或 stream 关闭时：

- 所有进行中请求都被 reject 为 `Transport closed`
- 不自动重启或重连
- 高层必须通过创建新 transport 来重连

## 反压/流式说明

- `request()` 等待 `stdin.write()` + `flush()`，因此 broken-pipe 失败会 reject 请求；`notify()` 通过 `writeFrame()` 写入，它不 await 并吸收 async EPIPE rejection。
- transport 中没有显式队列或高水位管理。
- 入站处理由 stream 驱动（`for await` over `readJsonl`），每次一条解析后的消息。

## Streamable HTTP transport 内部

## 生命周期与连接语义

HTTP transport 有逻辑连接状态，但请求路径按 HTTP 调用无状态：

- `connect()` 设置 `connected=true`（没有 socket/session 握手）
- 可选服务端 session 跟踪，通过 `Mcp-Session-Id` header
- `close()` 可选发送带 `Mcp-Session-Id` 的 `DELETE`，中止 SSE listener，发出 `onClose`

因此 `connected` 表示“transport 可用”，不是“已建立持久 stream”。

## Session header 行为

- 在 POST 响应上，如果存在 `Mcp-Session-Id` header，transport 存储它。
- 后续请求/通知会包含 `Mcp-Session-Id`。
- `close()` 尝试通过 HTTP DELETE 终止服务端 session；终止失败会被忽略。

## 超时、取消和认证刷新

对于 `request()`：

- timeout 使用 `AbortController`，通过 `createMCPTimeout`（`OMP_MCP_TIMEOUT_MS` 覆盖，否则 `config.timeout ?? 30000`；`0` 禁用）
- 调用方提供的 external signal 通过 `AbortSignal.any([...])` 合并
- AbortError 处理区分调用方 abort 与 timeout

对于 `notify()`：

- timeout 使用内部 `AbortController`，使用相同解析后的 timeout
- transport 接口上没有外部 abort 选项

对于 `MCPManager` 管理的 HTTP-like OAuth 配置，出站请求和尽力而为的服务端请求响应在 `HTTP 401`/`403` 时，若 token refresh 返回替换 headers，则重试一次。

## HTTP 错误传播

在非 OK 响应上：

- response text 被包含在抛出的错误中（`HTTP <status>: <text>`）
- 如果存在，`WWW-Authenticate` 和 `Mcp-Auth-Server` 的 auth hints 会被追加

在 JSON-RPC error 对象上：

- 抛出 `MCP error <code>: <message>`

畸形 JSON body（`response.json()` 失败）作为 parse exception 传播。

## SSE 行为与模式

存在两条 SSE 路径：

1. **按请求的 SSE 响应**（`#parseSSEResponse`）
   - 当 POST 响应 content type 为 `text/event-stream` 时使用
   - 消费 stream 直到找到匹配 response id
   - 可在同一 stream 中处理交错的通知

2. **背景 SSE listener**（`startSSEListener()`）
   - 可选的 GET listener，用于服务端发起的通知和服务端到客户端请求
   - `connectToServer()` 在 Streamable HTTP transports 上，在 `initialize` 之后、`notifications/initialized` 之前启动它
   - listener 启动最多等待一秒；非常小的 request timeout 下等待时间更短；`timeout: 0` / `OMP_MCP_TIMEOUT_MS=0` 禁用该启动截止时间
   - 如果 GET 返回 `405`、另一个非 OK 状态、无 body 或超时，listener 静默禁用自身

## 畸形载荷与断开处理

SSE JSON 解析错误从 `readSseJson` 冒出并 reject request/listener。

- 请求 SSE 解析错误 reject 活跃请求。
- 背景 listener 错误触发 `onError`（除了 AbortError），且已建立的 listener 在仍 connected 时结束会触发 `onClose`，以便 manager 重连。
- transport 本身不重启 listener；受管连接可通过 manager `onClose` 处理重连。

## Legacy HTTP+SSE transport 内部

`LegacySseTransport` 实现 MCP 协议修订版 2024-11-05：

- `connect()` 用 `GET Accept: text/event-stream` 打开配置的 URL。
- 第一个 `endpoint` 事件是控制数据，不是 JSON；其 `data` 值相对于配置的 URL 解析并存储为 JSON-RPC POST endpoint。
- `request()` 和 `notify()` 将 JSON-RPC 帧 POST 到发现的 endpoint。
- JSON-RPC 响应、通知和服务端到客户端请求从 `event: message` stream 事件中读取，并按 request id 关联。
- 如果 stream 结束，pending 请求以 `Legacy SSE stream closed` 失败；受管连接可通过 `onClose` 重连。

## `json-rpc.ts` 工具与 transport 抽象的差异

`src/mcp/json-rpc.ts` 提供 `callMCP()` 和 `parseSSE()` helper，用于直接 HTTP MCP 调用（被 Exa integration 使用），而不是 `MCPClient`/`MCPManager` 使用的 `MCPTransport` 抽象。

与 `HttpTransport` 的显著差异：

- 先解析整个响应文本，然后提取第一条 `data: ` 行（`parseSSE`），并带 JSON fallback
- 可选调用方 `AbortSignal`（`CallMcpOptions`），未提供时有硬 60 秒 `AbortSignal.timeout` 默认值；无 session-id handling、无 transport lifecycle
- 返回原始 JSON-RPC envelope 对象

该路径更轻量，但不如完整 transport 实现稳健。

## 重试/重连责任

## Transport-level

当前 transport 实现**不会**：

- 重试普通失败请求，除非 HTTP-like transports 在 `onAuthError` 接线时的单次 OAuth-refresh retry
- 在 stdio 进程退出后重连
- 自行重连 SSE listeners
- 在断开后重发进行中的请求

它们快速失败并传播错误。

## Manager/tool-bridge level

`MCPManager` 为受管连接接线 `transport.onClose`，并在 transport 意外关闭时运行 `reconnectServer(name)`。重连会拆毁陈旧连接、重新解析 auth/config 值、使用 backoff（`500`、`1000`、`2000`、`4000` ms）重试、重新加载工具，并在重连期间保留陈旧工具。

`MCPTool` 和 `DeferredMCPTool` 也会在 tool call 中对可重试连接错误尝试一次 reconnect + retry。这是 tool availability recovery，不是 transport-level retry。

## 失败场景总结

- **畸形 stdio 消息行**：丢弃；stream 继续。
- **Stdio stream/process 结束**：transport 关闭；pending 请求被 reject 为 `Transport closed`；受管连接触发 reconnect。
- **HTTP 非 2xx**：request/notify 抛出 HTTP 错误；受管 OAuth 请求可在 401/403 时刷新 auth 并重试一次。
- **无效 JSON 响应**：解析异常传播。
- **Legacy SSE stream 结束**：pending 请求以 `Legacy SSE stream closed` 失败；受管连接触发 reconnect。
- **SSE 结束且无匹配 id**：请求以 `No response received for request ID ...` 失败。
- **Timeout**：transport-specific timeout error。
- **Caller abort**：在方法接受时，AbortError/reason 从调用方 signal 传播。

## 实用边界规则

如果关注点是消息形状、id 关联或 MCP 方法顺序，它属于 protocol/client logic。

如果关注点是帧格式（JSONL vs HTTP/SSE）、stream parsing、fetch/spawn lifecycle、timeout clocks 或连接清理，它属于 transport implementation。
