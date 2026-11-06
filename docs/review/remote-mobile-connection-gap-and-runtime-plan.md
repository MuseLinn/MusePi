# 远程连接与移动端本地运行时：参考实现、MusePi 差距与设计准备

> 工作文档，不是长期规格。结论稳定后，长期能力应搬进 `docs/remote-workspace.md`、`docs/mobile-design.md` 或对应 ADR，本文再删除。
>
> 分析时间：2026-11-05。参考仓库版本：comma `66ab3dc`（2026-10-27）、openchamber `0137dc30`（2026-11-05）、dsh-go `03a68139`（2026-11-05）。
> 方法：逐仓读码 + 抽样复核；下文所有 `路径:行` 均为代码锚点，标注「推断」的条目没有直接代码证据。

---

## 0. 一页结论

1. **comma 和 openchamber 代表两种相反的连接哲学。** comma 把连接平面放在自己的云与 Agent Pod 里：客户端只见 HTTPS API，Tailscale 只跑在服务端，Cloudflare 只做 Worker 控制面。openchamber 把连接平面放在用户自己的机器上：公网隧道、SSH 转发、Private Relay 三选一，服务端是一个可自托管的 Bun 进程。
2. **Tailscale 在两家都不是「客户端 VPN」。** comma 在 Pod 内为每个 Agent Group 跑一个 `tsnet` 节点，只用 netstack 出站拨号，不经宿主机网络，也不开 Serve/Funnel。openchamber 与 MusePi 则是 shell 调用 `tailscale serve|funnel`，把本机端口挂到 `*.ts.net`。
3. **Cloudflare 在两家承担不同角色。** comma 用 Workers 做签名控制面（容器启停、Mini App 分发、nonce 防重放），**全仓没有 cloudflared**。openchamber 把 cloudflared 当作一等 tunnel provider（quick / managed-token / config-file），Private Relay 则是独立 Cloudflare Worker + E2EE。
4. **MusePi 已有可用的连接零件，但缺一层统一的连接模型。** SSH+sshfs、`serve --remote-token`、collab relay、cloudflared quick tunnel、tailscale serve 都在代码里；但它们是四个互不复用的子系统，移动端只会走 collab，且没有候选集、没有中继兜底、没有设备撤销。
5. **移动端最大的产品缺口不是「连不上」，而是「离开家就连不上，且只能靠用户在桌面手动开隧道」。** 这需要一条宿主主动出站的中继（openchamber Private Relay 模式），而不是继续堆隧道 provider。
6. **移动端本地运行时可以走 dsh-go 验证过的 proot 路线，但有一个硬决策门：`targetSdk`。** dsh-go 用 `targetSdk 28` 换取 app 私有目录 `exec`；MusePi 现在 `targetSdk 36`。不解决这一点，内嵌运行时无法落地。建议先做 2 周可行性 spike，再决定是否接受 targetSdk 28、退到 Termux 伴生，或维持纯远程。

---

## 1. 三种参考范式

### 1.1 comma：云 API + 服务端连接平面

客户端链路（`D:/Projects/Agents/references/comma/clients/packages/core/src/api.ts:224-263`）：

```
UI → core（TS，跑在 Electron utility process / iOS Hermes / Worker）
   → host（注入 bearer 或 httpOnly Cookie，校验 lease）
   → HTTPS /v1/comma/...
```

- 客户端**不含任何 Tailscale SDK / VPN 代码**；`clients/packages/core/src/tailnet.ts:16,203-225` 只是轮询服务端节点状态，给设置页展示登录链接。
- 客户端只见「产品 API」，真正的设备/Agent 连接由服务端用 iroh mesh 完成（`via = direct / relay / salix`）。
- 断线恢复完全在 core：SSE 65 s 一连接、1→2→4→8→10 s 退避、`?after=<checkpoint>` 续读（`clients/packages/core/src/history.ts:288-355`）。
- 授权变更用「代际作废」：换账号/登出即 `advanceGeneration()`，旧 lease 关闭，在途请求立刻 `signed_out`（`clients/packages/core/src/session.ts:108-131`）。

**适用条件**：你有自己的云、愿意托管 Agent 运行时、客户端可以永远只当瘦客户端。MusePi 当前不是这个形态。

### 1.2 openchamber：自托管服务端 + 三条远程路径

| 路径 | 实现位置 | 形态 |
| --- | --- | --- |
| 公网隧道 | `packages/web/server/lib/tunnels/*` | 服务端起 cloudflared / ngrok / tailscale 子进程，产出公网 URL；bootstrap token 换 Cookie |
| SSH 转发 | `packages/electron/ssh-manager.mjs` | Electron 主进程 SSH 到远端，`-L` 把远端 OpenChamber 端口转到本机；13 阶段状态机 |
| Private Relay | `packages/web/server/lib/relay/*` + `packages/ui/src/lib/relay/*` | 宿主主动出站 WSS 到 relay，客户端也出站；relay 只转密文；E2EE + 配对 secret |

关键设计：

- **隧道 provider 只有 4 个方法**（`start/stop/checkAvailability/resolvePublicUrl`）+ 能力表，UI 由能力表驱动（`D:/Projects/Agents/references/openchamber/packages/web/server/lib/tunnels/registry.js`、`.../TunnelSettings.tsx:512-524`）。
- **起新的再撤销旧的**：新隧道起来后才撤销旧 bootstrap token 与旧会话，并返回「几条链接失效」（`.../tunnels/routes.js:537-548`）。这避免了切换窗口期的可用空档。
- **公网侧绕过 UI 密码**：tunnel scope 下密码/Passkey/登出直接 403，只认 `oc_tunnel_session` Cookie（`.../opencode/core-routes.js:734-846`）。
- **移动端把实例建模成候选集**：`{kind:'direct',url}` 与 `{kind:'relay',relay}` 混排，index 0 优先；连接时 direct 链与 relay 探针竞速，relay 让出 1.5 s headstart（`D:/Projects/Agents/references/openchamber/packages/ui/src/apps/mobileConnections.ts:963,1051-1112`）。
- **秘密只走原生通道**：WebView 的 `fetch/EventSource/WebSocket` 都不能带自定义头，于是分别用 `CapacitorHttp`、流式 fetch、原生 WS 插件替代（`.../mobileConnections.ts:374-396`、`.../relay/runtime-socket.ts:18-30`）。

