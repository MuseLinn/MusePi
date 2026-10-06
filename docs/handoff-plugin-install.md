# 交接：插件安装面 + 拖入检测安装

交接日期 2026-10-06。安装面与其后一轮的健壮性修复均已提交（见文末提交表）。本文件记录**安装面本身**的设计与踩过的坑；P4 安装源在 §4，与本文档其余部分是两个批次。

---

## 0. 一句话状态

GUI 里原本**没有插件安装入口**（`PluginManager` 只在 CLI 可用）。安装面补齐到 DSH 对标水平并追加了拖入安装；后续一轮在其上修了七处健壮性缺陷（关闭时孤儿进程、刷新丢状态、manifest 字段读取、回滚半换树等）并补了 registry 回退链。当前 82 测试全绿、三包类型检查通过、工作区干净。

---

## 1. 改动集（20 个文件，随 `41f36a5b9` 提交）

### 新增（8）
| 文件 | 作用 |
|---|---|
| `packages/coding-agent/src/extensibility/plugins/spec-classifier.ts` | spec 四档分类：registry / git / tarball / path |
| `packages/coding-agent/src/extensibility/plugins/plugin-install-machine.ts` | 安装状态机：inspecting→installing→done\|failed\|cancelled，可取消 |
| `packages/coding-agent/src/extensibility/plugins/capability-report.ts` | 装完静态判定能否加载：runnable / partial / incompatible |
| `packages/coding-agent/src/daemon/services/plugin-install-service.ts` | daemon L2 服务，5 个 RPC |
| `packages/desktop-app/src/components/PluginInstallDialog.tsx` | GUI 安装对话框（含拖放区） |
| `…/plugins/spec-classifier.test.ts` | 12 例 |
| `…/plugins/plugin-install-machine.test.ts` | 6 例 |
| `…/plugins/capability-report.test.ts` | 5 例 |

### 修改（12）
| 文件 | 改了什么 |
|---|---|
| `…/plugins/manager.ts` | 新增 `runPackageManager()`：流式输出 + AbortSignal + 进程树终止；install 改用它；名称解析支持非 registry 分支 |
| `…/plugins/types.ts` | `InstallOptions` 加 `onOutput` / `signal`；新增 `InstallOutputChunk`、`InstallAbortedError` |
| `…/daemon/server.ts` | 注册 `PluginInstallService`；switch 加 5 个 case（1930 行附近） |
| `…/daemon/services/route-coverage.test.ts` | 登记新服务（该测试要求每个 RPC case 都被某服务认领） |
| `packages/desktop-app/electron/preload.cjs` | 暴露 `getDroppedFilePath`（用 `webUtils`，Electron 32+ 已移除 `File.path`） |
| `packages/desktop-app/src/env.d.ts` | 补 `getDroppedFilePath` 类型 |
| `…/desktop-app/src/components/UnifiedPluginsView.tsx` | 工具栏加「安装插件」按钮；加 `onPackagesRefreshed` prop |
| `…/desktop-app/src/styles/gui-settings.css` | 新增 `gui-plugin-log` / `gui-plugin-drop` / `gui-plugin-dialog-actions` |
| `packages/client-core/src/i18n/{zh-CN,en-US}/settings.ts` | 13 个新 key（两侧配对，硬约束） |
| `packages/coding-agent/CHANGELOG.musepi.md` | Unreleased 加 1 条（中英成对） |
| `docs/extensions-dev.md` | 新增 §14 插件安装面 / §15 用户自定义扩展核实 / §16 Claude Code 兼容面核实；§1 加术语澄清 |

### 新增的 5 个 RPC
```
plugins.install          { spec, force? } → { installId }     立即返回，不阻塞
plugins.install.status   → { installs: PluginInstallView[] }
plugins.install.cancel   { installId } → { status: cancelled | not-running }
plugins.install.output   { installId } → { lines }
plugins.uninstall        { name } → { name }
```
事件：`plugins.install.state`（载荷同 View）、`plugins.install.output`（逐块带 stream）。

---

## 2. 验收怎么做

```powershell
cd C:\Users\unive\projects\harness-engineering\musepi-omp

# 测试（29 个，应全绿）
bun test packages/coding-agent/src/extensibility/plugins/ `
         packages/coding-agent/src/daemon/services/route-coverage.test.ts

# 类型检查（见 §3 为什么不用 check:ts）
cd packages\coding-agent; bun run check:types; cd ../..
cd packages\desktop-app;  bun run check:types; cd ../..
cd packages\client-core;  bun run check:types; cd ../..

# 格式
bunx biome check --write packages/ docs/
```

手工验收路径：设置 → 插件页 → 工具栏「安装插件」。可试的 spec：
- `acme-plugin`（registry）
- `github:owner/repo`
- `C:\Users\<你>\some-plugin-dir`（本地目录）
- `https://example.com/pkg-1.0.0.tgz`
- 拖一个 `.tgz` 或插件文件夹进对话框
- `https://example.com/some/page` → 应报 "must point at a git repository or a tarball"（这条有测试兜底）

