# 配置发现与解析

[English](config-usage.md) | 中文

本文档描述当前 coding-agent 如何解析配置：扫描哪些根目录、优先级如何工作，以及解析后的配置如何被 settings、skills、hooks、tools 和 extensions 消费。

## 范围

主要实现：

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts`（从 `config.ts` 重新导出）
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

关键集成点：

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/hooks/loader.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

## 解析流程（图示）

```text
         Generic helper order (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.musepi/agent, ~/.claude, ...       │
│ 2) <cwd>/.musepi, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (native provider scans project .musepi before user .musepi;
  other providers have their own loading rules)
                    │
                    ▼
      provider priority sort + capability dedup
                    │
                    ▼
          subsystem-specific consumption
   (settings, skills, hooks, tools, extensions)
```

## 1) 配置根目录与来源顺序

## 规范根目录

`src/config.ts` 定义了固定的来源优先级列表：

1. `.musepi`（native）
2. `.claude`
3. `.codex`
4. `.gemini`

用户级基目录：

- `~/.musepi/agent`
- `~/.claude`
- `~/.codex`
- `~/.gemini`

项目级基目录：

- `<cwd>/.musepi`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` 是 `.musepi`（`packages/utils/src/dirs.ts`）。

## Profiles

命名的 profile（`musepi --profile <name>`、`--alias` 快捷方式，或 `OMP_PROFILE` / `PI_PROFILE`）会重定位 OMP 用户基目录。当某个 profile 处于激活状态时，本文档中所有写为 `~/.musepi/agent/...` 的 OMP-native 用户级路径都会解析为 `~/.musepi/profiles/<name>/agent/...`。

这种重定位在 native provider（`builtin.ts`）和通用 `config.ts` helper 中保持一致，因此涵盖 slash commands、rules、prompts、instructions、hooks、tools、extensions、settings、skills 和 MCP，以及顶层的 `SYSTEM.md` / `RULES.md` / `AGENTS.md` 文件和 runtime state（sessions、blobs、`agent.db`）。一个 profile 只能看到它自己的 OMP 配置，不能访问默认 profile 的 `~/.musepi/agent`。

