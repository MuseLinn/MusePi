# 会话操作：导出、转储、分享、fresh、fork、恢复/继续

[English](session-operations-export-share-fork-resume.md) | 中文

本文档描述会话导出/分享/派生/恢复操作当前实现中面向操作者的可见行为。

## 实现文件

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`../src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## 操作矩阵

| 操作                               | 入口路径                | 会话变更                      | 会话文件创建/切换                                                       | 输出产物                                                 |
| ---------------------------------- | ----------------------- | ----------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `/dump`                            | 交互式斜杠命令           | 否                            | 否                                                                     | 剪贴板文本                                               |
| `/export [path]`                   | 交互式斜杠命令           | 否                            | 否                                                                     | HTML 文件                                                |
| `--export <session.jsonl> [outputPath]` | CLI 启动快速路径        | 不改变运行时会话              | 无活跃会话；读取目标文件                                              | HTML 文件                                                |
| `/share`                           | 交互式斜杠命令           | 否                            | 否                                                                     | 加密分享链接（gist 或分享服务器）；自定义 handler 时才临时生成 HTML |
| `/fresh`                           | 交互式斜杠命令           | 是（仅面向 provider 的内存 id/状态） | 否；保留当前会话文件/header                                         | 无                                                       |
| `/fork`                            | 交互式斜杠命令           | 是（活跃会话身份改变）        | 创建新会话文件并将当前会话切换到它（仅持久化模式）                    | 存在时把 artifact 目录复制到新会话命名空间               |
| `--fork <id\|path>`                | CLI 启动                 | 是（创建会话之后）            | 从所选源创建新的会话派生到当前 cwd/会话目录                           | 无                                                       |
| `/resume`                          | 交互式斜杠命令           | 是（替换活跃内存状态）        | 切换到所选的既有会话文件                                              | 无                                                       |
| `--resume`                         | CLI 启动选择器            | 是（创建会话之后）            | 打开所选的既有会话文件                                                | 无                                                       |
| `--resume <id\|path>`              | CLI 启动                 | 是（创建会话之后）            | 打开既有会话；全局跨项目匹配时重新定位（目录已移动）或派生到当前项目  | 无                                                       |
| `--continue`                       | CLI 启动                 | 是（创建会话之后）            | 打开终端面包屑（目录已移动则重新定位）或最近的会话；若无则新建会话    | 无                                                       |

## 导出与转储

### `/export [outputPath]`（交互式）

流程：

1. 内置斜杠命令注册表（`src/slash-commands/builtin-registry.ts`）在 TUI 中把 `/export...` 路由到 `CommandController.handleExportCommand`。
2. 命令按空白拆分，只用 `/export` 之后的首个参数作为 `outputPath`。
3. `AgentSession.exportToHtml()` 调用 `exportSessionToHtml(sessionManager, state, { outputPath, themeName })`。
4. 成功后，UI 显示路径并在浏览器中打开该文件。

行为细节：

- 显式拒绝 `--copy`、`clipboard` 和 `copy` 参数，并提示改用 `/dump`。
- 导出会嵌入会话 header/entries/leaf，以及来自 agent 状态的当前 `systemPrompt` 和 tool 描述。
- 存储在会话文件旁的子代理 transcript（`<session>/<AgentId>.jsonl`，嵌套衍生递归）会作为 `subSessions` 嵌入（`src/export/html/index.ts` 中的 `collectSubSessions`；可用 `ExportOptions` 中的 `includeSubSessions: false` 禁用）。在页面中，task tool 卡片里的 agent id 会打开一个带面包屑的子会话覆盖层。
- Tool 调用通过 `<omp-tool-view>` web component 渲染——即与 desktop-web 共享、按 tool 预建的 React 渲染器（`packages/desktop-web/src/tool-render/`），由 `bun run gen:tool-views` 预编译到 `src/export/html/tool-views.generated.js`。
- 导出期间不会追加任何会话条目。

注意：

- 参数解析基于空白（`text.split(/\s+/)`），所以含空格的带引号路径在此命令路径下不会被保留为单个路径。

### `--export <inputSessionFile> [outputPath]`（CLI）

在 `main.ts` 中的流程：

1. 在交互式/会话启动之前尽早处理。
2. 调用 `exportFromFile(inputPath, outputPath?)`。
3. `SessionManager.open(inputPath)` 加载条目，然后生成并写入 HTML。
4. 进程打印 `Exported to: ...` 并退出。

行为细节：

- 输入文件缺失时显示 `File not found: <path>`。
- 此路径不会创建 `AgentSession`，也不会改动任何运行中的会话。

### `/dump`（交互式剪贴板导出）

流程：

1. `CommandController.handleDumpCommand()` 调用 `session.formatSessionAsText()`。
2. 若为空字符串，则报告 `No messages to dump yet.`。
3. 否则通过原生 `copyToClipboard` 复制到剪贴板。

转储内容包括：

- 系统提示词
- 活跃模型/思考级别
- Tool 定义 + 参数
- 用户/助手消息
- 思考块和 tool 调用
- Tool 结果与执行块（`excludeFromContext` 的 bash/python 条目除外）
- 自定义/钩子/文件提及/分支总结/压缩总结条目

转储不改变任何会话持久化状态。

## 分享

`/share` 发布会话的端到端加密快照并打印查看链接。实现：[`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts)。

