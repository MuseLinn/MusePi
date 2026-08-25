# 环境变量（当前运行时参考）

[English](environment-variables.md) | 中文

本参考源自以下当前代码路径：

- `packages/coding-agent/src/**`
- `packages/ai/src/**`（coding-agent 使用的 provider/auth 解析）
- `packages/utils/src/**` 和 `packages/tui/src/**`，其中这些变量直接影响 coding-agent 运行时

它只记录当前生效的行为。

## 解析模型与优先级

大多数运行时查找使用来自 `@musepi/pi-utils` 的 `$env`（`packages/utils/src/env.ts`）。

`$env` 加载顺序：

1. 已有的进程环境变量（`Bun.env`）
2. 项目 `.env`（`$PWD/.env`），用于尚未设置的键
3. Agent `.env`（`~/.musepi/agent/.env`，遵循 `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`），用于尚未设置的键
4. 配置根目录 `.env`（`~/.musepi/.env`，遵循 `PI_CONFIG_DIR`），用于尚未设置的键
5. Home `.env`（`~/.env`），用于尚未设置的键

每个 `.env` 文件内的额外规则：`OMP_*` 键会在该解析文件中镜像为 `PI_*` 键。

---

## 1) 模型/Provider 认证

除非另有说明，这些通过 `getEnvApiKey()`（`packages/ai/src/stream.ts`）消费。

### 核心 provider 凭据

