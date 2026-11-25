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
| `/collab lan` | 在局域网内共享（自托管 relay，无公网端点） |
| `/collab tunnel [cloudflared\|ngrok\|tailscale]` | 通过公网隧道共享（无内联参数时读取 `collab.exposure`） |
| `/pair` | 启动局域网共享并显示手机 App 的 6 位配对码 |
| `/join <link>` | 以访客身份加入共享会话 |
| `/leave` | 离开（访客）或停止共享（主机） |

## 默认 relay 之外的共享

`/collab` 默认走生产 relay。需要 agent 留在本机时，分享可以改用本地 relay，变化的只是访客抵达它的路径——加密房间协议在所有模式下完全相同。

| 模式 | 命令 | 访客从哪里连 | 需要 |
|---|---|---|---|
| 局域网 | `/collab lan` 或 `/pair` | 同一网络 | 无 |
| Cloudflare Tunnel | `/collab tunnel cloudflared` | 拿着链接即可 | `cloudflared` 二进制 |
| ngrok | `/collab tunnel ngrok` | 拿着链接即可 | `ngrok` 二进制及其免费 authtoken |
| Tailscale Serve | `/collab tunnel tailscale`，或 `collab.exposure = tailscale` 的分享 | 你的 tailnet | 两端都安装 Tailscale |

`/collab tunnel` 未内联指定传输时使用 `collab.exposure`，内联接受 `cloudflared`、`ngrok`、`tailscale`；配置为任意已注册曝光的 id 也可以作为默认值。daemon/GUI 分享（`collab.start`）读取同一设置。

### 局域网

局域网共享把 relay 绑到 `0.0.0.0`，并按每块可路由网卡打印链接。终端用明文 `ws` 加入；浏览器需要安全上下文才能用 WebCrypto，因此第二个带自签名证书的 relay 提供 `https`/`wss` deep link。若已安装 Tailscale 且 Serve 可用，分享还会打印一个带真实证书的 tailnet 链接（浏览器无警告）；这项尽力而为的装饰永远不会让局域网共享失败。

### Cloudflare Tunnel

quick 模式零配置：`cloudflared tunnel --url ws://localhost:<port>` 会打印随机的 `https://<id>.trycloudflare.com`，每次启动都会变。URL 从 `--logformat json` 输出解析（纯文本日志同样可解析），并在展示链接前探测公网主机——被封的边缘节点会立刻给出可诊断的错误，而不是之后一个死掉的 WebSocket。

named 模式需要 `collab.cloudflaredHostname` 和隧道 token。token 存放在加密密钥库的 `collab.cloudflared.<tunnelId>` 下，绝不进入设置、argv 或日志（子进程通过 `TUNNEL_TOKEN` 环境变量接收），链接为 `https://<hostname>`，重启后保持不变。

### ngrok

`/collab tunnel ngrok` 运行 `ngrok http <port>` 并从其 JSON 日志解析公网 URL。ngrok 免费层需要一次性执行 `ngrok config add-authtoken <TOKEN>`；MusePi 会提示这一步，但不会替你执行。

### Tailscale Serve

Serve 通过 `https://<machine>.<tailnet>.ts.net` 暴露 relay。它不再要求 serve 配置为空：MusePi 先用 `tailscale serve get-config --all` 备份当前配置，把 relay 挂到 443，443 已被占用时回退到 8443（端口写进链接）。停止时只移除自己那一条（`tailscale serve --https=<port> off`），再用 `tailscale serve set-config` 恢复备份——绝不使用 `tailscale serve reset`。MusePi 从不运行 `tailscale up`，也不保存任何 Tailscale 凭据；未登录、MagicDNS 关闭或 HTTPS 证书不可用时，会指出具体该去管理后台改哪个开关。

### 健康检查、撤销与时限

