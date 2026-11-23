---
name: musepi-plugin-dev
version: 1.1.0
description: 为 MusePi（TUI/CLI + 桌面 GUI）创建、修改或修复插件——默认交付 Track A 插件包（具名导出 name/inject/provide/apply、ctx.* 注册能力）；先用 cordis_* 做会话内原型，再用 plugin_manager 安装启用。也覆盖 custom tools、hooks、slash commands、skills 与 Track B 旧扩展的兼容加载。触发："创建插件/扩展/工具/命令/hook"、"给 musepi 加 X 支持"、用 cordis_define 试原型、修改插件加载机制、写 MCP 相关集成。
---

# MusePi 插件开发

插件系统在 `packages/coding-agent/src/extensibility/`。**默认交付 Track A 插件**；下表其余形态各有用途，Track B 只作兼容：

| 形态 | 是什么 | 关键文件 |
|---|---|---|
| **Custom tool** | 模型可调用的函数（execute + Zod schema） | `extensibility/custom-tools/loader.ts` |
| **Extension** | 生命周期/事件框架——可注册工具、拦截/修改事件 | `extensibility/extensions/`（loader/runner） |
| **Hook** | 外部 pre/post 命令脚本（如 tool_call 拦截） | `extensibility/hooks` |
| **Plugin (Track A)** | Cordis 插件包：具名导出 `name/inject/provide/apply`，`ctx.*` 服务面 | `extensibility/plugins`、`src/bundled-plugins/*` |
| **Plugin (Track B)** | `omp`/`pi` 遗留扩展包：`export default` factory + 平铺 `pi.register*`，只作兼容 | `extensibility/extensions` |
| **Slash command** | 斜杠命令（`/xxx`） | `extensibility/slash-commands.ts` |
| **Skill** | 静态知识包（SKILL.md） | `extensibility/skills.ts` + `discovery/builtin.ts` |

## 快速路径：Track A 插件（新代码一律用这个）

入口是**具名导出三件套**，不要 `export default`：

```ts
import type { ExtensionAPI } from "@musepi/pi-coding-agent";

export const name = "my-plugin";
export const inject = [] as const;          // 依赖的宿主服务名；不满足则拒绝装载
export const provide = [] as const;         // apply 返回值里暴露给别的插件的键

export async function apply(ctx: ExtensionAPI, config?: Record<string, unknown>): Promise<void> {
	ctx.on("tool_call", async event => {
		if (event.toolName === "bash" && /rm -rf/.test(event.input.command ?? "")) {
			return { block: true, reason: "Blocked by extension policy" };
		}
	}); // 返回值是 disposer，只注销这一个监听

	ctx.tools.register({ name: "my_tool", /* … */ } as never);
	ctx.commands.register("my-cmd", { handler: async (_args, c) => c.ui.notify("hi", "info") });
	ctx.effect(() => clearInterval(timer), "my-plugin:timer"); // 卸载时反向执行
}
```

- 服务面：`ctx.tools` / `commands` / `settings` / `prompts` / `slots` / `rpc` / `subagents` / `magicKeywords` / `memory` / `hmr`。平铺的 `pi.register*` 只是 legacy 别名，新插件不要用。
- **挂 UI 之前先查目录**：`cordis_inspect_query({ provider: "slots", method: "catalog" })` 返回每个座位的容量、作用域、注册时必须传的选项、宿主注入的 props、谁声明并挂载它、替换风险，以及当前已占着它的第一方插件。带 `{ input: { slot: "settings.section" } }` 只看一个座位。不要凭文档猜座位名或参数——目录就是契约。
- `apply` 第二参是清单 `musepi.config` 的钳制后取值；`ctx.cwd` 是装载根。
- 需要跨插件服务：入口 `provide: ["foo"]`，`apply` 返回 `{ foo: service }`；消费者 `inject: ["foo"]` 后用 `ctx.service("foo")`。
- **host 作用域**：`musepi.scope: "host"` 的包由宿主进程启动时装载一次（daemon 开监听前 / 首个会话前），会话装载跳过。放进程级注册（后端 provider、全局服务），不要放会话工具。
- 写进 `src/bundled-plugins/<name>/` 或 `apps/desktop/src/plugins/<name>/` 时，入口形状由 `test/first-party-plugin-conformance.test.ts` 与 `apps/desktop/test/plugin-conformance.test.ts` 强制校验。

**Track B 兼容路径**：老的 `export default function (pi) { pi.registerTool(...) }` 仍能加载，但只用于既有扩展；新插件不要这么写。两轨边界见 `docs/plugin-tracks.md`。

扩展在 **Bun 运行时**执行：ESM 模块（无 `require`）、可用 `await import()` 按需加载依赖。扩展代码与其他扩展共享进程——**不要**在扩展里做长阻塞/全局状态污染。

## 加载与发现（怎么让 musepi 看到你的扩展）

