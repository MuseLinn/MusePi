# Provider

[English](providers.md) | 中文

Provider 是 `musepi` 可以路由请求的 model 后端：Anthropic、OpenAI、Google Gemini、Groq、OpenRouter、Mistral、xAI、像 Ollama 这样的本地引擎、托管网关、自定义 `models.yml` provider，以及由扩展注册的 provider。

**provider** 是账户或后端命名空间，例如 `anthropic`、`openai`、`google` 或 `ollama`。**model** 是该 provider 下的具体模型，以 `provider/model-id` 形式选择，例如 `anthropic/claude-opus-4-6`。禁用某个 provider 会把它下面的每个模型从选择中移除；如果你只想收窄个别模型，请改用 model 设置。

本页介绍 provider 如何变为可用、凭据如何解析、provider/环境变量映射、本地引擎、禁用 provider 以及自定义 provider。关于端点相关的请求、推理、tool、stream、usage 与 retry 约束，见 [Provider 端点约束](./provider-endpoint-constraints.md)。关于 model 选择与完整的 `models.yml` schema，见 [Model 与 Provider 配置](./models.md)。关于配置文件位置与合并优先级，见 [设置](./settings.md)。关于凭据存储与登录流程的深入说明，见 [Secrets 与凭据](./secrets.md)。关于完整的环境变量参考，见 [环境变量](./environment-variables.md)。关于本地引擎设置，见 [本地模型](./local-models.md)。关于 context 文件发现 provider，见 [Context 文件](./context-files.md)。

## `musepi` 如何判定某个 provider 可用

启动时，model registry 按顺序从四个来源组装它的目录：

1. 内置 model 目录（每个内置 provider 及其已知模型）。
2. 来自 `~/.musepi/agent/models.yml` 的自定义 provider 与 model 条目。
3. 支持发现（本地引擎和支持 discovery 的网关）的 provider 的运行时发现模型。
4. 由扩展注册的 provider 与 model。

registry 可以持有一个当前不可选择的 model。一个 model 变为 **可用**（available）仅当同时满足两个条件：

1. 它的 provider ID **不在**生效的 `disabledProviders` 列表中；**并且**
2. 该 provider 要么是 **keyless**（隐式本地 provider，或带 `auth: none` 的自定义 provider），**要么**拥有可解析的凭据。

`disabledProviders` 在凭据**之前**被检查。如果一个 provider ID 被禁用，任何存储的 key、OAuth session、环境变量、`.env` 条目或 `models.yml` 的 `apiKey` 都不会让它可选——无论凭据如何，该 provider 的模型都会从可用性中移除。把该 ID 从生效列表中移除即可恢复它们。

