# musePi 两套插件轨道：边界、命名与现状

[English](plugin-tracks.md) | [中文](plugin-tracks.zh-CN.md)

> 这份文档是插件体系的**命名与归属权威**。新增文件、改名、写注释前先查这里。
> 状态：2026-10-19 首版（cordis 对齐改造第一批后）。

---

## 1. 为什么有两套

musePi 同时服务两类插件作者，两类的诉求不同：

| | **Track A — plugin（插件）** | **Track B — extension（扩展）** |
|---|---|---|
| 写给谁 | musePi 自己的插件生态 | 为 Pi / omp / Claude Code / Codex 写好的扩展 |
| 运行时 | cordis（`@deepseek-ai/cordis`） | `ExtensionRunner` + `ExtensionAPI` façade |
| 入口形态 | `name` / `inject` / `Config` / `apply(ctx, config)` | `export default function (pi)` |
| 代码归属 | `src/extensibility/plugins/` + `src/daemon/cordis-dynamic-plugins.ts` | `src/extensibility/extensions/` |
| 与上游关系 | musePi 自有，对齐 dsh 的 cordis 插件系统 | **与 omp 源码保持同源**，改动需能上游合并 |
| 状态存放 | fiber 上（效果账本回收） | 模块级（历史如此） |
| HMR | fiber dispose + 重新 apply | `runner.reloadExtension()` 整入口重载 |

**一句话**：比 omp 多一套 cordis 插件系统，比 dsh 多一套其他 agent 扩展的前向兼容。

---

## 2. 命名规则（本次改造的重点）

混乱的根源是**文件名叫 extensions，干的是 plugins 的活**。规则：

### 2.1 目录即轨道

```
src/extensibility/
├── plugins/          ← Track A。cordis 插件系统的一切
│   ├── cordis-entry.ts        入口三件套 + inject 依赖门
│   ├── mount.ts               Track A 自己的 import + bind
│   ├── dsh-*.ts               dsh 装配面解析（bundle/patch/layers）
│   ├── loader.ts              清单发现（读 lockfile、找入口路径）
│   ├── manager.ts             安装/卸载
│   ├── marketplace/           插件市场
│   └── legacy-pi-compat.ts    模块装载机制（两条轨道共用）
└── extensions/       ← Track B。与 omp 同源，勿改语义
    ├── loader.ts              import + bind（Track B 自己的）
    ├── runner.ts              ExtensionRunner
    └── types.ts               ExtensionAPI / Extension 形状
```

### 2.2 文件名必须说实话

| 实际归属 | 命名 |
|---|---|
| Track A（cordis 插件） | `*plugin*` / `cordis-*` |
| Track B（legacy 扩展） | `*extension*` |
| 两条轨道共用的**机制** | 按机制本身命名，不带轨道前缀 |

`daemon/` 下已按此改名：

| 旧名 | 新名 | 原因 |
|---|---|---|
| `cordis-dynamic-extensions.ts` | `cordis-dynamic-plugins.ts` | 它是 cordis **插件**装载运行时 |
| `extension-runtime-tools.ts` | `plugin-runtime-tools.ts` | 它给 **插件**管理面供工具 |
| `extension-sandbox.ts` | `plugin-sandbox.ts` | node:vm 沙箱承载插件 host 半体（cordis-host-runner 落地） |
| `test/daemon/extension-runtime-load-fiber.test.ts` | `test/daemon/plugin-runtime-load-fiber.test.ts` | 测的是插件 fiber 装载 |

`daemon/` 下**仍叫** `extension-*` 的，是逐个头文件核实后确认归 Track B 或两条轨道共用：

| 文件 | 归属 | 依据 |
|---|---|---|
| `extension-service.ts` | 共用管理面 | 扩展中心统一数据源，两条轨道都列 |
| `extension-artifact-compiler.ts` | 共用 | `ext.call` 两条轨道都走（RPC 派发器在此） |
| `extension-lifecycle-tools.ts` | **Track B** | 操作会话的 `ExtensionRunner`（`extension_load`/`reload` 工具集） |
| `extension-watch-roots.ts` | 共用 | 头部注释「扩展 / 插件热重载的监视根」，两条轨道都盯 |

### 2.3 类名同步

