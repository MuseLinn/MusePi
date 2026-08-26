# Collab：实时会话共享

[English](collab.md) | 中文

`/collab` 把你的运行中会话实时共享给其他 musepi 实例。访客会在**各自的 TUI 中原生渲染同一会话**——包括流式 assistant 文本、工具调用卡片、页脚状态（cwd、model、context %、cost）、ctrl+o 展开、`/dump`，无需终端镜像。访客可以向 agent 提问并中断 agent；真正运行 agent 和所有工具的是主机。

## 快速开始

主机：

```
/collab
```

会打印

```
Collab session started!
 • Join from another terminal: musepi join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
```

浏览器那一行可直接点击加入（指向完整 `https://` deep link 的 OSC 8 超链接）：relay 在 `/` 提供 web 访客客户端，room id 和 key 携带在 URL fragment 中。在另一台 musepi（任意目录、任意机器）中，两种方式都可以：

运行 `/collab` 或 `/collab view` 会启动或展示当前正在共享的会话，同时渲染终端/浏览器加入链接及其对应二维码。

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

访客在 `/leave`（或主机停止）时会恢复之前的会话。

### 命令

| 命令 | 效果 |
|---|---|
| `/collab` | 开始以完整控制权限共享；如果已经在共享，则重新打印链接/二维码 |
| `/collab <relay>` | 通过指定 relay 开始共享（`relay.example.com`、`ws://localhost:7475`） |
| `/collab view` | 开始以只读方式共享；如果已经在共享，则重新打印链接/二维码 |
| `/collab status` | 显示链接与参与者 |
| `/collab stop` | 停止共享 |
| `/join <link>` | 以访客身份加入共享会话 |
| `/leave` | 离开（访客）或停止共享（主机） |

## 链接格式

`/join <link>` 与 `musepi join "<link>"` 可接受的格式：

```
<roomId>.<key>                                                    → 默认 relay（wss://my.omp.sh）
<roomId>#<key>                                                    → 旧版裸格式
host[:port]/r/<roomId>.<key>                                     → 自定义 relay，推断为 wss://
host[:port]/r/<roomId>#<key>                                     → 旧版直接 relay 格式
https://host[:port]/r/<roomId>.<key>                             → 直接 relay URL，规范化为 wss://
wss://host[:port]/r/<roomId>.<key>                               → 直接 websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                             → 直接明文 ws，仅限 localhost
https://host[:port]/#<link>                                      → web UI 与 relay 同主机时的浏览器 deep link
https://web-host[:port][/<path>]/#<relay-link>                   → 浏览器 UI wrapper，relay link 在 fragment 中
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → web UI 与 relay 在不同主机
```

`<link>` / `<relay-link>` 会递归解析为上述任意可接受格式。对于带有可解析 fragment 的 `http(s)` 浏览器包装链接，fragment 优先，HTTP host/path 才被视为 relay。这使得 `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` 可以在 `web.example` 打开 web UI，同时加入 `wss://relay.example.com/r/<roomId>`。如果 fragment 不是完整的 collab 链接，解析会回退到旧版直接 relay 格式，因此 `https://relay.example.com/r/<roomId>#<key>` 仍表示 relay `relay.example.com`。

末尾的 `.<key>` 或 `#<key>` 部分是 room secret，使用 base64url 编码，有两种强度：

- **Full link** — 48 字节：32 字节 AES-256-GCM room key + 16 字节 write token。允许提问、中断和 subagent 控制。
- **View-only link** — 仅 32 字节 key，无 write token。仅允许实时读取。旧链接会被解析为只读。

新生成的链接使用点号拼接 room secret，是因为 RFC 3986 禁止 URL fragment 中出现原始 `#`；解析器仍接受旧版 `#` 格式和 `%23` 转义的旧版 deep link。

## 端到端加密

每个会话 payload（entries、events、state、prompts）在进入 socket 前都以 AES-256-GCM 密封。relay 只能看到：

- room id 和连接数，
- 不透明密文帧及其大小，
- 4 字节路由前缀（用于标识帧的目标 guest）。

掌握链接即掌握信任边界：full link 可以读取并操控会话，view-only link 只能读取。请像保管密钥一样分享这两类链接。

## 访客权限模型

两级信任，由链接本身强制执行——主机在加入时校验 16 字节 write token，拒绝无此 token 的写入请求（他们在参与者列表中显示为只读，加入提示也会说明这一点）。

持有 full link 的访客可以：

- 读取完整会话（包括加入时的 back-transcript），
- 向 agent 提问（在每位参与者的 transcript 中以姓名徽章渲染；LLM 看到的是原文 prompt——姓名仅用于展示），
- 中断 agent（Esc），
- 使用 [Agent Hub](./agent-hub.html) 管理主机的 subagents：实时表格和进度、chat（控制主机的 subagent）、kill、revive、按需查看 transcript（从主机获取），
- 回复主机交互式 `select` 和 `editor` 请求。主机只向可写访客广播待处理请求；第一条提交或取消的响应会决定结果并关闭其余展示。