Keybindings 是唯一的例外：命名 profile 会把默认 profile 的 `~/.musepi/agent/keybindings.*` 合并到自己的 `~/.musepi/profiles/<name>/agent/keybindings.*` 下，profile 文件会按 binding 覆盖默认值（[#4867](https://github.com/can1357/oh-my-pi/issues/4867)）。Keybindings 描述的是用户面前的终端/键盘，不会随活跃 profile 改变，因此除非 profile 显式覆盖，否则用户级 remap 在所有 profile 中都能继续工作。被继承的文件对 profile 进程来说是只读的——只有当默认 profile 自身运行时，才会对其执行 legacy-format 迁移。

其他来源基目录不受 profile 作用域限制，在每个 profile 下都以相同方式加载：外部工具基目录（`~/.claude`、`~/.codex`、`~/.gemini`）属于对应工具，项目级基目录（`<cwd>/.musepi`、`<cwd>/.claude`、...）按工作目录区分。通读本文档时，可将 `~/.musepi/agent` 视为当前活跃 profile 的 agent 目录简写。

## 重要约束

`src/config.ts` 中的通用 helper **不**在来源发现顺序中包含 `.pi`。

---

## 2) 核心发现 helpers（`src/config.ts`）

## `getConfigDirs(subpath, options)`

返回有序条目：

- 先返回用户级条目（按来源优先级）
- 再返回项目级条目（按相同来源优先级）

选项：

- `user`（默认 `true`）
- `project`（默认 `true`）
- `cwd`（默认 `getProjectDir()`）
- `existingOnly`（默认 `false`）

该 API 用于基于目录的配置查找（commands、hooks、tools、agents 等）。

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

跨有序基目录搜索第一个存在的文件，返回首个匹配项（仅路径，或路径加元数据）。

## `findAllNearestProjectConfigDirs(subpath, cwd)`

向上遍历父目录，返回**每个来源基目录下最近存在的目录**（`.musepi`、`.claude`、`.codex`、`.gemini`），然后按来源优先级排序。

当项目配置应从祖先目录继承时使用（monorepo / nested workspace 行为）。

---

## 3) 文件配置包装器（`ConfigFile<T>`，位于 `src/config/config-file.ts`，从 `src/config.ts` 重新导出）

`ConfigFile<T>` 是用于单个配置文件的 schema 校验加载器。

支持的格式：

- `.yml` / `.yaml`
- `.json` / `.jsonc`

行为：

- 根据提供的 omptype schema 校验解析后的数据。
- 缓存加载结果，直到调用 `invalidate()`。
- 通过 `tryLoad()` 返回三态结果：
  - `ok`
  - `not-found`
  - `error`（带 schema/parse 上下文的 `ConfigError`）

仍支持 legacy 迁移：

- 如果目标路径是 `.yml`/`.yaml`，同名的 `.json` 会被自动迁移一次（`migrateJsonToYml`）。

---

## 4) 设置解析模型（`src/config/settings.ts`）

runtime settings 模型是分层的：

1. 全局设置：`~/.musepi/agent/config.yml`
2. 项目设置：通过 settings capability 发现（providers 提供的 `settings.json` 和 `config.yml`）
3. CLI config overlays：`musepi --config <path>` / 重复的 `--config` 文件，仅以 `config.yml` 风格 YAML 加载到当前进程
4. Runtime overrides：内存中，非持久化
5. Schema defaults：来自 `SETTINGS_SCHEMA`

有效优先级：

`defaults <- global <- project <- CLI config overlays <- overrides`

写入行为：

- `settings.set(...)` 写入**全局**层（`config.yml`）并排队后台保存。
- 项目设置从 capability discovery 角度看是只读的。

## 仍激活的迁移行为

启动时，如果缺少 `config.yml`：

1. 从 `~/.musepi/agent/settings.json` 迁移（成功时重命名为 `.bak`）
2. 与来自 `agent.db` 的 legacy DB 设置合并
3. 将合并结果写入 `config.yml`

`#migrateRawSettings` 中的字段级迁移：

- `queueMode` -> `steeringMode`
- `ask.timeout` 毫秒 -> 当旧值看起来像毫秒时转为秒（`> 1000`）
- 旧版扁平 `theme: "..."` -> `theme.dark/theme.light` 结构

---

## 5) Capability/发现集成

大多数非核心配置加载都通过 capability registry（`src/capability/index.ts` + `src/discovery/index.ts`）进行。

## Provider 排序

Providers 按数值优先级排序（高的在前）。示例优先级：

- Native OMP（`builtin.ts`）：`100`
- Claude：`80`
- Codex / agents / Claude marketplace：`70`
- Gemini：`60`

```text
Provider precedence (higher wins)

native (.musepi)          priority 100
claude                 priority  80
codex / agents / ...   priority  70
gemini                 priority  60
```

## Dedup 语义

Capabilities 定义一个 `key(item)`：

- 相同 key => 先出现的项胜出（更高优先级/更早加载的项）
- 没有 key（`undefined`）=> 不做 dedup，保留所有项

相关 key：

- skills：`name`
- tools：`name`
- hooks：`${type}:${tool}:${name}`
- extension modules：`name`
- extensions：`name`
- settings：不做 dedup（保留所有项）

---

## 6) Native `.musepi` provider 行为（`packages/coding-agent/src/discovery/builtin.ts`）

Native provider（`id: native`）从以下位置读取 native config：

- 项目：`<cwd>/.musepi/...`
- 用户：`~/.musepi/agent/...`

### 目录准入规则

- Slash commands、rules、prompts、instructions、hooks、tools、extensions、extension modules 和 settings 只在根目录存在且非空时才使用该项目/用户根目录。
- Skills 会从当前工作目录向上遍历到 repo root/home boundary，扫描每个祖先的 `<ancestor>/.musepi/skills`，再加上 `~/.musepi/agent/skills`；不需要根 `.musepi` 目录本身非空。
- `SYSTEM.md` 和 `AGENTS.md` 直接读取用户级文件，并对项目文件使用最近祖先项目 `.musepi` 查找，但项目 `.musepi` 目录必须非空。完整的 `SYSTEM.md` / `APPEND_SYSTEM.md` 契约（replace 与 append、templating）见 [`docs/system-prompt-customization.md`](./system-prompt-customization.html)。

### 按范围加载

- Skills：`<ancestor>/.musepi/skills/*/SKILL.md` 和 `~/.musepi/agent/skills/*/SKILL.md`
- Slash commands：`commands/*.md`
- Rules：`rules/*.{md,mdc}`
- Prompts：`prompts/*.md`
- Instructions：`instructions/*.md`
- Hooks：`hooks/pre/*`、`hooks/post/*`
- Tools：`tools/*.{json,md,ts,js,sh,bash,py}` 和 `tools/<name>/index.ts`
- Extension modules：在 `extensions/` 下发现（+ legacy `settings.json.extensions` 字符串数组）
- Extensions：`extensions/<name>/gemini-extension.json`
- Settings capability：`settings.json`，然后是 `config.yml`

### 最近项目查找的细节

## 对于 `SYSTEM.md` 和 `AGENTS.md`，native provider 使用最近祖先项目 `.musepi` 目录搜索（walk-up），并且仍然要求项目 `.musepi` 目录非空。

## 7) 各主要子系统如何消费配置

## Settings 子系统

- `Settings.init()` 加载全局 `config.yml` + 发现的项目 settings capability items。
- 只有 `level === "project"` 的 capability items 才会被合并到项目层。

### 会话标题 prompt 覆盖

在与 `SYSTEM.md` / `APPEND_SYSTEM.md` 相同的配置位置创建 `TITLE_SYSTEM.md`：

```text
# ~/.musepi/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- 缺少 `TITLE_SYSTEM.md` 会保留内置的标题 prompts。
- 发现使用与 `SYSTEM.md` 相同的 project-then-user 配置目录模式：先项目 `.musepi/TITLE_SYSTEM.md`，再用户 `~/.musepi/agent/TITLE_SYSTEM.md` 及其他支持的配置基目录。
- 该覆盖仅替换自动会话标题生成的 system prompt；正常的 `SYSTEM.md` / `APPEND_SYSTEM.md` prompt 定制不受影响。
- 在线路径会要求标题模型把标题包在 `<title>...</title>` 中，并宽松地从文本解析（普通句子、截断/未闭合的标签，或杂散的 `{"title": "..."}` JSON echo 都可以）。`TITLE_SYSTEM.md` 覆盖会在其之后追加 wrap-in-`<title>` 指令。本地 tiny-title 路径保留 `<title>...</title>` prefill/stop wrapper，并使用该文件作为其系统 turn。

## Skills 子系统

- `extensibility/skills.ts` 通过 `loadCapability(skillCapability.id, { cwd })` 加载。
- 应用来源开关和过滤器（`ignoredSkills`、`includeSkills`、custom dirs）。
- 仍存在 legacy 命名的开关（`skills.enablePiUser`、`skills.enablePiProject`），但它们控制的是 native provider（`provider === "native"`）。

## Hooks 子系统

- `discoverAndLoadHooks()` 从 hook capability + 显式配置路径解析 hook 路径。
- 然后通过 Bun import 加载模块。

## Tools 子系统

- `discoverAndLoadCustomTools()` 从 tool capability + plugin tool paths + 显式配置路径解析 tool 路径。
- 声明式 `.md/.json` tool 文件仅作元数据；可执行加载期望代码模块。

## Extensions 子系统

- `discoverAndLoadExtensions()` 从 extension-module capability 加显式路径解析 extension modules。
- 当前实现有意在加载前只保留 `_source.provider === "native"` 的 capability items。

---

## 8) 应依赖的优先级规则

使用这个心智模型：

1. `config.ts` 中的来源目录顺序决定候选路径顺序。
2. Capability provider 优先级决定跨 provider 的 precedence。
…

…

…

如果代码中移除这些兼容路径，请立即更新本文档；今天仍有多个 runtime 行为依赖它们。