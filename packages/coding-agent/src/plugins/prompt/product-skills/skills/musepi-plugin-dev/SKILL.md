---
name: musepi-plugin-dev
version: 2.0.0
description: 为 MusePi（TUI/CLI + 桌面 GUI）创建、修改或修复插件——交付 Cordis 插件包（具名导出 name/inject/provide/apply、ctx.* 注册能力），先用 cordis_* 做会话内原型，再用 plugin_manager 安装启用。也覆盖 custom tools、hooks、slash commands、skills 与插件市场。触发："创建插件/工具/命令/hook"、"给 musepi 加 X 支持"、用 cordis_define 试原型、修改插件加载机制、写 MCP 相关集成。
---

# MusePi 插件开发

本文件是索引。细节在 `references/`，按需读，不要一次全读。

装载本技能**不授予**改动文件的权限。只有用户要求改动 MusePi 或其配置时才写插件、运行安装类动作或改预设；提问、设计、评审场景只做只读查询并报告结论。

## 查事实的顺序

1. **运行时检视**（工具可用时）：`cordis_inspect_list` / `cordis_inspect_query` 查精确的 Service 方法与事件模式、座位目录；`cordis_inspect_self` 看当前会话的插件与源码；`plugin_manager` 的 `list_plugins` 看组合条目与状态。
2. **本技能的 references**：见下方路由表。
3. 两者都答不了时，明确说明哪一点未经验证。不要为了拿到工具去改预设或配置。

## 路由表

| 要做的事 | 读这个 |
| --- | --- |
| 写一个插件入口、选服务面命名空间、决定作用域 | `references/plugin-model.md` |
| 让插件被装载、安装、启用，或排查装载失败 | `references/loading.md` |
| 用 `cordis_*` 在会话内做原型 | `references/dynamic-plugins.md` |
| 往界面里加座位或组件 | `references/ui-plugin.md` |
| 让模型也能操作插件的界面功能 | `references/user-actions.md` |
| 写插件页显示的标题、描述、配置表单与图标 | `references/plugin-details.md` |
| 声明组件、处理兼容性预检与版本豁免 | `references/components-and-compatibility.md` |
| 注册进程级服务或记忆后端 | `references/host-plugins.md` |
| 读配置、或考虑要不要持久化自己的配置 | `references/configuration.md` |
| 接一个 MCP server | `references/mcp-connection.md` |
| 打包、发布、进市场 | `references/packaging.md` |
| 查文档路径与代码位置 | `references/locate-docs.md` |
| 挑工具设计、写工具描述 | `references/tool-design.md` |
| 工程实践与验收 | `references/practices.md`、`references/verification.md` |

## 默认形态

用户说「创建插件」时，交付 **Cordis 插件包**：

- **入口**：具名导出 `name` / `inject` / `provide` / `apply`，能力通过 `ctx.*` 注册。
- **原型**：会话内用 `cordis_*` 验证交互与工具语义，不写盘、不跨会话。
- **交付**：写成包放到工作区或 `~/.musepi/plugins/<name>/`，用 `plugin_manager` 安装启用；非自动批准会话里让用户从插件页完成。安装树在 `~/.musepi/plugins/node_modules/<name>`（项目级在项目插件根）。

动态 `cordis_*` 的 `hostCode` 是沙箱函数体（只有 `defineTool`/timers/console）；插件包入口拿到的是宿主 `PluginAPI`。原型验证交互，包承载完整能力——两者不要混写。

## 硬约束

- **类型**：从 `@musepi/pi-coding-agent` 导入 `PluginAPI` / `CustomToolAPI`；不要用 `any` 绕过
- **ESM**：无 `require`；`verbatimModuleSyntax` 下类型导入用 `import type`
- **错误**：工具执行抛错会被包装成工具错误——message 要能让人看懂
- **权限**：插件与 agent 同权限（非沙箱）——破坏性操作走工具审批链
- **测试**：逻辑抽纯函数可单测；端到端用真实会话跑一次工具调用验证