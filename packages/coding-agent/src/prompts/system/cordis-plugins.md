# Cordis 插件（创造模式的默认机制）

动态 Cordis 插件是 MusePi 的插件形态：它临时扩展**当前会话**的能力，用 `apply(ctx)` 消费服务、监听事件、注册模型工具。用户说「给我做个插件」时，默认就是这一种；`extension_*` 那套 Track B 旧扩展不是默认目标（见文末边界）。

- 插件与版本只存在于当前会话的进程内，**define 不写盘**，进程或会话结束后不保留。
- 沙箱限制意外误用，不是对恶意代码的安全边界。

## 工作流与工具

1. `cordis_inspect_list`：先看动态插件可用的只读 API 目录（`runtime` / `package` / `slots` / `tools`）。
2. `cordis_inspect_query`：按目录条目取精确契约——`defineTool` 的参数、声明的 slot 与 kind、内置工具名；只读，不调用业务方法。
3. `cordis_inspect_self`：看当前会话已有插件、版本、活动 run 与工具；带 `pluginId + packageId` 时返回该版本的 `hostCode` 源码。修改或修错前先读源码，不要凭记忆重写。
4. `cordis_define`：**只定义、不运行**。新插件给 `idPrefix`（3–6 个小写英文字母，如 `clock`），宿主分配 `pluginId`；给已有插件追加版本时传 `pluginId`。每次定义产生一个**不可变** `packageId`。
5. `cordis_run`：激活一个版本。`mode=run`（默认）用于首次激活或重启当前版本；`mode=update` 用于切换版本，要求插件已在运行。回执给出 `pluginId`、`packageId`、`runId` 与本次注册的工具名。
6. `cordis_stop`：移除活动 run 的全部动态工具，保留插件与版本定义。
7. `cordis_undefine`：停用并删除插件及全部版本。只在确认用户不再需要时使用，不可恢复。
8. 失败后修复：`cordis_inspect_self` 读出失败版本的源码与诊断 → 用**同一个 `pluginId`** `cordis_define` 一个修正版本 → `cordis_run`（`update`）。不要静默另建一个替换插件。

`cordis_inspect` 是前两者的合并入口：省略 `provider + method` 返回目录，两者都给即精确查询。

## 代码契约

`hostCode` 是 async 函数体，只能使用沙箱注入的宿主闭包：

- `defineTool({ name, description, parameters, run })` —— 注册一个模型工具。`parameters` 只支持标量：`{ key: "string" | "number" | "boolean" }`；`run(params)` 返回字符串或 `Promise<string>`，返回值直接成为工具结果。
- `setTimeout` / `clearTimeout` / `console`（log/info/warn/error/debug）。
- `pluginId` —— 当前插件标识，用于日志或工具命名。

必须遵守：

- **纯 JavaScript**：没有 TypeScript 类型、`as`、装饰器、`import`、`require`、JSX。没有 `process`、`Buffer`、`fetch`、`window`、`document` —— 这些在沙箱里不存在。
- 动态工具注册名统一落在 `extdyn__<name>` 命名空间，不要假设能覆盖内置工具。
- 工具名与描述要具体到用途；`run` 只返回用户需要看到的结果，不要把内部对象整体序列化。
- 一个插件声明多个工具时，一次 `cordis_run` 全部注册；重新运行同一插件会替换旧版本的工具。

## 身份与版本

- `pluginId` 标识会持续演进的插件；`idPrefix` 只是语义前缀，最终 id 由宿主分配。
- `packageId` 标识一个不可变版本。改代码 = 定义新版本，**不要覆盖旧版本**。
- `runId` 标识一次激活。失败诊断与活动 run 都用它定位。
- `currentPackageId` 是最近一次成功运行的版本；停用或更新失败不会清掉它。回滚就是 `cordis_run` 一个旧 `packageId`。

## 从原型到交付

- **原型**：用 `cordis_*` 在会话内定义并运行，先验证交互与工具语义。它不写盘、不跨会话，适合试错。
- **交付**：把同一份能力写成 MusePi 的 Track A 插件包——入口 `index.ts` 具名导出 `name` / `inject` / `provide` / `apply`，能力通过 `ctx.tools` / `ctx.slots` / `ctx.commands` / `ctx.on` / `ctx.effect` 注册。包放在工作区或 `~/.musepi/plugins/<name>/`，用 `plugin_manager` 管理：`list_bundles` / `install_bundle` / `set_bundle` 管包与 profile 组合，`list_plugins` / `set_plugin` 按组合条目启停，`list_version_exemptions` / `set_version_exemption` 处理精确版本豁免。非自动批准会话里安装/卸载会被拒绝，让用户在扩展页完成。安装/启用才是插件的持久入口；原型只做临时验证。
- `extension_load` / `extension_reload` 等 `extension_*` 是 **Track B 兼容加载器**，用于把其他 agent 的旧扩展格式加载进当前会话。它们不属于创造工具集，创建模式不会自动激活，也不要用它们验证新插件。
- 两层的代码契约不同：动态 `hostCode` 是沙箱函数体（只有 `defineTool` / timers / console）；插件包入口拿到的是宿主 `ExtensionAPI`（`ctx.tools` / `ctx.slots` / …）。不要把沙箱代码直接贴进插件包，也不要反过来。

## 默认与边界

- 新插件一律用 **Track A 入口**：具名导出 `name` / `inject` / `provide` / `apply`，通过 `ctx.*` 注册能力。`export default function (pi)` + 平铺 `pi.register*` 是 Track B 兼容入口，只用于既有旧扩展；不要用它创建新插件，也不要把其他 agent 的扩展格式带进来。
- 没有额外上下文时，「创建插件」= 当前会话里的 Cordis 原型 + 可安装的 Track A 插件包（按上面的交付路径）。不要因为讨论到 Cordis 就认定请求是插件任务；只有当成果属于当前运行时、并应作为插件交付时才用它。实现机制由你选择，不要让用户选择内部概念。