**必看的两个行为**：取消后插件目录还原（不留半装依赖）；装完显示能力报告（装一个 DSH 插件会显示 `incompatible` 并列出缺哪些 `@deepseek-ai/*`）。

---

## 3. 环境事实（本机，非代码问题）

以下命令**在本机必失败**，与改动无关，别浪费时间排查：

| 命令 | 失败原因 |
|---|---|
| `bun check` / `bun run check:ts` | `bun run --parallel` 在本机 "Failed to start process"（Windows 进程限制） |
| `check:ts` 里的 `check-no-module-mocking` | Bun shell 里 `git ls-files` 不可用（PowerShell 里可用） |
| `check-dead-code` | knip `EPERM` |
| `bunx tsgo -p tsconfig.json`（在根） | tsconfig 结构报错，须用包内 `check:types` |

可用替代：`biome check`、`<包>/check:types`、`bun test`、`bun scripts/check-changelog-*.ts`。

---

## 4. P4 安装源（已落地）

三个设置项进 `SETTINGS_SCHEMA`（`pluginRegistryMode` / `pluginRegistryUrl` / `pluginRegistryFallbacks`），设置页 `tools` → `Plugin Sources` 组暴露前两个。回退链分三层落地：`registry-fallback.ts`（纯函数决策）、`registry-config.ts`（设置→链）、`manager.ts` 的 `#installWithRegistryFallback`（消费）。

**三态**：`auto` 官方源优先、镜像回退 / `custom` 指定源 / `bun` 完全交给包管理器。

早期设计讨论过「完整探测」（ping 取快者），**最终不做**，理由见下。

### 与 DSH 的差异（有意为之，不是遗漏）

| | DSH | musepi |
|---|---|---|
| 首选源 | `Config.registry` **必填**，部署方在 cordis.yml 配 | 用户设置，默认官方源 |
| 回退 | `fallbackRegistries` 默认 `[NPMMIRROR_REGISTRY]` | 同 |
| 换源判据 | `attributeFailure()` 三值归因 | 同（移植） |
| 延迟探测 | **无** | 无 |
| 粘性回退（记住上次走通的源） | **无** | 无 |
| `registry` 可否省略 | 否 | 是（`bun` 模式） |

差异的根因是部署模型不同：DSH 服务企业部署，部署方知道该用哪个源；MusePi 是桌面应用，用户自己知道有没有内网源。`custom` 已覆盖 DSH 必填的场景。

**探测与粘性回退都不做的理由**：延迟不是值得测量的信号——能快速应答小请求的源不代表拉 tarball 也快。而真正会变成用户困扰的形态（超时/不通）由回退链覆盖，不需要预先测量。粘性回退要引入持久化 + TTL，DSH 这个做了多年的产品明确没要，复杂度不划算。

### 已核实的环境事实

- `bun install --registry=<val>` 存在，优先级高于 `.npmrc` / `bunfig.toml` / 环境变量。
- 本机 `~/.bunfig.toml` 与 `~/.musepi/plugins/bunfig.toml` **都不存在**，走 bun 默认源。
- `~/.npmrc` 存在且带 `authToken`。选 `bun` 模式时由 bun 自己处理前缀绑定的 token，musepi 不读也不转述该文件。
- 设置键名**不带点号**：点号键会被 Settings 当嵌套路径解析（见 `settings-schema.ts` 中 `disabledExtensionComponents` 的注释）。

### 一处需要知道的降级

`custom` 模式留空、或 URL 不是 http(s) 地址时，解析为 `bun` 而不是报错。理由：让一个设置写错直接装不上，比退回到能用的默认更糟。设置不可读时（CLI 在首次读设置前就安装）同样退回 `bun`。

---

## 5. 已被否掉的方向（别重做）

调研过程中有四个方向被查证后否掉，理由记录在此，避免下一轮重复：

**P3 Claude Code 兼容层 —— 不做。** 最初以为 DSH 的兼容面很宽，实测相反：DSH 只桥接 `hooks.json` 的 7 个 command 型钩子（`hooks-claude-code/src/config.ts:11-19`），`configPath` 必填无自动发现（挂着 `TODO(per-session-hook-config)`），**不读** `.claude-plugin/plugin.json` / marketplace / commands / agents / skills / `.mcp.json`。而 musepi 这些**全都有**：`discovery/claude-plugins.ts`（读 `~/.claude/plugins/` + `.claude-plugin/plugin.json`）、`discovery/claude.ts`（9 个能力面）、`marketplace/fetcher.ts`（`.claude-plugin/marketplace.json`）、CLAUDE.md 含 `@import` 展开、MCP 从 `.claude.json` 读、LSP 从 `.claude/lsp.*` 读。补 P3 是把强项改窄。详见 §16。

**拖入的脚本批准闸门 —— 不做。** 原计划照技能市场加 `awaiting-approval`。实测 `bun install --help`：dependency scripts are never run（除非该包进了 `trustedDependencies`，我们不传 `--trust`）。所以拖入的包执行不了自己的 `postinstall`，闸门没有可拦的东西。**注意：早先写在状态机注释里的相反陈述已改正**，别照旧版本改回去。

