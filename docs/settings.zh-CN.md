# 设置

[English](settings.md) | 中文

`musepi` 从内置默认值、持久化的全局配置文件、可选的项目本地配置、一次性 CLI overlay 以及内存中的 runtime 覆盖中解析设置。当某个 repository 需要不同于全局默认值的 provider 集合、model role、tool 策略、memory backend 或 UI 行为时，可以使用项目设置——而无需改动整台机器的配置。

设置以纯 YAML mapping 形式存储。每个键、其类型、默认值和枚举值都来自 settings schema，你可以用 `musepi config` 或交互式 `/settings` 面板查看或修改其中任何一项。

- 关于 model/provider 凭据、`.env` 文件以及解析 API key 的环境变量表，见 [Providers](./providers.md)。
- 关于 `models.yml` 中的自定义 model 定义，见 [Models](./models.md)。
- 关于被发现到 agent context 中的指令文件（`AGENTS.md`、`.musepi/` 等），见 [Context files](./context-files.md)。
- 关于环境变量的完整目录，见 [Environment variables](./environment-variables.md)。
- 关于激活每轮专属行为的提示词，见 [Magic keywords](./magic-keywords.md)。

## 设置存放位置

| 范围 | 路径 | 读取行为 | 写入行为 |
|---|---|---|---|
| 全局 | `~/.musepi/agent/config.yml` | 主持久化设置文件。始终加载。 | `/settings`、`musepi config set` 和 `musepi config reset` 写到这里。 |
| 全局遗留 | `~/.musepi/agent/settings.json` | 仅在 `config.yml` 尚不存在时迁移一次到 `config.yml`。 | 迁移后不再写入；原文件被重命名为 `settings.json.bak`。 |
| 项目 | `<cwd>/.musepi/config.yml`（外加 `.musepi/settings.json`） | 当进程工作目录存在非空 `.musepi/` 时加载。 | 设置命令只读；请手动编辑该文件。 |
| 项目遗留 | `<cwd>/.musepi/settings.json` | 仍会被读取；项目 `config.yml` 合并在其之上。 | 不由设置命令写入。 |
| CLI overlay | 通过 `--config <file>` 传入的任意文件 | 在全局与项目设置之后加载，仅对该进程生效。可重复传入。 | 永不持久化。 |
| Runtime 覆盖 | 仅在内存中 | 由专用 CLI flag（`--model`、`--approval-mode` 等）和 feature 环境变量设置。 | 永不持久化。 |

`PI_CODING_AGENT_DIR` 可重新定位 `~/.musepi/agent` 基础目录。设置后，全局 `config.yml`、auth 存储（`agent.db`）以及 agent 目录下的一切都会随之移动。使用 `musepi config path` 打印当前生效的 agent 目录。