| 变量                            | 用途                                        | 何时必需                                                       | 备注 / 优先级                                                                                       |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_TOKEN`         | Anthropic API 认证                            | 使用带 OAuth token 认证的 Anthropic                             | 在 provider 认证解析中优先于 `ANTHROPIC_API_KEY`                                                    |
| `ANTHROPIC_API_KEY`             | Anthropic API 认证                            | 使用不带 OAuth token 的 Anthropic                               | 在 `ANTHROPIC_OAUTH_TOKEN` 之后的回退                                                               |
| `ANTHROPIC_FOUNDRY_API_KEY`     | 通过 Azure Foundry / 企业网关的 Anthropic     | 启用 `CLAUDE_CODE_USE_FOUNDRY`                                  | 启用 Foundry 模式时优先于 `ANTHROPIC_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`                            |
| `OPENAI_API_KEY`                | OpenAI 认证                                     | 使用无显式 apiKey 参数的 OpenAI 系 provider                     | 由 OpenAI Completions/Responses provider 使用                                                       |
| `GEMINI_API_KEY`                | Google Gemini 认证                             | 使用 `google` provider 模型                                     | Gemini provider 映射的主键                                                                          |
| `GOOGLE_API_KEY`                | Gemini 图像工具认证回退                         | 在没有 `GEMINI_API_KEY` 时使用 `gemini_image` 工具              | 由 coding-agent 图像工具回退路径使用                                                                |
| `GROQ_API_KEY`                  | Groq 认证                                       | 使用 Groq 模型                                                  |                                                                                                      |
| `CEREBRAS_API_KEY`              | Cerebras 认证                                   | 使用 Cerebras 模型                                              |                                                                                                      |
| `FIREWORKS_API_KEY`             | Fireworks 认证                                  | 使用 Fireworks 模型                                             |                                                                                                      |
| `FIREPASS_API_KEY`              | Fire Pass 认证                                  | 使用 Fire Pass 模型                                             |                                                                                                      |
| `TOGETHER_API_KEY`              | Together 认证                                   | 使用 `together` provider                                        |                                                                                                      |
| `AIMLAPI_API_KEY`               | AIML API 认证                                   | 使用 `aimlapi` provider                                         | OpenAI 兼容的 AIML API 端点 `https://api.aimlapi.com/v1`                                             |
| `HUGGINGFACE_HUB_TOKEN`         | Hugging Face 认证                               | 使用 `huggingface` provider                                     | Hugging Face 主 token 环境变量                                                                       |
| `HF_TOKEN`                      | Hugging Face 认证                               | 使用 `huggingface` provider                                     | 当 `HUGGINGFACE_HUB_TOKEN` 未设置时的回退                                                            |
| `SYNTHETIC_API_KEY`             | Synthetic 认证                                   | 使用 Synthetic 模型                                             |                                                                                                      |
| `NVIDIA_API_KEY`                | NVIDIA 认证                                      | 使用 `nvidia` provider                                          |                                                                                                      |
| `NANO_GPT_API_KEY`              | NanoGPT 认证                                     | 使用 `nanogpt` provider                                         |                                                                                                      |
| `NOVITA_API_KEY`                | Novita 认证                                      | 使用 `novita` provider                                          |                                                                                                      |
| `VENICE_API_KEY`                | Venice 认证                                      | 使用 `venice` provider                                          |                                                                                                      |
| `LITELLM_API_KEY`               | LiteLLM 认证                                     | 使用 `litellm` provider                                         | OpenAI 兼容的 LiteLLM 代理 key                                                                       |
| `LM_STUDIO_API_KEY`             | LM Studio 认证（可选）                          | 使用带认证主机的 `lm-studio` provider                           | 本地 LM Studio 通常无需认证；当需要 key 时任意非空 token 均可                                     |
| `OLLAMA_API_KEY`                | Ollama 认证（可选）                             | 使用带认证主机的 `ollama` provider                              | 本地 Ollama 通常无需认证；当需要 key 时任意非空 token 均可                                          |
| `LLAMA_CPP_API_KEY`             | llama.cpp 认证（可选）                          | 使用带认证主机的 `llama.cpp` provider                          | 本地 llama.cpp 通常无需认证；配置了 key 时任意非空 token 均可                                       |
| `XIAOMI_API_KEY`                | Xiaomi MiMo 认证                                 | 使用 `xiaomi` provider                                          |                                                                                                      |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | Xiaomi MiMo Token Plan 认证（AMS）              | 使用 `xiaomi-token-plan-ams` provider                           |                                                                                                      |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY`  | Xiaomi MiMo Token Plan 认证（CN）               | 使用 `xiaomi-token-plan-cn` provider                            |                                                                                                      |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | Xiaomi MiMo Token Plan 认证（SGP）              | 使用 `xiaomi-token-plan-sgp` provider                           |                                                                                                      |
| `MOONSHOT_API_KEY`              | Moonshot 认证                                    | 使用 `moonshot` provider                                        |                                                                                                      |
| `XAI_API_KEY`                   | xAI 认证                                         | 使用 xAI 模型或作为 `xai-oauth` 的回退                         |                                                                                                      |
| `XAI_OAUTH_TOKEN`               | xAI OAuth/SuperGrok 认证                         | 使用 `xai-oauth` provider                                       | 对 `xai-oauth` 优先于 `XAI_API_KEY`                                                                   |
| `OPENROUTER_API_KEY`            | OpenRouter 认证                                  | 使用 OpenRouter 模型                                            | 当首选/自动 provider 是 OpenRouter 时也用于图像工具                                                 |
| `MISTRAL_API_KEY`               | Mistral 认证                                     | 使用 Mistral 模型                                               |                                                                                                      |
| `ZAI_API_KEY`                   | z.ai 认证                                        | 使用 z.ai 模型                                                  | 也用于 z.ai 网页搜索 provider                                                                        |
| `ZHIPU_API_KEY`                 | Zhipu Coding Plan 认证                           | 使用 `zhipu-coding-plan` provider                               |                                                                                                      |
| `UMANS_AI_CODING_PLAN_API_KEY` | Umans AI Coding Plan 认证                        | 使用 `umans` provider                                           |                                                                                                      |
| `MINIMAX_API_KEY`               | MiniMax 认证                                     | 使用 `minimax` provider                                         |                                                                                                      |
| `MINIMAX_CODE_API_KEY`          | MiniMax Code 认证                                | 使用 `minimax-code` provider                                    |                                                                                                      |
| `MINIMAX_CODE_CN_API_KEY`       | MiniMax Code CN 认证                             | 使用 `minimax-code-cn` provider                                 |                                                                                                      |
| `OPENCODE_API_KEY`              | OpenCode 认证                                    | 使用 `opencode-go` / `opencode-zen` 模型                        |                                                                                                      |
| `QIANFAN_API_KEY`               | Qianfan 认证                                     | 使用 `qianfan` provider                                         |                                                                                                      |
| `QWEN_OAUTH_TOKEN`              | Qwen Portal 认证                                 | 使用带 OAuth token 的 `qwen-portal`                             | 优先于 `QWEN_PORTAL_API_KEY`                                                                          |
| `QWEN_PORTAL_API_KEY`           | Qwen Portal 认证                                 | 使用带 API key 的 `qwen-portal`                                 | 在 `QWEN_OAUTH_TOKEN` 之后的回退                                                                      |
| `ZENMUX_API_KEY`                | ZenMux 认证                                      | 使用 `zenmux` provider                                          | 用于 ZenMux OpenAI 与 Anthropic 兼容路由                                                              |
| `VLLM_API_KEY`                  | vLLM 认证/发现 opt-in                            | 使用 `vllm` provider（本地 OpenAI 兼容服务器）                  | 对无需认证的本地服务器，任意非空值即可                                                              |
| `CURSOR_ACCESS_TOKEN`           | Cursor provider 认证                             | 使用 Cursor provider                                          |                                                                                                      |
| `AI_GATEWAY_API_KEY`            | Vercel AI Gateway 认证                           | 使用 `vercel-ai-gateway` provider                             |                                                                                                      |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway 认证                       | 使用 `cloudflare-ai-gateway` provider                         | 必须将 base URL 配置为 `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`         |
| `ALIBABA_CODING_PLAN_API_KEY`   | Alibaba Coding Plan 认证                         | 使用 `alibaba-coding-plan` provider                           |                                                                                                      |
| `ALIBABA_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan 认证                       | 使用 `alibaba-token-plan` provider                            | 推荐的 provider 专属名称                                                                            |
| `BAILIAN_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan 认证                       | 使用 `alibaba-token-plan` provider                            | 兼容 Qwen Code 的 Token Plan 预设                                                                     |
| `DEEPSEEK_API_KEY`              | DeepSeek 认证                                    | 使用 DeepSeek 模型                                          |                                                                                                      |
| `SILICONFLOW_API_KEY`           | SiliconFlow 认证                                 | 使用 `siliconflow` provider                                   |                                                                                                      |
| `SILICONFLOW_CN_API_KEY`        | SiliconFlow（中国）认证                         | 使用 `siliconflow-cn` provider                                |                                                                                                      |
| `KILO_API_KEY`                  | Kilo 认证                                        | 使用 Kilo 模型                                              |                                                                                                      |
| `OLLAMA_CLOUD_API_KEY`          | Ollama Cloud 认证                                | 使用 `ollama-cloud` provider                                  |                                                                                                      |
| `WAFER_SERVERLESS_API_KEY`      | Wafer Serverless 认证                            | 使用 `wafer-serverless` provider                              | 按量计费的 Wafer SKU；对照 `https://pass.wafer.ai/v1/models` 校验                                  |
| `GITLAB_TOKEN`                  | GitLab Duo 认证                                  | 使用 `gitlab-duo` provider                                    |                                                                                                      |