**适用条件**：用户自己跑服务端，产品不托管用户数据。这与 MusePi 的「桌面 daemon + 手机加入」最接近。

### 1.3 dsh-go：账号服务器 + Relay/WebRTC + 本地 proot 运行时

远程侧（`D:/Projects/Agents/references/dsh-go/packages/dsh_remote/README.md`）：

- 远程与本地共用同一个 `DshClient`，差异收敛到 carrier 一层：`RemoteTunnelCarrier extends DshCarrier`，只在 endpoint 白名单、无 uplink、大包分块、错误映射四处不同（`.../lib/src/carrier/tunnel_carrier.dart:187-195`）。
- 数据面抽象成 `SecureHandshakeTransport`，Relay 与 WebRTC 都实现它；Noise IK 之上完全不知道走了哪条路（`.../lib/src/transport/transport.dart:88`、`relay_transport.dart:68`、`webrtc_transport.dart:40`）。
- 选路是三阶段、每阶段重开新连接：直连（纯 STUN）→ TURN → Relay；失败即换路径重新握手（`.../lib/src/account/remote_account.dart:974-1057`）。
- 信任是「REST 下发 Host 公钥 + 本地 pin + Noise 握手内二次比对」三段验证（`remote_account.dart:1084-1122`、`.../crypto/noise_ik.dart:444-449`）。

本地运行时侧（`D:/Projects/Agents/references/dsh-go/docs/architecture.md`、`app/android/.../runtime/*`）：

- Ubuntu 24.04 rootfs + Node + `dsh`，经 Termux `proot` 运行；App 只管理进程，不代理 HTTP。
- proot/loader 改名 `lib*.so` 放 jniLibs，`useLegacyPackaging=true` 解压到 `nativeLibraryDir`；`targetSdk=28` 换取 guest 可执行。
- 安装是事务：`staging/` 解压 → 原子换名 `rootfs/` → `/root` 移到 `home.carry` → `sync()` → 最后写 `rootfs.version`（`RuntimeInstaller.kt:164-202`）。
- 启动就绪判据是「token 正则 + TCP 可连」，不是 HTTP 200；token 180 s、端口 90 s 两个独立超时（`DshProcess.kt:336-357,443`）。
- 停机三级：guest `dsh` SIGTERM → 5 s 后 proot SIGQUIT → 2 s 后 `destroyForcibly`（`DshProcess.kt:266-291`）。
- 失败恢复三层：`CrashClassifier` → 2 次触发安全模式 → 插件集 `LastKnownGood`（`SafeMode.kt:28-39`、`RuntimeController.kt:745-818`）。

### 1.4 四家对比

| 维度 | comma | openchamber | dsh-go | MusePi 现状 |
| --- | --- | --- | --- | --- |
| 连接平面归属 | 厂商云 + Agent Pod | 用户机器 | 厂商账号服务器 + 用户 Host | 用户桌面 daemon |
| 客户端发现 | 构建期 API 基址 | 配对 v2 候选集 / SSH / 手动 URL | 账号登录 + Host 列表 | QR / 6 位码 / 粘贴链接 |
| 远程传输 | HTTPS（客户端不直连设备） | tunnel / SSH 转发 / E2EE relay | Relay / WebRTC(直连/TURN) | collab relay（LAN 或桌面开隧道） |
| 信任锚 | 产品租约 + bearer | 宿主 ECDH 公钥 + 配对 secret | Host 公钥 pin + Noise | 房间密钥（32/48 B） |
| 设备级撤销 | 租约代际 + APNs 重授权 | client token 吊销 + relay 撤链 | 每设备一条连接，被顶即 4003 | 无（停共享才失效） |
| 后台/推送 | APNs + Live Activity + 30 s SSE 窗口 | 推送 relay（加密 payload） | 移动端未深入 | 仅本地通知，无推送 |
| Tailscale 角色 | 服务端 tsnet，按 Group 一个节点 | CLI serve/funnel provider | 仅把 100.64/10 归为 CGNAT | CLI serve，仅消除证书警告 |
| Cloudflare 角色 | Workers 控制面，无 cloudflared | cloudflared provider + relay Worker | share-worker（下载分发） | cloudflared quick tunnel |

---

## 2. Tailscale 用法拆解

### 2.1 comma：服务端 `tsnet`，客户端零感知

- 每个 Salix Pod 跑一个 `salix-tailnet-gateway` 进程，按 Group 起多个 `tsnet` 节点（`D:/Projects/Agents/references/comma/systems/tailnet-gateway/README.md:3-6`）。
- 身份不在 Pod 磁盘：自定义 `tsnet.Store`，每次 `WriteState` 必须同步回 owner 的租约记录，写不进就停节点（`.../gateway.go:287`、`store.go:41`）。换 Pod 把保存的 state 塞回 `start` 即可，免二次审批。
- 拨号只走 netstack，并强制目标必须来自 netmap 的 peer 地址或已批准子网，显式排除 `/0`（`.../node.go:324-350`、`policy.go:29-55`）。
- 纯客户端：`ShieldsUp:true`，无监听器、无 Tailscale SSH、无 Serve/Funnel、不传日志（`.../node.go:165-177`、`README.md:41-45`）。
- 生命周期按需：idle 15 min、等审批 30 min、租约 30 s 续 10 s。

**可复用点**：如果 MusePi 未来有「托管 Agent 运行时」，这是最干净的模型——用户不需要在手机装 VPN，Tailscale 只存在于服务端；客户端仍然只连 HTTPS。

### 2.2 openchamber：CLI provider，进程存活即隧道

- `serve`（仅 tailnet 内）与 `funnel`（公网）两种模式，共用同一个前台子进程；杀掉进程即撤销（`D:/Projects/Agents/references/openchamber/packages/web/server/lib/tailscale-tunnel.js:110-136`）。
- 首次使用从 stdout 抓 `login.tailscale.com/f/...` 审批链接，回传 `approval_required`（`.../tailscale-tunnel.js:161-170`）。
- HTTPS 端口限制 443/8443/10000；macOS 绕过 App 的 `/bin/sh` wrapper 直接调 bundle 二进制，否则信号杀不掉（`.../providers/tailscale.js:22-48`、`.../tailscale-tunnel.js:16,29-31`）。
- 运行期没有健康检查；隧道断了 `status` 仍可能返回旧 URL（`.../tunnels/routes.js:611-629` 只覆盖显式 stop）。

