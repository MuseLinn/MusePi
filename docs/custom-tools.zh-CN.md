# Custom Tools

[English](custom-tools.md) | 中文

自定义工具（custom tools）是可由模型调用的函数，它们接入与内置工具相同的工具执行流水线（tool execution pipeline）。

自定义工具是一个导出工厂函数（factory）的 TypeScript/JavaScript 模块。工厂函数接收宿主 API（`CustomToolAPI`），返回一个工具或一组工具。

## 这是什么（以及不是什么）

- **自定义工具（Custom tool）**：在某一轮会话（turn）中可由模型调用（`execute` + Zod 参数 schema）。
- **扩展（Extension）**：生命周期/事件框架，可注册工具并拦截/修改事件。
- **钩子（Hook）**：外部的命令前/命令后脚本。
- **技能（Skill）**：静态的指引/上下文包，不是可执行的工具代码。

如果你需要模型直接调用代码，请使用自定义工具。

## 当前代码中的集成路径

当前有两种活跃的集成方式：

1. **SDK 提供的自定义工具**（`options.customTools`）
   - 通过 `CustomToolAdapter` 或扩展包装器（extension wrappers）包装为 agent 工具。
   - 在 SDK 启动（bootstrap）时始终包含在初始活跃工具集中。

2. **通过 loader API 从文件系统发现的模块**（`discoverAndLoadCustomTools` / `loadCustomTools`）
   - 作为库 API 暴露在 `src/extensibility/custom-tools/loader.ts` 中。
   - 宿主代码可调用这些 API，从 config/provider/plugin 路径发现并加载工具模块。

```text
模型工具调用流程

LLM tool call
   │
   ▼
Tool registry (内置工具 + 自定义工具适配器)
   │
   ▼
CustomTool.execute(toolCallId, params, onUpdate, ctx, signal)
   │
   ├─ onUpdate(...)  -> 流式传输的部分结果
   └─ return result  -> 最终工具内容/详情
```

## 发现位置（loader API）

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames)` 合并以下来源：

1. 能力提供者（`toolCapability`），包括：
   - 原生 OMP 配置（`~/.musepi/agent/tools`、`.musepi/tools`）
   - Claude 配置（`~/.claude/tools`、`.claude/tools`）
   - Codex 配置（`~/.codex/tools`、`.codex/tools`）
   - Claude marketplace 插件缓存提供者
2. 已安装的插件清单（通过插件 loader 读取 `~/.musepi/plugins/node_modules/*`）
3. 显式传入 loader 的已配置路径

### 重要行为

- 重复的已解析路径会被去重。
- 工具名冲突会针对内置工具及已加载的自定义工具被拒绝。
- 某些提供者会把 `.md` 和 `.json` 文件发现为工具元数据，但可执行模块 loader 会拒绝将其作为可运行工具。
- 相对配置路径从 `cwd` 解析；`~` 会被展开。

## 模块契约

自定义工具模块必须导出一个函数（推荐默认导出）：

```ts
import type { CustomToolFactory } from "@musepi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.zod.object({
    glob: pi.zod.string().optional(),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec(
      "git",
      ["ls-files", params.glob ?? "**/*.ts"],
      { signal, cwd: pi.cwd },
    );
    if (result.killed) {
      throw new Error("Scan was cancelled");
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || "git ls-files failed");
    }

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // cleanup resources if needed
    }
  },
});