### GitHub/Copilot 令牌

| 变量                    | 用途                                      | 备注                                           |
| ----------------------- | ------------------------------------------ | ---------------------------------------------- |
| `COPILOT_GITHUB_TOKEN`  | GitHub Copilot provider 认证               | 此处不使用通用 GitHub token                   |
| `GH_TOKEN`              | Web scraper 中的 GitHub API 认证           | Web scraper 在 `GITHUB_TOKEN` 之后的回退      |
| `GITHUB_TOKEN`          | Web scraper 中的 GitHub API 认证           | Web scraper 先检查此变量再检查 `GH_TOKEN`     |

### Auth broker / auth gateway（远程凭据库）

启用 broker 后，本地 SQLite 凭据存储被绕过，所有 OAuth refresh / access token 都存放在 broker 主机上。关于完整协议、CLI 表面以及 5 分钟/15 秒的使用缓存分层，见 [`auth-broker-gateway.md`](./auth-broker-gateway.html)。

| 变量                                | 用途                                                                                         | 何时必需                                                                                              | 备注 / 优先级                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OMP_AUTH_BROKER_URL`               | 远程 auth-broker 的 base URL（例如 `https://broker.tailnet:8765`）；选择 broker 模式             | 通过 broker 解析凭据；`musepi auth-gateway serve`（网关本身是 broker 客户端）也需要                  | 优先于 `config.yml` 中的 `auth.broker.url`。当设置但无可用 token 时，`resolveAuthBrokerConfig()` 会硬报错，而不是回退到本地 SQLite。 |
| `OMP_AUTH_BROKER_TOKEN`             | 除 `/v1/healthz` 外发送到每个 broker 端点的 Bearer token                                        | `OMP_AUTH_BROKER_URL` 已设置且 `auth.broker.token` 或 `<config-dir>/auth-broker.token` 无 token 可用 | 解析顺序：此 env → `auth.broker.token`（支持 `$ENV_NAME` 间接引用）→ `<config-dir>/auth-broker.token`（权限 `0600`）。`<config-dir>` 为 `~/.musepi/`（遵循 `PI_CONFIG_DIR`）。 |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | 加密本地 broker 快照缓存的新鲜度窗口                                                           | broker 模式下可选                                                                                      | 默认 `3600000`（1 小时）。新鲜度基于 broker 的 `snapshot.generatedAt`；`0` 禁用缓存读写，并强制每次启动都进行旧的阻塞式拉取。 |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | 加密本地 broker 快照缓存的路径                                                                  | broker 模式下可选                                                                                      | 默认为 `~/.musepi/cache/auth-broker-snapshot.enc`（或 XDG 缓存等价位置）。对测试、临时主机或重新定位 `0600` 缓存文件有用。 |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | 针对可信 broker 客户端的进程级 OAuth 账户路由                                               | broker 模式下可选                                                                                      | 一个 JSON 对象的路径，将 provider ID 映射到精确的 broker `identityKey` 数组。缺失的 provider 不受限制；`[]` 隐藏该 provider 的 OAuth 账户；API key 仍然可见。启动时解析一次，输入无效则 fail closed。这不是服务器授权。 |

网关没有专属环境变量——它继承 `OMP_AUTH_BROKER_*`。它自身的入站 bearer token 存放于 `<config-dir>/auth-gateway.token`，通过 `musepi auth-gateway token` 管理。

---

## 2) Provider 专属运行时配置

### Anthropic Foundry 网关（Azure / 企业代理）

启用 `CLAUDE_CODE_USE_FOUNDRY` 后，Anthropic 请求切换到 Foundry 模式：

- Base URL 从 `FOUNDRY_BASE_URL` 解析（若未设置，回退仍为模型/默认 base URL）。
- provider `anthropic` 的 API key 解析变为：
  `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`。
- `ANTHROPIC_CUSTOM_HEADERS` 被解析为逗号/换行分隔的 `key: value`
  对，并合并进请求头。当
  `ANTHROPIC_BASE_URL` 指向非 Anthropic 主机（例如企业 API
  网关）时它们也会被转发，因此需要专有认证头的企业网关可以
  在未启用 Foundry 模式下工作。
- TLS 客户端/服务端材料可从环境变量值注入：
  `NODE_EXTRA_CA_CERTS`、`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`。
  每个接受：
  - 指向 PEM 内容的文件系统路径，或
  - 内联 PEM（包括转义的 `\n` 序列）。

  `NODE_EXTRA_CA_CERTS` 对每个 provider 拉取都生效（OpenAI 兼容、
  Codex、Ollama、Azure Responses、Google、Anthropic），而不只是 Foundry——Bun 的
  `fetch` 本身不消费该环境变量，因此该 bundle 会被合并进
  `RequestInit.tls.ca`，与系统根证书存储并列。`CLAUDE_CODE_*` mTLS
  材料仍为 Anthropic-Foundry 专属。