每条隧道都盯着自己的子进程，并每 30 秒探测一次公网主机。隧道失效会立即撤销：URL 清空，health 变为 `degraded` 并带上原因与下一步建议，背后的 relay 同时关闭。分享状态是权威的——`remote-access.status` 返回 `mode`、`sessionId`、`exposure` 和 `health`，并在 host 结束、会话切换或曝光失效后报告 `hosting: false`，分享面板不会继续展示死链接。原因不会随记录一起消失：`hosting` 为 `false` 时，同一应答会带上 `lastEnd {exposure, health, at, reason, detail, hint}`（下次 `collab.start` 时清空），失效隧道的 `detail` 与下一步 `hint` 正是从这里到达 UI。应答还会在某个配置值让分享的一部分不可用时带上 `warning`——例如不可用的 `collab.webUrl`，其来源会被 relay 以 `403` 拒绝。分享运行中、复用同一分享时，以及分享停止后，都会返回同一条提示；重新开始分享时会重新计算。

`collab.shareTtlMinutes`（默认 `0`，不自动停止）会在配置的分钟数后自动停止分享。限时分享会在 `remote-access.start` 与 `remote-access.status` 中报告截止时刻 `expiresAt`（epoch 毫秒），面板据此倒计时，而不是让访客自己发现分享已经停止；未配置时限时该字段不出现，分享结束后也随之消失。

### 隐私边界

- **局域网** — 流量只在你自己的网络里；浏览器链接是带自签名证书的 `https`，tailnet 链接（若显示）由 Tailscale 加密。
- **公网隧道** — Cloudflare 或 ngrok 在边缘终结 TLS，能看到连接元数据，但看不到房间内容（内容端到端密封）。公网 URL 本身不是秘密：fragment 里带着房间密钥，拿到完整链接的人就能操控会话。
- **Tailscale** — relay 只在你的 tailnet 内可达；访客需要安装 Tailscale 并登录同一个 tailnet。

### 扩展曝光方式

自托管 relay 是插件而不是内置功能：在你的插件加载时向进程级 registry 注册一个传输实现。

```ts
import { BaseExposure, exposureRegistry } from "@musepi/pi-coding-agent/collab/exposure";

exposureRegistry.register("my-relay", () => new MyRelayExposure());
```

一个曝光声明 `id`、`label`、`capabilities`（`guestInstall`、`publicExposure`、`stableUrl`、`thirdParty`）、`probe()`、`start({ port })`、`close()`，并通过 `onChange` 报告 `unavailable | starting | ready | degraded | stopped` 健康状态。`LocalShareManager` 按 id 解析它（`startExposure("my-relay")`），daemon 在 `collab.exposures` 中列出它，变为 degraded 时会自动撤销 relay。协议无需改动：传输实现只需要提供一个访客能抵达的 origin。

### 什么时候不该用公网隧道

- 两端都能上网、且不需要 agent 留在本机时，默认 relay 就够了。
- 同网络设备优先用局域网，两端都在同一 tailnet 时优先用 Tailscale。
- 不要只图方便就把机器暴露到公网：完整链接能读取整个会话历史并操控 agent。
- 企业网络常屏蔽 `trycloudflare.com`；改用局域网或自有域名上的 named 隧道。

## 链接格式

`/join <link>` 与 `musepi join "<link>"` 可接受的格式：

```
<roomId>.<secret>                                                 → 默认 relay（wss://my.omp.sh）
<roomId>#<secret>                                                 → 旧版裸格式
host[:port]/r/<roomId>#<secret>                                   → 自定义 relay，推断为 wss://
host[:port]/r/<roomId>.<secret>                                   → 旧版直接 relay 格式
https://host[:port]/r/<roomId>#<secret>                           → 直接 relay URL，规范化为 wss://
https://host[:port]/r/<roomId>.<secret>                           → 旧版直接 relay 格式
wss://host[:port]/r/<roomId>#<secret>                             → 直接 websocket relay URL
wss://host[:port]/r/<roomId>.<secret>                             → 旧版直接 websocket relay 格式
ws://localhost:7475/r/<roomId>#<secret>                           → 直接明文 ws，仅限 localhost
https://host[:port]/#<link>                                       → web UI 与 relay 同主机时的浏览器 deep link
https://web-host[:port][/<path>]/#<relay-link>                    → 浏览器 UI wrapper，relay link 在 fragment 中
https://web.example/collab/#relay.example.com/r/<roomId>.<secret> → web UI 与 relay 在不同主机
```