原生项目设置有意限定在进程工作目录的 `.musepi/` 文件夹——设置发现**不会**向上遍历祖先目录寻找最近的 `.musepi/`。其他 discovery provider（Claude、Codex、Gemini、Cursor、OpenCode）也可以从它们自己的文件贡献项目级设置；这些对 `musepi` 设置命令而言是只读的，可以按 provider id 关闭（见 [Provider 与来源禁用](#provider-与来源禁用)）。

## 配置文件格式

全局 `config.yml` 始终是 YAML。用于其他文件（例如 `models.yml`）的通用配置加载器接受 `.yml`、`.yaml`、`.json` 和 `.jsonc`：

- 当请求的是 `.yml`/`.yaml` 路径而只存在同名的 `.json` 时，会自动迁移为 YAML（幂等，每个进程一次）。
- `.json` 和 `.jsonc` 配置按原样读取，不做迁移。
- 顶层不是 mapping 的文件（裸数组或标量）在持久化设置中被视为空，而对 `--config` overlay 则是硬错误。

## 读取与写入设置

在 session 内使用交互式 `/settings` 面板，或在 shell 中使用 `musepi config` 命令。两者都作用于合并后的生效设置，但每次持久化写入只会落到**全局**文件。

```bash
musepi config list                 # 所有设置及其当前生效值
musepi config list --json          # 同上，机器可读
musepi config get theme.dark       # 单个值
musepi config get theme.dark --json
musepi config set compaction.enabled false
musepi config set defaultThinkingLevel medium
musepi config reset steeringMode   # 将某个键恢复为 schema 默认值
musepi config path                 # 打印当前生效的 agent 目录
```

对于希望在正常启动时也看到完整首次运行动画的用户，设置 `startup.showSplash`：

```bash
musepi config set startup.showSplash true
```

这只控制启动 splash 动画。它不会重新运行 setup 或改变 setup 状态，并且 `startup.quiet: true` 仍会抑制包括 splash 在内的所有启动界面元素。

### 子命令

| 命令 | 效果 |
|---|---|
| `musepi config list` | 按 tab 分组打印所有设置及其当前值和类型。`--json` 输出一个以设置路径为键的对象，值为 `{ value, type, description }`。 |
| `musepi config get <key>` | 打印某个键的生效值。未知键以非零码退出。`--json` 输出 `{ key, value, type, description }`。 |
| `musepi config set <key> <value>` | 按键的 schema 类型解析 `<value>` 并写入全局 `config.yml`。 |
| `musepi config reset <key>` | 将键的 schema **默认值**写回全局配置（这会持久化默认值，而不是删除该键）。 |
| `musepi config path` | 打印当前生效的 agent 目录（遵循 `PI_CODING_AGENT_DIR`）。 |

不带子命令的 `musepi config` 或 `--help` 会打印帮助并列出设置。`list`、`get`、`set` 和 `reset` 都接受 `--json` flag。

### 值解析

`musepi config set` 按目标键的 schema 类型解析值字符串。字符串会先做 trim。

| 类型 | 接受的输入 | 备注 |
|---|---|---|
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | 大小写不敏感。其他输入被拒绝。 |
| number | 任意有限 JavaScript 数字 | `Infinity`/`NaN` 被拒绝。 |
| enum | 键的允许值之一 | 必须精确匹配；错误信息会列出有效值。 |
| array | JSON 数组 | 例如 `'["anthropic","openai"]'`。必须能解析且为数组。 |
| record | JSON 对象 | 例如 `'{"bash":"prompt"}'`。必须能解析且为非数组对象。 |
| string | 按给定值存储（已 trim） | 多词值以空格拼接。 |

键必须精确匹配真实的 schema path。没有简写——应设置 `theme.dark`，而不是 `theme`。

### 写入去向

`musepi config set`、`musepi config reset`、`/settings` 以及任何 runtime 设置变更都写入当前 agent 目录下的全局 `config.yml`。它们从不写入 `<cwd>/.musepi/config.yml`。要创建项目本地覆盖，请直接编辑该文件（见 [项目本地配置](#项目本地配置)）。保存做了防抖处理，并在锁保护下重新读取文件，因此 session 打开期间的外部编辑会被保留。

## 优先级

从最低到最高优先级，设置的生效值按以下顺序构建：

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides
```

从最高到最低：

1. **Runtime 覆盖** — 为当前进程在内存中应用的专用 CLI flag 和 feature 环境变量：`--model`、`--smol`、`--slow`、`--plan`、`--approval-mode`、`--auto-approve`/`--yolo`、`--hide-thinking`、`--advisor`、`--no-pty`、`--api-key` 以及 protocol-mode 默认值。永不持久化。
2. **CLI 配置 overlay** — 每个 `--config <file>`；后面的 overlay 文件覆盖前面的。
3. **项目设置** — 先 `<cwd>/.musepi/settings.json` 再 `<cwd>/.musepi/config.yml`（以及其他 discovery provider 在项目级的贡献）。
4. **全局设置** — `~/.musepi/agent/config.yml`。
5. **内置默认值** — 来自 settings schema。

在所有层都未设置的键在读取时解析为其 schema 默认值。

### 环境变量覆盖

环境变量**不是**单一的设置层。每个变量由拥有对应值的 feature 读取，通常作为每台机器的覆盖或 fallback，并且永远不会写回 `config.yml`。直接映射到某个设置的变量如下：

| 环境变量 | 覆盖的设置 | 备注 |
|---|---|---|
| `PI_SMOL_MODEL` | `modelRoles.smol` | 同时暴露为 `--smol`。 |
| `PI_SLOW_MODEL` | `modelRoles.slow` | 同时暴露为 `--slow`。 |
| `PI_PLAN_MODEL` | `modelRoles.plan` | 同时暴露为 `--plan`。 |
| `PI_NO_PTY=1` | （禁用 PTY bash） | 对该进程等价于 `--no-pty`。 |
| `PI_PY` | `eval.py` | `PI_PY=0` 禁用 Python eval backend。 |
| `PI_JS` | `eval.js` | `PI_JS=0` 禁用 JavaScript eval backend。 |
| `PI_TINY_DEVICE` | `providers.tinyModelDevice` | 本地 tiny model 的 ONNX execution provider。 |
| `PI_TINY_DTYPE` | `providers.tinyModelDtype` | 本地 tiny model 的 ONNX 精度。 |
| `OMP_AUTH_BROKER_URL` | `auth.broker.url` | 环境变量值优先于配置。 |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token` | 环境变量值优先于配置。 |
| `PI_CODING_AGENT_DIR` | （重定位 agent 目录） | 移动 `config.yml`、`agent.db` 及整个 agent 基础目录。 |
| `PI_CONFIG_FILES` | CLI 配置 overlay | 平台路径列表（Unix 上是 `:`，Windows 上是 `;`）；文件在 `--config` overlay 之前按序加载。 |

Provider API key 单独解析（存储的 auth、OAuth、`models.yml`、环境和 `.env` 文件）；见 [Providers](./providers.md) 和完整的 [Environment variables](./environment-variables.md) 参考。

## 合并规则

各层通过 deep merge 组合：

- **对象做 deep merge** — 只存在于较低层的键被保留；较高层中的键进行覆盖。
- **标量和数组整体替换** 为更高优先级层的值。较高层的数组不会追加到较低层的数组之后。

点分设置路径使用嵌套 YAML mapping 表示：

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
```

### Bash 命令审批模式

`tools.approval` 按 tool 名称设置默认策略。对 bash，你可以用 `bash.patterns` 添加有序的命令规则；第一条匹配的规则胜出。模式支持字面文本加 `*` 通配符。

```yaml
tools:
  approvalMode: write
  approval:
    bash: allow

bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "rm -rf *"
      approval: deny
    - match: "*"
      approval: allow
```

规则的有效审批值是 `allow`、`prompt` 和 `deny`。除非有匹配规则明确 deny，关键 bash 命令仍然需要确认；诸如 `match: "*"` 这样的宽泛 allow 规则不能绕过关键命令守卫。

匹配是非对称的，以保证规则语义如其所示：`deny` 和 `prompt` 规则在 glob 匹配整条命令**或复合行的任一单段**（按 `&&`、`||`、`;`、`|`、单个 `&`、subshell 和换行拆分）时触发，因此 `match: "rm -rf *"` 仍会拒绝 `cd /tmp && rm -rf build` 和 `sleep 1 & rm -rf build`。`allow` 规则必须匹配**完整**命令，且绝不应用于复合行，因此像 `match: "git *"` 这样的窄 allow 规则无法为 `git status && rm -rf /` 作保。

### Bash interceptor 模式

`bashInterceptor` 与 `bash.patterns` 是分开的：它把 Bash 命令重定向到专用 tool，而不是定义命令能否执行。需显式启用并用替换 tool 和面向 model 的消息配置正则表达式模式：

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead."
```

命名的替换 tool 必须在当前 session 中可用，否则 interceptor 不会拦截 Bash 调用。关于权限策略与专用 tool 路由的详细对比（包括复合命令行为和排序），见 [Bash tool 文档](tools/bash.md#command-policy-and-dedicated-tool-routing)。

### 实例演示：全局 vs. 项目

```yaml
# ~/.musepi/agent/config.yml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - gemini

# <repo>/.musepi/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

在 `<repo>` 内的生效设置：

```yaml
tools:
  approvalMode: write   # 从全局保留（对象 deep merge）
  approval:
    bash: allow         # 被项目覆盖
    read: allow         # 从全局保留
disabledProviders:
  - groq                # 项目数组替换了全局数组
```

数组替换是最常见的意外：项目的 `disabledProviders` 不是在全局列表上扩展——而是成为该项目下的完整列表。`enabledModels`、`cycleOrder`、`extensions` 以及其他所有数组类型的设置同样如此。

## 项目本地配置

当一个 repository 需要自己的设置时，创建 `<repo>/.musepi/config.yml`：

```yaml
# <repo>/.musepi/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: write
  approval:
    bash: prompt

compaction:
  strategy: snapcompact
  thresholdPercent: 80

theme:
  dark: titanium
```

除非你的 repository 政策允许，否则不要把 secret 提交进项目配置。凭据优先使用环境变量、存储的 auth、auth broker 或不纳入版本控制的 `--config` overlay。

### 一次性 overlay

对不应持久化的临时层使用 `--config`：

```bash
musepi --config ./local/ci-settings.yml "check this failure"
musepi --config ./base.yml --config ./experiment.yml "try this model"
```

默认启动命令、`acp` 和 `models` 都接受 `--config`。

Wrapper 也可以将 `PI_CONFIG_FILES` 设为平台分隔的路径列表（Unix 上是 `:`，Windows 上是 `;`）。环境变量 overlay 按列出的顺序在显式 `--config` overlay 之前加载。

Overlay 路径相对于进程工作目录解析（`~` 会被展开）。每个 overlay 必须能解析为 YAML mapping；文件缺失、YAML 无效或顶层数组/标量都是硬错误——它**不会**静默回退到更低优先级的设置。

## 路径作用域数组

两个数组设置——`enabledModels` 和 `disabledProviders`——除裸字符串外还接受路径作用域条目，使单一全局配置可以在不同目录表现不同：

```yaml
enabledModels:
  - claude-sonnet-4-5            # 处处适用
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama                       # 处处适用
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

裸字符串条目处处适用。作用域条目在当前工作目录**就是**配置路径或位于其**之下**时生效。`~` 展开为你的 home 目录，相对路径在匹配前先做解析。

接受的 **path** 键（可任选组合）：`path`、`paths`、`pathPrefix`、`pathPrefixes`。

接受的 **value** 键：

- `models`（用于 `enabledModels`）或 `providers`（用于 `disabledProviders`）
- `values` 或 `items`（两者通用）

只有字符串值会被保留；畸形的作用域条目会被忽略。路径作用域在层合并**之后**解析，因此读取的是最终生效数组。

## Provider 与来源禁用

`disabledProviders` 是一个共享的 id 命名空间，在任何凭据检查之前门控两个不同的子系统：

| 条目类型 | 示例 id | 效果 |
|---|---|---|
| Model provider | `anthropic`, `openai`, `gemini`, `groq`, `ollama`, `openrouter` | 将这些后端从 model 选择中移除，即使凭据可用也一样。见 [Providers](./providers.md)。 |
| Discovery source | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | 阻止该来源贡献 context 文件、MCP server、command、skill、hook、tool、prompt 或设置。见 [Context files](./context-files.md)。 |

大多数 provider 控制场景列出的是 model provider id。禁用 `claude` discovery source 与禁用 `anthropic` model provider 不同——前者停止 Claude 格式配置的发现，后者停止 Anthropic model 后端。

由于数组是替换而非追加，设置了 `disabledProviders` 的项目必须列出完整的目标集合：

```yaml
# ~/.musepi/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.musepi/config.yml — 在此 repo 内只禁用 groq
disabledProviders:
  - groq
```

默认值是空数组（什么都不禁用）。关于这两个子系统的 provider id 和排序，见 [Providers](./providers.md) 和 [Context files](./context-files.md)。

## 设置目录

下面每个键都在 settings schema 中定义；`musepi config list` 显示完整集合及当前值。默认值和枚举值取自 schema。支持 env 或 flag 覆盖的设置已注明；这些覆盖只在进程内生效，不会持久化。

### Models

`modelRoles`、`modelTags` 和 `cycleOrder` 共同定义你可以在哪些 model 之间切换。Role 值可携带 thinking 后缀（`:minimal`、`:low`、`:medium`、`:high`、`:xhigh`、`:max`）。

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: gemini/gemini-3-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

cycleOrder:
  - smol
  - default
  - slow

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `modelRoles` | record | `{}` | Role 名 -> model id 的映射。内置 role：`default`、`smol`、`slow`、`vision`、`plan`、`designer`、`commit`、`tiny`、`task`、`advisor`。`tiny` role 会覆盖轻量后台任务（标题、memory、auto-thinking、意外停止）所用的在线 model，否则用 `@smol`。Per-role env/flag 只有 `--model`/`--smol`/`--slow`/`--plan`；advisor 用 `modelRoles.advisor` 配置。 |
| `modelTags` | record | `{}` | 自定义 role/tag 元数据；可引入额外的 role。 |
| `modelProviderOrder` | array | `[]` | model id 有歧义时的优先 provider 顺序。 |
| `cycleOrder` | array | `["smol","default","slow"]` | model 切换器轮询的 role。 |
| `enabledModels` | array | `[]` | model 允许列表；支持[路径作用域条目](#路径作用域数组)。空表示所有可用 model。 |
| `disabledProviders` | array | `[]` | 被禁用的 model/discovery provider；支持路径作用域条目。见[上文](#provider-与来源禁用)。 |
| `includeModelInPrompt` | boolean | `true` | 在 system prompt 中包含当前 model 名称。 |

`models.yml` schema 与自定义 provider 定义见 [Models](./models.md)。

### Advisor

Advisor 是第二个 model，它会审查每一轮完成的 turn 并可向主 session 注入建议。先用 `modelRoles.advisor` 分配一个 model，然后通过 `advisor.enabled`、`/advisor on` 或带 `--advisor` flag 启动来启用它。

运行时行为、`WATCHDOG.md` 发现以及有界 catch-up 语义见 [Advisor and WATCHDOG.md](./advisor-watchdog.md)。

| 键 | 类型 | 默认值 | 备注 |
| --- | --- | --- | --- |
| `advisor.enabled` | boolean | `false` | 当 `modelRoles.advisor` 解析到可用 model 时启用 advisor 运行时。 |
| `task.agentAdvisor` | record | `{}` | Per-agent subagent advisor：agent 名 → `"on"` / `"off"` / advisor model pattern。覆盖 agent frontmatter 的 `advisor`；从 `/agents` hub 配置。 |
| `advisor.syncBacklog` | enum | `off` | Advisor 有界 catch-up 延迟：`off`、`1`、`3` 或 `5`。仅在 advisor backlog 达到或超过阈值时，主 model 至多等待 30 秒。 |
| `advisor.immuneTurns` | number | `3` | 一次 `concern`/`blocker` 中断之后，在此数量的已完成主 turn 内，后续 concern/blocker 以不打断的方式作为旁注路由。 |

### Thinking

```yaml
defaultThinkingLevel: high
hideThinkingBlock: false
thinkingBudgets:
  minimal: 1024
  low: 2048
  medium: 8192
  high: 16384
  xhigh: 32768
  max: 32768
```

| 键 | 类型 | 默认值 | 取值 |
|---|---|---|---|
| `defaultThinkingLevel` | enum | `high` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`。每次运行可用 `--thinking` 覆盖。 |
| `hideThinkingBlock` | boolean | `false` | 在输出中隐藏 thinking block。`--hide-thinking` 在该次运行内设置它（仅影响显示）。 |
| `thinkingBudgets.minimal` | number | `1024` | `minimal` 档位的 token 预算。 |
| `thinkingBudgets.low` | number | `2048` | `low` 的 token 预算。 |
| `thinkingBudgets.medium` | number | `8192` | `medium` 的 token 预算。 |
| `thinkingBudgets.high` | number | `16384` | `high` 的 token 预算。 |
| `thinkingBudgets.xhigh` | number | `32768` | `xhigh` 的 token 预算。 |
| `thinkingBudgets.max` | number | `32768` | `max` 的 token 预算。 |
| `providers.autoThinkingMaxEffort` | enum | `xhigh` | `defaultThinkingLevel: auto` 可解析到的最高 effort。`xhigh` 使分类器保持在最高档之下一档，因此只有 `ultrathink` 能到达 `max`；`max` 允许分类器在暴露该档位的 model 上按最高档计费。无论哪种情况，本地端上分类器都被限制在 `xhigh`。这决定的是 `auto` 能*解析到*什么：ladder 在上限之下没有任何档位的 model 完全得不到 auto level，而同时设置了 `thinking.requiresEffort` 的 model 仍会从 transport 收到其支持的最低 effort——在 `["max"]` ladder 上那就是 `max`，因为 model 不接受其他值。 |

### Sampling

值为 `-1` 表示"使用 provider/model 默认值"——`musepi` 不会发送该参数。

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `temperature` | number | `-1` | 采样温度。 |
| `topP` | number | `-1` | Nucleus sampling。 |
| `topK` | number | `-1` | Top-K sampling。 |
| `minP` | number | `-1` | 最小概率截断。 |
| `presencePenalty` | number | `-1` | Presence penalty。 |
| `repetitionPenalty` | number | `-1` | Repetition penalty。 |
| `tier.openai` | enum | `none` | `none`, `auto`, `default`, `flex`, `scale`, `priority`。对 OpenAI / OpenAI-Codex 及 OpenAI 系 OpenRouter model 作为 `service_tier` 发送。 |
| `tier.anthropic` | enum | `none` | `none`, `priority`。`priority` 在支持的直连 Claude model 上启用 fast mode（在 Bedrock/Vertex 及经 OpenRouter 时被忽略）。 |
| `tier.google` | enum | `none` | `none`, `flex`, `priority`。Gemini API 在 body 中发送；Vertex 经 header 发送 `priority`（`flex` 在 Vertex 上是 no-op）。 |
| `tier.subagent` | enum | `inherit` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`。应用到被 spawn 的 model 所属家族；`inherit` 跟随主 agent。 |
| `tier.advisor` | enum | `none` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`。应用到 advisor model 所属家族。 |
| `personality` | enum | `default` | `default`, `friendly`, `pragmatic`, `none`。 |

### Retry 与 fallback

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    # 没有显式 chain 的任何 role 都继承 "default" chain。
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chain 覆盖 default（role 来自 `modelRoles`，
    # 包括自定义 role）。Selector 接受可选的 thinking
    # 后缀，例如 openai/gpt-5.5:low。
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    # Model-selector 键（任何包含 "/" 的键）把 chain 绑定到
    # model 本身：只要该 model 处于活跃状态就生效，无论它
    # 被分配给哪个 role，并且在 role 重分配后依然保留。
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    # `provider/*` 键覆盖一个 provider 的所有 model——现在的
    # 和未来的。`provider/*` 条目保留失败 model 的 id 并只换
    # provider：google-antigravity/x -> google/x -> google-vertex/x。
    # 目标 provider 上缺失的 id 会被跳过（近似 id 模糊解析）；
    # 精确的 model 键对特定 model 覆盖通配符。
    google-antigravity/*:
      - google/*
      - google-vertex/*
```

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `retry.enabled` | boolean | `true` | 重试瞬态 provider 错误。 |
| `retry.maxRetries` | number | `10` | 每个请求的最大重试次数。 |
| `retry.baseDelayMs` | number | `500` | 初始 backoff。 |
| `retry.maxDelayMs` | number | `300000` | Backoff 上限（5 分钟）。 |
| `retry.modelFallback` | boolean | `true` | 某 model 不可用时切换到另一个 model。 |
| `retry.fallbackChains` | record | `{}` | 将 role、model selector 或 `provider/*` 通配符映射到有序的 fallback selector。包含 `/` 的键以 model 为导向并优先于 role：`provider/model-id` 匹配那个精确 model，`provider/*` 匹配该 provider 的所有 model。`provider/*` *条目*保留失败 model 的 id 并只换 provider。`default` chain 覆盖所有没有自己 chain 的 role。未知 model/provider 或畸形的 chain 在启动时报告为 config warning。 |
| `retry.fallbackRevertPolicy` | enum | `cooldown-expiry` | `cooldown-expiry` 在抑制窗口结束后回到主 model；`never` 保持 fallback 直到手动切换。 |

当活跃 model 持续失败（429、配额墙、provider 故障）且 `retry.modelFallback` 开启时，session 按特异性选择拥有失败 model 的 chain：先是精确的 `provider/model-id` 键，再是 `provider/*` 通配符，再是当前 role 的 chain，最后是 `default`。它会跳过仍在冷却中的 model selector，并为本轮剩余部分完成切换。Subagent 在其 agent 定义列出多个 model pattern 时获得各自的 per-spawn chain——第一个可解析的 pattern 为主 model，其余成为它的 fallback；`fallbackChains` 中没有 `agent:<name>` 键。

### Tools 与审批

```yaml
tools:
  approvalMode: yolo          # default
  approval:
    bash: prompt
    edit: allow
  maxTimeout: 0
  intentTracing: true
```

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `tools.approvalMode` | enum | `yolo` | `always-ask`（自动批准只读）、`write`（自动批准读 + workspace-write）、`yolo`（自动批准所有层级）。`--approval-mode` 和 `--auto-approve`/`--yolo` 按次覆盖。 |
| `tools.approval` | record | `{}` | 按 tool 名称为键的 per-tool 策略；每个值为 `allow`、`deny` 或 `prompt`。例如 `musepi config set tools.approval '{"bash":"prompt"}'`。 |
| `tools.maxTimeout` | number | `0` | Tool 最大运行时长（秒）；`0` = 无上限。 |
| `tools.intentTracing` | boolean | `true` | 记录每次调用的 intent 字符串。 |
| `tools.outputMaxColumns` | number | `768` | 流式输出的每行字节上限；`0` 禁用。 |
| `tools.artifactSpillThreshold` | number | `50` | Tool 输出超过多少 KB 后 spill 到 artifact。 |
| `tools.artifactHeadBytes` | number | `20` | Spill 时内联保留的头部 KB 数；`0` = 仅尾部。 |
| `tools.artifactTailBytes` | number | `20` | Spill 时内联保留的尾部 KB 数。 |
| `tools.artifactTailLines` | number | `500` | Spill 时内联保留的最大尾行数。 |

各个内置 tool 由各自的键开关，例如 `bash.enabled`、`launch.enabled`、`eval.py`、`eval.js`、`glob.enabled`、`grep.enabled`、`fetch.enabled`、`browser.enabled`、`computer.enabled`、`astEdit.enabled`、`astGrep.enabled` 和 `web_search.enabled`。`inspect_image` tool 由三态 `inspect_image.mode` 控制（`auto`|`on`|`off`，默认 `auto`）：`auto` 仅在活跃 model 缺少原生图像输入时暴露它，`/vision` slash command 可按 session 覆盖该 mode。

### 原生 computer use

默认禁用的 `computer` essential tool 通过原生 OS API 捕获并控制真实主机桌面。它与 `browser` 相互独立：`computer` 可以驱动 IDE、终端、原生应用、浏览器窗口和系统对话框，而 `browser` 管理 Chromium/CDP tab 和结构化页面自动化。

```yaml
computer:
  enabled: true
  backend: auto
  display: all
  maxWidth: 1920
  maxHeight: 1200
```

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `computer.enabled` | boolean | `false` | 启用原生 computer tool。具备原生能力的 OpenAI GA model 使用 `{ "type": "computer" }` wire 形式；其余所有 function-calling model 把 `computer` 当作普通 function tool。`/computer` slash command 只为当前 session 切换此项。 |
| `computer.backend` | enum | `auto` | `auto` 或 `native`；两者都要求原生捕获/输入，绝不回退到 browser automation。 |
| `computer.display` | string | `all` | 合成所有活跃 display，或使用成功 computer 结果中报告的数字 display ID。 |
| `computer.maxWidth` | number | `1920` | 合成截图最大宽度（像素）。无法保持原始细节的 image transport——包括 GitHub Copilot Responses 和 xAI OAuth——将有效宽度限制在 `1280`；Claude 系 model 作为兼容性 fallback 也采用同样的限制。 |
| `computer.maxHeight` | number | `1200` | 合成截图最大高度（像素）。上述坐标安全 transport 将有效高度限制在 `896`；其他 model 保持配置的上限。 |

Computer 设置在 desktop controller 创建时捕获。跨越坐标安全尺寸边界的 model 切换会重建 controller 并重新快照这些设置；仅修改配置不会，所以改完设置后请开新 session。重建后的 controller 没有先前的坐标系，因此在下一次指针操作前先截一张新图。启用输入前，配置 `tools.approvalMode` 或 `tools.approval.computer` 并授予平台权限。见 [Native computer use](computer-use.md)。

### Shell、eval 与 LSP

```yaml
bash:
  enabled: true
  autoBackground:
    enabled: false
    thresholdMs: 60000

eval:
  py: true
  js: true

python:
  kernelMode: session       # session, per-call
  interpreter: ""

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
  diagnosticsOnEdit: false
  formatOnWrite: false
```

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `bash.enabled` | boolean | `true` | 启用 bash tool。 |
| `launch.enabled` | boolean | `true` | 启用 launch tool 以共享长时间运行的项目进程。 |
| `bash.autoBackground.enabled` | boolean | `false` | 自动将长时间运行的命令转入后台。 |
| `bash.autoBackground.thresholdMs` | number | `60000` | 自动转后台的阈值。 |
| `eval.py` | boolean | `true` | Python eval backend。`PI_PY=0` 对该进程禁用。 |
| `eval.js` | boolean | `true` | JavaScript eval backend。`PI_JS=0` 对该进程禁用。 |
| `python.kernelMode` | enum | `session` | `session`（持久 kernel）或 `per-call`。 |
| `python.interpreter` | string | `""` | Python 解释器路径；空 = 自动检测。 |
| `lsp.enabled` | boolean | `true` | Language-server 集成。`--no-lsp` 对本次运行禁用。 |
| `lsp.lazy` | boolean | `true` | 按需启动 server。 |
| `lsp.diagnosticsOnWrite` | boolean | `true` | 写入后运行诊断。 |
| `lsp.diagnosticsOnEdit` | boolean | `false` | 编辑后运行诊断。 |
| `lsp.formatOnWrite` | boolean | `false` | 写入时格式化文件。 |
| `lsp.diagnosticsDeduplicate` | boolean | `true` | 折叠重复诊断。 |
| `shellPath` | string | _（未设置）_ | 覆盖 bash 使用的 shell 二进制。 |

### 文件：编辑与读取

```yaml
edit:
  mode: hashline            # apply_patch, hashline, patch, replace
  fuzzyMatch: true
  fuzzyThreshold: 0.95
  blockAutoGenerated: true

read:
  defaultLimit: 300
  toolResultPreview: false
  summarize:
    enabled: true
    prose: false
```

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `edit.mode` | enum | `hashline` | `apply_patch`, `hashline`, `patch`, `replace`。 |
| `edit.fuzzyMatch` | boolean | `true` | 允许模糊锚点匹配。 |
| `edit.fuzzyThreshold` | number | `0.95` | 模糊匹配的相似度阈值。 |
| `edit.blockAutoGenerated` | boolean | `true` | 拒绝编辑生成文件/lockfile 类文件。 |
| `edit.streamingAbort` | boolean | `false` | 流式编辑失配时中止。 |
| `read.defaultLimit` | number | `300` | `read` 不带 selector 时的默认行数。 |
| `read.summarize.enabled` | boolean | `true` | 代码读取的结构化摘要。 |
| `read.summarize.prose` | boolean | `false` | 也对散文类文件做摘要。 |
| `read.toolResultPreview` | boolean | `false` | Tool 结果的内联预览。 |
| `readLineNumbers` | boolean | `false` | 显示普通行号。 |

### Context、compaction 与 memory

```yaml
contextPromotion:
  enabled: false

compaction:
  enabled: true
  strategy: snapcompact     # context-full, handoff, shake, snapcompact, off
  midTurnEnabled: true      # 在 tool-loop 的 provider 请求之间检查阈值
  thresholdPercent: -1       # -1 = 默认的 reserve 行为
  thresholdTokens: -1        # > 0 时为固定 token 上限
  remoteEnabled: true

memory:
  backend: off               # off, local, hindsight, mnemopi
```

| 键 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `contextPromotion.enabled` | boolean | `false` | Context 溢出时提升到活跃 model 显式的 `contextPromotionTarget`。 |
| `compaction.enabled` | boolean | `true` | 自动对话 compaction。 |
| `compaction.midTurnEnabled` | boolean | `true` | 在下一个 provider 请求之前，于安全的 turn 中段 tool-loop 边界检查阈值。 |
| `compaction.strategy` | enum | `snapcompact` | `context-full`, `handoff`, `shake`, `snapcompact`, `off`。 |
| `compaction.thresholdPercent` | number | `-1` | Context 百分比触发；`-1` = 基于 reserve 的默认行为。 |
| `compaction.thresholdTokens` | number | `-1` | `> 0` 时为固定 token 触发。 |
| `compaction.reserveTokens` | number | `16384` | 为下一 turn 保留的 token 数。 |
| `compaction.keepRecentTokens` | number | `20000` | 始终保留的近期 token 数。 |
| `compaction.remoteEnabled` | boolean | `true` | 允许远程 compaction 服务。 |
| `compaction.autoContinue` | boolean | `true` | Compaction 之后自动继续。 |
| `memory.backend` | enum | `off` | `off`, `local`, `hindsight`, `mnemopi`。每个 backend 都有自己的 `hindsight.*` / `mnemopi.*` / `memories.*` 调优键。 |
| `autolearn.enabled` | boolean | `false` | 实验性功能：agent 停止后，推动它将经验教训记入 memory，并在 `~/.musepi/agent/managed-skills` 下创建/增强独立的 managed skill。启用 `manage_skill` tool（以及在 memory backend 激活时的 `learn`）。 |
| `autolearn.autoContinue` | boolean | `false` | 当 `autolearn.enabled` 时，在停止时自动运行一个 capture turn（消耗额外 token）。关闭时 = 一条被动提醒搭你的下一 turn 便车。 |
| `autolearn.minToolCalls` | number | `5` | 只有在某 turn 使用了至少这个数量的 tool 之后才推动。 |

`compaction` 还有更多调优键（idle compaction、supersede/drop 启发式），可在 `musepi config list` 中查看。完整的策略参考见 [Compaction](./compaction.md)。

### 外观与终端

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode        # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default            # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto           # off, auto, always
```

| 键 | 类型 | 默认值 | 取值 |
|---|---|---|---|
| `theme.dark` | string | `titanium` | 深色终端背景使用的 theme。 |
| `theme.light` | string | `light` | 浅色终端背景使用的 theme。 |
| `symbolPreset` | enum | `unicode` | `unicode`, `nerd`, `ascii`。 |
| `colorBlindMode` | boolean | `false` | Diff 新增行用蓝色代替绿色。 |
| `showHardwareCursor` | boolean | `true` | 显示终端硬件光标。 |
| `statusLine.preset` | enum | `default` | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`。 |
| `statusLine.separator` | enum | `powerline-thin` | `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`。 |
| `statusLine.sessionAccent` | boolean | `true` | 用 session 颜色着色编辑器边框。 |
| `statusLine.transparent` | boolean | `false` | Status line 使用终端背景。 |
| `statusLine.showHookStatus` | boolean | `true` | 显示 hook 状态消息。 |
| `terminal.showImages` | boolean | `true` | 内联渲染图像（当终端支持时）。 |
| `images.autoResize` | boolean | `true` | 为 model 兼容性缩放大图。 |
| `images.blockImages` | boolean | `false` | 永不向 provider 发送图像。 |
| `tui.hyperlinks` | enum | `auto` | `off`, `auto`, `always`。 |

要自定义 status line，设置 `statusLine.preset: custom` 并配置 `statusLine.leftSegments`、`statusLine.rightSegments` 和 `statusLine.segmentOptions`。

### 交互

| 键 | 类型 | 默认值 | 取值 |
|---|---|---|---|
| `steeringMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`。排队的 steering 消息如何投递。 |
| `followUpMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`。 |
| `interruptMode` | enum | `immediate` | `immediate`, `wait`。 |
| `doubleEscapeAction` | enum | `tree` | `branch`, `tree`, `none`。 |
| `autoResume` | boolean | `false` | 在 cwd 中自动恢复最近一次 session。 |
| `ask.timeout` | number | `0` | `ask` 提示超时前的秒数；`0` = 不超时。（旧的毫秒值会迁移为秒。） |
| `ask.notify` | enum | `on` | `on`, `off`。 |

### Providers 与服务

```yaml
providers:
  webSearchOrder: [perplexity, exa, gemini]
  imageOrder: [openai, xai]
  fetch: auto
  webSearchGeminiModel: gemini-2.5-flash
  tinyModel: online
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openrouterVariant: default
  kimiApiFormat: anthropic

provider:
  appendOnlyContext: auto    # auto, on, off

exa:
  enabled: true
  enableSearch: true
  enableResearcher: false
  enableWebsets: false

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| 键 | 类型 | 默认值 | 取值 / 备注 |
|---|---|---|---|
| `providers.webSearchOrder` | array | `[]` | `web_search` 按优先级排列的 provider ID（`perplexity`, `gemini`, `anthropic`, `codex`, `zai`, `exa`, `jina`, `kagi`, `tavily`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng` 等）。重复和未知 ID 会被忽略；未列出的 provider 之后保持其内置相对顺序。空 = 内置顺序。取代已移除的 `providers.webSearch` enum（旧值迁移到此列表头部）。 |
| `providers.webSearchGeminiModel` | string | _（未设置）_ | 当 `web_search` 使用 Gemini 时用于 Google Search grounding 的 Gemini model ID；默认 `gemini-2.5-flash`，可被 `GEMINI_SEARCH_MODEL` 覆盖。 |
| `providers.imageOrder` | array | `[]` | 图像生成 provider ID 的优先顺序（`openai`, `openai-codex`, `antigravity`, `xai`, `gemini`, `openrouter`）。未列出的 provider 跟随活跃 session provider 和内置顺序。取代已移除的 `providers.image` enum（旧值迁移到此列表头部）。 |
| `providers.fetch` | enum | `auto` | `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `jina`。 |
| `providers.tinyModel` | enum | `online` | `online` 或一个本地 model（`lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`）。 |
| `providers.tinyModelDevice` | enum | `default` | 本地 tiny model 的 ONNX execution provider。可被 `PI_TINY_DEVICE` 覆盖。 |
| `providers.tinyModelDtype` | enum | `default` | 本地 tiny model 的 ONNX 精度。可被 `PI_TINY_DTYPE` 覆盖。 |
| `providers.openaiWebsockets` | enum | `auto` | `auto`, `off`, `on`。 |
| `providers.openrouterVariant` | enum | `default` | `default`, `nitro`, `floor`, `online`, `exacto`。 |
| `providers.kimiApiFormat` | enum | `anthropic` | `openai`, `anthropic`。 |
| `provider.appendOnlyContext` | enum | `auto` | `auto`, `on`, `off`。 |
| `exa.enabled` | boolean | `true` | 启用 Exa 集成。 |
| `exa.enableSearch` | boolean | `true` | Exa search。 |
| `exa.enableResearcher` | boolean | `false` | Exa researcher。 |
| `exa.enableWebsets` | boolean | `false` | Exa websets。 |
| `searxng.endpoint` | string | _（未设置）_ | SearXNG 实例 URL。 |
| `searxng.token` | string | _（未设置）_ | SearXNG token；另有 `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`。 |
| `auth.broker.url` | string | _（未设置）_ | Auth-broker URL。可被 `OMP_AUTH_BROKER_URL` 覆盖。 |
| `auth.broker.token` | string | _（未设置）_ | Auth-broker token。可被 `OMP_AUTH_BROKER_TOKEN` 覆盖。 |

Provider 凭据与自定义 model definition 单独配置——见 [Providers](./providers.md) 和 [Models](./models.md)。

### 其他分组

`musepi config list` 还暴露许多其他分组设置，包括：`task.*`（subagent 并发、isolation、model 覆盖）、`skills.*` 和 `commands.*`（discovery 开关）、`mcp.*`、`github.*`、`async.*`、`goal.*`、`loop.*`、`todo.*`、`magicKeywords.*`、`ttsr.*`（time-traveling stream rules）、`display.*`、`startup.*`、`share.*`、`collab.*`、`stt.*`/`tts.*`、`memories.*`/`hindsight.*`/`mnemopi.*`（memory backend），以及 `bashInterceptor.*`。每个都遵循上文所示的相同类型/默认值规则。

## 遗留迁移

`musepi` 会自动迁移较旧的配置形状。这些都不需要你采取行动；列出它们是为了让你知道 `config.yml` 里可能出现哪些变化。

### 启动时迁移到 `config.yml`

当 `~/.musepi/agent/config.yml` 不存在时，启动会从遗留来源构建一次，然后写出结果：

1. `~/.musepi/agent/settings.json`（迁移成功后重命名为 `settings.json.bak`）。
2. 持久化在 `agent.db` 中的设置。

`config.yml` 存在后，这些遗留来源不再被查询。通用配置加载器也会在其他配置文件只存在 `.json` 形式时执行 `.json` -> `.yml` 迁移。

### 字段级迁移

每当原始设置被加载时应用（全局、项目、overlay 和 runtime 覆盖）：

| 旧 | 新 |
|---|---|
| `inspect_image.enabled` boolean | `inspect_image.mode`（`true` → `on`，`false` → `off`） |
| `queueMode` | `steeringMode` |
| 毫秒单位的 `ask.timeout`（值 `> 1000`） | 秒（除以 1000） |
| 扁平 `theme: "<name>"` 字符串 | `theme.dark` / `theme.light`（按亮度选择槽位；内置 `light`/`dark` 被丢弃以使用默认值） |
| `task.isolation.enabled: true/false` | `task.isolation.mode: auto/none` |
| `task.simple` | 已移除 |
| 遗留 `task.isolation.mode`（`worktree`, `fuse-overlay`, `fuse-projfs`） | `rcopy`, `overlayfs`, `projfs` |
| `lastChangelogVersion` | 移到 marker file 并从 `config.yml` 中剥离 |

## 故障排查

### 项目设置没有生效

- 从包含 `.musepi/config.yml` 的目录启动 `musepi`。设置发现只检查当前工作目录的 `.musepi/`，不检查祖先目录。
- 确保 `.musepi/` 非空；空的配置目录会被忽略。
- 确认文件是合法 YAML 且顶层是一个 mapping。
- 在该目录运行 `musepi config get <key>` 查看生效值。
- 记住 `--config` overlay 和 runtime flag 会覆盖项目配置。

### 全局数组在项目中消失了

数组是替换而非追加。如果项目设置了 `disabledProviders`、`enabledModels`、`cycleOrder`、`extensions` 或任何其他数组，请在项目层写**完整**的目标值——全局数组会被完全替换。

### 修改配置后 provider 仍然可用

- 检查你禁用的是 model provider id（如 `anthropic`）还是 discovery source id（如 `claude`）——它们是不同命名空间、效果不同。
- 检查是否有项目（或 overlay）的 `disabledProviders` 数组替换了你全局的那个。
- 凭据仍可能来自环境变量、`.env`、OAuth、存储的 auth 或 `models.yml`；无论如何，禁用一个 provider 都会阻止它被选中，但要确认你编辑对了层。见 [Providers](./providers.md)。
- 如果 model 列表已经初始化过，重启 session。

### `musepi config set` 写错了文件

`musepi config set` 和 `musepi config reset` 始终写入当前 agent 目录下的全局 `config.yml`。运行 `musepi config path` 打印它。对于项目本地设置，请直接编辑 `<repo>/.musepi/config.yml`。

### `musepi config reset` 没有删除我的键

`reset` 会把 schema **默认值**写入全局配置——它持久化默认值而不是删除该键。要让全局配置不再覆盖项目值，请手动从 `~/.musepi/agent/config.yml` 删除该键。

### `--config` overlay 在启动时失败

`--config` 文件是进程本地的 YAML mapping。文件缺失、YAML 无效或顶层数组/标量都是硬错误——它不会静默回退到更低优先级的设置。修正路径或内容。

### 环境变量压过了我的配置

某些设置（model role、eval backend、tiny-model device/精度、auth broker、PTY）可以被环境变量或 CLI flag 覆盖以便于每台机器的定制，并且它们的优先级高于 `config.yml`。取消设置变量或去掉 flag，让持久化的值生效。见 [环境变量覆盖](#环境变量覆盖) 和 [Environment variables](./environment-variables.md)。

### `musepi config set <key>` 提示 "Unknown setting"

键必须精确匹配 schema path，不能简写。使用 `theme.dark`，而不是 `theme`。运行 `musepi config list` 查看所有有效键。