### 阶段 1：自定义分享 handler（若存在）

`loadCustomShare()` 在 `~/.musepi/agent` 中检查首个存在的候选：

- `share.ts`
- `share.js`
- `share.mjs`

要求：

- 模块必须 default-export 一个函数 `(htmlPath) => Promise<CustomShareResult | string | undefined>`。

若存在且有效，则保留旧契约：会话被导出到一个临时 HTML 文件（`${os.tmpdir()}/${Snowflake.next()}.html`），handler 收到其路径，之后临时文件被删除。
Handler 结果解释：

- string => 视为 URL，显示并打开
- object => 显示 `url` 和/或 `message`；打开 `url`
- `undefined`/falsy => 通用 `Session shared`

关键回退行为：

- 若自定义 handler 存在但加载失败，命令报错并返回。
- 若自定义 handler 执行并抛出异常，命令报错并返回。
- 在这两种失败情况下，它**不会**回退到默认流程。
- 仅当不存在自定义分享脚本时，默认流程才运行。

### 阶段 2：默认加密分享

仅当未找到自定义分享 handler 时（`shareSession()`）：

1. 构建会话快照（`header`、`entries`、`leafId`，以及来自 agent 状态的当前 `systemPrompt` 和 tool 描述）。
2. 若启用了 `share.redactSecrets`（默认）且配置了 secrets（`secrets.*`），secret 混淆器会深度遍历快照中的每个字符串，把配置/发现的 secret 替换为占位符。
3. JSON 被 gzip 压缩并用一个新鲜的 AES-256-GCM 密钥封存（`[12B IV][ciphertext+tag]`）。
4. 上传目标由 `share.store` 决定：
   - **分享服务器**（默认，`store: "blob"`）——向 `<share.serverUrl>`（默认 `https://my.omp.sh/s`）`POST` 原始 blob，上限 1 MB。超大的快照会被裁剪到能放下为止：先内联图片，再长字符串（32 KB → 8 KB → 2 KB → 512 B 上限），最后是最旧的条目。
   - **Secret gist**（`store: "gist"`）——当 `gh` 已安装且已认证时，封存 blob 以 base64 编码推送到 `session.ompshare.txt`（封存预算 5 MB；gist 原始抓取上限 10 MB），当 `gh` 不可用时回退到分享服务器。
5. 两种情况下链接都是 `<share.serverUrl>/<id>#<base64url key>`。那里提供的查看页面抓取 blob（十六进制 id 走 GitHub gist API，其它走服务器的 blob 存储）并在客户端解密；密钥只存在于 URL fragment，绝不出现在任何 HTTP 请求中。