新生成的直接链接把 room secret 放在 fragment 里（`/r/<roomId>#<secret>`）：URL path 会发送给最外层的代理并被它记录——隧道分享里就是隧道边缘——而 fragment 永远不离开客户端。旧版 path 形态（`/r/<roomId>.<secret>`）仍会被解析。仍有两种形态继续生成它：默认 relay 的裸格式（`<roomId>.<secret>`，没有 origin 或 path 可以携带 `#`），以及浏览器 deep link 的内层链接（fragment 里再出现一个 `#` 会被严格的 URL 栈转义）。

`<link>` / `<relay-link>` 会递归解析为上述任意可接受格式。对于带有可解析 fragment 的 `http(s)` 浏览器包装链接，fragment 优先，HTTP host/path 才被视为 relay。这使得 `https://web.example/collab/#relay.example.com/r/<roomId>.<secret>` 可以在 `web.example` 打开 web UI，同时加入 `wss://relay.example.com/r/<roomId>`。如果 fragment 不是完整的 collab 链接，解析会回退到旧版直接 relay 格式，因此 `https://relay.example.com/r/<roomId>#<secret>` 仍表示 relay `relay.example.com`。

末尾的 `.<secret>` 或 `#<secret>` 部分是 room secret，使用 base64url 编码，有两种强度：

- **Full link** — 48 字节：32 字节 AES-256-GCM room key + 16 字节 write token。允许提问、中断和 subagent 控制。
- **View-only link** — 仅 32 字节 key，无 write token。仅允许实时读取。旧链接会被解析为只读。

解析器接受两种 secret 位置（以及 `%23` 转义的旧版 deep link）。只有 fragment 位置能让 secret 不进入代理日志；嵌在另一个 fragment 里的链接使用 path 位置，因为 RFC 3986 禁止那里出现原始 `#`。

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

`packages/client-core` 是针对相同链接的独立浏览器客户端——访客侧无需安装 musepi。relay 在 `/` 提供它，这也是 `/collab` deep link 可点击加入的原因：`https://<relay>/#<link>` 会加载客户端并从 fragment 自动连接。它渲染实时 transcript（流式文本、thinking、工具卡片）、按需 transcripts 的 subagent 面板，以及带有相同访客能力（prompt、interrupt、hub actions）的 composer。在该包内运行 `bun run dev` 用于本地实例，运行 `bun run mock-host` 使用离线脚本化主机开发，运行 `bun run build` 输出可部署到任意地方的静态 `dist/`（WebCrypto 需要 HTTPS）。客户端只与 relay 通信，key 始终留在 i…

当浏览器 UI 与 websocket relay 分开托管时，请设置 `collab.webUrl`。为空时，`/collab` 从 `collab.relayUrl` 推导 `http(s)://host[:port]`；显式 web UI URL 必须使用 `https://`，开发环境例外：`http://` 仅允许 localhost、回环地址或私有地址。生成的浏览器 URL 仍然在 fragment 中携带 relay 专属的 collab link。对于自己启动 relay 的分享，配置的 UI 来源也会传给该 relay，因此跨源 WebSocket 会被接受，而不是被 Origin 门以 `403` 拒绝。

## 设置