| 变量                      | 值类型                                   | 行为                                                                           |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `CLAUDE_CODE_USE_FOUNDRY` | 布尔类字符串（`1`、`true`、`yes`、`on`）  | 为 Anthropic provider 启用 Foundry 模式                                        |
| `FOUNDRY_BASE_URL`        | URL 字符串                                 | Foundry 模式下 Anthropic 端点的 base URL                                       |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token 字符串                             | 用于 `Authorization: Bearer <token>`                                            |
| `ANTHROPIC_CUSTOM_HEADERS`  | 请求头列表字符串                           | 额外请求头；格式 `header-a: value, header-b: value` 或换行分隔。只要 `ANTHROPIC_BASE_URL` 非 Anthropic，也会在 Foundry 之外转发。 |
| `NODE_EXTRA_CA_CERTS`       | PEM 路径或内联 PEM                         | 用于服务器证书校验的额外 CA 链                                                  |
| `CLAUDE_CODE_CLIENT_CERT`   | PEM 路径或内联 PEM                         | mTLS 客户端证书                                                               |
| `CLAUDE_CODE_CLIENT_KEY`    | PEM 路径或内联 PEM                         | mTLS 客户端私钥（必须与证书配对）                                              |

### Amazon Bedrock

| 变量                                                                        | 默认 / 行为                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `AWS_REGION`                                                                | 主要 region 来源                                                                          |
| `AWS_DEFAULT_REGION`                                                        | 若 `AWS_REGION` 未设置时的回退                                                               |
| `AWS_PROFILE`                                                               | 启用指定配置文件名的认证路径                                                                  |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`                               | 启用 IAM key 认证路径                                                                     |
| `AWS_BEARER_TOKEN_BEDROCK`                                                  | 最高优先级的 bearer token 认证路径；设置时跳过 AWS profile/凭据链查找                        |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | 在 provider 检测中将 Bedrock 标记为可用（凭据解析本身涵盖环境键、profile/SSO/`credential_process`，然后是 IMDSv2） |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`                              | 在 provider 检测中将 Bedrock 标记为可用（与上方 ECS 变量相同的注意事项）                  |
| `AWS_BEDROCK_SKIP_AUTH`                                                     | 若为 `1`，注入虚拟凭据（代理/非认证场景）                                                    |
| `HTTPS_PROXY` / `HTTP_PROXY`                                                | 通过 Bun 的原生 fetch 代理支持生效（该 provider 不再自带 AWS SDK / proxy-agent 传输）       |
| `NO_PROXY`                                                                  | 将匹配的主机从 Bun 的原生代理路由中排除                                                        |

Provider 代码中的 region 回退：`options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`。

### Azure OpenAI Responses

| 变量                                 | 默认 / 行为                                                           |
| ------------------------------------ | -------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`               | 除非作为选项传入 API key，否则必需                                    |
| `AZURE_OPENAI_API_VERSION`           | 默认 `v1`                                                            |
| `AZURE_OPENAI_BASE_URL`              | 直接覆盖 base URL                                                     |
| `AZURE_OPENAI_RESOURCE_NAME`         | 用于构造 base URL：`https://<resource>.openai.azure.com/openai/v1`   |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`   | 可选映射字符串：`modelId=deploymentName,model2=deployment2`          |

Base URL 解析：选项 `azureBaseUrl` → 环境变量 `AZURE_OPENAI_BASE_URL` → 选项/环境变量 resource name → `model.baseUrl`。

### Google Vertex AI