### 2.3 MusePi：只把 Tailscale 当「证书修复」

- `packages/coding-agent/src/collab/tailscale-serve.ts:58-90`：先 `serve status --json`，已有用户配置、CLI 缺失、HTTPS 非付费版一律返回 `null`。
- 成功则 `tailscale serve --bg http://localhost:<port>`，从 stdout 抓 `https://<machine>.<tailnet>.ts.net`；失败静默降级到自签 LAN 链接（`:80-105`）。
- 只在 LAN 共享启动时 best-effort 调用（`packages/coding-agent/src/collab/local-share.ts:165`），tunnel 模式不走 Tailscale。
- 移动端代码不感知 Tailscale；`packages/collab-proto/src/link.ts:99` 把 `100.64/10` 当私有地址允许明文 `ws://`，理由是该网段本身已加密。

**结论**：MusePi 的 Tailscale 只解决「浏览器证书警告」，没有把它当连接平面。它既没有 `funnel` 公网模式，也没有服务端 `tsnet`，更没有客户端 tailnet 发现。

### 2.4 三种用法怎么选

| 场景 | 推荐 | 理由 |
| --- | --- | --- |
| 厂商托管 Agent，用户设备只是 UI | comma 式服务端 tsnet | 用户零安装；ACL 在 tailnet 侧；服务端可审计 |
| 用户自托管桌面，手机偶尔远程 | openchamber 式 `serve`/`funnel` provider | 无需自建中继；但依赖用户装 Tailscale 且接受 CLI |
| 手机与桌面都在同一 tailnet | 直接用 tailnet IP/MagicDNS + `serve` | MusePi 已有 `100.64/10` 明文例外，成本最低 |
| 不想让用户装任何 VPN | 自建 E2EE relay | openchamber Private Relay / dsh-go Relay 路径 |

MusePi 目前只覆盖第三行的一半：能生成 ts.net URL，但没有把「tailnet 候选」纳入连接模型，也没有 `funnel` 公网模式。

---

## 3. Cloudflare 用法拆解

### 3.1 comma：Workers 是控制面，不是数据面

- 三个项目里只有两个真代码：`miniapp-dispatch`、`salix-vm-gateway`；`meet-token-factory` 只是部署壳，源码在外部仓库（`D:/Projects/Agents/references/comma/systems/cloudflare/meet-token-factory/source.lock.json:2-3`）。
- `salix-vm-gateway` 的 Worker **不代理容器流量**：`managed_sandbox.ts:125-128` 把 DO 的 `fetch` 直接返回 409，`:183-191` 把 SDK 的 auto-start/containerFetch/start/destroy 全部 override 成抛错；README 原文「Nothing reaches the Container through the Worker」。
- 容器自己出站：entrypoint 起 station，把 `https://` 改写成 `wss://…/v1/connect` 并带 `Bearer workloadCredential`（`.../entrypoint.sh:24-32,48-51`、`.../station/src/connector/connector.ts:937-948`）。
- 两个 Worker 共用一套签名协议：`x-salix-{signature,timestamp,nonce,request-id}` + HMAC-SHA256 + 每 nonce 一个 ReplayGuard DO（`.../salix-vm-gateway/src/auth.ts:21-126`、`.../miniapp-dispatch/src/app.ts:30-72`）。
- **全仓没有 cloudflared**：三份 wrangler 配置没有 `tun` 段，入站全是 custom domain 直连 Worker。

**结论**：comma 的 Cloudflare 只承担「公网固定入口 + 短请求仲裁 + 容器启停」，与 Tailscale 的分界是「谁发起连接」——需要公网固定端点、需要 DO 串行化的走 Worker；设备/容器主动连出的私有长连接走 Tailscale/iroh。

### 3.2 openchamber：cloudflared 是一等 provider，relay 是另一个 Worker

- cloudflared 三种模式：quick（临时 URL）、managed-remote（token + hostname）、managed-local（config file）；managed token 写临时文件 `0600` 并事后清理（`.../providers/cloudflare.js:23-52`、`.../cloudflare-tunnel.js:446-470`）。
- Private Relay 本体是独立 Cloudflare Worker（在 `openchamber-website` 仓库，不在本仓），只负责按 `serverId` 把两条 WSS 腿拼起来转密文；E2EE 在两端（`.../relay/DOCUMENTATION.md:5-17`）。
- relay 不负责客户端授权：`grant` 字段 v1 worker 忽略，真正的门是 E2EE + 配对 secret（`.../connectionPayload.ts:22-25`）。

**结论**：openchamber 同时用 Cloudflare 做「公开入口」（cloudflared）和「私密中继」（relay Worker），两者定位不同，互不复用。

### 3.3 MusePi：只有 quick tunnel

- `packages/coding-agent/src/collab/tunnel.ts:66-79`：30 s 等 URL，8 s 探活；失败抛 `TunnelUnreachableError` 并建议改用 LAN。
- 只支持 cloudflared quick tunnel 与 ngrok；没有 named tunnel、没有 Cloudflare Access service token、没有 config file 模式。
- 隧道生命周期由 `LocalShareManager` 管；停止分享即杀进程；没有运行期健康检查、没有自动重建。
- `docs/ota-mobile-design.md:16` 已记录 `*.r2.cloudflarestorage.com` 在中国大陆可能不可达，OTA 建议自托管。

### 3.4 结论：MusePi 缺的是「私密中继」，不是「更多隧道」

- 公网隧道解决「手机能访问桌面」，但要求**桌面在线且用户手动开隧道**，并且 URL 是公开的（安全全靠房间密钥）。
- Private Relay 解决「双方都出站、无需公网 IP、无需用户操作」，代价是厂商/自建 relay 的带宽与可用性。
- 两者应该并存：LAN → tailnet → 隧道 → relay 作为候选优先级，而不是四选一。

---

## 4. 连接层机制矩阵

