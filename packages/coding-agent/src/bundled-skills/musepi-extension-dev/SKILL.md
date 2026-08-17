---
name: musepi-extension-dev
description: 为 MusePi（TUI/CLI + 桌面 GUI）开发扩展——custom tools、extensions（生命周期/事件）、hooks、plugins、slash commands、skills。触发：用户要求"加个工具/扩展/命令/hook/插件"、"给 musepi 加 X 支持"、修改扩展加载机制、写 MCP 相关集成。桌面 GUI 会话（daemon）与 TUI 共享同一扩展系统，扩展天然两形态可用。
---

# MusePi 扩展开发

扩展系统在 `packages/coding-agent/src/extensibility/`。六种形态，各有用途：

| 形态 | 是什么 | 关键文件 |
|---|---|---|
| **Custom tool** | 模型可调用的函数（execute + Zod schema） | `extensibility/custom-tools/loader.ts` |
| **Extension** | 生命周期/事件框架——可注册工具、拦截/修改事件 | `extensibility/extensions/`（loader/runner） |
| **Hook** | 外部 pre/post 命令脚本（如 tool_call 拦截） | `extensibility/hooks` |
| **Plugin** | 可安装的扩展包（`omp.extensions` 清单） | `extensibility/plugins` |
| **Slash command** | 斜杠命令（`/xxx`） | `extensibility/slash-commands.ts` |
| **Skill** | 静态知识包（SKILL.md） | `extensibility/skills.ts` + `discovery/builtin.ts` |

## 快速路径：最小扩展（够用 90% 场景）

写一个 TS 文件（默认导出 factory），放到 `~/.musepi/agent/extensions/<name>/index.ts`（用户级）或 `<cwd>/.musepi/extensions/<name>/index.ts`（项目级）：

```ts
import type { ExtensionAPI } from "@musepi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("My Extension");

	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash" && /rm -rf/.test(event.input.command ?? "")) {
			return { block: true, reason: "Blocked by extension policy" };
		}
	});

	pi.registerTool({
		name: "my_tool",
		label: "My Tool",
		description: "…",
		parameters: z.object({ query: z.string() }),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return { content: [{ type: "text", text: `got ${params.query}` }] };
		},
	});

	pi.registerCommand("my-cmd", {
		description: "…",
		handler: async (_args, ctx) => ctx.ui.notify("hi", "info"),
	});
}
```

扩展在 **Bun 运行时**执行：ESM 模块（无 `require`）、顶层 `export default` factory、可用 `await import()` 按需加载依赖。扩展代码与其他扩展共享进程——**不要**在扩展里做长阻塞/全局状态污染。

## 加载与发现（怎么让 musepi 看到你的扩展）

1. **自动发现**：`~/.musepi/agent/extensions`（用户）+ `<cwd>/.musepi/extensions`（项目）——目录含 `index.ts` 即可
2. **显式配置**：`~/.musepi/agent/config.yml` 的 `extensions:` 数组（路径/包目录）或 `-e/--extension` CLI flag
3. **禁用**：`disabledExtensions: [extension-module:<name>]`（name = 目录/文件名）；`--no-extensions` 全关
4. **验证**：`musepi /extensions` 列出已加载扩展；扩展里的 `console.error` 进 daemon/TUI 日志
5. **改 daemon 场景**：GUI 的 daemon 长驻——改扩展后必须重启 daemon（GUI 菜单"重启 daemon"）才生效；TUI 新会话即生效

## 文档路由表（需要细节时读这些，别猜）

| 任务 | 文档 |
|---|---|
| 扩展 API 全貌/事件名/命令上下文 | `docs/extensions.md` |
| 加载机制细节（发现顺序/路径解析/禁用） | `docs/extension-loading.md` |
| 自定义工具（模型直接调用） | `docs/custom-tools.md` |
| Hook（pre/post 脚本、可突变什么） | `docs/hooks.md` |
| 加 LLM provider（如新模型厂） | `docs/adding-a-provider.md` + 照抄 `packages/ai/src/registry/` 现有 provider（一个 def 文件 + 一个 registry 行 + catalog 条目） |
| MCP server/工具 | `docs/mcp-config.md` / `docs/mcp-server-tool-authoring.md` |
| 插件市场/安装器 | `docs/marketplace.md` / `docs/plugin-manager-installer-plumbing.md` |
| 设置项（settings.schema） | `docs/settings.md` + `src/config/settings-schema.ts`（单文件权威） |
| 斜杠命令实现 | `docs/slash-command-internals.md` |
| 系统提示词/技能注入 | `docs/context-files.md` / `docs/skills.md` |
| GUI 侧（daemon RPC/Electron） | `docs/gui-implementation.md`（daemon 契约/IPC 形状） |

## 硬约束

- **类型**：扩展 API 类型从 `@musepi/pi-coding-agent` 导入（`ExtensionAPI`/`CustomToolAPI`）；不要用 `any` 绕过
- **ESM**：无 `require`；`verbatimModuleSyntax` 下类型导入用 `import type`
- **Zod**：工具参数 schema 用 `pi.zod`（扩展工厂参数）——不用 typebox（扩展侧）
- **错误**：工具执行抛错会被包装成工具错误——用有意义的 message
- **权限**：扩展与 agent 同权限（非沙箱）——破坏性操作需用户确认（工具审批链）
- **测试**：扩展逻辑抽纯函数可单测（`bun test`）；端到端用真实会话跑一次工具调用验证
