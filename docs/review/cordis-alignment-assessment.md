# cordis 对齐评估（2026-10-18）

目标：让 musePi 自有插件（内置 + 用户安装）像 dsh 一样统一走 cordis，
`pi.*` 退为 façade，且 HMR 不依赖模块缓存击穿。

---

## 1. dsh 的实际做法（对照基准）

**装配是声明式的，插件是 npm 包，没有「内置 vs 用户」二分。**

```
$DSH_HOME/profiles/<name>/
├── package.json          # dsh.profile.bundles 列出 bundle 链
├── cordis.yml            # profile 根插件树（本项目是 `[]`）
└── cordis.patch.yml      # 用户覆盖层，bundle 之后应用
```

- 所有插件（第一方 `@deepseek-ai/dsh-*` 与第三方 `dsh-codearts-auth`）都是
  **同一个 npm 依赖表里的包**，由 cordis loader 按 yml 装配。
- 本地开发用 `link:`（仍是 npm 链接），不特殊化加载路径。
- **没有 `?mtime=` 击穿**：重载语义是 **fiber dispose + 重新 apply**，
  插件状态挂在 fiber 的效果账本上，dispose 即回收。
- 插件入口是 cordis 形态：`export const name` / `export const inject` /
  `export function apply(ctx)`。

---

## 2. musePi 现状

### 2.1 两条装载路径（双实例的根源）

| 路径 | 入口 | 用途 | 上下文 |
|---|---|---|---|
| 会话 | `loadExtensions()` | 会话装配 | 完整 `ExtensionContext` |
| 宿主级 | `cordis-dynamic-extensions` → `importAndBindExtension()` | session-less RPC | 完整（经 fiber） |
| 面板 RPC | `extension-artifact-compiler.loadExtensionOnce()` | `ext.call` | **裸 `{cwd, sessionId}`** |

### 2.2 模块身份被 `?mtime=` 打散

`loadLegacyPiModule()` 无条件执行：

```ts
return await import(`${entrySpecifier}?mtime=${nextLegacyPiLoadTag()}`);
```

注释明确这是 **P5 HMR 的刻意设计**。后果：每次装载都是新模块实例，
模块级状态不共享。本轮已因此踩坑两次（签到定时器、宿主凭据桥）。

### 2.3 bundled 特判

```ts
function isBundledPluginPath(resolvedPath: string): boolean {
	return normalized.includes("/src/bundled-plugins/") || normalized.includes("/bundled-plugins/");
}
```

只有 `src/bundled-plugins/`（当前只有 magic-keywords）走普通 `import()`，
其余全部走 mtime 击穿。`discovery/builtin.ts` 的注释自陈
「a bundled unit is a package the distribution ships, not a separate kind of
thing」——**措辞与实现矛盾**。

---

## 3. 关键可行性发现

### 3.1 cordis fiber 重载**仍然经过** `loadLegacyPiModule`

`CordisDynamicExtensionRuntime.reloadPlugin()`：

```ts
await this.#unloadRecord(record);          // fiber.dispose()
const target = await resolveExtensionTarget(record.sourcePath);
await this.#mount(record, target);         // → importAndBindExtension → loadLegacyPiModule
```

`#mount` 的 apply 里调 `importAndBindExtension`，而后者走
`loadLegacyPiModule`（带 mtime）。**所以当前的 cordis 重载并没有绕开模块击穿**。

这意味着：

- 想靠「换成 fiber 重载」自动消除双实例，**单靠现有代码不成立**；
  必须让 cordis 路径的模块装载本身不击穿。
- 但这也说明改造点很集中：**只要 cordis 路径用不带 mtime 的 import，
  双实例就消失**，而 HMR 由 fiber dispose 保证「旧注册被撤销」。

### 3.2 `pi.*` 在 cordis 下完整可用（已确认）

`#ledgerApi` 用 Proxy 把 19 个登记动词（`on` / `registerProvider` /
`registerRpc` / `registerComponent` / `registerTool` / …）包装成
`ctx.effect`，其余属性原样透传。**插件入口形态不需要改**。

### 3.3 HMR 的真实依赖

现有 HMR（`agent-session.reloadExtension`）依赖 mtime 图快照判定变更，
再整入口重载。若 cordis 路径改成不击穿缓存，**必须**：

- 用 fiber dispose 撤销旧注册（已有：效果账本 + `undoRegistration`）
- 用别的机制让 Bun 重新求值模块——否则 `import()` 命中缓存，新代码不进