`CordisDynamicExtensionRuntime` → `CordisDynamicPluginRuntime`；
`DynamicExtensionRecord/Handle/Inspection` → `DynamicPlugin*`；
`#getDynamicExtensions()` → `#getDynamicPlugins()`；
组 fiber 名 `musepi-dynamic-extensions` → `musepi-dynamic-plugins`。

**例外**：`DynamicExtensionLoadError` / `DynamicExtensionLoadErrorCode` 保留原名——
它们定义在 `extensions/dynamic-extension-error.ts`，是两条轨道共用的结构化错误词汇，
且 Track B 的 loader 直接 import 它。改它会让 Track B 产生无意义 diff。

---

## 3. HMR（一条变更判定，两个重载动作）

```
文件变更 → chokidar watcher（500ms 防抖 + 120ms settle）
  ├─ Track A  host-level reconcile → PluginGraphIdentities.stale()
  │             → runtime.reloadPlugin(name)
  │                 → #unloadRecord()：fiber.dispose()，效果账本反向回收全部登记
  │                 → #mount(..., fresh=true)：重新 import + apply
  └─ Track B  每个活跃会话 → agent-session
                → runner.reloadExtension(path)      ← 同样 fresh: true
```

### 变更判定的唯一实现：`PluginGraphIdentities`

两条轨道都用它决定「哪个入口要重载」，规则集中在
`extensibility/plugins/plugin-graph-identities.ts`：

- **记录的是整张源码图**（入口 + 它 import 到的每个模块），不是入口一个文件。
  改子模块必须能重载插件——`quota.ts` 改了而入口没改，仍是这个插件的改动。
- **身份 = `inode:size:mtime`**。同尺寸改写靠 inode 抓（编辑器落盘常是写临时
  文件再 rename）；`ctime` 刻意不计入——包管理器装包会建硬链接，ctime 变而内容
  不变，计进去等于每次安装都让所有插件看起来改了。
- **2000ms 时间戳容差**（FAT 只存 2 秒精度）；观测时钟取自标记文件而非
  `Date.now()`（系统钟与文件钟可能差一个 tick）。
- **依赖排除按插件根目录判定，不按路径文本**：安装态插件自己就住在
  `node_modules/` 下，"路径含 node_modules 就排除"会把每个已安装插件的全部源文件
  排除掉、记录变成空集——症状是「改了没反应」，而不是报错。

**图从哪来**：`legacy-pi-compat.ts` 的 `collectExtensionModules` 走图，
`extensionGraphFiles(entry)` 把同一次 walk 的结果交给记录方，避免二次遍历与两处
对「图是什么」的判断分叉。Track A 的 `mount.ts` 必须**静态** import 该模块：
动态 import 曾解析到第二个实例，loader 写一份、runtime 读另一份，记录永远是空。

### watcher 用 chokidar，不用 `fs.watch({ recursive: true })`

Windows 下 `fs.watch` 的 recursive 形式对**嵌套较深的文件**不投递事件：实测从
另一个进程写 `plugins/node_modules/<pkg>/src/helper.ts` 得到 **0 个事件**，同样
的写入经 chokidar 立即触发。插件包正是这个形状，用 recursive 会「监视了每个已
安装插件，却永远收不到它们任何模块的改动」。

**模块身份**：首次装载走**不带查询串**的 import，取进程内同一实例——
`ext.call`（面板）与活跃会话因此看到同一份插件状态。reload 时才附加
`?mtime=` 重新求值（Bun 无法只失效单个模块，见 `plugins/legacy-pi-compat.ts` 文档）。

**范围差异（与 dsh 的 `boot/hmr` 比）**：dsh 跟踪整个 profile 的模块依赖图并做
accepted/declined 反向传播（externals 不重载）。这里以**插件自己的图**为重载单元，
不做全局反向传播——因为重载动作是「重新求值入口」，入口重载会把整张图带上；
依赖（`node_modules/` 内的、以及宿主经 shim 解析到的模块）不计入记录，它们靠重装
或宿主升级变化，重载插件也改变不了。

---

## 4. 当前进度（2026-10-19）

### 已完成