| 机制 | comma | openchamber | dsh-go | MusePi |
| --- | --- | --- | --- | --- |
| 一次性配对秘密 | Watch pairing secret | pairing v2 `secret`，TTL 10 min，单次 | QR 登录，无 URL scheme | 6 位码，TTL 10 min，单次 |
| 配对秘密存储 | Keychain | 服务端只存 SHA-256 | Server 侧一次性 token | 内存 Map |
| 宿主身份锚 | 服务端租约 | ECDH 公钥进 QR | Host 公钥 pin + Noise | 房间密钥（无宿主身份） |
| 传输鉴权 | lease + bearer | clientToken / tunnel Cookie | Noise + device token | 房间密钥 + writeToken |
| 撤销粒度 | 租约代际 / 设备 | client token + relay 设备 | 每设备连接 | 无 |
| 断线退避 | 1/3/10/30 s，两层 | 1→30 s，终端错误不重连 | 0.5→10 s + 抖动，终态粘住 | 1→30 s，致命码不重连 |
| 后台策略 | 关流 + 30 s 窗口 + APNs | 推送 relay | 未深入 | 无（WebView 后台即停） |
| 健康检查 | 服务端 probe | 仅启动阶段 | 25 s/10 s 探针 | 无 |
| 多实例 | 账号级 | 实例 + 候选集 | Host 列表 + pin | 最多 8 台，手动切换 |

---

## 5. MusePi 客户端缺口

### 5.1 现状：四个互不复用的子系统

1. **SSH + sshfs 远程工作区**（桌面 GUI）：`remote.hosts/hostAdd/connect/browse/disconnect` 五个 RPC 已接真，四步向导可用。挂载远端 `/` 后会话 `cwd` 指向本地挂载路径，所有工具零改动。
2. **远端 daemon 瘦客户端**：`InstanceManagerDialog` 填 `label/url/token`，切当前 daemon URL；对端需 `musepi serve --remote-token <≥16 字符>`。
3. **collab 实时共享**：LAN 明文 relay + 自签 TLS relay、cloudflared/ngrok tunnel、tailscale serve；手机作为 guest 加入。
4. **auth-broker**：`OMP_AUTH_BROKER_URL` 置位后凭据托管，broker 独占 refresh token。

### 5.2 缺口表

| 优先级 | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| P0 | 远程工作区没有「远程」语义：wire 无 remote 字段，无徽标、无门控、断开不清理会话 | `packages/wire/src/index.ts` 仅注释出现 remote；`packages/desktop-app/src/app.tsx:2471` 只传 `cwd`；`packages/coding-agent/src/daemon/remote.ts:183` 只 unmount | 用户不知道自己在远端；断开后会话指向空目录 |
| P0 | SSH 首次信任无校验：`BatchMode=yes` + `StrictHostKeyChecking=accept-new`，无指纹确认 UI | `packages/coding-agent/src/ssh/connection-manager.ts:106` | 首连可被中间人；也无法输入口令/agent |
| P0 | sshfs 挂载远端 `/`，无路径白名单；`mountRemote` 无超时；`isMounted` 在 Windows 用「目录非空」推断 | `packages/coding-agent/src/daemon/remote.ts:121`；`packages/coding-agent/src/ssh/sshfs-mount.ts:101,125` | 完整 bash 工具可写远端任意路径；半通网络 UI 卡死；空根/残留文件误判 |
| P0 | daemon 远程 token 拼在 WS URL 查询串并落 localStorage；无设备级撤销、无轮换、无 TLS | `packages/desktop-app/src/lib/remote-hosts.ts:58`；`packages/coding-agent/src/daemon/ws-transport.ts:151` | 反代/日志可见；只能换 token 重启 |
| P0 | 6 位配对码 10⁶ 空间、无尝试次数限制 | `packages/coding-agent/src/collab/pair-codes.ts:28-52` | 同一 LAN 内可枚举/抢注，拿到即完整写权限 |
| P1 | 没有统一连接描述符：隧道/SSH/daemon/collab 各有一套 URL 与认证形态 | 四个子系统无共享类型 | 新增传输要改四处；移动端无法复用 |
| P1 | tunnel 只有 quick 模式，无 named tunnel / Access / 运行期健康检查 / 原子替换 | `packages/coding-agent/src/collab/tunnel.ts:66-79`；`local-share.ts:176-210` | 链接不稳定；无法长期使用；切换有断档 |
| P1 | tailscale 只做 `serve` 且失败静默降级，无 `funnel`、无审批 UI | `packages/coding-agent/src/collab/tailscale-serve.ts:58-105` | 公网场景不可用；用户不知道为何降级 |
| P1 | 桌面 GUI 不能作为 collab guest 加入；仅 client-core/TUI 有 guest | — | 桌面↔桌面共享缺失 |
| P2 | Docker 连接方式仍是禁用占位 | `packages/desktop-app/src/components/ConnectDialog.tsx:267` | — |
| P2 | Windows WinFsp 端到端未验证 | `docs/remote-workspace.md` 自述 | 平台风险 |

---

## 6. MusePi 移动端缺口

### 6.1 现状

```
手机 WebView（Capacitor https://localhost）
  ├─ QR / 6 位码 / 粘贴链接 → parseCollabLink
  ├─ 6 位码 → ws://<host>:8301 pair.resolve → webLink
  └─ GuestClient → CollabSocket → ws(s)://<host>/r/<roomId>
                     └─ AES-256-GCM（房间密钥）→ CollabHost（桌面 daemon 内）
```

- 三条入口最终汇成 `parseCollabLink`（`packages/collab-proto/src/link.ts:211`）。
- 鉴权不是 bearer，而是链接内嵌密钥：32 B 只读，48 B = 32 B key + 16 B writeToken（`link.ts:253-257`）；写权限在 `hello.writeToken` 声明，host 侧 timing-safe 校验（`packages/client-core/src/lib/client.ts:441`、`packages/coding-agent/src/collab/host.ts:455`）。
- 原生能力：键盘 inset、沉浸状态栏、返回键层栈、深链、本地通知+角标、扫码（`getUserMedia` + jsQR）。无推送、无 foreground service、无 iOS 工程、无 OTA 实现。
- 多实例：`packages/client-core/src/lib/hosts.ts:36-38`，localStorage 存公开元数据 + 安全存储存凭证，上限 8 台。

### 6.2 缺口表