1. **自动发现**：`~/.musepi/agent/extensions`（用户）+ `<cwd>/.musepi/extensions`（项目）——目录含 `index.ts` 即可
2. **显式配置**：`~/.musepi/agent/config.yml` 的 `extensions:` 数组（路径/包目录）或 `-e/--extension` CLI flag
3. **禁用**：`disabledExtensions: [extension-module:<name>]`（name = 目录/文件名）；`--no-extensions` 全关
4. **验证**：`musepi /extensions` 列出已加载扩展；扩展里的 `console.error` 进 daemon/TUI 日志
5. **改动生效（HMR 热拔插）**：改扩展**入口文件**后 daemon watcher ~500ms 内广播 `extensions.changed`，GUI ~1s 刷新，活跃会话执行 `reloadExtension`（忙会话挂起、agent_end 补做）——**不用重启 daemon**；会话内工具下次调用生效，未重注册的旧工具名被移除。子模块改动也会生效：watcher 按整张源码图的 mtime 判定，命中后重载属主入口，加载标签逐级盖到相对 import（回归：`test/extensibility/legacy-pi-submodule-reload.test.ts`），不必再 touch 入口。扩展内存态不迁移。只有改了扩展的发现/加载机制本身、或 daemon 侧注册代码时才需要重启 daemon（GUI 菜单"重启 daemon"）；TUI 新会话即生效

## 插件配置（manifest config + pi.config，dsh 管理页 parity）

扩展需要用户可配项时，在扩展目录的 package.json 的 `musepi` 块（权威清单字段；`omp`/`pi` 遗留兼容可读）声明 `config` 字段表（`boolean | number | string | select | path`，数字可带 `min/max/step`，下拉必须给 `options`，每个字段可标 `restart: none|session|daemon` 生效域）与 `resources` 资源卡（`disk`/`memory`/`setupMinutes`/`models`）。扩展中心详情页自动渲染管理表单并落盘；运行时读取：

```ts
const threshold = await pi.config.get<number>("threshold"); // 钳制后的值，未写过 = 声明默认
const all = await pi.config.getAll(); // 完整值表（只含声明键）
```

取值与表单、写入共用同一条钳制链路：存储坏值回退声明默认，未声明键读不到。存储落点 `<agentDir>/extensions/plugin-config.json`，键 = `extension-module:<name>`。fail-soft：坏清单字段被逐个丢弃并给警告，不拖垮扩展登记。详见 `docs/extensions-dev.md` §13。

## 自举工具环（agent 在会话内自己管插件）

daemon 会话给 agent 挂了一组创造工具。**创造模式只激活 Cordis 环**；Track B 兼容加载器默认不激活：

- `extensions_list`——已加载插件/扩展清单（**唯一常激活**，只读、便宜）
- `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` / `cordis_inspect_list` / `cordis_inspect_query` / `cordis_inspect_self`——会话级动态 Cordis 插件（vm 沙箱，`extdyn__` 命名空间），不写盘就能试原型。`define` 只定义不运行、每次产生不可变版本；`run` 用 `mode=run|update` 激活并返回 `runId`；`inspect_list/query` 查只读 API 目录与精确契约；`inspect_self` 给全 `pluginId+packageId` 时返回源码，用于原位修复。
- `plugin_manager`——profile 插件面：`list_plugins` / `set_plugin`（组合条目）、`list_bundles` / `set_bundle`（包与 profile 组合）、`install_bundle` / `remove_bundle`、`list_version_exemptions` / `set_version_exemption`。安装/卸载与授予豁免执行或放行宿主代码，只在自动批准会话里允许；否则让用户从扩展页完成。
- `extension_load` / `extension_reload` / `extension_status` / `extension_validate` / `extension_rollback`——**Track B 兼容加载器**：把其他 agent 的旧扩展格式加载进当前会话。它们不属于创造工具集，creator 预设不会激活；只在用户明确要求处理旧扩展时，通过扩展管理面（TUI 的扩展面板 / GUI 的扩展页）显式启用。`/extensions` 只是 TUI 面的入口，不是模型侧的开启方式。

激活方式：**creator（创造）预设自动激活 Cordis 环**（settings `tools.extensionMetaTools`，会话起即顶层可用，不走 xd:// 设备）；Track B 环始终需要扩展管理面显式激活。默认不激活的原因：普通会话不为这些工具的 schema 付费。

## 创建插件：默认形态与目标

用户说「创建插件」时，默认交付 **Track A 插件包**，不是 Track B：

- **入口**：具名导出 `name` / `inject` / `provide` / `apply`，能力通过 `ctx.*` 注册（`ctx.tools` / `ctx.slots` / `ctx.commands` / `ctx.on` / `ctx.effect`）。
- **禁止**：`export default function (pi) { pi.register… }` 与其他 agent 的扩展格式。平铺 `pi.register*` 只是旧别名，新插件不要用。
- **原型**：会话内用 `cordis_*` 验证交互与工具语义（不写盘、不跨会话）。先 `cordis_inspect_list` / `cordis_inspect_query` 查 API，`cordis_inspect_self` 看已有插件与源码。
- **交付**：把能力写成包，放到工作区或 `~/.musepi/plugins/<name>/`，用 `plugin_manager`（`list_plugins` → `install_plugin` → `set_plugin`）安装启用；非自动批准会话里让用户在扩展页完成。不要用 Track B 的 `extension_load` 把新插件塞进去验证。
- **两套契约不要混写**：动态 `cordis_*` 的 `hostCode` 是沙箱函数体（只有 `defineTool`/timers/console）；插件包入口拿到的是宿主 `ExtensionAPI`。原型验证交互，交付包承载完整能力。

