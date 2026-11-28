---
layout: default
title: 候选输入建议
status: living
summary: MusePi 如何在回合结束后预测用户的下一句话，并在空输入框中作为候选提供。
scope:
  - packages/coding-agent/src/plugins/interaction/prompt-suggestion
  - packages/coding-agent/src/session/prompt-suggestion.ts
  - packages/coding-agent/src/daemon/session-host.ts
  - packages/client-core/src/lib/prompt-suggestion.ts
  - apps/desktop/src/components/Composer.tsx
---

# 候选输入建议

[English](input-suggestions.md) | 中文

候选输入建议是一句被预测出的「用户下一句话」，作为空输入框的占位显示，用 `Tab` 或 `→` 采纳。它只是便利手段：采纳只是填入草稿，发送仍由用户决定；忽略它也不会有任何代价。

该机制移植自 OpenBitFun 的 prompt suggestion 链路，但落在 MusePi 已有的临时侧信道原语上，而不是新造一条模型调用路径。

## 1. 为什么复用当前回合，以及为什么要用会话自己的模型

预测的生成方式是：把刚结束的那个回合再跑一次，并在尾部追加一条指令，走 `AgentSession.runEphemeralTurn` 且显式传 `modelSource: "session"`。这两件事合起来才构成一次可信预测：

- 与本回合同一个模型、系统提示、工具目录、思考档位与 prompt 缓存键；
- 会话历史，包括仍在流式输出中的半成品回复；
- 不写入会话，因此候选永远不会出现在转写记录里；
- 不阻塞并发进行的主回合。

模型选择刻意**不走**侧信道默认值。`runEphemeralTurn` 默认用 `sideChannelModel`，那是给 `/btw`、`/omfg` 与空闲回顾准备的，好让它们能指向更便宜的模型。预测不属于这一类：它延续的是用户正在看的那个回合，而 provider 的缓存前缀属于产出该回复的那个模型。换成 tiny 或侧信道模型，既会让缓存整段失效，也会让候选变成另一个模型的语气。因此这里显式传 `modelSource: "session"`——设置项的说明写着「复用本轮对话的提示缓存」，正是这个原因，而不是为了省一次调用。

## 2. 请求契约

指令文件位于 `packages/coding-agent/src/plugins/interaction/prompt-suggestion/suggestion-instruction.md`。它声明请求由应用生成，要求给出用户最可能输入的**那一条**消息，要求沿用用户自己的语气与语言，只返回单行纯文本；当对话确实没有可延续的下一步时返回字面量 `null`。JSON、备选方案与解释都被明确拒绝。

响应按纯文本读取：不带输出 schema，不调用工具。`promptSuggestionText` 只裁剪首尾空白，空串与裸词 `null` 视为「没有建议」，其余内容原样保留。

## 3. 何时生成

策略位于内置 Cordis 插件 `musepi-prompt-suggestion`（`packages/coding-agent/src/plugins/interaction/prompt-suggestion`），不在 daemon 里。插件订阅 `agent_end`，并依次检查五道闸门：

| 闸门 | 规则 |
| --- | --- |
| 宿主 | 必须存在 `ctx.showSuggestion` 与 `ctx.runEphemeralTurn`；print、RPC 与 TUI 宿主都不提供，因此一次请求都不会发 |
| 设置 | `suggestion.enabled`（默认开启），启动前与发布前各读一次 |
| 结算 | 不能带 `event.willContinue`——已经排好自动续跑的回合还没有结束 |
| 回合结果 | 最后一条 assistant 消息的 `stopReason` 不能是 `aborted` 或 `error` |
| 并发 | 每个会话同时只有一条请求；`turn_start`、`input`、`session_shutdown` 会取消在途请求 |

预测是尽力而为的后台工作：失败会用完全相同的请求重试一次，整体受 80 秒超时约束，任何异常都不会冒到用户面前——没有 toast、没有事件、没有转写记录。

没有输入框的宿主天然沉默，因为能力是「不存在」而不是「为 false」：daemon 把 `showSuggestion` 接到该会话的订阅者上，其余宿主根本不提供。

## 4. 投递与过期

成功的预测走 `ctx.showSuggestion`，daemon 把它接到 `{ kind: "suggestion", payload: { suggestion } }` 并推给该会话的订阅者，与既有的 `title`、`recap` 信封同级。它属于会话状态，不是转写事件。

客户端按会话各存一份候选，位于 `packages/client-core/src/lib/prompt-suggestion.ts`。过期由两端共同保证，而不是引入 turn id：

- daemon 在 `turn_start` 取消在途请求，预测无法越过它所描述的回合；
- 输入框在发送时清空候选，被中止的回合无法让它复活；
- store 以会话为键，切换对话不会把候选带到另一段上下文。

## 5. 呈现

两个输入框（桌面壳 `apps/desktop/src/components/Composer.tsx`，游客/移动壳 `packages/client-core/src/components/shell/Composer.tsx`）读同一个 store，并遵守同一份契约：

- 仅在草稿为空、输入框可写、没有 ask 对话框占用输入、语音采集空闲时显示；
- 渲染为占位槽里的一行省略文本，与 textarea 自身的文字度量对齐，末尾跟一个 `Tab` 键帽；
- 不接收指针事件（`pointer-events: none`）：点击属于下层 textarea，绝不抢走光标；
- 采纳后候选仍留在 store 里——清空文本会重新出现同一条预测，而不是把它消费掉。

## 6. 配置

只有一个设置项：`suggestion.enabled`（`packages/coding-agent/src/config/settings-schema.ts`），默认 `true`，入口在 设置 → 会话与记忆 → 会话 中的「候选输入建议」。模型**刻意不可配置**——预测始终使用会话自己的模型，任何别的模型都会让它赖以成立的缓存前缀失效。