UI 会报告分享 URL（以及在适用时的底层 gist URL 和截断说明）。无头 `/share` 打印相同的行。与 `/export` 不同，`/share` 对内存会话（`--no-session`）也有效：快照从实时条目构建，无需会话文件。

分享中的取消/中止语义：

- Loader 有 `onAbort` 钩子，会恢复编辑器 UI 并报告 `Share cancelled`。
- 上传本身不会中途中止；取消是 UI 层面的，并在上传返回后检查。

## Fresh

交互式 `/fresh` 重置当前会话面向 provider 的流状态，**而不触碰本地 transcript、会话文件或 header**。当 provider 流被卡住或损坏时（过期的 prompt cache、回合中途故障、或服务端会话 id 漂移），用它来恢复，同时保留你能看到的对话。

`AgentSession.freshSession()`：

- 在 agent 流式输出期间会被拒绝——先等待响应完成或中止它。
- 关闭每个缓存的 provider 会话状态条目（服务端会话 / prompt-cache 句柄），并报告剪除了多少个。
- 生成一个新鲜的 provider 会话 id，并把 hindsight 与 mnemopi 记忆重新按键到它，同时使 append-only 上下文失效，以便下一回合把完整本地 transcript 重新发送给 provider。
- 保留本地 transcript、会话文件和会话身份不变，因此你已说或已收到的一切都不会丢失。

因为它保留当前会话文件，`/fresh` 与 `/new`（启动一个全新空会话）和 `/drop`（删除当前会话并新建一个）不同：只有 `/fresh` 在给 provider 一个干净起点时仍保留可见历史。

## Fork

交互式 `/fork` 从当前会话创建一个新会话，并把活跃会话身份切换过去。

### 前置条件与即时防护

- 若 agent 正在流式输出，`/fork` 会被拒绝并给出警告。
- 操作前会清除 UI 状态/加载指示器。

### 会话级流程

`AgentSession.fork()`：

1. 发出 `session_before_switch`，`reason: "fork"`（可取消）。
2. 刷新待写入内容。
3. 调用 `SessionManager.fork()`。
4. 把 artifact 目录从旧会话命名空间复制到新命名空间（尽力而为；非 ENOENT 的复制失败会记录日志，不致命）。
5. 更新 `agent.sessionId`，并继承上一个 provider prompt-cache 键，除非已显式固定 prompt-cache 键。
6. 发出 `session_switch`，`reason: "fork"`。

`SessionManager.fork()` 行为：

- 需要持久化模式和既有会话文件。
- 创建新会话 id 和新 JSONL 文件路径。
- 用以下内容重写 header：
  - 新 `id`
  - 新时间戳
  - `cwd` 不变
  - `parentSession` 设为上一个会话 id
  - `providerPromptCacheKey` 设为上一个 header 的继承键，若未固定则为上一个会话 id
- 新文件中的非 header 条目全部保持不变。

### 非持久化行为

- 内存会话管理器从 `fork()` 返回 `undefined`。
- `AgentSession.fork()` 返回 `false`。
- UI 报告 `Fork failed (session not persisted or cancelled)`。

### CLI `--fork <id|path>`

启动时的 `--fork` 在正常会话创建之前解析：