## 进程级能力：`ctx.hmr` 与记忆后端

- **`ctx.hmr`**（由 host 插件 `musepi-hmr` provide）：`on("hmr/change" | "hmr/reload", listener, { prepend })`、`runExclusive(tx)`、`getLinked(file)` / `getOuterStack(file)`、`reload()`、`enabled`。监听不随插件自动回收，用 `ctx.effect(off)` 挂到账本。配置（`base/root/ignored/debounce`）来自该包自己的 `musepi.config`。
- **`ctx.memory.registerBackendProvider({ id, label, description, create })`**：注册或替换一个记忆后端。新 id 会自动出现在 `memory.backend` 的枚举与设置选择器里，卸载后消失；核心四种（off/local/mnemopi/hindsight/sharpshooter）仍是内置 provider。`memory.*` RPC 是核心契约，替换实现即可，不要另立方法名。

## Cordis 插件运行时（组件 / 子 fiber / 兼容性预检）

- **组件**：插件 package.json `musepi.components` 声明组件数组（`[{ id, label?, deny? }]`）；宿主为组件建独立子 fiber，设置页可对单组件启停（deny 列表落盘）。整插件 reload 时组件一并重建。
- **宿主 fiber 检视**：cordis 组 fiber 下各插件/组件的加载状态可从扩展检视入口查询（`extension_status` / 插件管理页）。
- **兼容性预检**：加载插件前宿主先做 Bun/平台兼容性检查；声明不兼容时插件详情弹窗给归因段，用户可对整个插件**授予精确版本豁免**（写 `<agentDir>/compatibility.json`，RPC `extensions.setVersionExemption`）——比 `bunfig` 豁免窄，只放过单个版本。

## 发布到插件市场

1. **打包**：`musepi plugin pack [path] [-o dir] [--json]` 生成可分发的 `.tgz`。它要求包有 `name`、`version` 和 `musepi` / `omp` / `pi` 清单，检查声明的入口存在后调用 `bun pm pack`；不访问 registry，也不执行 publish。
2. **公开发布**：需要让别人按包名安装时，走包 registry 的发布流程（版本、依赖与 `engines` 由包管理器校验）。`plugin pack` 只打包——不要把「打包成功」报告成「已发布」。
3. **进市场**：市场是「一个仓库存一份 catalog」。仓库根放 `.omp-plugin/marketplace.json`（Claude Code 兼容用 `.claude-plugin/marketplace.json`），`plugins[]` 每项写 `name` / `description` / `version` / `source`；`source` 可以是相对路径、npm 包名或 git 地址。字段全表见 `docs/marketplace.md`。
4. **分发来源**：用户执行 `/marketplace add <owner/repo>`（或桌面端能力中心 → 市场添加来源）后即可发现与安装。未发布、只在本机的包仍可走插件页的 spec 安装（tarball / 本地目录 / git）。
5. **自检**：安装完成后看能力报告（runnable / partial / blocked）与插件详情；槽位没有挂载点的组件会显示为 partial，不会静默消失。

## 文档路由表（需要细节时读这些，别猜）

**这张表只在 MusePi 仓库 clone 内有效**：它指向的 `docs/` 目录不随发行包分发。在仓库外开发扩展时改用运行时可观测的事实——`settings.schema` 的字段、`extension_status` 检视面、`~/.musepi/agent/` 下的实际文件、`--help`——不要按这些路径去找文件，也不要声称读过读不到的文件。

| 任务 | 文档 |
|---|---|
| 扩展 API 全貌/事件名/命令上下文 | `docs/extensions.md` |
| 插件两轨与入口规范 | `docs/plugin-tracks.md` |
| 能力缝（provider/service/slot 所有权） | `docs/capability-seams.md` |
| 工具所有权（哪个组件拥有哪个内建工具） | `packages/coding-agent/src/tools/tool-ownership.ts` |
| 插件配置（manifest config / pi.config / 资源卡） | `docs/extensions-dev.md` §13 |
| 加载机制细节（发现顺序/路径解析/禁用） | `docs/extension-loading.md` |
| 自定义工具（模型直接调用） | `docs/custom-tools.md` |
| Hook（pre/post 脚本、可突变什么） | `docs/hooks.md` |
| 加 LLM provider（如新模型厂） | `docs/adding-a-provider.md` + 参照 `packages/ai/src/registry/` 现有 provider 的写法（一个 def 文件 + 一个 registry 行 + catalog 条目） |
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
