# 钩子

[English](hooks.md) | 中文

本文档描述 `src/extensibility/hooks/*` 中的**当前钩子子系统代码**。

## 运行时的当前状态

默认 CLI runtime 初始化**扩展运行器**路径。在当前的启动流程中：

- `--hook` 被视为 `--extension` 的别名（CLI 路径被合并进 `additionalExtensionPaths`）
- 通过 `hookCapability` 发现的 JS/TS 钩子工厂（例如 `.musepi/hooks/pre/*.ts`）作为扩展模块加载，因此它们的 `pi.on(...)` 处理器绑定到 runtime 事件总线
- 工具由 `ExtensionToolWrapper` 包装，而不是 `HookToolWrapper`
- 上下文转换和生命周期发射都通过 `ExtensionRunner` 进行

因此，本文档记录的是遗留钩子子系统的实现本身（类型/加载器/运行器/包装器），以及当发现钩子路径由扩展运行器加载时仍被接受的工厂形状。

## 关键文件

- `src/extensibility/hooks/types.ts` — 钩子上下文、事件类型和结果契约
- `src/extensibility/hooks/loader.ts` — 模块加载与钩子发现桥接
- `src/extensibility/hooks/runner.ts` — 事件分发、命令查找、错误信号
- `src/extensibility/hooks/tool-wrapper.ts` — 前置/后置工具拦截包装器
- `src/extensibility/hooks/index.ts` — exports/re-exports

## 钩子模块是什么

钩子模块必须默认导出一个工厂：

```ts
import type { HookAPI } from "@musepi/pi-coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      String(event.input.command ?? "").includes("rm -rf")
    ) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

该工厂可以：

- 通过 `pi.on(...)` 注册事件处理器
- 通过 `pi.sendMessage(...)` 发送持久化自定义消息
- 通过 `pi.appendEntry(...)` 持久化非 LLM 状态
- 通过 `pi.registerCommand(...)` 注册斜杠命令
- 通过 `pi.registerMessageRenderer(...)` 注册自定义消息渲染器
- 通过 `pi.exec(...)` 运行 shell 命令并通过 `pi.logger` 记录日志
- 使用注入的 Zod 兼容构建器 `pi.zod`、原生 omptype 构建器 `pi.arktype`、遗留 `pi.typebox`，以及通过 `pi.pi` 访问包导出

## 发现与加载

默认会话通过扩展运行器发现 JS/TS 钩子工厂。`discoverExtensionPaths(configuredPaths, cwd)` 执行：

1. 从能力注册表加载原生扩展模块
2. 从钩子能力注册表加载可导入的 `.ts`/`.js` 钩子工厂
3. 追加插件扩展入口点
4. 追加显式配置的路径

遗留的 `discoverAndLoadHooks(configuredPaths, cwd)` 辅助函数仍然存在，并执行：

1. 从能力注册表加载已发现的钩子（`loadCapability("hooks")`）
2. 追加显式配置的路径（按绝对路径去重）
3. 调用 `loadHooks(allPaths, cwd)`

随后 `loadHooks` 导入每个路径并期望一个 `default` 函数。

### 路径解析

`loader.ts` 将钩子路径解析为：

- 绝对路径：按原样使用
- `~` 路径：展开
- 相对路径：相对于 `cwd` 解析

## 事件表面

钩子事件在 `types.ts` 中是强类型的。

### 会话事件

- `session_start`
- `session_before_switch` → 可返回 `{ cancel?: boolean }`
- `session_switch`
- `session_before_branch` → 可返回 `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_branch`
- `session_before_compact` → 可返回 `{ cancel?: boolean; compaction?: CompactionResult }`
- `session.compacting` → 可返回 `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`
- `session_compact`
- `session_before_tree` → 可返回 `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`
- `session_tree`
- `session_shutdown`

### Agent/上下文事件

- `context` → 可返回 `{ messages?: Message[] }`
- `before_agent_start` → 可返回 `{ message?: { customType; content; display; details; attribution } }`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `auto_compaction_start`
- `auto_compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

### 工具事件（模型前后）

- `tool_call`（执行前） → 可返回 `{ block?: boolean; reason?: string; input?: Record<string, unknown> }`。返回 `input` 的非阻断处理器会替换工具执行的参数（原始执行输入，而非标准化的 `event.input` 视图）；当 `block` 为 true 时忽略，且不应用于 `computer` 工具调用。
- `tool_result`（执行后） → 可返回 `{ content?; details?; isError? }`

这是钩子子系统的核心前置/后置拦截模型。

```text
钩子工具拦截流程

tool_call 处理器
   │
   ├─ 任意 { block: true }？ ── 是 ──> throw（工具被阻断）
   │
   └─ 否
      │
      ▼
   执行底层工具
      │
      ├─ 成功 ──> tool_result 处理器可以覆盖 { content, details }
      │
      └─ 错误   ──> 发射 tool_result(isError=true) 然后重新抛出原始错误
```

## 执行模型与变更语义

### 1）执行前：`tool_call`

`HookToolWrapper.execute()` 在工具执行前发射 `tool_call`。

- 如果任意处理器返回 `{ block: true }`，执行停止
- 如果处理器抛出异常，包装器安全失败并阻断执行
- 返回的 `reason` 成为抛出的错误文本

### 2）工具执行

如果未被阻断，底层工具正常执行。

### 3）执行后：`tool_result`

成功后，包装器发射带有以下内容的 `tool_result`：

- `toolName`、`toolCallId`、`input`
- `content`
- `details`
- `isError: false`

