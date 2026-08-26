# Vibe 模式

[English](vibe-mode.md) | 中文

Vibe 模式会把当前会话变成一名 **director**：它不再直接编辑代码，而是驱动持久运行的 background worker sessions。在 Vibe 模式下，你自己的工具集会缩减为 `read`、可选的 parent-owned `todo`，再加上五个 worker-control tools；workers 负责 grep、编辑、运行和构建，你则通过读取它们修改过的文件来核验结果。如果存在 `todo`，它也只是 director 在父会话中的记账工具；workers 不拥有它。

## 启用与退出

使用 `/vibe` slash command 切换：

```text
/vibe                 # 进入 vibe 模式
/vibe fix the flaky test in packages/tui   # 进入并提交第一条 directive
/vibe                 # 再次运行即退出
```

- 进入时会安装 vibe tools，将当前活跃工具集缩减为 `read`、可选的 parent-owned `todo` 以及 vibe tools，并为该 turn 注入 director 指令。
- 内联 prompt（`/vibe <prompt>`）会进入该模式，并把这段 prompt 作为第一条 directive 提交。
- 退出时会恢复之前的工具集，并 **kills every worker session** —— worker 的存活期不会超过控制它的 mode。
- Vibe 模式与 plan mode 和 goal mode 互斥；请先退出这些模式。开启时状态行会显示 `Vibe` 指示器。

## 两层 worker

每个 worker 都是拥有完整工具面的 coding agent。启动时需要选择 tier：

| Tier   | Backing agent | Model role | Use for |
|--------|---------------|------------|---------|
| `fast` | `sonic`       | `@smol`（低延迟 role） | 机械执行、草稿、高吞吐量工作 |
| `good` | `task`        | `@task`（会话中的强模型） | 设计、判断调用、reviewing `fast` output |

Model resolution 与 `task` spawn 走同一路径，因此
`task.agentModelOverrides` 和你的 model-role settings 同样生效。

## Worker-control tools

| Tool | Purpose |
|------|---------|
| `vibe_spawn` | 启动一个 worker（`fast` 或 `good`）并给出完整、自包含的 brief。Workers 启动时空白——它们永远不会看到 director 的 conversation。 |
| `vibe_send`  | 给 worker 发送后续 turn：一次修正、下一步，或 review 请求。 |
| `vibe_wait`  | 阻塞直到 worker 完成下一次 turn。Sends 和 spawns 都会立即返回；结果会自行送达，因此只有在没有结果就无法继续时才调用 `vibe_wait`。 |
| `vibe_kill`  | 终止一个卡住或工作流已结束的 worker。 |
| `vibe_list`  | 当你记不住当前 roster 时列出活跃 worker 列表。 |

spawn 或 send 会立即返回；worker 的 turn result 会自行回送到 director 的 conversation 中，和异步 `task` 结果完全一样。正常运行一个 `fast` 和一个 `good` worker 在不同 workstreams 上并发，是常见形态。

## Workflow

1. 把请求拆成独立的 workstreams——每个 workstream 对应一个 worker session，这样各自都能建立有用的本地上下文。
2. `vibe_spawn` 时给出自包含的 brief：文件、约束、acceptance criteria。
3. 在 turn 进行中继续指挥其他 workers；只有被阻塞时才使用 `vibe_wait`。
4. 当一个 turn result 到达时，先 `read` 被修改的文件来核验声明，再基于它继续推进。如果存在可选的 parent-owned `todo`，通过它整理已验证的工作，然后 `vibe_send` 下一步。
5. 按难度路由：用 `fast` 起草，当 `fast` 卡住或问题需要判断时升级到 `good`。
6. 结束或卡住的 worker 用 `vibe_kill` 清理；用 `vibe_list` 恢复 roster。

你仍然对最终结果负责——用 `read` 核验，绝不要相信 worker 的一面之词。