| 变量                          | 必需？                             | 备注                                                                                                    |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`         | 是（除非在选项中传入）             | 主要项目 ID 来源                                                                                        |
| `GCP_PROJECT`                  | 回退                               | 备选项目 ID 来源                                                                                        |
| `GCLOUD_PROJECT`               | 回退                               | 备选项目 ID 来源                                                                                        |
| `GOOGLE_CLOUD_PROJECT_ID`      | 仅 OAuth 登录辅助                  | 由 Gemini CLI OAuth 项目发现使用                                                                       |
| `GOOGLE_VERTEX_LOCATION`       | 是（除非在选项中传入）             | 主要 Vertex 位置来源                                                                                    |
| `GOOGLE_CLOUD_LOCATION`        | 回退                               | 备选 Vertex 位置来源                                                                                    |
| `VERTEX_LOCATION`              | 回退                               | 备选 Vertex 位置来源                                                                                    |
| `GOOGLE_CLOUD_API_KEY`         | 条件                               | 直接 Vertex API-key 认证；否则当项目和位置已设置时 ADC 回退可认证                                      |
| `GOOGLE_APPLICATION_CREDENTIALS` | 条件                             | 若设置，文件必须存在；否则检查 ADC 回退路径（`~/.config/gcloud/application_default_credentials.json`） |

### Kimi

| 变量                     | 默认 / 行为                                            |
| ------------------------ | -------------------------------------------------------- |
| `KIMI_CODE_OAUTH_HOST`   | 主要 OAuth 主机覆盖                                      |
| `KIMI_OAUTH_HOST`        | 回退 OAuth 主机覆盖                                      |
| `KIMI_CODE_BASE_URL`     | 覆盖 Kimi 用量端点 base URL（`usage/kimi.ts`）          |

OAuth 主机链：`KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`。

### Gemini CLI 兼容性

| 变量                       | 默认 / 行为                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `PI_AI_GEMINI_CLI_VERSION` | 覆盖 Gemini CLI user-agent 版本标签（未设置时 `0.35.3`）    |

### OpenAI Codex responses（特性/调试控制）

| 变量                                     | 行为                                             |
| ---------------------------------------- | -------------------------------------------------- |
| `PI_CODEX_DEBUG`                         | `1`/`true` 启用 Codex provider 调试日志          |
| `PI_CODEX_WEBSOCKET`                     | `1`/`true` 启用 websocket 传输偏好               |
| `PI_CODEX_RESPONSES_LITE`                | `1`/`true` 强制 Responses Lite；`0`/`false` 强制标准 Responses body；未设置则使用模型目录默认值 |
| `PI_OPENAI_STATEFUL`                     | 覆盖平台 OpenAI Responses API 的有状态链式默认值（`previous_response_id`，强制 `store: true`）：默认在 api.openai.com 上为开，其他处为关 |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS`     | 正整数覆盖（默认 300000）                         |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET`        | 非负整数覆盖（默认 5）                            |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS`      | 正整数基础退避覆盖（默认 500）                    |
| `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS`  | 正整数 OpenAI 首事件超时覆盖；`0` 禁用。`musepi config set providers.streamFirstEventTimeoutSeconds <seconds>` 提供持久化配置等价项 |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`         | 正整数 OpenAI 流空闲超时覆盖；`0` 禁用。`musepi config set providers.streamIdleTimeoutSeconds <seconds>` 提供持久化配置等价项 |

### Cursor provider 调试

| 变量              | 行为                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `DEBUG_CURSOR`    | 启用 provider 调试日志；`2`/`verbose` 用于详细 payload 片段        |
| `DEBUG_CURSOR_LOG` | JSONL 调试日志输出的可选文件路径                                 |

### Prompt 缓存兼容性开关

| 变量                | 行为                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PI_CACHE_RETENTION` | 若为 `long`，在支持处启用长保留（`anthropic`、`openai-responses`、Bedrock 保留解析）                         |

---

## 3) Web 搜索子系统

### 搜索 provider 凭据

| 变量                                              | 由谁使用                                                       |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `EXA_API_KEY`                                      | Exa 搜索/MCP；或使用 `/login exa`                             |
| `BRAVE_API_KEY`                                    | Brave 搜索 provider                                            |
| `PERPLEXITY_API_KEY`                               | Perplexity 搜索 provider API-key 模式                          |
| `PERPLEXITY_COOKIES`                               | Perplexity cookie 认证搜索模式                                 |
| `TAVILY_API_KEY`                                   | Tavily 搜索 provider                                           |
| `ZAI_API_KEY`                                      | z.ai 搜索 provider（也检查 `agent.db` 中存储的 OAuth）         |
| `OPENAI_API_KEY` / DB 中的 Codex OAuth             | Codex 搜索 provider 的可用性/认证                               |
| `PI_CODEX_WEB_SEARCH_MODEL`                        | Codex 搜索 provider 模型覆盖                                   |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`  | Kimi/Moonshot 搜索 provider 环境变量认证                        |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot 搜索端点覆盖                                    |
| `KAGI_API_KEY`                                     | Kagi 搜索 provider                                              |
| `JINA_API_KEY`                                     | Jina 搜索 provider                                              |
| `PARALLEL_API_KEY`                                 | Parallel 搜索 provider                                          |
| `SEARXNG_ENDPOINT`、`SEARXNG_TOKEN`                | SearXNG 端点及可选 bearer token                                |
| `SEARXNG_BASIC_USERNAME`、`SEARXNG_BASIC_PASSWORD` | SearXNG HTTP Basic Auth 凭据                                   |

SearXNG 还从 `~/.musepi/agent/config.yml` 读取等价的 `searxng.endpoint`、`searxng.token`、`searxng.basicUsername` 和 `searxng.basicPassword` 设置；环境变量是回退。

### Anthropic 网页搜索认证链

`searchAnthropic()` 按此顺序解析凭据：

1. `ANTHROPIC_SEARCH_API_KEY`
2. `authStorage.getApiKey("anthropic")` 回退凭据（运行时与配置覆盖、存储的 OAuth、登录来源的 API key、通用 Anthropic 环境回退，然后是其他存储的 API key；环境回退在 Foundry 模式下为 `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`，否则为 `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`）

对于任一条凭据路径，base URL 解析为：

1. `ANTHROPIC_SEARCH_BASE_URL`
2. 启用 `CLAUDE_CODE_USE_FOUNDRY` 时的 `FOUNDRY_BASE_URL`
3. `ANTHROPIC_BASE_URL`
4. `https://api.anthropic.com`

相关变量：