1. `--fork` 与 `--no-session` 一起会被拒绝。
2. 路径样式的值（`/`、`\` 或 `.jsonl`）调用 `SessionManager.forkFrom(path, cwd, sessionDir)`。
3. 其它值通过 `resolveResumableSession(...)` 解析：先本地会话，当 `sessionDir` 未被强制时再做全局搜索。匹配接受小写会话 id 前缀、完整 JSONL 文件名前缀以及去时间戳后的文件名 id 后缀。
4. 派生的文件在当前 cwd/会话目录作用域中创建，并成为启动时的活跃会话管理器。
5. 全上下文派生会自动从源 header 的继承键填充 `providerPromptCacheKey`，回退到源会话 id。当 `--model`、`--thinking`、`--system-prompt`、`--append-system-prompt`、`--tools` 或 `--no-tools` 改变了 provider 路由或 prompt/tool 形状时，启动会丢弃该自动继承。

用 `--prompt-cache-key <key>` 显式且独立地固定 provider prompt-cache 身份，使其与 OMP 会话 id 和 `--provider-session-id` 都无关。`--provider-session-id` 继续控制 provider 会话/路由 header 与粘性凭据选择；`--prompt-cache-key` 在受支持时控制 OpenAI Responses 的 `prompt_cache_key` 载荷。

## 恢复与继续

### 交互式 `/resume`

流程：

1. 打开会话选择器，内容由 `SessionManager.list(currentCwd, currentSessionDir)` 填充。若当前文件夹没有会话，则预加载 `SessionManager.listAll()`，选择器直接以全项目作用域打开。
2. 选择后，`SelectorController.handleResumeSession(sessionPath)` 调用 `session.switchSession(sessionPath)`。
3. UI 清除/重建聊天和 todos，然后报告 `Resumed session`（当恢复的会话属于另一个项目时报告 `Resumed session in <dir>`，此时进程 cwd 与 cwd 派生的缓存通过 `applyCwdChange` 重新指向）。

备注：

- 选择器初始在当前文件夹作用域；Tab 切换到全项目作用域（首次切换时懒加载 `SessionManager.listAll()`，之后缓存）。

## CLI `--resume`

### `--resume`（无值）

- `main.ts` 列出当前 cwd/sessionDir 的会话并打开选择器。当当前文件夹为空时，回退到 `SessionManager.listAll()` 并以全项目作用域打开选择器；仅当全局列表也为空时才打印 `No sessions found`。
- 所选路径在会话创建前用 `SessionManager.open(selectedPath)` 打开。从另一个项目选择会话会先把进程切入该项目的目录，并重载 cwd 作用域的设置/缓存。

### `--resume <value>`

`createSessionManager()` 的解析顺序：

1. 若值看起来像路径（`/`、`\` 或 `.jsonl`），直接打开。
2. 否则 `resolveResumableSession(...)` 搜索：
   - 当前作用域（`SessionManager.list(cwd, sessionDir)`）
   - 仅当未提供显式 `sessionDir` 时才搜索全局会话（`SessionManager.listAll()`）
3. 匹配接受大小写不敏感的会话 id 前缀、完整 JSONL 文件名前缀，以及 `<timestamp>_<sessionId>.jsonl` 中时间戳后的 id 后缀。

跨项目 id 匹配行为：

- 若匹配会话的 cwd 与当前 cwd 不同，行为取决于该匹配会话记录的目录是否仍存在：
  - **目录已不存在（已移动/重命名，例如 `git worktree move`）**：CLI 询问 `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`。
    - 选是（默认）：`SessionManager.open(match.path)` 然后 `manager.moveTo(cwd)` 把既有会话重新定位到当前目录（不产生重复文件）。
    - 选否：命令取消（返回无会话）。非 TTY 下：命令报错。
  - **目录仍存在（确实是不同项目）**：CLI 询问 `Session found in different project ... Fork into current directory? [y/N]`。
    - 选是：`SessionManager.forkFrom(match.path, cwd, sessionDir)` 创建新的本地派生文件。
    - 选否：命令取消。非 TTY 下：命令报错。

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`：

1. 解析当前 cwd 的会话目录。
2. 读取终端作用域的面包屑。
3. 若面包屑指向一个记录在不同 cwd 下、其目录已不存在（已移动/重命名）的会话，**且**当前目录没有自己的会话，则通过 `moveTo` 把该会话重新定位到当前目录，而不是重新开始。
4. 否则，若面包屑的 cwd 与当前 cwd 匹配，则使用面包屑会话；否则回退到最近修改的会话文件。
5. 打开找到的会话；若无，则新建一个会话。

