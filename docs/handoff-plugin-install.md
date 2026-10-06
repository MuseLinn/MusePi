# 交接：插件安装面 + 拖入检测安装

交接日期 2026-10-06。分支未提交（改动集见下）。本文件是给**新会话**的第一读物——先读它，再读 `docs/extensions-dev.md` §14–§16。

---

## 0. 一句话状态

GUI 里原本**没有插件安装入口**（`PluginManager` 只在 CLI 可用）。本轮把安装面补齐到 DSH 对标水平并追加了拖入安装，**后端与 GUI 均已实现、29 测试全绿、两包类型检查通过**。剩 P4 安装源未开工（设计已讨论，见 §4）。

---

## 1. 改动集（20 个文件，未提交）

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

## 4. 待办：P4 安装源（未开工）

**已定**：丙档（完整探测）+ 全局设置。设计讨论到一半，卡在这几个待定语义：

1. **状态要几个？** 我倾向三个：未设置→自动探测 / 填了 URL→永不探测 / 显式关自动选→走 bun 默认。也可以只做两个（省掉最后一个开关）。
2. **探测时机**：装的那一下必须有（DSH 就是这样）；设置页显示"当前源 + 延迟"是锦上添花，可后置。
3. **探测失败**：倾向**不拦安装**，保持 bun 默认照常跑并照常报错（DSH 同此）。理由：ping 被墙 ≠ 实际下载不通。
4. **回退链做一跳还是 N 跳**：倾向**只一跳**（官方↔镜像）。DSH 是通用 N 链，靠 `attributeFailure()` 归因"这个失败换源有没有用"；我们只有两个源，失败几乎必然是网络，直接换即可。私有源不做回退（不该回退到公网）。
5. **手动填源要不要**：DSH 有（选择器含"手动输入 http(s) 地址"）。我们建议保留一个自由输入框——内部源/代理加速的唯一口子（不加也能用 `.npmrc`，但既然 bun 会读，两者等价）。

已核实的事实：
- `bun install --registry=<val>` 存在，优先级高于 `.npmrc` / `bunfig.toml` / 环境变量。
- 本机 `~/.bunfig.toml` 与 `~/.musepi/plugins/bunfig.toml` **都不存在**，当前走 bun 默认源。
- musepi 目前**没有任何 registry 相关的设置或 UI**（grep 无命中）。
- DSH 的模型 = 两个预设（`registry.npmjs.org` / `registry.npmmirror.com`）+ 自由输入 + N 跳回退链；它还有 `PluginRegistries` 部署配置。

实现落点建议：设置键进 `SETTINGS_SCHEMA`（全局，影响 GUI / 市场 / CLI 三条安装路径）；探测放 daemon（能发 HTTP、能读设置），不进 GUI；探测结果必须缓存，否则每次装都打两次网络。

---

## 5. 已被否掉的方向（别重做）

调研过程中有四个方向被查证后否掉，理由记录在此，避免下一轮重复：

**P3 Claude Code 兼容层 —— 不做。** 最初以为 DSH 的兼容面很宽，实测相反：DSH 只桥接 `hooks.json` 的 7 个 command 型钩子（`hooks-claude-code/src/config.ts:11-19`），`configPath` 必填无自动发现（挂着 `TODO(per-session-hook-config)`），**不读** `.claude-plugin/plugin.json` / marketplace / commands / agents / skills / `.mcp.json`。而 musepi 这些**全都有**：`discovery/claude-plugins.ts`（读 `~/.claude/plugins/` + `.claude-plugin/plugin.json`）、`discovery/claude.ts`（9 个能力面）、`marketplace/fetcher.ts`（`.claude-plugin/marketplace.json`）、CLAUDE.md 含 `@import` 展开、MCP 从 `.claude.json` 读、LSP 从 `.claude/lsp.*` 读。补 P3 是把强项改窄。详见 §16。

**拖入的脚本批准闸门 —— 不做。** 原计划照技能市场加 `awaiting-approval`。实测 `bun install --help`：dependency scripts are never run（除非该包进了 `trustedDependencies`，我们不传 `--trust`）。所以拖入的包执行不了自己的 `postinstall`，闸门没有可拦的东西。**注意：早先写在状态机注释里的相反陈述已改正**，别照旧版本改回去。

**用户 patch 层（DSH 的 `cordis.patch.yml`）—— 不做。** 两条能力其实都已有：`discoverExtensionPaths` 第 4 类来源 `configuredPaths` 等价于"插自定义行"（`loader.ts:1017-1043`）；"按行单独开关"就是 `extensions.setComponentEnabled`（粒度 `<plugin>/<component>`）。且我们粒度更细——`ExtensionItem` 有 17 条独立贡献通道（`types.ts:2085-2142`），DSH 的"行"不可再分。真实差异只有"不能用一段配置声明一个插件"，场景极少。详见 §15。

**bundle 概念 —— 不引入。** DSH 的 bundle = 包 + 一份 Loader 配置 patch。我们不需要：插件由 `pi.extensions` 运行时发现，`package.json` 的 `musepi` 块声明它提供什么，装上即用。

---

## 6. 需要注意的坑

- **`PluginManager.install` 的回滚语义**：任何退出路径（失败 / spec 非法 / 取消）都会走 `#rollbackFailedInstall` 恢复 manifest + lockfile + node_modules。取消判定看的是 `options.signal.aborted` 而非抛出的错误——kill 进程必留非零码，否则取消会被误报成失败。
- **`capability-report.ts` 读磁盘 package.json**，不读 `InstalledPlugin.manifest`（后者是 `omp`/`pi` 块，装 `musepi` 块的包会是 undefined，会把"入口文件缺失"误判成 runnable）。这个坑有测试兜底。
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