| 变量                        | 默认 / 行为                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_SEARCH_API_KEY`  | 专用于 Anthropic 网页搜索 provider 的 API key。最高优先级的搜索认证；在不影响聊天补全的情况下，为搜索调用覆盖 `ANTHROPIC_API_KEY` / OAuth / Foundry。 |
| `ANTHROPIC_SEARCH_BASE_URL` | 专用于 Anthropic 网页搜索 provider 的 base URL。应用于 `ANTHROPIC_SEARCH_API_KEY` 或回退 Anthropic 凭据；为搜索调用覆盖 `ANTHROPIC_BASE_URL`（以及 Foundry 模式下的 `FOUNDRY_BASE_URL`）。 |
| `ANTHROPIC_SEARCH_MODEL`    | 搜索模型覆盖。默认为 `claude-haiku-4-5`。                                                                                                                                                         |
| `ANTHROPIC_BASE_URL`        | 在未设置搜索专属 base URL 时，Anthropic 请求的通用回退 base URL。                                                                                                                              |

使用 `ANTHROPIC_SEARCH_BASE_URL`（可选地带 `ANTHROPIC_SEARCH_API_KEY`），可以在聊天经企业网关（`ANTHROPIC_BASE_URL` 或 `CLAUDE_CODE_USE_FOUNDRY=true`）路由的同时，把网页搜索指向直接的 Anthropic 端点，反之亦然。

### Perplexity OAuth 流程行为 flag

| 变量                | 行为                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `PI_AUTH_NO_BORROW` | 若设置，在 Perplexity 登录流程中禁用 macOS 原生应用 token 借用路径            |

---

## 4) Python 工具与内核运行时

| 变量                      | 默认 / 行为                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PI_PY`                    | Python eval 后端的布尔类覆盖：truthy（`1`/`true`/`yes`/`on`）启用，任何其他值禁用；未设置则交由 `eval.py` 设置（默认启用） |
| `PI_JS`                    | 对 JavaScript eval 后端相同的布尔类覆盖；未设置则交由 `eval.js` 设置（默认启用）                              |
| `PI_PYTHON_SKIP_CHECK`     | 若为 `1`，跳过 Python 解释器可用性检查（子进程 runner 仍按需启动）                                          |
| `PI_PYTHON_INTEGRATION`    | 若为 `1`，让门控集成测试（例如 `python-runner.integration.test.ts`）针对真实 Python 运行                     |
| `PI_PYTHON_IPC_TRACE`      | 若为 `1`，记录与 Python runner 子进程交换的 NDJSON 帧                                                        |
| `VIRTUAL_ENV`              | Python 运行时解析中优先级最高的 venv 路径                                                                       |

额外条件行为：

- 若 `BUN_ENV=test` 或 `NODE_ENV=test`，Python 可用性检查视为通过并跳过预热。
- Python 环境过滤会拒绝常见 API key，并允许安全的 base 变量以及带 `LC_`、`XDG_`、`PI_` 前缀的变量。

---

## 5) Agent/运行时行为开关

