# 顾问卡修复的真实数据交叉验证（2026-09-27）

状态：已验证（修复在真实会话数据上成立，另发现 2 个低危残留问题）

关联 commit：`62f44a2a1` fix(desktop): 顾问卡不再触发聊天旧消息整批消失 + 会话地图轮次/时长错乱

## 数据来源

daemon journal：`%TEMP%/musepi-daemon/journal/<sessionId>.journal.jsonl`；持久化投影：`materialized.db` 的 `materialized_sessions.snapshot`。

| 会话 | 角色 | journal 事件数 | 顾问卡数 |
| --- | --- | --- | --- |
| `01a0ccb3-3b78-7000-a49e-ac9fa2ed6d40` | 目标会话（"你现在处于什么模式下？"，09-23 起、09-27 18:00 左右触发 bug） | 2915 | 3 |
| `01a0d4aa-9e65-7000-9a6a-68520afe68a4` | 对照 | 1166 | 1 |
| `01a0ddbf-4aff-7000-95e1-11aa649c50fd` | 对照 | 573 | 1 |
| `1a40b656-69ce-4427-b933-258d52c9953d` | 对照（hex id 空间） | 896 | 1 |

关键事实（journal 原文）：目标会话 3 张顾问卡（seq 2424/2910/2914）的 message 均 **`parentId: null`**——修复前持久化，parentId 缺失是旧数据固状，GUI 兜底规则必须对旧数据成立（不能依赖 daemon 重新打标）。

## JSONL × 截图对照

截图 1（聊天视图）：顾问卡出现后只剩 1 条 user 气泡 + 顾问卡，其余全消失。
截图 2（地图视图）：3 个 `Turn 1 <advisory se…>` 堆叠 + 跨度 `200h 43m` + 右侧空白框。

修复前机制与数据逐条对应：

- 尾条目（seq 2915）是 parentless 顾问卡 → 旧 leaf-walk 把它判成真根，活跃路径只剩它一行 → 聊天里 journal 中其余 **76/77 条**（4 user、29 assistant、36 toolResult、其余 custom/标记）全部消失。修复后 `walkLeafPath` 判 `complete=false` → `filterVisibleEntries` 回退全显示 → **77/77 全部保留**（脚本断言通过）。
- 3 张顾问卡均 parentless 且非首条 → 旧 `depthOf` 给每张深度 1 → 地图 3 个 "Turn 1"。修复后 depth 返回 undefined → 回退 journal 序（Turn 5/6/7），标题读 `details.notes[].note`（journal 里 `details.notes[0].note` 存在且为干净文本），无 `<advisory>` XML 泄漏（4 个会话断言通过）。
- `200h 43m` 来自旧时长锚污染（`endMs = startMs + duration` 无钳制）。当前 `materialized.db` 里该会话的 `roundDurations=[[1790502866633,13173],[1790503231436,225603]]`（13s / 226s，均正常量级）；journal 重放投影的事件跨度 101.76h = 会话真实存活时长（09-23 → 09-27），`endMs` 钳制生效（无 endMs<startMs、无 >24h 时长）。

## 投影验证

临时脚本：`.workbuddy/tmp/verify-advisor-projection.ts`（只读，import 修复后的 `packages/sdk/src/materialized-view.ts`、`packages/desktop-app/src/lib/leaf-walk.ts`、`packages/desktop-app/src/components/trajectory-data.ts`，全量重放 4 个会话 journal）。

结果（ALL CHECKS PASSED）：

- 可见性：4/4 会话 `filterVisibleEntries` 输出 = 全部条目；尾条目 parentless 顾问卡均 `complete=false` 回退全显示（旧 bug 情形专项断言通过）。
- 地图：轮次不塌（目标会话 8 组 Turn 0–7）、标题无 XML、投影跨度 = 真实时长。
- 同毫秒 key 拆键：目标会话 seq 2910/2911（同一顾问卡 start/end 同毫秒）正确去重为 1 张卡，3 张卡 id 互不覆盖。

## 新发现的问题

1. **低危：rekey 路径 hex/key id 空间混用确认存在，但当前无界面可见影响**（agent-15 尾巴 closure）。`packages/coding-agent/src/daemon/session-host.ts:1674-1684`：`sdkEntries.map` 只 rekey `type === "message"` 的条目，SDK 的 14 条 `custom` + 2 条 `model_change` 保留 hex id 且其 hex parentId 悬空（父 message 已被 rekey 成 `role:ts`）。已用持久化快照逐一核实：这些条目类型在 `Transcript.tsx:920-1047` 的 switch 中渲染为 null（model_change/thinking_level_change 无行，未知类型 default skip），不参与消息叶链（message 的父链走 `nearestMessageOf` 只跳 message 祖先），leaf-walk 从消息叶出发永不经过它们 → 不丢行、不塌深度。残留风险：若未来有渲染依赖 `custom`/`model_change` 条目或其 parentId，悬空父链会静默断链。建议后续把 rekey 扩展到非 message 条目（父解析同样走 nearestMessageOf 语义）。
2. **低危：`agent_end` 时长锚取条目时间戳（provider 时钟），`Date.now() - turnStartMs` 用墙钟**，两者时钟源不一致。当前 `roundDurations` 值（226s vs 组内事件仅 ~47s）已显示 provider 时钟滞后墙钟数分钟；`buildTrajectoryTree` 的 endMs 钳制（trajectory-data.ts:440-449）保证了显示不出格，但冻结的 `roundDurationMs` 本身可能偏大。仅影响"已工作 X 秒"读数的精确度，无错乱。

## 结论

修复在真实会话数据上成立：旧 journal 中 `parentId: null` 的顾问卡（修复前持久化的数据）在修复后的投影下聊天条目 0 丢失、地图轮次/标题/时长全部正常；4 个会话（含 hex id 空间对照）全量重放断言全绿。发现的 2 个残留问题均为低危，不影响本次修复的正确性。