Keyless 本地引擎是特例：当没有配置 key 时，`ollama`、`llama.cpp` 和 `lm-studio` 被视为 keyless，因此只要引擎有响应，它们发现的模型就可选——无需登录。见 [内置本地引擎](#内置本地引擎)。

## 凭据与优先级

当 provider 需要 API key 时，`musepi` 按以下顺序解析（首个匹配者胜出）：

1. **Runtime 覆盖**：为当前进程提供的 key，例如 CLI `--api-key`。从不持久化。
2. **`models.yml` 配置 key**：固定在一个自定义 provider 上的 `apiKey`，以 config-sourced bearer 注册。它刻意压过存储的 OAuth，这样为自定义 `baseUrl` 或网关提供的 key 会被采用，而不是转发代理会拒绝的上游 OAuth token。
3. **存储的 OAuth 凭据**：在需要时刷新；多个账户自动排序并轮换。对于 Anthropic 和 ChatGPT (Codex)，每个 organization 或 workspace 算作一个账户：同一个 email 持有 Team 或 Enterprise seat 及 personal plan 时可以按订阅各登录一次（在浏览器同意页选择 workspace），轮换会把它当作两个账户。
4. **登录来源的存储 API key**：由一次成功的 `/login` 保存的 API-key 凭据。
5. **Provider 环境变量**：包括从 `.env` 文件加载的值（见 [env-var 表](#环境变量与-env-文件)）。
6. **其他存储的 API key**：例如 broker 迁移的 key。这是最后手段，以确保显式环境变量胜出。
7. **`models.yml` fallback resolver**：未以其他方式注册的自定义 provider 的 key。

存储的凭据位于 auth store，本地认证在 `~/.musepi/agent/agent.db`，以 broker 模式运行时在配置的 auth-broker snapshot 中。（`PI_CODING_AGENT_DIR` 会重定位 `~/.musepi/agent` 基础目录，auth store 也随之移动。）

### OAuth 与 API key，以及 provider 作用域的登录

登录是 **provider 作用域** 的：认证 `anthropic` 不会认证 `openai`，每个 provider 跟踪自己的凭据。即使有有效的存储 auth，被禁用的 provider 仍然保持禁用。

在 session 内使用交互式 slash 命令：

- `/login` — 打开 OAuth/key 选择器。`/login <provider>` 直接跳到某个 provider（例如 `/login anthropic`）；对于需要粘贴 callback 的 OAuth 流程，运行 `/login <redirect-url>` 来完成。
- `/logout` — 打开 provider 选择器以移除存储的凭据。

对于由共享 auth broker 支撑的 headless 或远程环境，CLI 暴露 `musepi auth-broker login <provider>` / `musepi auth-broker logout`（以及 `status`、`list`、`import`、`migrate`）。关于 broker 模型，见 [Secrets 与凭据](./secrets.md)。

当一个 model 没有凭据时，`musepi` 会告诉你运行 `/login` 或设置该 provider 的环境变量。

### 在 `models.yml` 中固定一个 key

自定义 provider 的 `apiKey` 被解析为 **环境变量名或字面值**：如果该值命名了一个已存在的环境变量，则使用该变量的值；否则字符串本身就是 key。给值加 `!` 前缀会把它作为 shell 命令运行并使用 trim 后的 stdout（关于完整值语法，见 [Model 与 Provider 配置](./models.md)）。

```yaml
# ~/.musepi/agent/models.yml
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY # reads this env var if set, else literal text
    models:
      - id: claude-sonnet
        name: Claude Sonnet via Gateway
        contextWindow: 200000
        maxTokens: 8192
```

如果自定义 provider 设置了 `authHeader: true`，解析出的 key 会作为 `Authorization: Bearer <key>` 头注入对该 provider 的每个请求。

## 环境变量与 `.env` 文件

每个 provider 都有一个或多个环境变量，在没有存储凭据时提供 key。下表是经过验证的 provider → 变量映射；完整目录很大，因此拆分为核心 provider 和其他 provider。OAuth 支撑的 provider 除了 API key 之外（或代替之）也可接受一个 token 变量。

### 核心 provider

| Provider ID | 环境变量 |
|---|---|
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` (Foundry 模式在 `CLAUDE_CODE_USE_FOUNDRY=true` 时优先用 `ANTHROPIC_FOUNDRY_API_KEY`) |
| `openai` | `OPENAI_API_KEY` |
| `openai-codex` | `OPENAI_CODEX_OAUTH_TOKEN` |
| `google` | `GEMINI_API_KEY` |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`，或 Application Default Credentials（`GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`） |
| `groq` | `GROQ_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `xai-oauth` | `XAI_OAUTH_TOKEN`，然后 `XAI_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` |
| `cursor` | `CURSOR_ACCESS_TOKEN` |
| `azure` | `AZURE_OPENAI_API_KEY` |
| `amazon-bedrock` | `AWS_PROFILE`，或 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`，或一个 ECS/IRSA 凭据链 |

### 其他托管 provider

| Provider ID | 环境变量 |
|---|---|
| `cerebras` | `CEREBRAS_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `siliconflow` | `SILICONFLOW_API_KEY` |
| `siliconflow-cn` | `SILICONFLOW_CN_API_KEY` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `nvidia` | `NVIDIA_API_KEY` |
| `huggingface` | `HUGGINGFACE_HUB_TOKEN`，然后 `HF_TOKEN` |
| `moonshot` | `MOONSHOT_API_KEY` |
| `nanogpt` | `NANO_GPT_API_KEY` |
| `novita` | `NOVITA_API_KEY` |
| `venice` | `VENICE_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY`（目录发现也用 `VERCEL_AI_GATEWAY_API_KEY`） |
| `cloudflare-ai-gateway` | `CLOUDFLARE_AI_GATEWAY_API_KEY` |
| `litellm` | `LITELLM_API_KEY`；代理端点可选 `LITELLM_BASE_URL` |
| `kilo` | `KILO_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `zenmux` | `ZENMUX_API_KEY` |
| `zhipu-coding-plan` | `ZHIPU_API_KEY` |
| `umans` | `UMANS_AI_CODING_PLAN_API_KEY` |
| `qianfan` | `QIANFAN_API_KEY` |
| `qwen-portal` | `QWEN_OAUTH_TOKEN`，然后 `QWEN_PORTAL_API_KEY` |
| `synthetic` | `SYNTHETIC_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `alibaba-coding-plan` | `ALIBABA_CODING_PLAN_API_KEY` |
| `aimlapi` | `AIMLAPI_API_KEY` |
| `gitlab-duo` | `GITLAB_TOKEN` |
| `opencode-zen`, `opencode-go` | `OPENCODE_API_KEY` |
| `firepass` | `FIREPASS_API_KEY` |
| `wafer-serverless` | `WAFER_SERVERLESS_API_KEY` |
| `xiaomi` | `XIAOMI_API_KEY` |
| `ollama-cloud` | `OLLAMA_CLOUD_API_KEY` |
| `ollama` | `OLLAMA_API_KEY`（可选；本地发现默认 keyless） |
| `lm-studio` | `LM_STUDIO_API_KEY`（可选；默认 keyless） |
| `llama.cpp` | `LLAMA_CPP_API_KEY`（仅在服务器要求 auth 时） |

OAuth 支撑的 provider，例如 `anthropic`、`github-copilot`、`cursor`、`ollama-cloud`、`qwen-portal`、`kimi-code`、`xai-oauth`、`wafer-serverless`、`google-gemini-cli` 和 `google-antigravity`，通常通过 `/login` 而非环境变量访问。关于未在此列出的 search-tool 与配置变量，见 [环境变量](./environment-variables.md)。

### `.env` 发现与优先级

`musepi` 会在任何 provider 查询之前把 `.env` 文件主动加载进进程环境。它读取四个文件，对每个变量而言，**首个**定义它的来源胜出。生效优先级从高到低：

1. `musepi` 继承的进程环境（已设置的变量总是胜出）。
2. `<cwd>/.env`
3. `~/.musepi/agent/.env`
4. `~/.musepi/.env`
5. `~/.env`

已存在于进程环境中的变量永远不会被 `.env` 文件覆盖。在这些文件中，`<cwd>/.env` 里设置的值胜出 `~/.musepi/agent/.env`，后者胜出 `~/.musepi/.env`，再胜出 `~/.env`。因此 shell 导出的 `OPENAI_API_KEY` 胜过每个 `.env` 文件，而项目的 `<cwd>/.env` 胜过你 home 目录的 `~/.env`。

项目本地的 `.env` 是最简单的办法，让一个 repository 使用项目专属的网关、key 或本地端点：

```dotenv
# <project>/.env
OPENROUTER_API_KEY=sk-or-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`.env` 解析刻意保持最小化：

- 空行和以 `#` 开头的行被忽略；
- key 必须匹配 `[A-Za-z_][A-Za-z0-9_]*`（shell 标识符形状）——其他名称被丢弃；
- 值可以用单引号或双引号包裹，引号会被去除；
- 包含 NUL 字节的值被丢弃；
- 以 `OMP_` 为前缀的 key 也会镜像为对应的 `PI_` 前缀名称。

## 内置本地引擎

三个本地引擎会被自动发现，无需 `models.yml` 条目。每个都使用一个可由环境变量覆盖的 base URL：

| Provider ID | Base URL（环境变量覆盖 → 默认值） | 备注 |
|---|---|---|
| `ollama` | `OLLAMA_BASE_URL`, then `OLLAMA_HOST` (normalized), else `http://127.0.0.1:11434` | 默认 keyless。 |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`, else `http://127.0.0.1:8080` | 除非为 `llama.cpp` 存储了 key，否则 keyless。 |
| `lm-studio` | `LM_STUDIO_BASE_URL`, else `http://127.0.0.1:1234/v1` | 默认 keyless。 |

这些隐式引擎在以下情况会被**跳过**：

- 同 ID 的 provider 已在 `models.yml` 中配置（你的显式配置胜出）；或
- 该 provider ID 出现在生效的 `disabledProviders` 列表中。

关于安装与运行这些引擎，见 [本地模型](./local-models.md)。

## 禁用 model provider

使用 `disabledProviders` 设置把某个 provider 的模型从选择中移除：

```yaml
# ~/.musepi/agent/config.yml or <project>/.musepi/config.yml
disabledProviders:
  - anthropic
  - openai
  - google
  - groq
```

Provider ID 精确匹配。禁用 `google` 以隐藏 Google Gemini API provider；OAuth 支撑的 Google provider `google-gemini-cli` 和 `google-antigravity` 是单独的 ID，必须逐个禁用。禁用 `ollama`、`llama.cpp` 或 `lm-studio` 以停止该引擎的本地发现。

`disabledProviders` 统一适用于：

- 内置目录 provider；
- 自定义 `models.yml` provider；
- 运行时发现的 provider 模型；
- 扩展注册的 provider；
- 隐式本地引擎。

禁用某个 provider 不会删除它存储的凭据——把它从生效列表中移除即可重新启用。

## 项目级 provider 控制

项目设置存放在 `<project>/.musepi/config.yml`。当一个 repository 必须允许或隐藏不同于你全局默认的 provider 集合时使用：

```yaml
# <project>/.musepi/config.yml
disabledProviders:
  - openai
  - openrouter
```

设置数组会被高优先级层**整体替换**，而不是合并或追加。如果全局文件禁用了三个 provider 而项目文件禁用一个，项目只会看到项目列表：

```yaml
# ~/.musepi/agent/config.yml
disabledProviders:
  - anthropic
  - openai
  - google

# <project>/.musepi/config.yml
disabledProviders:
  - groq
```

项目内的生效结果：

```json
["groq"]
```

项目数组会为从该项目启动的 session 重新启用 `anthropic`、`openai` 和 `google`。如果你想让项目在全局集合上**追加**，请在项目文件里重复全局 ID。关于完整的优先级链（包括 `--config` overlay 与 runtime 覆盖），见 [设置](./settings.md)。

## 路径作用域的 `disabledProviders`

`disabledProviders` 可以混合纯字符串条目（处处适用）与路径作用域条目（仅当当前工作目录匹配配置路径时适用）：

```yaml
disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
  - paths:
      - ~/work/client-a
      - ~/work/client-b
    values:
      - openrouter
```

- 裸字符串条目总是适用。
- 作用域条目在当前工作目录**就是**配置路径或位于其**之下**时适用。`~` 展开为 home 目录。
- 接受的 path 键：`path`、`paths`、`pathPrefix`、`pathPrefixes`。
- 接受的 value 键：`providers`、`values`、`items`。

对于上面的示例：

- `ollama` 处处禁用。
- `anthropic` 和 `openai` 在 `~/projects/sensitive` 之下额外禁用。
- `openrouter` 在 `~/work/client-a` 和 `~/work/client-b` 之下额外禁用。

路径作用域在设置合并**之后**解析。因为高优先级层会整体替换整个数组，项目级的 `disabledProviders` 数组会丢弃任何仅存在于全局数组中的作用域条目。`enabledModels` 是唯一另一个支持相同路径作用域形式的设置。详情见 [设置](./settings.md)。

## Provider ID 与 discovery provider ID

`disabledProviders` 使用一个**共享的 ID 命名空间**来门控两个不同子系统：

- **Model provider** — 本页的后端（`anthropic`、`openai`、`ollama`、自定义 `models.yml` ID，……）。禁用一个会把它下面的模型从选择中移除。
- **Discovery provider** — context 文件、MCP 服务器、命令、skills、hooks、tools、prompts 与设置的来源。禁用一个会停止该来源贡献能力条目。

| 条目类型 | 示例 | 效果 |
|---|---|---|
| Model provider ID | `anthropic`, `openai`, `google`, `groq`, `openrouter`, `ollama`, `my-gateway` | 将该 provider 的模型从可用性中移除。 |
| Discovery provider ID | `native`, `claude`, `codex`, `gemini`, `agents`, `github` | 停止该发现来源贡献能力条目。 |

注意相近的名称。Google Gemini **API** 模型使用 model provider ID `google`；`gemini` 是 **discovery** provider ID（读取 `GEMINI.md` 的来源），而不是 Google 的 model provider。只在你打算禁用整个配置来源时才使用 discovery ID。关于 discovery provider 一侧，见 [Context 文件](./context-files.md)。

## `models.yml` 中的自定义 provider

自定义 provider 位于 `~/.musepi/agent/models.yml` 的 `providers:` 下。在那里定义的 provider ID 参与与内置 provider 相同的选择、凭据解析和 `disabledProviders` 规则。

最小化的 OpenAI 兼容 provider：

```yaml
providers:
  my-openai-compatible:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: MY_OPENAI_COMPATIBLE_KEY # env-var-name or literal
    models:
      - id: fast-chat
        name: Fast Chat
        contextWindow: 128000
        maxTokens: 8192
```

无 key 的本地 provider（无需凭据）：

```yaml
providers:
  local-proxy:
    baseUrl: http://127.0.0.1:4000/v1
    api: openai-completions
    auth: none
    models:
      - id: local-model
        name: Local Model
        contextWindow: 32768
        maxTokens: 4096
```

支持 discovery 的 provider（模型在运行时从端点获取）：

```yaml
providers:
  team-proxy:
    baseUrl: https://models.example.com/v1
    apiKey: TEAM_PROXY_API_KEY
    authHeader: true # send Authorization: Bearer <resolved key>
    disableStrictTools: true
    discovery:
      type: proxy
```

关于完整 schema、所有允许的 `api` 值、discovery `type`、model 覆盖与等价设置，见 [Model 与 Provider 配置](./models.md)。

要禁用某个自定义 provider，精确列出其 ID：

```yaml
disabledProviders:
  - my-openai-compatible
  - team-proxy
```

## 故障排查

**某个 provider 的模型不可选择。** 确认该 provider 有凭据（`/login <provider>`、导出的环境变量或 `models.yml` 的 `apiKey`），并且它的 ID 不在生效的 `disabledProviders` 列表中。记住规则：未被禁用**且**（keyless **或**有凭据）。Keyless 本地引擎只在引擎实际运行并有响应时才出现。

**使用了错误的 key（来自 `.env` 的过期 key）。** 解析优先 runtime `--api-key`，然后是 `models.yml` 配置 key、存储的 OAuth、由 `/login` 保存的 key、环境变量或 `.env`、其他存储的 API key，最后是 `models.yml` fallback resolver。已设置的进程环境变量也胜过每个 `.env` 文件，且 `<cwd>/.env` 胜过 `~/.env`。如果意外 key 胜出，检查是否有导出的 shell 变量以及按优先级顺序的四个 `.env` 文件，并清除那个本不应生效的。

**即使我禁用了，某个 provider 仍然出现。** `disabledProviders` 数组是被替换而不是合并：项目的 `<project>/.musepi/config.yml` 数组会完全覆盖全局数组。验证你所在目录的*生效*列表（路径作用域条目只在其配置路径处或路径之下适用），并确认 ID 拼写精确。用 `musepi config get disabledProviders` 检查合并后的值（见 [设置](./settings.md)）。

**某个 discovery provider 名称对模型没有影响（或反之）。** ID 命名空间是共享的。`gemini`、`codex`、`claude`、`native` 和 `agents` 是 discovery 来源 ID；Google 的 model 后端是 `google`。确保你禁用对了 provider 种类。

**某个自定义 `models.yml` provider 加载不了。** YAML 或 schema 错误会让 registry 跳过自定义文件。用 `musepi models` 校验该文件（用 `musepi models find <substr>` 把它限定到某个 provider），确认每个 provider 都有 `baseUrl`、有效的 `api` 以及至少一个 model 条目，并确认没有隐式本地引擎在悄悄遮蔽它（显式的 `ollama`/`lm-studio`/`llama.cpp` 条目会替换该 ID 的内置发现）。见 [Model 与 Provider 配置](./models.md)。