| 变量                         | 默认 / 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`              | `smol` 的临时 model-role 覆盖（CLI `--smol` 优先）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_SLOW_MODEL`              | `slow` 的临时 model-role 覆盖（CLI `--slow` 优先）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_PLAN_MODEL`              | `plan` 的临时 model-role 覆盖（CLI `--plan` 优先）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_NO_TITLE`                | 若设置（任意非空值），在首条用户消息时禁用自动会话标题生成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PI_TINY_DEVICE`             | 本地 tiny 模型的 ONNX execution provider；覆盖 `providers.tinyModelDevice` 设置（默认：CPU；支持 `cpu`、`gpu`、`metal`/`webgpu`、`auto`、`cuda`、`dml`、`coreml`、`wasm`、`webnn`、`webnn-gpu`、`webnn-cpu`、`webnn-npu`） |
| `PI_TINY_DTYPE`              | 本地 tiny 模型的 ONNX 量化/精度；覆盖 `providers.tinyModelDtype` 设置（默认：各模型随附 dtype，当前为 `q4`；支持 `auto`、`fp32`、`fp16`、`q8`、`int8`、`uint8`、`q4`、`bnb4`、`q4f16`、`q2`、`q2f16`、`q1`、`q1f16`） |
| `PI_NO_INTERLEAVED_THINKING` | 若为 `1`，禁用 Anthropic 交错思考预算行为，并对较旧思考模式使用输出 token 膨胀                                                                                                                             |
| `NULL_PROMPT`                | 若为 `true`，系统提示构建器返回空字符串                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PI_BLOCKED_AGENT`           | 在 task tool 中阻断特定 subagent 类型                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PI_SUBPROCESS_CMD`          | 覆盖 subagent 生成命令（绕过 `musepi` / `musepi.cmd` 解析）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PI_TASK_MAX_OUTPUT_BYTES`   | 每个 subagent 的最大捕获输出字节数（默认 `500000`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PI_TASK_MAX_OUTPUT_LINES`   | 每个 subagent 的最大捕获输出行数（默认 `5000`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_TIMING`                  | 若设置（任意非空值），通过 `logger.printTimings()` 向 **stderr** 打印分层的计时跨度树。交互模式下该树在 agent 就绪后（TUI 启动前）打印一次；打印模式下在整个 prompt 批次完成后打印。打印模式 prompt 被包裹在 `print:prompt:initial` / `print:prompt:next` 跨度中，使每条用户消息显示为一行。`PI_TIMING=x` 在交互模式打印后立即以代码 0 退出进程（仅用于测量冷启动）。`PI_TIMING=full` 列出每个模块加载条目，而不仅是前 N 个。 |
| `PI_DEBUG_STARTUP`           | 若设置（任意非空值），在每个启动阶段开始/结束时向 **stderr** 流式输出一行同步 `[startup] <phase>:start` / `:done` 标记——包括命令模块导入（`cli:load:<name>`）和原生 addon 提取/`dlopen`（`native:*`）。与 `PI_TIMING`（仅在启动完成时打印）不同，这些标记在高通时会存留：stderr 上最后一行指出进程卡住的阶段。可与 `PI_TIMING` 自由组合；标记与跨度树共享相同的阶段名称。 |
| `PI_PACKAGE_DIR`             | 覆盖包资产 base 目录解析（`docs/`、`examples/`、`CHANGELOG.md`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PI_DISABLE_LSPMUX`          | 若为 `1`，禁用 lspmux 检测/集成并强制直接生成 LSP 服务器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PI_RPC_EMIT_TITLE`          | 在 RPC 模式下启用标题事件的布尔类 flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SMITHERY_URL`               | Smithery 网页 URL 覆盖（默认 `https://smithery.ai`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SMITHERY_API_URL`           | Smithery API base URL 覆盖（默认 `https://api.smithery.ai`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SMITHERY_API_KEY`           | 用于受管 MCP 认证查找的 Smithery API key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PUPPETEER_EXECUTABLE_PATH`  | 浏览器工具 Chromium 可执行文件覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LITELLM_BASE_URL`           | LiteLLM 代理 base URL 回退（未设置时 `http://localhost:4000/v1`）；显式的 `providers.litellm.baseUrl` / `models.yml` 配置优先 |
| `LM_STUDIO_BASE_URL`         | 默认隐式 LM Studio 发现 base URL 覆盖（未设置时 `http://127.0.0.1:1234/v1`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OLLAMA_BASE_URL`            | 默认隐式 Ollama 发现 base URL 覆盖（未设置时用 `OLLAMA_HOST`，然后 `http://127.0.0.1:11434`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `OLLAMA_HOST`                | 当 `OLLAMA_BASE_URL` 未设置时用于隐式 Ollama 发现的主机；接受 Ollama 风格值如 `127.0.0.1:11434` 或 `http://host:11434`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OLLAMA_CONTEXT_LENGTH`      | 隐式 Ollama 发现的正整数上下文窗口覆盖；只影响 OMP 上下文预算，不改变 Ollama 运行时的 `num_ctx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LLAMA_CPP_BASE_URL`         | 默认隐式 Llama.cpp 发现 base URL 覆盖（未设置时 `http://127.0.0.1:8080`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PI_EDIT_VARIANT`            | 有效时强制 edit 工具变体（`patch`、`replace`、`hashline`、`apply_patch`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PI_STRICT_EDIT_MODE`        | 若为 `1`，禁用内置的模型专属 edit-mode 回退，因此除非 `PI_EDIT_VARIANT` 或 `edit.modelVariants` 覆盖，否则使用配置/全局的 `edit.mode` |
| `PI_FORCE_IMAGE_PROTOCOL`    | 在使用处强制受支持的图像协议（`kitty`、`iterm2`/`iterm`、`sixel`、`none`）。在 tmux 内设置 `kitty` 也会选择 Kitty Unicode 占位符放置，除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 禁用它 |
| `PI_ALLOW_SIXEL_PASSTHROUGH` | 当 `PI_FORCE_IMAGE_PROTOCOL=sixel` 时允许 SIXEL 直通                      |
| `PI_NO_PTY`                  | 若为 `1`，对 bash tool 禁用交互式 PTY 路径                                                                                                                        |
| `OMP_MCP_TIMEOUT_MS`         | 为每个 MCP server 覆盖 MCP 客户端请求超时（ms）。`0` 禁用客户端超时（`AbortSignal` 永不触发）。无效（负数或非数字）值会被忽略并给出警告，然后使用各 server 配置或默认值（`30000`）。 |

当 CLI 使用 `--no-pty` 时，`PI_NO_PTY` 也会在内部被设置。

---

## 6) 存储与配置根路径

这些影响 coding-agent 存储数据的位置以及它加载哪些进程内设置 overlay。

| 变量                  | 默认 / 行为                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| `PI_CONFIG_DIR`       | home 下的配置根目录名（默认 `.musepi`）                                            |
| `PI_CODING_AGENT_DIR` | agent 目录的完整覆盖（默认 `~/<PI_CONFIG_DIR 或 .musepi>/agent`）                 |
| `PI_CONFIG_FILES`     | 设置 overlay 的平台路径列表（Unix 上 `:`，Windows 上 `;`）；在显式 `--config` overlay 之前按序加载 |
| `PWD`                 | 在路径辅助函数匹配规范当前工作目录时使用                                          |

---

## 7) Shell/工具执行环境

（来自 `packages/utils/src/procmgr.ts` 和 coding-agent bash tool 集成。）

