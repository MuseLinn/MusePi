# ADR 0001: cordis 收编边界与分层纪律

- 状态：已接受（2026-09-27，M2.9 试点验收 + 决策点批复）
- 背景：`docs/review/0.5.0-m2.9-cordis-spike.md`（双 spike 实测 25+16 全绿）、`docs/review/0.5.0-m2-daemon-host-layering.md`（P1 宿主分层）

## 决定

cordis（MIT，npm `@deepseek-ai/cordis` 锁 4.0.4，不整包 vendor）作为 daemon 宿主层的组合内核，按 strangler-fig 渐进收编：P2 首个 cordis 化服务为 SessionService，注册表垫片双跑保证可回滚。

## 边界（依赖方向纪律）

1. cordis 依赖只进 `packages/coding-agent/src/daemon/` 宿主层与未来新增的宿主侧包。核心领域包（`packages/agent` / `packages/ai` / `packages/wire`（若存在）/ `packages/sdk` / `packages/catalog`）**零 cordis import**——它们消费的是 L2 服务接口（纯 TS 类型），永远不感知组合内核。CI 门禁：`scripts/check-cordis-boundary.ts`（入 `bun run check`）。
2. L2 服务接口文件（`daemon/services/types.ts`）保持零 cordis 依赖。cordis 适配（`mountDaemonService`、启动编排、错误翻译）集中放 `daemon/host-context.ts`。
3. 测试用真 cordis `Context`（纯内存、无 IO），不 mock cordis。
4. 事件面不走 cordis 事件总线（isolate 不隔离事件，root 共享）——会话级事件分发维持 EventService 现状；组合面（工具/prompt/扩展装配）才走 cordis。
5. preset→会话挂载点在 session-host 层（`daemon/session-host.ts`）：会话创建时 fork isolate scope，销毁即 dispose 全量回收。**isolate 键清单必须包含全部派生键**（spike ② 验收实录：派生键不隔离会向上冒泡跨会话污染）。

## 理由

- 可回滚：注册表垫片双跑，Context 卸载即回 P1 形态；试点失败则 L2 注册表即终态，投入不浪费。
- 可测试：领域包测试面不变。
- 单点收益：服务 `stop?()` 语义从手写纪律升级为框架保证的 effect 账本反向回收。

## 影响

- P2 起 daemon 宿主层逐步 cordis 化；每服务一刀独立提交。
- 新增宿主侧能力默认按 cordis 插件形态声明（`static inject` + `apply` + disposer）。