持有 view-only link 的访客可以实时查看所有内容——back-transcript、流式文本、工具卡片、subagent transcript——但主机拒绝他们的提问、中断和 agent 控制请求。

所有会修改主机会话或机器的操作都是主机专属：`/model`、`/compact`、`/resume`、`/branch`、bash（`!`）、python（`$`）、skills 等。访客保留一个小的本地允许列表（`/dump`、`/export`、`/copy`、`/help`、`/hotkeys`、`/theme`、`/settings`、`/leave`、`/collab`、`/exit`、`/quit`）。

访客的已知 v1 限制：你在加入时已经开始流式输出的一轮，会从下一条消息边界开始可见。

## Web 客户端

`packages/desktop-web` 是针对相同链接的独立浏览器客户端——访客侧无需安装 musepi。relay 在 `/` 提供它，这也是 `/collab` deep link 可点击加入的原因：`https://<relay>/#<link>` 会加载客户端并从 fragment 自动连接。它渲染实时 transcript（流式文本、thinking、工具卡片）、按需 transcripts 的 subagent 面板，以及带有相同访客能力（prompt、interrupt、hub actions）的 composer。在该包内运行 `bun run dev` 用于本地实例，运行 `bun run mock-host` 使用离线脚本化主机开发，运行 `bun run build` 输出可部署到任意地方的静态 `dist/`（WebCrypto 需要 HTTPS）。客户端只与 relay 通信，key 始终留在 i…

当浏览器 UI 与 websocket relay 分开托管时，请设置 `collab.webUrl`。为空时，`/collab` 从 `collab.relayUrl` 推导 `http(s)://host[:port]`；显式 web UI URL 必须使用 `https://`，开发环境例外：仅允许 `http://localhost`。生成的浏览器 URL 仍然在 fragment 中携带 relay 专属的 collab link。

## 设置

| 设置 | 默认值 | 含义 |
|---|---|---|
| `collab.relayUrl` | `wss://my.omp.sh` | `/collab` 未内联传入 relay 时使用的默认 relay |
| `collab.webUrl` | empty | `/collab` 链接使用的浏览器 UI URL；为空时从 relay 推导；显式 `http://` 仅允许 localhost |
| `collab.displayName` | OS username | 对其他参与者显示的名称 |
| `share.serverUrl` | `https://my.omp.sh/s` | `/share` 使用的 viewer/upload base（链接为 `<base>/<id>#<key>`） |
| `share.redactSecrets` | `true` | `/share` 快照上传前运行密钥混淆器 |

## 自托管 relay

当前生产 relay 并未分发用于自托管：其 Go 源码和独立二进制文件未发布。下面列出的端点文档描述托管服务的网络契约，而不是可安装的发布版本。

用于本地协议开发，本仓库包含一个仅 WebSocket 的源码可用替代实现，位于 [`packages/desktop-web/scripts/local-relay.ts`](../packages/desktop-web/scripts/local-relay.ts)。在 `packages/desktop-web` 中运行 `bun run relay` 监听 `ws://localhost:7466`。它实现了 `/r/<roomId>`，但不提供浏览器客户端、`/share` blob 或 `/healthz`，因此不能替代生产服务。

relay 是一个小型内容无关 Go 服务。除活跃连接外不保留状态，暴露：

- `GET /` — 静态 desktop-web 访客客户端（`/collab` deep link 的目标），
- `GET /r/<roomId>?role=host|guest` — WebSocket 升级，
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob 上传、viewer 页面和 blob 获取，
- `GET /healthz` — 存活检查。

## 架构说明

Hub 拓扑——主机是权威，访客之间不直接通信：

1. `entry` 帧——持久化会话条目，在 blob 外部化前广播，使图片保持内联（访客无法解析主机 blob 引用）。访客原样追加这些条目（id 保留）到 `~/.musepi/collab/<roomId>.jsonl` 下的 replica 会话文件，并写入 agent 的 message array，这也是 `/dump` 和上下文估算可用的原因。
2. `event` 帧——实时 agent 事件，直接送入访客的常规事件控制器；只按事件渲染以避免重复渲染。
3. `state` 帧——防抖页脚快照：streaming 标志、主机完整 model 对象和 thinking level（应用到访客的 replica agent state，因此 model 显示和 context-window 计算是原生行为）、主机 context 数字、以及参与者。
4. `bus` 帧——镜像 task-subagent 生命周期/进度 EventBus 流量，重新发布到访客的本地 bus，使 subagent HUD 和 status-line 计数以原生方式工作。
5. `agents` 帧——agent-registry 快照，喂给访客本地 registry，使 Agent Hub 表能渲染主机 subagents。

访客→主机：`hello`、`prompt`、`abort`、`agent-cmd`（hub chat/kill/revive）和 `fetch-transcript`（增量 subagent-transcript 读取，通过定向 `transcript` 帧回答）。replica 通过常规 `/resume` 机制加载，因此 theming、ctrl+o 和 transcript 行为都是原生构造；访客进程不会对主机路径执行 chdir。
