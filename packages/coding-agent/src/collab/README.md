# collab 模块(会话共享协议)边界说明

> 2026-08-16。回答"collab 是否应该拆出独立包"——结论:当前**不拆**,触发条件见文末。

## 角色

collab 是 **MusePi 会话共享协议**:把正在运行的 agent 会话实时共享给其他
musepi 实例(TUI guest/终端)与 Web/移动端。它起源于上游 OMP TUI 的
`/collab` 命令,现在同时服务 Desktop GUI 与 Mobile 客户端(经 daemon
代理,渲染层由 `@musepi/desktop-web` 承载——该包已于 2026-08-16 更名,
见 `docs/i18n.md` 同期的 repo 结构变更)。

## 模块职责与依赖方向

```
纯传输/工具(零 coding-agent 内部依赖)      host/guest 状态机(耦合内部)
cert.ts · crypto.ts(re-export collab-proto)  host.ts(1069 行)
local-share.ts · ngrok.ts                    guest.ts(765 行)
relay-client.ts · relay-server.ts            protocol.ts(类型织入 session)
tailscale-serve.ts · tunnel.ts               wire-guard.ts(类型织入 session)
display-name.ts · replication-shrink.ts
```

- **传输层**(左列):中继/隧道/证书,只依赖 `@musepi/pi-wire` / `@musepi/pi-ai`
  类型与 node,零内部依赖 —— 物理独立,可直接单测。
- **状态机**(右列):host/guest 深耦合 coding-agent 内部 —— `session/agent-session`、
  `session/session-entries`、`modes/types`、`registry/*`、`tools/widget`、
  `daemon/boards`、`i18n`、`task/types`。`protocol.ts` 的帧类型直接引用
  `AgentSessionEvent`/`SessionEntry`,协议与会话类型织在一起。

## 为什么不拆独立包(证据)

1. **唯一消费者是 coding-agent 自身**:grep 全仓,`collab/*` 的 import 全部
   来自 `packages/coding-agent/src/`,无第二包消费。独立包当前零复用收益。
2. **协议类型织入会话类型**:拆包必须先把 `protocol.ts`/`wire-guard.ts` 依赖
   的 `AgentSessionEvent`/`SessionEntry` 自持化或泛型化,连锁改动 host/guest
   的全部调用点 —— 核心功能重构,风险高。
3. **桌面/移动经 daemon 间接消费**:desktop-web 是纯渲染,不直接碰 collab
   协议;daemon 内的 host 服务它们。名实分离问题已由 `desktop-web` 更名解决,
   协议物理位置不影响其服务范围。

## 触发拆包的条件(满足任一再做)

- 出现第二个直接消费者(如 collab 独立服务器、CLI 工具、测试 harness 需要
  脱离 coding-agent 加载协议);
- 需要对 host/guest 做脱离会话的单元测试(此时先做**接口注入化**:
  把 `AgentSession`/statusline 引用改为构造参数/接口,再迁包)。

拆包顺序(届时):① `protocol.ts`/`wire-guard.ts` 类型自持 → ② 传输层
(左列)整体迁入新包 → ③ host/guest 接口注入化迁移。
