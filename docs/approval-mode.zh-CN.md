# 工具审批模式

[English](approval-mode.md) | 中文

工具审批有两个独立的输入：

1. **工具声明** — 每个工具都可以声明一个 `approval` 层级：
   - `read`：读取数据或更新仅 UI 的会话元数据。
   - `write`：改变工作区/会话状态，但不执行任意代码。
   - `exec`：执行代码、调用 shell、驱动浏览器、派生 agent，或执行类似宽泛的操作。
2. **用户策略** — `tools.approval.<toolName>: allow | deny | prompt` 覆盖该工具的模式，除非非 yolo 的安全 override 强制提示。

没有 `approval` 声明的工具被视为 `exec`。这是对未知自定义工具的安全默认。MCP server 工具声明 `write`。

## 模式

用 `tools.approvalMode` 配置：

| 模式                 | 自动批准             | 提示                |
| -------------------- | -------------------- | ------------------- |
| `always-ask`         | `read`               | `write`, `exec`     |
| `write`              | `read`, `write`      | `exec`              |
| `yolo`（默认）        | `read`, `write`, `exec` | 无                  |

`--auto-approve` 和 `--yolo` 强制将该会话的 `tools.approvalMode` 设为 `yolo`。

## 用户覆盖

`tools.approval` 在每种模式下都被尊重：

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem__delete: deny
```

每次工具调用的解析：

1. 从 `tool.approval(args)` 计算工具审批决定；省略表示 `exec`。
2. 若存在 `tools.approval.<tool>` 则规范化；无效值被忽略。
3. 在 `yolo` 模式下，存在用户策略时使用用户策略；否则允许该调用。安全 `override` 原因在 `yolo` 下不强制提示。
4. 在非 yolo 模式下，若工具设置 `override: true`，则 `deny` 被阻止，且所有其他情况都提示，即使用户策略说 `allow`。
5. 否则，有效的用户策略优先。
6. 否则，活动模式按层级自动批准或提示。

## 安全 override

工具可以用对象形式的审批强制提示：

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` 用它处理关键破坏性模式，例如 `rm -rf /`、fork 炸弹、远程获取后执行、写入 `/etc/passwd`，以及宿主机关机命令。这些以 `reason` 形式出现在审批提示中，但在 `yolo` 模式下自动批准，除非该工具的用户策略设为 `prompt` 或 `deny`。

### 原生 computer 安全检查

默认为禁用的 [`computer` 工具](./computer-use.html) 从完整有序批处理中选择其层级：

- 只包含 `screenshot` 和 `wait` 的批处理使用 `read`；
- 任何指针或键盘操作使用 `exec`；
- 缺失或格式错误的操作保守地使用 `exec`。

Provider 安全检查使用比普通工具审批更强的门控。解析顺序：

1. `tools.approval.computer: deny` 立即阻止该调用。
2. 否则，任何 OpenAI `pending_safety_checks` 强制交互式 Approve/Deny 提示。
3. `yolo`、`--auto-approve`、按工具的 `allow`，以及先前的 xdev 批准都不确认 provider 检查。
4. 无头会话或不可用的 UI 失败关闭。
5. 显式批准仅针对该次调用记录；结果返回相同的检查作为 `acknowledged_safety_checks`。
6. 执行器在原生输入前再次检查审批标记。

Provider 批准不授权底层现实世界操作。屏幕文本不可信，不能覆盖直接的用户指令。除非用户直接消息已授权，否则后果性操作仍需在风险点确认确切的 target、scope 和 values。

## 逐工具提示详情

工具可以用 `formatApprovalDetails(args)` 添加审批提示正文行。标准提示包括：

- `Allow tool: <name>`
- 未注明来源的 `mcp__...` 工具用 `Origin: MCP server tool`
- 当工具决定提供原因时用 `Reason: <reason>`
- 工具特定详情，如 command、path、code、browser action 或 subagent assignment

## 在工具上定义审批

内置和自定义工具共享相同的形状：

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision = ToolTier | { tier: ToolTier; reason?: string; override?: boolean };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

示例：

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";
```

## ACP 会话

ACP（`musepi acp`）使用与普通 OMP 启动相同的设置解析器。全局 `~/.musepi/agent/config.yml` 适用，ACP 会话 `cwd` 的项目配置适用，传给 ACP server 进程的任何 `--config <file>` overlay 适用于该进程创建的会话。

要自动批准 ACP 工具调用，在全局或项目配置中设置模式：

```yaml
tools:
  approvalMode: yolo
```

或用 runtime override 或单进程配置 overlay 启动 ACP server：

```bash
musepi acp --yolo
musepi acp --auto-approve
musepi acp --approval-mode yolo
musepi acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

优先级是普通设置的优先级：runtime flags（`--approval-mode`、`--auto-approve`、`--yolo`）覆盖 `--config` overlay，后者覆盖项目配置，再覆盖全局配置。ACP 目前不定义 `session/new`、`session/load` 或 `session/resume` 审批策略字段，因此需要按会话 yolo 的 ACP 客户端应使用上述 flag 之一或会话特定的 `--config` overlay 启动单独的 `musepi acp` 进程。

当显式配置或由 runtime flag 提供时，`tools.approvalMode: yolo` 完全适用于 ACP。它跳过 OMP 的审批提示，也跳过 ACP 客户端对 `bash`、`edit`、`delete` 和 `move` 的权限门，除非 `tools.approval.<tool>` 为 `prompt` 或 `deny`。schema 默认是 `yolo`，但默认配置的 ACP 会话仍保留客户端权限门；客户端想要无监督执行时应显式设置 `tools.approvalMode: yolo`。

当需要 ACP 审批时，OMP 通过 ACP 客户端而不是终端 TUI 路由它。客户端门控的 `bash`、`edit`、`delete` 和 `move` 调用使用 ACP `session/request_permission`；当客户端公布 `elicitation.form` 时，通用审批提示使用表单引询。被拒绝、取消或不支持的提示会拒绝/取消工具调用；OMP 不会静默允许它。

## 子代理

子代理以 `tools.approvalMode: yolo` 无头运行，因此不会卡住等待 UI。父 `task` 审批是授权边界。用户的 `tools.approval.<tool>` 设置继续控制一个工具是被允许、提示还是阻止。