| 优先级 | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| P0 | 没有中继兜底：离开 LAN 且桌面没开隧道就连不上 | `packages/client-core/src/lib/hosts.ts:68-83` 只按 host 名分 lan/relay，实际 `relay` 仍是桌面地址 | 产品核心场景缺失 |
| P0 | 房间密钥即全部权限：无宿主身份证明、无设备撤销、无逐消息授权 | `packages/collab-proto/src/link.ts:253-257`；`packages/coding-agent/src/collab/host.ts:455` | 旧链接在停止共享前始终可连；无法踢单台设备 |
| P0 | 非安全上下文明文降级：http LAN 下 `crypto.subtle` 缺失即 `plaintext` | `packages/collab-proto/src/socket.ts:92-94`；`packages/client-core/src/app.tsx:107` | 同 Wi-Fi 抓包可读帧内容 |
| P0 | 无后台保活：manifest 无 `<service>`、无 `FOREGROUND_SERVICE` | `packages/mobile/android/app/src/main/AndroidManifest.xml:1-55` | 长任务/审批在切后台后失联 |
| P0 | 无推送：只有本地通知；桌面离线时手机收不到审批/完成 | `docs/mobile-design.md:314-320` | 异步协作断裂 |
| P1 | 没有候选集/竞速：只有单地址，切换网络要重连甚至重配 | 对比 openchamber `mobileConnections.ts:963-1113` | LAN↔蜂窝体验差 |
| P1 | 没有 direct daemon 模式：`serve --remote-token` 已存在，但移动端只走 collab | `packages/coding-agent/src/commands/serve.ts:40-42`；`packages/client-core/src/app.tsx:234` 的 `/__daemon.json` 只在本机服务时可用 | 少一条低延迟路径 |
| P1 | 没有 host 身份校验：拿到房间密钥即可连，无法确认「是那台电脑」 | `link.ts` 无 host 公钥字段 | 与 openchamber 的 hostEncPubJwk 差距 |
| P1 | OTA 全未实现 | `docs/ota-mobile-design.md:66-73` 全未勾选；`packages/mobile/package.json` 无 Capgo | 每次发版必须重装 APK |
| P1 | 语音不可用：collab RPC 白名单无 `stt.*`/`tts.*`，daemon 事件 inert | `packages/coding-agent/src/collab/host.ts:960-1010`；`packages/client-core/src/lib/client.ts:414-433` | 移动端语音输入/朗读缺失 |
| P2 | Harmony 壳断链：脚本仍指向 `packages/guest-client/dist`，包已改名 `client-core` | `packages/harmony/scripts/copy-web-assets.js:16`；`packages/` 下无 `guest-client` | 鸿蒙壳可能无法出包 |
| P2 | Harmony `HarmonyNative.ets` 死代码，与 `Index.ets` 内联代理漂移 | `packages/harmony/entry/src/main/ets/pages/Index.ets:110-121` | 维护风险 |
| P2 | Android 全局明文 + 信任 user CA + `allowMixedContent` | `packages/mobile/capacitor.config.ts:7-32`、`AndroidManifest.xml:10` | 安全边界完全靠上层 URL 匹配 |
| P2 | 无 foreground service 计划、无真机复验记录 | `docs/mobile-design.md:301,413,514` | 平台风险 |

---

## 7. 目标架构建议（远程连接）

### 7.1 统一连接描述符

把四个子系统的连接信息收敛成一个可序列化对象，放在 `packages/wire` 或 `packages/collab-proto`：

```ts
type TransportCandidate =
  | { kind: "lan"; url: string; priority: 0 }
  | { kind: "tailnet"; url: string; priority: 10 }
  | { kind: "tunnel"; url: string; priority: 20 }
  | { kind: "relay"; relayUrl: string; serverId: string; hostPubKey: string; priority: 30 };

interface ConnectionDescriptor {
  v: 2;
  deviceId: string;          // 稳定设备标识，用于 token 作用域
  hostId: string;            // 宿主身份（公钥哈希）
  candidates: TransportCandidate[];
  secret: string;            // 一次性配对 secret，兑换后立即丢弃
}
```

- **候选集而不是单 URL**：客户端按 priority 探测，失败降级，不重配。
- **宿主公钥进 QR**：relay 候选只带公钥，凭据在隧道内兑换；这样能证明「连到的确实是那台机器」，而不需要 PKI。
- **secret 一次性**：兑换后换 clientToken，后续所有请求用 bearer；secret 不落盘。

### 7.2 传输候选与竞速

建议直接采用 openchamber 的探测模型，但按 MusePi 的 collab 语义改造：

1. 并发探测候选，relay 让出 1.5 s headstart（LAN 优先）。
2. 每个候选先读 `/health` 拿 `serverId`，不匹配**不发 secret/token**（防 DHCP 重分配把凭据送给陌生机器）。
3. 401 或 `authenticated:false` 直接判 `needs-login`，不换候选重试（secret 已消费）。
4. 选中后固定 `runtimeKey = deviceId`，LAN↔relay 切换只是换传输，不重挂 UI、不丢会话。
5. 候选刷新：定期调 `/api/client-auth/connection/candidates` 更新 LAN 地址，保留 https 与 relay。

### 7.3 信任与撤销

- **宿主身份**：`hostId = base64url(SHA-256(hostPublicKey))`；首次配对人工可比对短指纹。
- **设备记录**：服务端按 `deviceId` 存 `{name, platform, clientVersion, createdAt, lastSeenAt, revokedAt}`；撤销即 `revokedAt`，并在下一个 SSE 窗口/心跳周期断开。
- **token 轮换**：clientToken 带 `generation`；换发新 token 时旧 generation 立即失效；不依赖 refresh token。
- **配对码防爆破**：6 位码加「每 IP/设备 5 次/10 分钟，锁 10 分钟」，或直接改成 128-bit secret 的 QR（6 位码只作为便捷入口）。

### 7.4 隧道生命周期

- provider 能力表 + 4 方法接口（`start/stop/checkAvailability/resolvePublicUrl`），UI 由能力表驱动。
- **起新的再撤销旧的**：返回 `{ revokedLinks, revokedDevices }` 计数。
- **运行期健康检查**：每 30 s 探活；失败自动重建并通知客户端换 URL（客户端通过候选刷新拿新地址）。
- **Cloudflare named tunnel**：支持 `token + hostname` 与 `config file`；Access service token 通过 `additional headers` 注入（`CF-Access-Client-Id/Secret`），并把 `capacitor://localhost`、`https://localhost` 加入 Access CORS。
- **Tailscale**：增加 `funnel` 模式与审批链接 UI；`serve` 失败不再静默，返回结构化原因。
- **relay**：自建一个最小 Worker + DO（或复用现有 relay 协议），宿主主动出站 WSS；E2EE 用 X25519 + HKDF + AES-256-GCM；relay 只按 `serverId` 路由。

