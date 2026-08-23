# @musepi/pi-tool-select

MusePi agent 的渐进式工具披露（`select_tools`）：把 MCP 等可延后 schema 挡在顶层
`tools[]` 之外、按需加载，让模型每一轮只看到本轮真正可能用到的 schema。

## 模块

| 模块 | 职责 |
| --- | --- |
| `partition` | 哪些工具可延后 + 激活集计算。永不延后的来源：`builtin`、`sdk` |
| `gate` | 该模型是否启用渐进披露？（catalog `deferredToolsMode`，如 `kimi`） |
| `ledger` | 从会话历史折叠已加载工具集——过往轮次的延后加载标记决定当前可用集合 |
| `plan` | `planLoad`：`select_tools` 请求的三分（已加载 / 可延后 / 拒绝） |
| `announcement` | 披露流程的公告与结果渲染（`SELECT_TOOLS_TOOL_NAME = "select_tools"`） |
| `types` | 共享类型（`ToolSelectModelRef`、gate 配置、加载计划） |

## 用法

agent 循环把模型请求的工具名交给 `select_tools`；`plan` 决定哪些可以现在加载，
`ledger` 把结果折叠回会话历史，`announcement` 为转写渲染变更。

## 约束

- builtin 与 SDK 工具永不延后——渐进披露只作用于扩展/MCP 表面。
- ledger 是已加载集的唯一事实源；不要另存一份可能与会话历史漂移的内存副本。