- [x] `cordis-dynamic-extensions.ts` → `cordis-dynamic-plugins.ts`
- [x] `extension-runtime-tools.ts` → `plugin-runtime-tools.ts`
- [x] `extension-sandbox.ts` → `plugin-sandbox.ts`
- [x] Track A 自建装载管线 `plugins/mount.ts`（不再走 Track B 的 `importAndBindExtension`）
- [x] 入口三件套 `plugins/cordis-entry.ts`（`name` / `inject` / `provide` / `Config` / `apply`）
- [x] `inject` 依赖门：声明了宿主不提供的服务 → 拒绝挂载，不半残；消息点名提供者
- [x] `Config` 装载前钳制，`apply(ctx, config)` 第二参传入
- [x] `fresh` 双语义：首次共享实例，reload 重新求值
- [x] `session_start` 事件派发（此前类型存在但从未派发，失败完全静默）
- [x] 组件子 fiber 也走 Track A 管线
- [x] **`effect` / `state` 原语**：`pi.effect(cleanup)` 回收任意副作用；
      `pi.state` 是 fiber 作用域存储，随卸载清空（16 条测试）
- [x] **插件间依赖全解析**：`provide` 发布服务对象、`inject` 检查、
      `pi.service(name)` 取用、提供者卸载即摘除（17 条测试）
- [x] **`musepi-auth-hub` 迁移到 cordis 三件套**，并发布 `auth-hub.pool` /
      `auth-hub.checkin` 两个只读服务对象（5 条发布契约测试）
- [x] 修 `ProviderConfig` 缺 `label` / `resolveApiKey`：这两个字段此前只在宿主内部
      类型上，插件侧拿不到，导致渠道标签在 provider 层丢失

### 未完成（已知债，不阻塞）

- [x] `plugins/` 内 `dsh-*` 系列与 cordis 机制系列的边界文档 →
      `extensibility/plugins/README.md`（分组规则 + `dsh/` 命名说明，中英双语）
- [x] Track B 为何没有 `effect` / `state` → `extensions-dev.md` §18：
      两者都需要 fiber 才能成立，legacy 侧没有可挂的生命周期对象，
      发一个不会触发回收的 `effect` 就是静默泄漏
- [x] `daemon/` 下剩余 `extension-*` 的逐一定性，已写进各文件头部：
      `extension-lifecycle-tools.ts` 是 Track B（会话级 extension_* 工具集）；
      `extension-service.ts` / `-artifact-compiler.ts` / `-watch-roots.ts`
      是两轨共用（管理面与 RPC 入口 / 槽位编译与 load-once 缓存 / 监视根）。
      文件名里的 `extension-` 是历史命名，不代表只服务 legacy 一侧
- [ ] `provide` 的真实消费者：机制已通且有测试覆盖，但除 auth-hub 自己外还没有
      第二个插件实际 `inject` 它——属于「未被真实使用验证」而非「未实现」

---

## 5. 新增文件前的检查单

1. 这个文件服务哪条轨道？→ 目录放对
2. 文件名是否会让下一个人找错轨道？→ 名字说实话
3. 如果是共用机制 → 放 `plugins/legacy-pi-compat.ts` 这类共享位置，注释说明两轨共用

---

## 6. 本次改造的验证基线

```
cordis-dynamic-plugins.test.ts      16 pass   装载/账本/reconcile/检视
cordis-primitives.test.ts           16 pass   effect 回收 + state 作用域
cordis-service-deps.test.ts         11 pass   provide/inject 解析
cordis-service-delivery.test.ts      6 pass   服务交付（provider 卸载即摘除）
extension-module-identity.test.ts    4 pass   模块身份双语义
session-start-dispatch.test.ts       4 pass   session_start 派发契约
agent-session-extension-hmr.test.ts  3 pass   Track B HMR
plugin-runtime-load-fiber.test.ts    3 pass   宿主级 fiber 装载接线
────────────────────────────────────────────
合计                                 63 pass / 0 fail
```

插件侧（musepi-auth-hub）：**194 pass / 0 fail**，含 5 条服务发布契约——
`provide` 声明的每个名字都必须是 `apply` 返回值里的键（对不上是静默失败：
依赖检查通过、`pi.service(name)` 却拿到 `undefined`）。

实机（daemon 8407）：两个 extension-module 同路径装载、17 渠道全部带标签、
`importDsh` 17→16 账号、backup 16、check-in 9 结果、宿主凭据桥可达。