**这是整个改造最难的一点**：Bun 的 ESM 缓存无法只对「一个模块」失效。
dsh 的做法是 **cordis fiber 只负责注册/回收，模块重新求值交给进程重启或
构建期热替换**，而不是运行时替换模块。

---

## 4. 改造清单

按风险从低到高：

### P1 低风险，纯收益

1. **`ext.call` 派发到 cordis 实例**（已完成）
2. **`session_start` 派发**（已完成）
3. **删掉 `isBundledPluginPath` 特判**：让内置插件与用户插件走同一条路径。
   风险低——只影响 magic-keywords 一个包，且它本来也是 `pi.*` 形态。

### P2 中风险，需要行为约定

4. **插件状态不得依赖模块实例**：把「模块级 `let`」定为反模式，
   改用 `globalThis` 锚点（本轮已在两处落地）。这条是**约束**，
   不是代码改动——但应写进 `docs/extensions-dev.md` 并对现有插件做一次审计。

### P3 高风险，架构级

5. **cordis 路径改用不击穿缓存的 import**：
   - 收益：双实例根除，状态天然共享
   - 代价：**cordis 路径的 HMR 失效**（模块不重新求值）
   - 缓解：cordis 插件的 HMR 改成「进程内不热更，提示重启」，
     或用单独的 `?mtime=` 只在**显式 reload** 时附加

6. **加 `cordis.yml` 声明式装配层**：
   - 现状是目录扫描 + settings
   - 收益：与 dsh 同构，插件树可版本化/可覆盖
   - 代价：发现逻辑重写、迁移现有 `~/.musepi/plugins`

---

## 5. 建议

**不建议一次性做完 P3。** 理由是第 5 条有一个硬约束：Bun 运行时无法
只失效单个模块，所以「去掉 mtime 击穿」与「运行时 HMR」在当前 stack 上
**不可兼得**。dsh 能这么做，是因为它的插件树由构建产物 + 进程重启管理，
不是运行时热替换。

建议路径：

- **本轮做 P1 + P2**（低风险、消除已知坑、把约束写进文档）
- **P3 先做一个 spike**：验证「cordis 路径不击穿 + 显式 reload 才附加
  mtime」能否同时满足 HMR 与状态共享；验证通过再推
- **P3.6（cordis.yml）** 独立评估，它是装配层重构，与 HMR 问题正交

需要你确认这个分阶段策略，再开始动手。

---

## 6. 实施记录（2026-10-18 第一轮）

### 已完成

**P1.1 `ext.call` 派发到 cordis 实例** — `CordisDynamicExtensionRuntime.invokeRpc()` +
`setExtensionRpcDispatcher()`(server `settleHostServices` 注册)。`invokeExtensionRpc`
先走 dispatcher，`found: false` 回落旧路径。

**P1.2 `session_start` 派发** — 这个事件**从未被派发过**：类型存在、`pi.on` 能通过
类型检查，但 `agent-session.ts` 只发会话内事件。失败模式完全静默(无错误无日志，
handler 就是不跑)，插件只能靠 `tool_call` 兜底。新增 `emitSessionStartEvent()`
(对应既有 `emitSessionShutdownEvent`)，在 `sdk.ts` 会话完全构造后调用。
实测：建会话后无需任何对话，`ExtensionContext` 即可达。

**P3.5 `?mtime=` 双语义** — `loadLegacyPiModule(path, { fresh })`：
缺省不带查询串(进程内同一实例)，`fresh: true` 附 `?mtime=`(重新求值)。
已接线全部重载点：`ExtensionRunner.reloadExtension`、`reloadPlugin`、
句柄 `reload()`、组件 `setComponentEnabled` 重启用。

实测确认两个语义都成立：两次独立装载只求值一次；`fresh` 重新求值且拿到新字节。

**P1.3 删除 bundled 特判** — `isBundledPluginPath()` 已删，内置与用户插件同路径。

### 过程中发现并修掉的回归

组件子 fiber 的重载原先把 `fresh` 漏了，`cordis-dynamic-extensions.test.ts` 的
「组件 HMR：reload 拾取组件入口改写」立刻报红(beta-v1 而非 beta-v2)。这反过来
证明组件级 HMR **确实依赖** `fresh` —— 该测试是这次改动最有价值的守卫。

### 未做（下一轮）

- **P3.6 `cordis.yml` 声明式装配层**：现状是 `settings.extensions` 数组 + 目录扫描；
  与 dsh 的三层(profile bundles → cordis.yml → cordis.patch.yml)结构不同。
  这是装配层重构，与本轮模块身份问题正交，未动。