| 变量                       | 行为                                                                           |
| -------------------------- | ------------------------------------------------------------------------------ |
| `PI_BASH_NO_CI`            | 抑制向生成的 shell 环境自动注入 `CI=true`                                       |
| `CLAUDE_BASH_NO_CI`        | `PI_BASH_NO_CI` 的遗留别名回退                                                  |
| `PI_BASH_NO_LOGIN`         | 禁用登录 shell 模式；shell 参数变为 `['-c']` 而非 `['-l','-c']`                  |
| `CLAUDE_BASH_NO_LOGIN`     | `PI_BASH_NO_LOGIN` 的遗留别名回退                                                |
| `PI_SHELL_PREFIX`          | 可选命令前缀包装                                                                |
| `CLAUDE_CODE_SHELL_PREFIX` | `PI_SHELL_PREFIX` 的遗留别名回退                                                 |
| `VISUAL`                   | 首选外部编辑器命令                                                              |
| `EDITOR`                   | 回退外部编辑器命令                                                              |

当前实现：`PI_BASH_NO_LOGIN`/`CLAUDE_BASH_NO_LOGIN` 生效；当任一被设置时，`getShellArgs()` 返回 `['-c']`。

---

## 8) UI/主题/会话检测（自动检测的环境变量）

这些作为运行时信号被读取；它们通常由终端/操作系统设置，而非手动配置。

| 变量                                                                                                            | 用途                                                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `COLORTERM`、`TERM`、`WT_SESSION`                                                                                | 颜色能力检测（主题颜色模式）                             |
| `COLORFGBG`                                                                                                     | 终端背景亮/暗自动检测                                    |
| `TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`TERMINAL_EMULATOR`                                                      | 系统 prompt/context 中的终端身份                         |
| `TMUX_PANE`、`CMUX_SURFACE_ID`、`KITTY_WINDOW_ID`、`TERM_SESSION_ID`、`WT_SESSION`                               | 稳定的每终端会话面包屑 ID                                |
| `SHELL`、`ComSpec`、`TERM_PROGRAM`、`TERM`                                                                      | 系统信息诊断                                             |
| `APPDATA`、`XDG_CONFIG_HOME`                                                                                     | lspmux 配置路径解析                                      |
| `HOME`                                                                                                          | MCP 命令 UI 中的路径缩短                                  |

---

## 9) TUI 运行时 flag（共享包，影响 coding-agent 的 UX）

| 变量                        | 行为                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `PI_NOTIFICATIONS`           | `off` / `0` / `false` 抑制桌面通知                                                    |
| `PI_TUI_WRITE_LOG`           | 若设置，将 TUI 写入记录到文件                                                          |
| `PI_TUI_RAW_BACKSPACE_IS_CTRL` | 若为 `1`，将原始 `0x08` 解释为 Ctrl+Backspace 而非 Backspace；在 SSH/容器跳板隐藏 Windows Terminal 客户端时使用 |
| `PI_HARDWARE_CURSOR`         | 若为 `1`，启用硬件光标模式                                                             |
| `PI_NO_SYNC_OUTPUT`          | 若设置（任意非空值），禁用 DEC 2026 同步输出包装，同时保留 TUI autowrap 守卫           |
| `PI_NO_DECCARA`              | 若设置（truthy），禁用 Kitty DECCARA 矩形 SGR 背景填充（强制 padded-string 渲染）     |
| `PI_DEBUG_REDRAW`            | 若为 `1`，启用重绘调试日志                                                             |
| `PI_FORCE_IMAGE_PROTOCOL`    | 强制终端图像协议检测（`kitty`、`iterm2`/`iterm`、`sixel`、`none`）。在 tmux 内设置 `kitty` 也会选择 Kitty Unicode 占位符放置，除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 禁用它 |
| `PI_KITTY_PLACEHOLDERS`      | `1` 强制开启 Kitty Unicode 占位符放置；`0` 强制关闭。在 tmux/screen 下，仅当确认外层终端支持 Kitty `U=1` 占位符时才使用 `1`——否则 U+10EEEE 可能渲染为字面 PUA 方框 |
| `PI_NO_KITTY_PLACEHOLDERS`   | `1` 硬禁用 Kitty Unicode 占位符放置，并优先于 `PI_KITTY_PLACEHOLDERS`                  |
| `PI_TUI_RESIZE_IN_PLACE`     | `1`/`true` 强制原地调整大小（不借用 alt-screen，不做 ED3 重排）；`0`/`false` 强制 alt-screen 快速路径。Warp 默认开启，因为它会在 alt-screen 切换时重新报告尺寸 |

---

## 10) Commit 生成控制

| 变量                       | 行为                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `PI_COMMIT_TEST_FALLBACK` | 若为 `true`（大小写不敏感），强制 commit 回退生成路径             |
| `PI_COMMIT_NO_FALLBACK`   | 若为 `true`，当 agent 未返回提案时禁用回退                        |
| `PI_COMMIT_MAP_REDUCE`    | 若为 `false`，禁用 map-reduce commit 分析路径                     |
| `DEBUG`                   | 若设置，打印 commit agent 错误堆栈跟踪                            |

---

## 敏感变量

将这些视为 secret；不要记录或提交它们：

- Provider/API key 以及 OAuth/bearer 凭据（所有 `*_API_KEY`、`*_TOKEN`、OAuth access/refresh token）
- 云凭据（`AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS` 路径可能暴露 service-account 材料）
- 搜索/provider 认证变量（`EXA_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY`、Anthropic 搜索 key）
- Foundry mTLS 材料（`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`、`NODE_EXTRA_CA_CERTS` 指向私有 CA bundle 时）

在生成内核子进程之前，Python 运行时也会显式剥离许多常见 key 变量（`packages/coding-agent/src/eval/py/runtime.ts`）。