### 7.5 分阶段

| 阶段 | 内容 | 规模 |
| --- | --- | --- |
| R0 | 统一 `ConnectionDescriptor` + 候选探测（LAN/现有 tunnel） | 1–2 周 |
| R1 | direct daemon 候选（`--remote-token`，token 用 ticket 换，不进 URL）+ serverId 门禁 | 1 周 |
| R2 | named Cloudflare tunnel + Access + 健康检查 + 原子替换 | 1–2 周 |
| R3 | 自建 E2EE relay + host 公钥/设备撤销 | 3–4 周 |
| R4 | 推送（APNs/FCM 或自建 relay）+ 后台保活 | 2–3 周 |

> 顺序建议：R0/R1 先做，立刻改善「同一网络/已知端口」的体验；R3 才是解决「离开家」的关键，但工作量最大。

---

## 8. 移动端本地运行时设计

### 8.1 目标与非目标

**目标**

- 手机在没有桌面 daemon 的情况下，本地运行 `musepi` agent runtime。
- 工具链（read/bash/write/glob/grep/git）行为与桌面一致。
- 安装、启动、停止、升级、回滚可中断、可恢复。
- 模型密钥不落明文；本地端口默认只对回环开放。

**非目标**

- 不追求 Play Store 上架（MusePi 当前分发方式已排除 Play）。
- 不在首版支持 iOS。
- 不在手机本地跑完整模型推理（仍走 API）。

### 8.2 路线选择

| 路线 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 纯远程 | 维持现状，补齐中继/推送 | 零运行时成本 | 离线不可用；依赖桌面 | 现状，不够 |
| B. Termux 伴生 | 用户在 Termux 装 Bun + `musepi serve` | 工程量最小；工具链完整 | 需装第二个 App；UX 差；权限/唤醒不可控 | 过渡方案 |
| C. 内嵌 proot + glibc rootfs + Bun | APK 自带 rootfs，proot 跑 `musepi serve` | 工具链一致；免 root；dsh-go 已验证 | `targetSdk` 必须 ≤28；包体 150–250 MB；性能税 | **推荐做主路线** |
| D. 交叉编译 natives + 内嵌 Bun | 直接产出 `aarch64-linux-android` | 无 proot 税 | Bun 无官方 Android target；`bun:sqlite`/`bun:jsc`/`bun:ffi` 不可替换；工作量最大 | 不推荐 |

**关键洞察**：走 proot 后，运行时看到的是 **glibc aarch64 Linux**，因此现有 `bun-linux-arm64` 与 `aarch64-unknown-linux-gnu` 的 natives 可以直接用，不需要新增 Android triple。这把「ABI 缺失」这个最大阻塞降级为「打包与 exec 权限」问题。

**硬决策门：`targetSdk`**

- Android 10+ 对 `targetSdk ≥ 29` 的应用禁止执行 app 私有目录中的文件（W^X）。dsh-go 用 `targetSdk 28` 换取 guest `exec`（`app/android/app/build.gradle.kts:79-92`）。
- MusePi 当前 `targetSdk 36`（`packages/mobile/android/variables.gradle:4`）。保持 36 时，proot 自身可以从 `nativeLibraryDir` 执行，但它从 rootfs 里 `execve` guest 程序会被拒绝。
- 可选破法（都需 spike 验证）：
  1. 接受 `targetSdk 28`（dsh-go 路线，最稳）。
  2. 把 Bun 与必要工具放进 `nativeLibraryDir`，rootfs 只提供库与数据；proot 把 guest 路径 bind 到 nativeLibraryDir。可行但工具链覆盖不全。
  3. 用 `memfd_create` + `execveat` 的 loader 包装 guest 程序；无现成实现，风险高。
  4. 外部 Termux 运行（路线 B），APK 只做 UI。
- **建议**：先做 2 周 spike，同时验证 1 与 2；若 1 的副作用（Android 15/16 行为、无法上架）不可接受，则产品上退回「纯远程 + Termux 伴生」。

### 8.3 组件与数据流

```
client-core（TS，WebView）
  └─ LocalRuntimeBridge（MethodChannel musepi/runtime）
       └─ RuntimePlugin (Kotlin)
            └─ RuntimeController（进程内单例）
                 ├─ RuntimeInstaller   资产/下载 → rootfs
                 ├─ RuntimeService     前台服务 + wake lock
                 ├─ RuntimeProcess     libproot.so → musepi serve
                 └─ SecretStore        Android Keystore
```

数据面：WebView 直接连 `ws://127.0.0.1:<port>`（带每次启动生成的 token），不经过 Kotlin 代理。Kotlin 只负责生命周期与日志。

建议新增文件（对齐 dsh-go 的分层）：

- `packages/mobile/android/app/src/main/java/com/musepi/mobile/runtime/RuntimeInstaller.kt`
- `.../RuntimeProcess.kt`
- `.../RuntimeService.kt`
- `.../RuntimeController.kt`
- `.../RuntimePlugin.kt`
- `.../RuntimeLogs.kt`
- `packages/client-core/src/lib/runtime/native-runtime.ts`
- `packages/client-core/src/lib/runtime/local-host.ts`
- `runtime/`（新顶层目录）：`build-runtime.sh`、`manifest.json`、`patches/`

### 8.4 状态机与平台通道

```
notInstalled → installing → installed → starting → running → stopping → installed
                    ↓            ↓          ↓                     ↓
                  error        error      error                 error
```

MethodChannel `musepi/runtime`：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `getStatus` | — | `{ abi, bundledVersion, installedVersion, phase, port, token, error }` |
| `install` | `{source?: "asset" \| "download"}` | `null`；进度走事件流 |
| `start` | `{env: Record<string,string>}` | `null` |
| `stop` | — | `null` |
| `getLogs` | `{lines}` | `string[]` |
| `getLogSnapshot` | `{lines}` | `{entries, throughSeq}` |
| `reset` | `{keep: "home" \| "none"}` | `null` |