| 设置 | 默认值 | 含义 |
|---|---|---|
| `collab.relayUrl` | `wss://my.omp.sh` | `/collab` 未内联传入 relay 时使用的默认 relay |
| `collab.webUrl` | empty | `/collab` 链接使用的浏览器 UI URL；为空时从 relay 推导；显式 `http://` 仅允许 localhost 或私有地址 |
| `collab.displayName` | OS username | 对其他参与者显示的名称 |
| `collab.exposure` | `cloudflared` | `/collab tunnel` 与未指定传输的隧道分享使用的默认曝光 id |
| `collab.cloudflaredHostname` | empty | named Cloudflare 隧道的 hostname；为空时使用 quick 隧道 |
| `collab.shareTtlMinutes` | `0` | 局域网或隧道分享在多少分钟后自动停止；`0` 表示一直共享到手动停止 |
| `share.serverUrl` | `https://my.omp.sh/s` | `/share` 使用的 viewer/upload base（链接为 `<base>/<id>#<key>`） |
| `share.redactSecrets` | `true` | `/share` 快照上传前运行密钥混淆器 |

## 自托管 relay

当前生产 relay 并未分发用于自托管：其 Go 源码和独立二进制文件未发布。下面列出的端点文档描述托管服务的网络契约，而不是可安装的发布版本。

用于本地协议开发，本仓库包含一个仅 WebSocket 的源码可用替代实现，位于 [`packages/client-core/scripts/local-relay.ts`](../packages/client-core/scripts/local-relay.ts)。在 `packages/client-core` 中运行 `bun run relay` 监听 `ws://localhost:7466`。它实现了 `/r/<roomId>`，但不提供浏览器客户端、`/share` blob 或 `/healthz`，因此不能替代生产服务。

relay 是一个小型内容无关 Go 服务。除活跃连接外不保留状态，暴露：

- `GET /` — 静态 guest-client 访客客户端（`/collab` deep link 的目标），
- `GET /r/<roomId>?role=host|guest` — WebSocket 升级，
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob 上传、viewer 页面和 blob 获取，
- `GET /healthz` — 存活检查。

### relay 的心跳、限制与关闭码

所有进程内 relay——局域网、隧道和 `collab.start` 分享运行的那个——遵循这套连接契约；客户端对任何 relay 应用相同的关闭码规则：

- **心跳** — 每 25 秒发一次 WebSocket ping。一个 ping 整整一个间隔都没有回应的 peer 被视为半开连接（Wi-Fi 切换、Doze、NAT 过期），会被断开；这些流量也让安静隧道的空闲计时器不会关掉健康分享。客户端会自动回应 ping。
- **主机掉线与重认领** — 主机连接没有正常关闭就消失时，房间保留 30 秒。访客会收到 `4001` 并在该窗口内退避重试（从第一次 `4001` 起最多 30 秒、五次尝试）；主机用同一链接重连即可重认领同一房间，并获知窗口期内加入的访客。主机正常关闭则房间立即结束，relay 停止服务时访客收到 `1001`。
- **关闭码** — `4001` 表示主机暂时不在、房间可能回来：重试。`4004` 表示房间已不存在（主机停止、宽限期结束，或链接来自旧分享）：重试没有意义。`1001` 表示 relay 本身停止服务：同样终止。`4009`（另一个主机占着房间）和 `4029`（房间已满）对本次尝试是终止。`1008` 是策略性拒绝——同一地址访客过多，或入站字节速率超限——客户端可以重连，但同一个条件会反复出现，直到原因改变；`1013` 表示 relay 的 64 个房间上限，应稍后重试；全局连接上限（256）在升级前直接以 HTTP `503` 拒绝。
- **准入限制** — 进程内 relay 对每个客户端地址同时允许 32 条已升级连接、每分钟 60 次新升级，以及 16 条尚未升级的 socket。后两项预算刻意分开：加载浏览器页面及其资源只花 pending 预算，从不花加入预算，所以刷新风暴不会把真正的访客锁在外面。全局上限为 256 条连接与 64 个房间；每个房间 16 位访客，同一地址最多 8 位。升级前的拒绝走 HTTP：来源不允许返回 `403`，连接数或速率受限返回 `429`，达到全局连接上限返回 `503`。
- **Origin 门** — 浏览器会在 WebSocket 升级时带上 `Origin`。relay 接受自己的 origin、内置 App 外壳（`https://localhost`、`capacitor://localhost`、`ionic://localhost`）以及 `allowedOrigins` 中传入的来源；不带 `Origin` 的终端客户端放行。这也是进程内分享会自动接受 `collab.webUrl` 来源的原因：UI 与 relay 可以分别由不同 origin 提供。

