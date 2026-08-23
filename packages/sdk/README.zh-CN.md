# @musepi/sdk

MusePi daemon 协议契约：JSON-RPC 2.0 方法表 + TypeBox 模式。本包是 daemon
暴露内容的**唯一事实源**——GUI/TUI/远程客户端从这些模式编译 `Type.Static` 类型，
因此一个模式变更会在构建时反映到每个消费者。

每个方法带有 `TransportAuth` 等级，隧道/relay 安全边界由方法表自身强制：

- `local` — unix socket / localhost 仅限：写操作、设置、终端、文件
- `session` — 任何已认证会话（relay/tunnel 亦可）：只读会话操作，以及已有会话
  内的 prompt/approve
- `public` — 无需会话：handshake/connect/QR 仅限

## 模块

| 模块 | 职责 |
| --- | --- |
| `index` | JSON-RPC 方法表（`MethodEntry` 行：method / auth / TypeBox params） |
| `events` | 会话流契约——订阅/恢复信封 + 事件联合；信封运行时用 TypeBox 校验（kind/seq），载荷为类型化 |
| `events-types` | 流信封的运行时形状（`entry` / `event` / `state` / `approval-request` / `ask-request` / …） |
| `materialized-view` | daemon 事件溯源管线的投影层，与浏览器客户端共享——将追加式 journal 折叠为可查询的会话状态 |

## 约束

- 模式漂移对每个编译客户端都是破坏性变更——扩展契约，绝不静默收紧。
- 永不导入 agent/session 代码；协议契约保持传输与引擎无关。