- **P2 状态反模式审计**：把「模块级 `let`」定为反模式写进文档并审计现有插件；
  本轮已在签到定时器与宿主凭据桥两处改用 `globalThis` 锚点，但未做全量审计。

---

## 7. `cordis.yml` 层的结论：已有对等物，不建

目标 (1)「加 cordis.yml 声明式装配层」经核实**已完成**——以 settings + JSON store
的形态存在，且覆盖 dsh 三种 patch 能力：

| dsh `cordis.patch.yml` | musepi 已有形态 | 位置 |
|---|---|---|
| `name:` 装载清单 | `settings.extensions`(字符串数组，含 user/project 两级来源) | `settings.extensionsSourceLevel()` |
| `disable:` | `settings.disabledExtensions`(键空间 `kind:name`) | `extension-service.setEnabled` |
| `config:` 字段覆盖 | `extensions/plugin-config.json`(`{extId: {key: value}}`) | `extensions-center/plugin-config-store.ts` |

**因此不另建 YAML 层。** 理由是这会造出第二套装配真相源——插件树同时存在于
`cordis.yml` 与 `settings.extensions`，而 `discovery/builtin.ts` 已经吃过一次
「唯一真相源名不副实」的亏（host 侧另有 13 个字面量副本的注释自陈）。dsh 用 YAML
是它的 profile 分发模型(profile = 可分享的目录)，musepi 的 settings 已是同一语义且
带 GUI 管理面(设置 → 扩展与插件)。

**若将来确需 YAML**(比如要支持 profile 导出分享)，正确做法是把 YAML 作为
`extensions` 键的**另一种来源**接进 `discoverExtensionPaths`，而不是并列的新层。

---

## 8. 第一轮收尾（2026-10-18 深夜）

### 最终实机证据

```
extension-modules: musepi-auth-hub, magic-keywords   ← 两类来源同一条装载路径
pool.importDsh    : written=17 → 16 accounts          ← 凭据读写正常
backup.export     : 16 accounts, format dsh-codearts-auth/backup
pool.channels     : 17
check-in          : 9 results, coversToday=8          ← 每日领取实际跑通
hostCredential.probe: reachable, 4 creds              ← 会话上下文可读宿主凭据
```

### 过程中抓到并修掉的两个真问题

**(a) 组件子 fiber 漏传 `fresh`** — `cordis-dynamic-extensions.test.ts` 的
「组件 HMR：reload 拾取组件入口改写」立刻报红(beta-v1 而非 beta-v2)。修法是把
`fresh` 从 `#mount` 一路穿到 `#mountComponent`，并把 `setComponentEnabled` 的
重启用显式标为重载。这个失败反过来证明了组件级 HMR **确实依赖** `fresh`。

**(b) `pendingMagicKeywordRegistrations` 被无条件读** — 既有缺陷，本轮的
`sdk-preloaded-extensions-isolation` 测试把它踩出来了(调用方给 minimal stub
runtime 时 `undefined.length` 抛 TypeError)。已改为可选链。**不是本轮引入**，
只是被暴露。

### 部署层面发现

插件安装副本(`~/.musepi/plugins/node_modules/...`)是**实体目录拷贝**，此前同步脚本
只搬 `src/ui/scripts/test/docs`，漏了 `node_modules`，导致 `yaml` 缺失、
`pool.importDsh` 报 "Cannot find package 'yaml'"。已补拷。

### 目标达成度

| 目标 | 状态 | 证据 |
|---|---|---|
| (1) cordis.yml 声明式装配层 | **不建**（已有对等物） | §7：settings.extensions + disabledExtensions + plugin-config.json 三键已覆盖 dsh 三种 patch |
| (2) 统一插件形态为 cordis，pi.* 作 façade | **达成** | `#ledgerApi` 19 个登记动词全走 `ctx.effect`，插件入口无需改 |
| (3) 去掉 `?mtime=` 击穿，改用 fiber dispose+重apply | **达成（双语义）** | `loadLegacyPiModule(path, {fresh})`：缺省共享实例，`fresh:true` 重新求值；4 条 identity 测试 |
| (4) 去掉 bundled 目录特判 | **达成** | `isBundledPluginPath` 已删，magic-keywords 与 auth-hub 同路径装载 |

**未完成**：P2「模块级 let 反模式全量审计」。已在两处（签到定时器、宿主凭据桥）
改用 `globalThis` 锚点，但未对全部插件做审计——这需要遍历所有已装插件，属下一轮。