### 加入失败时怎么排查

| 现象 | 含义 | 处理 |
|---|---|---|
| 浏览器加入时 `403` / “origin not allowed” | 页面来源既不是 relay 自己的，也不在允许列表 | 把 UI 交给 relay 提供；设置 `collab.webUrl` 让进程内分享自动允许；自托管 relay 则把来源加进 `allowedOrigins` |
| `429` / “connection rate limit” | 同一地址一分钟内升级过多，或持有的活跃/待升级 socket 过多 | 等一分钟、关掉多余标签页，避免反复刷新 |
| `4004` / “no such room” | 主机已停止、分享 TTL 到期、30 秒重认领窗口结束，或链接来自旧分享 | 重新开始分享并把新链接发出去 |
| `4001` 反复出现 | 主机连接掉线，房间正在等它回来 | 让访客在 30 秒内继续重试，并检查主机的网络或隧道；五次尝试后重新分享 |
| `1001` / “sharing stopped” | relay 本身停止服务 | 等 relay 恢复后重连；链接本身仍有效 |
| `1008` / “too many guests from one address” | 同一地址已占满房间 16 个访客位中的 8 个（单地址公平上限） | 换一个地址加入，或自托管一个提高单地址上限的 relay |
| `1008` / “byte rate limit exceeded” | 客户端向 relay 发送的速率超过 32 MiB/s | 通常是客户端进入循环或有 bug；先修好再重连，否则上限会再次触发 |
| `1013` / “relay is at capacity” | relay 达到 64 个房间上限 | 稍后重试，或自托管一个提高房间上限的 relay |
| `503` / “relay is at capacity” | relay 在升级前已达到全局连接上限（256） | 稍后重试，或自托管一个提高连接上限的 relay |
| `4009` / “host conflict” | 另一个主机已经占着该 room id | 停掉那个主机，或等它错过一个心跳间隔；room id 属于单次分享，重新分享即可避开 |
| `4029` / “room is full” | 房间达到 16 位访客上限 | 改用访客更少的只读分享，或自托管一个提高房间上限的 relay |
| web UI 能打开但会话连不上 | UI 来源与 relay 来源不同，且 relay 不允许 UI 的来源 | 进程内分享设置 `collab.webUrl`；自托管 relay 则允许该 UI 来源 |

## 架构说明

Hub 拓扑——主机是权威，访客之间不直接通信：

1. `entry` 帧——持久化会话条目，在 blob 外部化前广播，使图片保持内联（访客无法解析主机 blob 引用）。访客原样追加这些条目（id 保留）到 `~/.musepi/collab/<roomId>.jsonl` 下的 replica 会话文件，并写入 agent 的 message array，这也是 `/dump` 和上下文估算可用的原因。
2. `event` 帧——实时 agent 事件，直接送入访客的常规事件控制器；只按事件渲染以避免重复渲染。
3. `state` 帧——防抖页脚快照：streaming 标志、主机完整 model 对象和 thinking level（应用到访客的 replica agent state，因此 model 显示和 context-window 计算是原生行为）、主机 context 数字、以及参与者。
4. `bus` 帧——镜像 task-subagent 生命周期/进度 EventBus 流量，重新发布到访客的本地 bus，使 subagent HUD 和 status-line 计数以原生方式工作。
5. `agents` 帧——agent-registry 快照，喂给访客本地 registry，使 Agent Hub 表能渲染主机 subagents。

访客→主机：`hello`、`prompt`、`abort`、`agent-cmd`（hub chat/kill/revive）和 `fetch-transcript`（增量 subagent-transcript 读取，通过定向 `transcript` 帧回答）。replica 通过常规 `/resume` 机制加载，因此 theming、ctrl+o 和 transcript 行为都是原生构造；访客进程不会对主机路径执行 chdir。