**用户 patch 层（DSH 的 `cordis.patch.yml`）—— 不做。** 两条能力其实都已有：`discoverExtensionPaths` 第 4 类来源 `configuredPaths` 等价于"插自定义行"（`loader.ts:1017-1043`）；"按行单独开关"就是 `extensions.setComponentEnabled`（粒度 `<plugin>/<component>`）。且我们粒度更细——`Extension` 接口为每个注册面各持一个独立贡献通道（`extensibility/extensions/types.ts` 的 `Extension`），DSH 的"行"不可再分。真实差异只有"不能用一段配置声明一个插件"，场景极少。详见 §15。

**bundle 概念 —— 不引入。** DSH 的 bundle = 包 + 一份 Loader 配置 patch。我们不需要：插件由 `pi.extensions` 运行时发现，`package.json` 的 `musepi` 块声明它提供什么，装上即用。

---

## 6. 需要注意的坑

- **`PluginManager.install` 的回滚语义**：任何退出路径（失败 / spec 非法 / 取消）都会走 `#rollbackFailedInstall` 恢复 manifest + lockfile + 被替换的包目录，**随后重跑一次包管理器把 node_modules 拉回与还原后文件一致**（有 lock 用 `--frozen-lockfile`，无 lock 用 `--no-save`）——包管理器写的是整棵树，只还原单个包目录会让别的插件的传递依赖停在半换状态。取消判定看的是 `options.signal.aborted` 而非抛出的错误——kill 进程必留非零码，否则取消会被误报成失败。
- **manifest 块的读取只有一处权威**：`readPluginBlock`（`extensibility/plugins/manifest-block.ts`），`musepi` 优先、`omp`/`pi` 兼容。新增读取点必须用它——`PluginManager` 曾只读后两个字段，导致只声明 `musepi` 的插件在 `doctor()` 里被报成"非插件"。
- **`capability-report.ts` 读磁盘 package.json**，不读 `InstalledPlugin.manifest`（后者是安装器解析出的块，可能为空）。这个坑有测试兜底。
- **能力报告的槽位集合引用 `collab-proto` 的 `EXTENSION_SLOT_DECLARATION`**，不要复制一份——复制品曾与权威一致，直到新增槽位时静默失配。
- **i18n 双语是硬约束**：en 侧 `satisfies Record<SettingsKey, string>`，zh 加 key 不加 en 会编译失败，反之亦然。
- **`route-coverage.test.ts` 必须同步登记新服务**，否则 daemon RPC 不可达（测试会红）。
- **CSS token**：`--color-text-tertiary` / `--color-accent` 不在 CSS 里定义，由 JS 主题注入，用了是安全的；但别照抄不存在的类名（`gui-btn-primary` 有，`gui-btn--primary` 没有）。
- **图标名**在 `vendor/oc-icons/sprite.ts` 的 `iconSpriteData` 键里，`"package"` 不存在（用 `download` / `plug` / `archive`）。

---

## 7. 本轮的方法教训（给你自己看）

这一轮我犯了两次同类错误，都是**没查就断言**：

1. 说"DSH 的 Claude Code 兼容只有 hooks.json"时，读的是 **rc.1 源码 checkout**，而本机跑的是 rc.2——且完全没查 musepi 自己已经有一整套 Claude Code 兼容。
2. 说"我们没有 DSH 的用户 patch 层能力"，实际那两条能力一条已有一条有等价机制。写进文档后被指出才回头查装载链。

共同点：**拿 DSH 的形状去推断 musepi 的缺口，而没先读 musepi 的装载链**。所以文档里凡是"DSH 有 X / 我们没有 Y"的句式，都要有 file:line 依据；没有依据就别写。

后续一轮又犯了同一类错误的另一个方向：设置文案写的是**打算做的**行为（探测），实现做的是**实际该做的**（不探测）。文案超前于实现与文档滞后于代码一样有害——读设置的人会期待一个不存在的测量。

---

## 8. 提交表

安装面与其后的修复，按提交顺序：

| 提交 | 内容 |
|---|---|
| `41f36a5b9` | 安装面本体：spec 安装 + 拖入 + 能力报告 |
| `07033d00b` | 关闭时中止在途 spec 安装（服务此前从不调用 `stop`） |
| `75988ffaf` | GUI 刷新后重新接管在途安装 |
| `1d1f4f6a5` | 同上，marketplace 路径（两条路径写同一个 `package.json`） |
| `1f52e8fe6` | manifest 字段读取单一权威（此前只读两个旧字段） |
| `a2e353be1` | 能力报告的槽位集合改为引用 `EXTENSION_SLOT_DECLARATION` |
| `97dbe6b17` | 回滚后重跑包管理器，修 `node_modules` 半换树 |
| `4fdf36d31` | registry 回退链决策层（三纯函数） |
| `2a461c572` | 安装源设置（三态 + 双语） |
| `265b1a70c` | 回退循环接线 |
| `c358ba627` | 安装源文案与实现对齐，删未消费的返回字段 |