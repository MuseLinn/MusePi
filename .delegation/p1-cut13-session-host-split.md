# P1 第十三刀（收官刀）：会话宿主面文件级拆分——session-host.ts

你在 `musepi-omp` 仓库（Bun monorepo）执行一次**纯搬移式文件拆分**：把 server.ts 上半部的"会话宿主面"代码块原样搬进新文件 `packages/coding-agent/src/daemon/session-host.ts`。**不改任何逻辑、不改任何可见性语义、不改运行时行为**——这是文件搬家，编译器和测试是双重把关。

先读 `docs/review/0.5.0-m2-daemon-host-layering.md` §10 了解 P1 前十二刀纪律。

## 背景（已完成侦查，直接采信）

server.ts 现 9,401 行，三段结构：
- 832-2933：**会话宿主面**（本刀搬走）——SessionScopedEventBus、assistantReplyText、LiveSession、DaemonConnection、CachedSessionDiscovery、discoverySettingsFingerprint、DaemonSessionHost（含复活/idle 快照/收养/journal 事件序全部机制）、renderDebugTranscript、extractEntryText
- 479-503：DaemonOptions（宿主构造 options 类型，随迁）
- 其余：DaemonServer 巨型 switch + 胶水（**不动**）

关键事实（已核实）：
- 宿主区对 DaemonServer 的 4 处提及全是 doc 注释，**零代码依赖**；
- 宿主区对 DaemonOptions 有 2 处真实类型引用（`#options` 字段 + 构造参数）→ DaemonOptions 随迁，server.ts 改 `import type` 引回（接口类型编译期擦除，无运行时循环依赖）；
- 宿主区不使用 MAX_REQUEST_BYTES（765 行常量留 server.ts）；
- server.ts 下半部（DaemonServer 区）仍在用被搬符号：assistantReplyText（3183）、extractEntryText（5435）、renderDebugTranscript（6885）、LiveSession（大量）、DaemonConnection（大量）→ session-host.ts 必须 **export** 它们，server.ts import 回来；
- SessionScopedEventBus 仅宿主区内使用，export 与否均可（建议 export 保持公共形状）；
- 外部模块对 server.ts 的导入：`serve.ts` 引 startDaemon（不动）、`ws-transport.ts` 引 `DaemonConnection` + MAX_REQUEST_BYTES → server.ts 需 `export type { DaemonConnection } from "./session-host";` 再导出；`turn-index.test.ts` 引 buildDaemonTurnIndex（740 行，不动）。

## 一、新建 `packages/coding-agent/src/daemon/session-host.ts`

原样搬入 server.ts 的以下区块（**逐字，含全部注释**）：

1. `export interface DaemonOptions`（479 行起，至该接口结束）
2. `class SessionScopedEventBus`（832 行起）——导出改为 `export class`
3. `function assistantReplyText`（约 850 行）——改 `export function`
4. `interface LiveSession`（881 行）——改 `export interface`
5. `export interface DaemonConnection`（945 行）
6. `interface CachedSessionDiscovery` + `function discoverySettingsFingerprint`（两声明紧邻）——interface 改 export（function 仅区内用可 export 也可不导，跟 CachedSessionDiscovery 对齐导出）
7. `export class DaemonSessionHost`（1067-2933，**1,866 行主体整体逐字搬移**）
8. `function renderDebugTranscript` + `function extractEntryText`（宿主类之后、紧挨 2933 之前的两个工具函数）——改 export

被搬代码用到的 module import（EventBus、AgentEvent、journal、view-store、pause-sidecar、SDK 各类型、fs/path/os 等）**从 server.ts 顶部按需复制**到 session-host.ts（只搬被搬代码实际引用的名字；server.ts 顶部若因此产生 unused import，第二节清理）。

## 二、server.ts 改动

1. **删除**上述区块（479 的 DaemonOptions、832-2933 全部）。
2. **新增 import**：`import { DaemonSessionHost } from "./session-host";`（放服务 import 区之后即可）；`import type { DaemonOptions } from "./session-host";`；`import type { LiveSession, DaemonConnection } from "./session-host";`（若 DaemonConnection 以值方式只用类型，type 引入即可）；assistantReplyText / extractEntryText / renderDebugTranscript 三个值函数按需引入（`import { assistantReplyText, extractEntryText, renderDebugTranscript } from "./session-host";`）。
3. **再导出**：文件顶部合适位置 `export type { DaemonConnection } from "./session-host";`（ws-transport.ts 依赖此路径）。
4. **import 清理**：server.ts 顶部对被搬代码不再使用的 import 删除（用 check:ts 的 unused 报错 + biome noUnusedImports 双重确认，宁可保守多跑一轮）；
5. **什么都不许改**：巨型 switch、DaemonServer 方法、其余常量与接口一律不动；LiveSession 等在 server.ts 内的使用点一行都不改（import 同名同形，编译器保证）。

## 三、严禁触碰

- 宿主类任何方法实现、字段、事件序逻辑（纯搬移，逐字）。
- buildDaemonTurnIndex（740）、MAX_REQUEST_BYTES（765）、SOCKET_DIR、ModeSessionLike、SkillListItem 已迁版本等 server.ts 留守符号。
- cron/channels/collab/services 各区。
- 禁止"顺手重构"：不重排方法顺序、不改注释措辞、不增删空行（搬移过程允许区块间空行自然衔接）。

## 四、验证（必须亲自跑过并贴结果）

```bash
cd packages/coding-agent
bunx biome check --write src/daemon
bun test src/daemon test/daemon    # 期望 195 pass / 0 fail
bun run check:ts 2>&1 | grep -c "error TS"   # 仓库根目录跑；期望 0
git diff --stat
```

预期：server.ts 净减约 2,000 行（9,401 → ~7,400），session-host.ts 约 2,100 行。

回复格式：改动文件清单、git diff --stat、验证输出原文、偏差及理由。若 Bun 工具被权限系统拒绝，如实说明并停止。