EventChannel `musepi/runtime/events`：`progress` / `status` / `logs` / `notice`。

`RuntimeStatus` 字段与 dsh-go 对齐，但 `port`/`token` 只在本进程内可见，不写入日志。

### 8.5 安装事务、升级与回滚

- 运行时包：`runtime/out/<abi>/rootfs.tar.xz` + `manifest.json`（`version`、`abi`、`sha256`、`uncompressedBytes`、`bunVersion`、`musepiVersion`）。
- 安装：校验 SHA-256 → 磁盘预检（`uncompressedBytes × 1.15`）→ 解压到 `staging/` → 原子换名 `rootfs/` → `/root` 移到 `home.carry` → `sync()` → 最后写 `rootfs.version`。
- 升级：只换 `rootfs/`，保留 `/root`；旧版本留在 `rootfs.old/` 直到新版本成功启动一次。
- 回滚：启动失败 3 次或 60 s 内崩溃 2 次 → 自动回退 `rootfs.old/`；同时保留 `LastKnownGood` 插件集。
- 删除：`settleReset` 可中断；白名单只允许 `home`、`logs`、`runtime-version` 等闭集项（防路径穿越）。

### 8.6 进程、端口与 token

启动命令（示意）：

```
libproot.so --kill-on-exit --link2symlink --sysvipc -0 \
  -r <filesDir>/runtime/rootfs \
  -b /dev -b /proc -b /sys -b /system -b /apex \
  -w /root \
  /usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin \
    MUSEPI_HOME=/root/.musepi ... \
  /usr/local/bin/musepi serve --host 127.0.0.1 --port <p>
```

- **端口**：从 8300 起逐 +1 试，最多 20 个，全失败退 `ServerSocket(0)`。
- **token**：Kotlin 每次启动生成 32 B base64url，作为 `--remote-token` 或新增的 `--local-token` 传入；MusePi 现有 `--remote-token` 会把 WS 绑到 `0.0.0.0`，需要新增「只绑回环但要求 token」的选项（`packages/coding-agent/src/commands/serve.ts:40-42` 当前语义）。
- **就绪**：daemon 启动后 stdout 打印 token/端口；Kotlin 解析 token 并轮询 TCP，token 180 s、端口 90 s 两个独立超时。
- **停机**：guest `musepi` SIGTERM → 5 s → proot SIGQUIT → 2 s → `destroyForcibly`；pid 文件记录 guest pid，配合 `starttime` + uid 防 PID 复用误杀。
- **孤儿回收**：按 `uid + rootfs 路径 + cwd + argv` 认领，2 s 截止。

### 8.7 保活与后台

- 前台服务 `foregroundServiceType="specialUse"`，常驻通知带「停止」动作；`PARTIAL_WAKE_LOCK`。
- Android 12+ 电池优化白名单引导；Android 14+ 前台服务类型声明。
- 进程被杀后只对「非用户停止 + 存活 >60 s」自动重启，5/15/45 s 递增，10 分钟最多 3 次；启动失败不计入重试（避免把插件问题当崩溃）。
- 移动网络切换：监听 `ConnectivityManager`，重建 loopback 连接；本地运行时不受影响。

### 8.8 密钥与凭据

- 模型 API key：Android Keystore 加密存储；启动时解密，通过**环境变量**注入 proot。`/proc/<pid>/environ` 仅同 uid 可读，风险可接受。
- 不把 key 写入 rootfs 的 `credentials.json`；若 daemon 必须落盘，使用 `0600` + 应用私有目录，并在设置页明确告知。
- 更强方案：`OMP_AUTH_BROKER_URL` 指向自建 broker，手机只持 broker token，provider key 永不落设备（`packages/ai/src/auth-broker/discover.ts:198`）。
- 本地 daemon token 每次启动重新生成，不持久化；UI 通过 MethodChannel 拿，不写 localStorage。

### 8.9 包体与 ABI

- 只发 `arm64-v8a`；模拟器另发 `x86_64` flavor。
- `useLegacyPackaging = true` + `keepDebugSymbols` 让 `lib*.so` 可执行且字节可校验；`disable-abi-filtering=true` 防止 flavor 只做加法导致混入其他 ABI。
- `release_assets.py` 等 CI 断言：包内只含目标 ABI。
- 包体预算：rootfs 压缩 150–250 MB，解压 600–900 MB；首装磁盘要求「包体 ×2 + 64 MB」。
- 若不能接受 APK 体积：首启下载 + SHA-256 校验 + 断点续传；或提供「离线 APK」与「轻量 APK」两个 flavor。

### 8.10 安全边界

- daemon 默认只绑 `127.0.0.1`，且要求 token（防同设备其他 App 连接）。
- 明文只允许回环；`network_security_config` 对非 loopback 关闭 cleartext。
- rootfs 首次运行前校验哈希；更新包必须签名/哈希校验。
- 本地运行时等价于桌面信任：agent 可在 rootfs 内执行任意命令；不额外宣称沙箱。
- 不把 rootfs 暴露给 WebView 文件访问；`allowMixedContent` 与本地运行时无关时应收紧。

### 8.11 分阶段与验收

| 阶段 | 产出 | 验收 |
| --- | --- | --- |
| S0（2 周） | targetSdk 28 debug APK：proot + 最小 rootfs + Bun + `musepi serve` | 真机 arm64 启动；`bun:sqlite`、natives、bash/git/rg 可用；冷启动/RSS/包体有基线 |
| S1（3–4 周） | RuntimeInstaller/Process/Service/Controller/Plugin；client-core 连接 loopback | 安装中断可续；启动/停止/重置闭环；日志 seq 不丢不重 |
| S2（2–3 周） | 升级/回滚、崩溃分类、安全模式、LKG | 杀进程/断电/版本回滚各有测试 |
| S3（2 周） | Keystore 注入、token 每次生成、明文收紧 | 反编译 APK 不见 key；其他 App 无法连 loopback |
| S4（2–3 周） | 下载式运行时 / 双 flavor、OTA、真机矩阵 | Android 12/14/16 各一台通过 |

### 8.12 风险与未确认

**代码事实**

