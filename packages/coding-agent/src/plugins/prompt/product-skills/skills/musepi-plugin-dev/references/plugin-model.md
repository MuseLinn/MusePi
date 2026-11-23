# 插件模型：入口、服务面与作用域

一个 MusePi 插件是一个 **Cordis 插件包**：`package.json` 声明清单，入口模块具名导出三件套。

## 入口形状

```ts
import type { PluginAPI } from "@musepi/pi-coding-agent";

export const name = "my-plugin";
export const inject = [] as const;   // 依赖的宿主服务名；不满足则不装载
export const provide = [] as const;  // apply 返回值里暴露给其他插件的键

export async function apply(ctx: PluginAPI, config?: Record<string, unknown>): Promise<void> {
	ctx.on("tool_call", async event => {
		if (event.toolName === "bash" && /rm -rf/.test(event.input.command ?? "")) {
			return { block: true, reason: "Blocked by plugin policy" };
		}
	});
	ctx.effect(() => clearInterval(timer), "my-plugin:timer");
}
```

不要写 `export default function (pi) { pi.register…() }`——那是其他 agent 的扩展格式，不属于本宿主。

## 服务面

`PluginAPI` 按命名空间暴露注册点。每个 `register` 返回 disposer；`ctx.effect` 内的清理在卸载时反向执行。

| 命名空间 | 注册什么 |
| --- | --- |
| `ctx.tools` | 模型可调用的工具（`register`）、工具视图（`registerView`） |
| `ctx.commands` | 斜杠命令、快捷键 |
| `ctx.settings` | 需要用户配置的字段 |
| `ctx.prompts` | 系统提示词区块 |
| `ctx.slots` | 界面座位与 widget |
| `ctx.rpc` | 宿主 RPC 方法与 web 路由 |
| `ctx.subagents` | 子代理提供者 |
| `ctx.memory` | 记忆后端提供者 |
| `ctx.magicKeywords` | 触发词 |
| `ctx.skins` | 滚动条皮肤 |

平铺的 `pi.register*` 是 legacy 别名，新插件不要用。

## 作用域

| `musepi.scope` | 装载时机 | 放什么 |
| --- | --- | --- |
| 缺省（`session`） | 每个会话 | 会话工具、提示词区块、界面座位 |
| `"host"` | 宿主进程启动一次（daemon 监听前、首个会话前） | 进程级注册：记忆后端 provider、全局服务 |

会话装载会跳过 `host` 作用域包，避免同一注册被每个会话重复执行。

## 包身份与配置

`apply` 的第二个参数是清单 `musepi.config` 字段表的钳制后取值；`ctx.cwd` 是装载根。取值、表单与写入共用同一条钳制链路：存储坏值回退声明默认，未声明键读不到。

需要跨插件服务时：入口声明 `provide: ["foo"]`，`apply` 返回 `{ foo: service }`；消费方 `inject: ["foo"]` 后用 `ctx.service("foo")`。