# @musepi/collab-proto

Collab 实时会话的线传输层，由宿主（`coding-agent`）与访客（`desktop-web`）共享：
AES-256-GCM 帧密封、分享链接格式、线信封、二维码与 relay WebSocket 客户端。
纯传输层——不依赖 agent/session，浏览器安全（零 `Buffer`），帧类型通用。

## 模块

| 模块 | 职责 |
| --- | --- |
| `crypto` | AES-256-GCM 帧密封/解封。仅用 WebCrypto（Bun、Node ≥22、浏览器一致）。房间密钥只存在于链接 fragment——relay 只见不透明字节。密封布局：`[12B IV][ciphertext+tag]` |
| `link` | 分享链接格式 + 线信封。链接：`wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>`；信封：`[4B uint32 BE peerId][sealed payload]`（访客恒发 peerId 0，由 relay 改写） |
| `socket` | relay 房间的客户端 WebSocket 包装——密封/解封帧、指数退避重连、映射致命 close 码。帧类型通用（宿主 `CollabFrame` / 访客 `GuestFrame`/`HostFrame`） |
| `qrcode` | 自包含 QR 生成器（byte 模式，版本 1–40，纠错 L/M/Q/H）+ 半块 ANSI 终端渲染——`/collab qrcode` 命令用它打印可扫码加入码，零运行时 QR 依赖 |
| `extension-slots` | 内核↔渲染端槽位契约（单一权威：daemon 校验 + GUI 挂载诊断共用）——新增槽位在此声明，daemon `extensions.list` 自动下发 |

## 用法

宿主与访客都从 barrel 导入；各自用 `crypto` 密封自己的富帧类型，经 `socket`
传输，用 `link`/`qrcode` 渲染加入入口。

```ts
import { sealFrame, openFrame, createRelaySocket } from "@musepi/collab-proto";
```

## 约束

- `crypto`/`link`/`socket` 里无 `Buffer`、无 Node 全局——保持浏览器安全。
- 无 i18n、日志或 agent 依赖——close 原因的翻译由 UI 层负责。