- MusePi 无 Android ABI 产物；`bazel/triples/BUILD.bazel` 只有 linux-gnu/musl、apple-darwin、windows-msvc。
- `packages/natives/native/index.js:17` 顶层 `loadNative()`，失败即抛，无降级。
- `packages/coding-agent` 对 Bun 专有 API 硬依赖：`Bun.spawn` 103、`Bun.file` 286、`Bun.write` 149、`bun:sqlite` 23、`bun:jsc` 3、`bun:ffi` 2。
- 移动端无 `<service>`、无 `FOREGROUND_SERVICE`；`targetSdk 36`。
- 模型密钥在桌面侧是 SQLite `agent.db` + `credentials.json` 明文 `0600`；手机侧目前只有 collab 房间密钥进 Keystore。

**推断**

- proot 下的 glibc rootfs 可直接使用 `bun-linux-arm64` 与 `aarch64-unknown-linux-gnu` natives；无需 Android triple。
- targetSdk 28 仍是当前最可靠的 exec 破法；targetSdk 36 + nativeLibraryDir bind 的可行性未验证。

**未确认**

- Bun 官方 Android 支持程度；`bun:jsc`/`bun:ffi` 在 proot 下的实际行为。
- `crates/pi-shell`、`crates/pi-iso` 是否有 POSIX-only 依赖。
- 各 OEM（小米/华为/OPPO）对 `specialUse` 前台服务与 wake lock 的实际回收策略。
- Android 16 对 targetSdk 28 应用的兼容窗口还能维持多久。
- rootfs 内 `git`/`rg`/`node-gyp` 等工具的内存与启动开销。

---

## 9. 建议的下一步

**远程（先做，收益确定）**

1. 在 `packages/wire` 定义 `ConnectionDescriptor` / `TransportCandidate`，四个子系统逐步迁移。
2. 移动端 ConnectScreen 增加「候选列表 + 探测」；先把现有 LAN 与 tunnel 两种候选接进去。
3. 给 `serve` 增加「回环 + token」选项，移动端增加 direct daemon 候选（token 用一次性 ticket 换，不进 URL）。
4. 配对码加失败限流；collab 增加「按设备撤销」与 host 公钥。
5. 隧道 provider 抽成能力表；补 named Cloudflare tunnel + Access + 健康检查。

**移动端本地运行时（并行 spike）**

1. 建 `runtime/` 与最小 rootfs（Ubuntu base + bash/coreutils/git/rg/ca-certificates + Bun）。
2. 用 targetSdk 28 debug APK 验证 proot + `musepi serve` + natives + `bun:sqlite`。
3. 记录冷启动、RSS、包体、安装时长；同时跑 targetSdk 36 对照组确认 exec 失败。
4. 决策门评审：接受 targetSdk 28 / 走 nativeLibraryDir bind / 退回 Termux 伴生。

**不建议现在做**

- 直接交叉编译 `aarch64-linux-android` 全套 natives（在 proot 路线未否决前投入产出比最低）。
- 自建 relay 与本地运行时同时开工（两条都是 3–4 周级，先远程后本地）。

---

## 附录 A：关键锚点

**comma**

- `clients/packages/core/src/api.ts:224-263` — SSE 流与 lease 关闭竞速
- `clients/packages/core/src/history.ts:288-355` — SSE 续读与退避
- `clients/packages/core/src/session.ts:108-131` — lease 代际作废
- `systems/tailnet-gateway/node.go:324-350` — netstack-only 拨号
- `systems/tailnet-gateway/policy.go:29-55` — netmap 解析与 `/0` 排除
- `systems/cloudflare/salix-vm-gateway/src/auth.ts:21-126` — HMAC + nonce 防重放
- `systems/cloudflare/salix-vm-gateway/src/managed_sandbox.ts:125-128` — Worker 不代理容器流量

**openchamber**

- `packages/web/server/lib/tunnels/routes.js:537-548` — 起新隧道再撤销旧凭证
- `packages/web/server/lib/relay/DOCUMENTATION.md:5-17` — 三层 relay 架构
- `packages/ui/src/lib/relay/handshake.ts:107-158` — 客户端 E2EE 握手
- `packages/ui/src/apps/mobileConnections.ts:963-1113` — 候选集竞速
- `packages/electron/ssh-manager.mjs:1470-1580` — SSH 13 阶段状态机
- `packages/mobile/README.md:72-118` — Cloudflare Access 操作手册

**dsh-go**

- `packages/dsh_remote/lib/src/carrier/tunnel_carrier.dart:187-195` — carrier 差异面
- `packages/dsh_remote/lib/src/account/remote_account.dart:974-1057` — 三阶段选路
- `app/android/.../runtime/RuntimeInstaller.kt:164-202` — 安装事务
- `app/android/.../runtime/DshProcess.kt:266-291` — 三级停机
- `app/android/.../runtime/SafeMode.kt:28-39` — 重启节奏
- `runtime/lib/rtbuild.py:1324-1352` — proot argv 模板

**MusePi**

- `packages/coding-agent/src/collab/local-share.ts:165` — tailscale serve 接线
- `packages/coding-agent/src/collab/tunnel.ts:66-79` — quick tunnel 探活
- `packages/coding-agent/src/collab/pair-codes.ts:28-52` — 配对码
- `packages/coding-agent/src/daemon/remote.ts:121,183` — sshfs 挂载 `/` 与只卸载
- `packages/coding-agent/src/ssh/connection-manager.ts:106` — accept-new
- `packages/desktop-app/src/lib/remote-hosts.ts:58` — token 进 URL
- `packages/client-core/src/app.tsx:234` — `/__daemon.json` 直连路径
- `packages/collab-proto/src/link.ts:253-257` — 32/48 B 密钥
- `packages/collab-proto/src/socket.ts:92-94` — 明文降级
- `packages/mobile/android/variables.gradle:4` — targetSdk 36
- `bazel/triples/BUILD.bazel:44-96` — 无 Android triple

## 附录 B：未确认清单

- openchamber relay Worker 的路由/DO/限流实现（源码在 `openchamber-website` 仓库）。
- comma `meet-token-factory` 的签发内核（源码在外部仓库）。
- dsh-go Host 侧实现与 TURN 真机行为（仓库只含客户端）。
- MusePi `CollabSocket` 的完整重连/退避边界（只读了 `socket.ts:236-243`）。
- 自签 TLS relay 在 Electron 渲染进程是否会弹证书错误。
- proot + Bun 在 Android 16 各 OEM 的真实回收率与冷启动。