如果处理器返回覆盖：

- `content` 可以替换结果内容
- `details` 可以替换结果详情

工具失败时，包装器发射 `isError: true` 和错误文本内容的 `tool_result`，然后重新抛出原始错误。

### 钩子可以变更什么

- 单次调用的 LLM 上下文，通过 `context`（`messages` 替换链）
- 成功工具调用的工具输出内容/详情（`tool_result` 路径）
- 通过 `before_agent_start` 前置注入的消息
- 通过 `session_before_*` 和 `session.compacting` 进行的取消/自定义压缩/树行为

### 该实现中钩子无法变更什么

- 原始工具输入参数原地修改（仅在 `tool_call` 上阻断/允许）
- 抛出工具错误后的执行继续（错误路径重新抛出）
- 包装器行为中的最终成功/错误状态（返回的 `isError` 有类型但未被 `HookToolWrapper` 应用）

## 排序与冲突行为

### 发现级排序

能力提供者按优先级排序（更高优先级的在前）。按能力键去重，先出现的获胜。

对于 `hooks`，能力键是 `${type}:${tool}:${name}`。来自较低优先级提供者的被 shadow 的重复项被标记并从有效发现列表中排除。

### 加载顺序

`discoverAndLoadHooks` 构建一个扁平的 `allPaths` 列表，按解析后的绝对路径去重，然后 `loadHooks` 按该顺序迭代。
每个发现目录内的文件顺序取决于 `readdir` 输出；钩子加载器不执行额外排序。

### 运行时处理器顺序

在 `HookRunner` 内部，顺序由注册序列决定：

1. hooks 数组顺序
2. 每个钩子/事件的处理器注册顺序

按事件类型的冲突行为：

- `tool_call`：除非处理器阻断，否则最后返回的结果获胜；第一次阻断即短路。返回的 `input`（执行参数覆盖）遵循同样的最后获胜规则；处理器之间不会观察到彼此的修订
- `tool_result`：最后返回的覆盖获胜（无短路）
- `context`：链式；每个处理器接收前一个处理器的消息输出
- `before_agent_start`：保留返回的第一条消息；后续消息被忽略
- `session_before_*`：追踪最后返回的结果；`cancel: true` 立即短路
- `session.compacting`：最后返回的结果获胜

命令/渲染器冲突：

- `getCommand(name)` 跨钩子返回第一个匹配（先加载的获胜）
- `getMessageRenderer(customType)` 返回第一个匹配
- `getRegisteredCommands()` 返回所有命令（无去重）

## UI 交互（`HookContext.ui`）

`HookUIContext` 包括：

- `select`、`confirm`、`input`、`editor`
- `notify`
- `setStatus`
- `custom`
- `setEditorText`、`getEditorText`
- `theme` getter

`ctx` 包括 `hasUI`、`cwd`、`sessionManager`、`modelRegistry`、当前 `model`、`isIdle()`、`abort()` 和 `hasQueuedMessages()`。

在没有 UI 运行时，默认 no-op 上下文行为是：

- `select/input/editor` 返回 `undefined`
- `confirm` 返回 `false`
- `notify`、`setStatus`、`setEditorText` 是无操作
- `getEditorText` 返回 `""`

### 状态行行为

通过 `ctx.ui.setStatus(key, text)` 设置的钩子状态文本：

- 按键存储
- 按键名排序
- 净化（ANSI/VT 转义序列被剥离；控制字符映射为空格；重复空格合并；修剪）
- 连接并按显示宽度截断

## 错误传播与回退

### 加载时

- 无效模块或缺少默认导出 → 捕获在 `LoadHooksResult.errors`
- 为其他钩子继续加载

### 事件时

`HookRunner.emit(...)` 对大多数事件捕获处理器错误并向监听者发射 `HookError`（`hookPath`、`event`、`error`），然后继续。

`emitToolCall(...)` 更严格：处理器错误在那里不会被吞掉；它们传播到调用者。在 `HookToolWrapper` 中，这会阻断工具调用（fail-safe）。

## 真实 API 示例

### 阻断不安全的 bash 命令

```ts
import type { HookAPI } from "@musepi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    if (!cmd.includes("rm -rf")) return;

    if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
    const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
    if (!ok) return { block: true, reason: "user denied command" };
  });
}
```

### 在执行后编辑工具输出

```ts
import type { HookAPI } from "@musepi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;

    const redacted = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replaceAll(/API_KEY=\S+/g, "API_KEY=[REDACTED]"),
      };
    });

    return { content: redacted };
  });
}
```

### 按 LLM 调用修改模型上下文

```ts
import type { HookAPI } from "@musepi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (msg) => !(msg.role === "custom" && msg.customType === "debug-only"),
    );
    return { messages: filtered };
  });
}
```

### 注册带有命令安全上下文方法的斜杠命令

```ts
import type { HookAPI } from "@musepi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a new session with setup message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [
              { type: "text", text: "Continue from prior session summary." },
            ],
            timestamp: Date.now(),
          });
        },
      });
    },
  });
}
```

## 导出面

`src/extensibility/hooks/index.ts` 和包子路径 `@musepi/pi-coding-agent/extensibility/hooks` 导出：

- 加载 API（`discoverAndLoadHooks`、`loadHooks`）
- 运行器和包装器（`HookRunner`、`HookToolWrapper`）
- 所有钩子类型
- `execCommand` 重新导出

包根（`@musepi/pi-coding-agent`）不重新导出 `HookAPI`；从钩子子路径导入遗留钩子类型。