export default factory;
```

参数 schema 可使用与 Zod 兼容的 omptype 构建器（`pi.zod`）、原生 omptype 构建器（`pi.arktype`），或兼容旧版的 TypeBox shim（`pi.typebox`），它们都会流经共享的校验/传输流水线（validation/wire pipeline）。

工厂返回类型：

- `CustomTool`
- `CustomTool[]`
- `Promise<CustomTool | CustomTool[]>`

## 传给工厂的 API 表面（`CustomToolAPI`）

来自 `types.ts` 和 `loader.ts`：

- `cwd`：宿主工作目录
- `exec(command, args, options?)`：进程执行辅助函数
- `ui`：UI 上下文（在无头模式下可以为 no-op）
- `hasUI`：在非交互流程中为 `false`
- `logger`：共享的文件日志器
- `arktype`：注入的 omptype `type(...)` 构建器
- `typebox`：兼容旧版 TypeBox 风格 schema 的 shim
- `pi`：注入的 `@musepi/pi-coding-agent` 导出
- `pushPendingAction(action)`：注册一个预览动作，通过向 `/xdev/resolve` 或 `/xdev/reject` 写入纯文本来完成（`docs/resolve-tool-runtime.md`）

Loader 以 no-op 的 UI 上下文启动，并要求宿主代码在真实 UI 就绪时调用 `setUIContext(...)`。

## 执行契约与类型

`CustomTool.execute` 签名：

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params` 通过 `Static<TParams>` 由其 omptype 或 TypeBox schema 静态地类型化。
- 运行时参数校验在 agent 循环中、执行之前进行。
- `onUpdate` 为 UI 流式传输发出部分结果。
- `ctx` 包含 `sessionManager`、`modelRegistry`、当前 `model`、`isIdle()`、`hasQueuedMessages()`、`abort()`，以及可选的 `settings`、`fetch` 和 `autoApprove`。
- `signal` 携带取消信号。

`CustomToolAdapter` 将其桥接到 agent 工具接口，并以正确的参数顺序转发调用。

工具定义还可以声明 `strict`、`hidden`、`deferrable`、`mcpServerName`、`mcpToolName`、`approval` 和 `formatApprovalDetails`。

## 工具如何暴露给模型

- 工具被包装为 `AgentTool` 实例（`CustomToolAdapter` 或扩展包装器）。
- 它们按名称被插入会话工具注册表（tool registry）。
- 在 SDK 启动时，自定义工具和扩展注册的工具会被强制包含进初始活跃工具集。
- CLI `--tools` 目前只校验内置工具名；自定义工具的纳入通过发现/注册路径及 SDK 选项处理。

## 渲染钩子

可选的渲染钩子：

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

TUI 中的运行时行为：

- 如果存在钩子，工具输出会在 `Box` 容器内渲染。
- `renderResult` 接收 `{ expanded, isPartial, spinnerFrame? }`。
- 渲染器错误会被捕获并记录日志；UI 回退到默认文本渲染。

## 会话/状态处理

可选的 `onSession(event, ctx)` 接收会话生命周期事件，包括：

- `start`、`switch`、`branch`、`tree`、`shutdown`
- `auto_compaction_start`、`auto_compaction_end`
- `auto_retry_start`、`auto_retry_end`
- `ttsr_triggered`、`todo_reminder`

当分支/会话上下文变化时，使用 `ctx.sessionManager` 从历史中重建状态。

## 失败与取消语义

### 同步/异步失败

- 在 `execute` 中抛出异常（或 promise 被拒绝）会被视为工具失败。
- Agent 运行时把失败转换为带有 `isError: true` 和错误文本内容的工具结果消息。
- 使用扩展包装器时，`tool_result` 处理器可以进一步改写内容/详情，甚至可以覆盖错误状态。

### 取消

- Agent 中止通过 `AbortSignal` 传播到 `execute`。
- 把 `signal` 转发给子进程工作（`pi.exec(..., { signal })`），以实现协作式取消。
- `ctx.abort()` 让工具请求中止当前的 agent 操作。

### onSession 错误

- `onSession` 错误会被捕获并记录为警告；它们不会导致会话崩溃。

## 设计时需要面对的真实约束

- 工具名必须在活跃注册表中全局唯一。
- 在 `details` 中优先使用确定性的、schema 化的输出，以便渲染器/状态重建。
- 用 `pi.hasUI` 保护 UI 的使用。
- 把工具目录中的 `.md`/`.json` 视为元数据，而非可执行模块。
