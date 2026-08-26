# Agent Hub

[English](agent-hub.md) | 中文

Agent Hub 是用于监视和控制当前会话关联子代理的交互式 TUI。它将实时名单、逐代理活动与用量、 transcript 访问、转向、复活和终止控制组合在一起。主代理不列入名单，因为它的对话就是当前会话视图本身。

Hub 还会在会话恢复时，从当前会话的持久化产物中发现已停放（parked）的子代理。 Advisor transcript 文件会以只读行形式出现。

## 打开 Hub

| 输入 | 行为 |
| --- | --- |
| `Alt+A` | 通过 `app.agents.hub` 打开或关闭 Agent Hub。即使名单为空也会打开 roster。 |
| `Ctrl+S` | 通过遗留的 `app.session.observe` 动作打开或关闭同一个 Hub。 |
| 双击 `←` | 在当前主会话编辑器为空、且当前会话有待展示代理时，直接打开 Hub。 |

运行 `/hotkeys` 查看当前有效组合键。可在 `~/.musepi/agent/keybindings.yml` 中重映射任一动作：

```yaml
app.agents.hub: Alt+A
app.session.observe: Ctrl+S
```

双击 `←` 手势不是 keybinding 动作。当焦点位于子代理时，双击 `←` 会返回主会话，而不是打开 Hub。

## 名单与检查器

名单从会话的 agent registry 和 progress 事件更新。响应式行显示：

- 状态（`running`、`idle`、`parked` 或 `aborted`）、agent 身份、父代理和未读 IRC 计数；
- 模型角色、已解析模型，以及距上次活动的时长；
- 分配的任务或当前活动；
- 成本、活跃时间或已过时长、请求数、tool-call 数和 token 数。

头部对所有被测量代理的状态和用量做聚合。按 `t` 在稳定的平铺名单和父/子树之间切换。

在宽终端上，所选代理的 inspector 会出现在名单旁边；在窄终端上，按 `Tab` 用 inspector 替换名单。Inspector 额外展示：

- 当前 tool 及参数、最近 intent 和重试状态；
- 上下文窗口使用情况（若可用）；
- 父/子级 lineage；
- 输出和 patch 路径，以及隔离 worktree 的 branch 元数据（若存在）。

指标取决于该代理可用的 progress 或持久化 usage 数据。缺失数据会显示为 `usage —`，而不是估算值。

### 名单控制

| 按键或输入 | 动作 |
| --- | --- |
| `j` / `k`、`↑` / `↓`、滚轮 | 选择一个代理。 |
| `Enter` 或点击 | 打开所选代理。 |
| `t` | 切换平铺视图与父/子树视图。 |
| `Tab` | 在窄终端上切换 inspector。 |
| `PageUp` / `PageDown` | 滚动已打开的 inspector。 |
| `r` | 复活选中的 parked 代理。 |
| `x` | 必要时中止当前 turn，然后终止并释放所选代理。 |
| `Esc` | 先在窄终端关闭 inspector，然后关闭 Hub。 |

只有 `parked` 代理可以被复活。`x` 是立即生效的；仅在确定要丢弃该代理实例时使用。

## 读取与转向子代理

对于普通本地子代理，按 `Enter` 或点击会将主 TUI 聚焦到该代理的会话并关闭 Hub。聚焦一个 parked 代理会先复活它。随后 transcript、状态行和编辑器都属于该子代理：

1. 读取其实时 transcript 和 tool 活动。
2. 输入消息并按 `Enter`，以 steer 一个正在运行的 turn，或 prompt 一个空闲代理。
3. 在空编辑器下按 `Esc`，或双击 `←`，返回主会话。

Steering 使用正常的 prompt 路径，因此消息和响应都会写入该子代理的持久化会话历史。在子代理聚焦期间，按 `Esc` 返回主会话；它不会中断子代理。

没有本地可聚焦会话的上下文会改用 Hub 的全屏 transcript viewer。这包括 collab guests 和 advisor 行。viewer 会增量 tail 文件-backed transcript，并且仅在所选代理可被发消息时才提供输入行。在那里发送具有相同语义：parked 则 revive，running 则 steer，idle 则 prompt。

## 持久化代理与 Advisor

为持久化会话打开 Hub 时，会扫描该会话的 artifact 树。历史子代理 JSONL 文件会变成 parked 行；被终止代理的 tombstone 保持 aborted 状态。嵌套子代理保留其父/子 lineage。输出和 patch 产物会被附加到对应的 inspector 行。

Advisor transcript 文件（`__advisor*.jsonl`）会以其所属会话下的 `advisor` 类型行出现。它们是可观测记录，不是 peer：

- 它们的 transcript 可以被打开和跟踪；
- 它们不能被发消息；
- 它们不能被复活；
- 它们不能被终止。

这些限制同样适用于控制主机 Hub 的 collab guest。

## 相关界面

Agent Hub 是面向用户实时会话视图。相邻命令和内部 URL 服务于更窄的场景：

- `/jobs` 打印运行中以及最近结束的异步 tool jobs 快照；它不替代逐代理 transcript 或控制视图。
- `history://<id>` 为 coding agent 提供 live 或 parked 子代理的精简 transcript。
- `agent://<id>` 解析子代理保存的最终输出产物；它不是实时 transcript。
- `hub` `list` 向 coding agent 暴露 peer 名单，`hub` `send` 可以以编程方式 steer 或跟进普通子代理。给 parked 子代理发消息会复活它。

Advisor 行被有意排除在面向 agent 的 `hub`、`history://` 和 `agent://` peer 工作流之外。

另见 [Task Agent Discovery and Selection](./task-agent-discovery.html)、[Collaboration](./collab.html) 和 [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.html)。
