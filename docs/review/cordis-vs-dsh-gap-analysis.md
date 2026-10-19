# cordis 插件系统：dsh vs musePi 差异与可吸收项

对照基准：dsh 的 `@deepseek-ai/cordis@4.0.4`（`Plugin.Base` / `Context` /
`Service` / `Fiber`）与 musePi 的 `ExtensionAPI` + `ExtensionContext`。

---

## 1. 装载入口

| | dsh | musePi |
|---|---|---|
| 入口形态 | `export const name` / `export const inject` / `export function apply(ctx, config)` | `export default function (pi: ExtensionAPI)` |
| 配置 | `Config: StandardSchemaV1`（声明式 schema，装载前校验） | `extensions.setConfig` + manifest `config` 字段（手写钳制） |
| 依赖声明 | `inject: ['credentials', 'llm']` — 缺服务则**不装载** | 无对应物（插件自己 `try/catch` 兜） |
| 提供服务 | `provide: 'my-svc'` — 别的插件可 `inject` 它 | `registerService(name, {start, stop})`，但**不可被他人依赖** |

**可吸收：`inject` / `provide` 服务依赖图。** 这是 dsh 插件系统最独特的能力：
插件之间可以声明式地互相依赖，缺依赖时整个 fiber FAILED 而不是装上一个半残的
实例。我们的 `registerService` 目前只是"带生命周期的后台任务"，没有进依赖解析。

吸收方式：给 `registerService` 加一个 `provides` 字段，并让 `ExtensionAPI`
暴露 `getService(name)`；装载时若声明的依赖缺席就记 FAILED。工作量中等，收益是
插件生态可组合。

**可吸收：`Config` schema。** 我们已有 `plugin-config-store` + `coerceConfigFieldValue`，
但那是**运行时钳制**；dsh 是**装载前校验**——config 不合法时插件根本不启动，
用户立刻看到错误而不是跑起来才半残。可把 manifest 的 config 字段声明升级为
schema 校验。

---

## 2. 生命周期

| | dsh | musePi |
|---|---|---|
| 卸载 | `fiber.dispose()` 反向回收所有 `ctx.effect` | `undoRegistration` 逐动词撤销（已有） |
| 效果账本 | `ctx.effect(() => cleanup)` 任意副作用 | 只覆盖 19 个登记动词 |
| 状态存放 | fiber 上（`ctx.set`/`ctx.get` 作用域） | 模块级变量（本轮已证明会跨实例分裂） |
| 检视 | `fiber.state` + `getEffects()` 诊断树 | `inspect()` 有状态与错误，无效果账本 |

**可吸收：通用 `ctx.effect`。** 这是本轮改造的**真正缺口**。我们的效果账本只包住
`register*` 动词——插件若在 `apply` 里直接开了个 `setInterval` 或 `fetch` 监听，
卸载时没人回收。dsh 的 `ctx.effect(() => cleanup)` 是**任意副作用**的通用回收原语。

这正是本轮 `globalThis` 锚点的正确归宿：与其让插件自己把状态挂 `globalThis`，
不如提供 fiber 作用域的状态存取。可设计为 `ExtensionAPI.state`（`get`/`set`/
`delete`，fiber dispose 时清空）。

---

## 3. 装配层

| | dsh | musePi |
|---|---|---|
| 清单 | `cordis.yml`（profile 根，bundle 链叠加） | `musepi.assembly.toml`（`assembly/manifest.ts`） |
| 覆盖 | `cordis.patch.yml`（id-targeted config/disable/insert） | `settings.extensions` + `disabledExtensions` + `plugin-config.json` |
| 分发 | profile = 可分享目录 | settings（带 GUI 管理面） |
| surface 过滤 | bundle 级 | `ManifestExtensionItem.surfaces`（**我们有，dsh 无**） |
| fail-loud | fiber FAILED 结构化归因 | `AssemblyVerifyReport` fatal/warn 分级（**我们有，更细**） |

**结论：不搬 YAML。** 理由见 `docs/review/cordis-alignment-assessment.md` §7。
反过来，`surfaces` 过滤和 fail-loud 分级是我们的**领先项**，dsh 没有。

---

## 4. 值得吸收的清单（按收益排序）

| # | 项 | 收益 | 风险 |
|---|---|---|---|
| 1 | **通用 `ctx.effect` + fiber 作用域状态** | 消除"模块级状态跨实例分裂"这一类 bug；卸载回收任意副作用 | 中——要设计 API 面并迁移现有 `globalThis` 用法 |
| 2 | **`inject` / `provide` 依赖图** | 插件可组合；缺依赖时 FAILED 而非半残 | 中——需要装载期拓扑解析 |
| 3 | **`Config` schema 装载前校验** | 配置错误立刻可见，而非运行期半残 | 低——manifest 已有 config 字段，加一层校验 |
| 4 | ~~cordis.yml~~ | 已有对等物，不建 | — |

---

## 5. 明确不吸收的

- **YAML 装配层**：会形成第二套真相源（§7）。
- **插件入口改成 cordis 形态**：`pi.*` façade 已被 `#ledgerApi` 证明可完整承载
  19 个登记动词，改入口形态是纯churn。
- **profile 目录分发**：musepi 的 settings + GUI 管理面是更合适的形态，dsh 的
  profile 目录分享在单机 CLI 场景收益有限。