这是仅限启动的行为；没有交互式 `/continue` 斜杠命令。

## 会话切换实际上如何改变运行时状态

`AgentSession.switchSession(sessionPath)` 完成 resume 类操作所用的运行时切换：

1. 发出 `session_before_switch`，`reason: "resume"` 与 `targetSessionFile`（可取消）。
2. 断开 agent 事件订阅并中止进行中的工作。
3. 刷新当前会话管理器的写入。
4. 捕获当前会话、agent 消息、排队中的 steering/follow-up/next-turn 消息、model/thinking/service-tier、MCP 选择、tools 和 system prompt 的回滚状态。
5. 清空排队的 steering/follow-up/next-turn 消息。
6. `sessionManager.setSessionFile(sessionPath)` 并更新 `agent.sessionId`。
7. 从加载的条目构建会话上下文。
8. 为目标会话恢复 MCP 选择/tools/system prompt。
9. 发出 `session_switch`，`reason: "resume"`。
10. 从上下文替换 agent 消息并同步 todos。
11. 切换文件时关闭 provider 会话，或同文件重载改变了重放消息时也一样。
12. 恢复 model（若当前 registry 可用）。
13. 恢复或初始化 thinking 级别与 service tier。
14. 重新连接 agent 事件订阅。
15. 若有，则运行已注册的会话切换 reconciler（交互模式通过 `setSessionSwitchReconciler` 注册 `#reconcileModeFromSession()`，以便重新进入如 plan 的持久化模式）；reconciler 错误会被记录日志，不致命。

若捕获之后的任一步骤失败，`switchSession()` 会恢复已捕获的状态并重新连接之前的 agent 订阅，然后再重新抛出。

`switchSession()` 本身不会创建新会话文件。

## 事件发出与取消点

### 切换/派生生命周期钩子

对于 `newSession`、`fork` 和 `switchSession`：

- 之前的事件：`session_before_switch`
  - reasons：`new`、`fork`、`resume`
  - 通过返回 `{ cancel: true }` 可取消
- 之后的事件：`session_switch`
  - 同一组 reason
  - 包含 `previousSessionFile`

`ExtensionRunner.emit()` 在第一个返回取消的 before 事件结果时提前返回。

### 自定义 tool `onSession` 行为

SDK 把扩展会话事件桥接到自定义 tool `onSession` 回调：

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

这些回调是观察性的；它们不会取消切换/派生。

### 与本文档相关的其它取消面

- 流式输出期间 `/fork` 被阻止（用户必须先等待/中止当前响应）。
- `/resume` 选择器可由用户关闭选择器取消。
- 跨项目 `--resume <id>` 可通过拒绝派生提示取消。
- `/share` 有 UI 中止路径（`Share cancelled`）；上传本身不会中途被终止。

## 非持久化（内存）会话行为

当会话管理器以 `SessionManager.inMemory()`（`--no-session`）创建时：

- 会话文件路径缺失。
- `/export` 失败，报 `Cannot export in-memory session to HTML`（传播到命令错误 UI）。`/share` 仍可用：快照从实时条目构建。
- `/fork` 失败，因为 `SessionManager.fork()` 需要持久化。
- `/dump` 仍可用，因为它序列化内存中的 agent 状态。
- 若设置了 `--no-session`，CLI 的 resume/continue 语义会被绕过，因为管理器创建会立即返回内存态。

## 已知实现注意点（截至当前代码）

- `SelectorController.handleResumeSession()` 不检查 `session.switchSession(...)` 的布尔结果；被钩子取消的切换仍可能继续走到 UI 的「Resumed session」重绘/状态路径。
- `/share` 自定义分享失败不会降级到默认加密分享流程；它们会以错误终止命令。
- `/export` 参数分词过于简化，不保留含空格带引号的路径。
