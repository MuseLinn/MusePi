# 模型与 Provider 配置（`models.yml` / `models.yaml`）

[English](models.md) | 中文

本文档描述 coding-agent 当前如何加载模型、应用覆盖、解析凭据，以及在运行时选择模型。

## 控制模型行为的因素

主要实现文件：

- `packages/coding-agent/src/config/model-registry.ts` — 加载内置 + 自定义模型、provider 覆盖、运行时发现、auth 集成
- `packages/coding-agent/src/config/model-resolver.ts` — 解析模型 pattern 并选择 initial/smol/slow 模型
- `packages/coding-agent/src/config/settings-schema.ts` — 与模型相关的设置（`modelRoles`、provider 传输偏好）
- `packages/coding-agent/src/session/auth-storage.ts` — 从 `@musepi/pi-ai` 重新导出 `AuthStorage`；API key + OAuth 解析顺序
- `packages/catalog/src/models.ts` 和 `packages/catalog/src/types.ts` — 内置 providers/models 与公开模型类型

## 配置文件位置与遗留行为

默认配置路径，按优先级顺序：

- `~/.musepi/agent/models.yml`
- `~/.musepi/agent/models.yaml`

仍保留的遗留行为：

- 两个 YAML 文件都不存在且同一位置存在 `models.json` 时，将其迁移为 `models.yml`。
- 以编程方式传给 `ModelRegistry` 时，显式的 `.json` / `.jsonc` 配置路径仍然支持。

## `models.yml` / `models.yaml` 结构

```yaml
providers:
  <provider-id>:
    # provider-level config
equivalence:
  overrides:
    <provider-id>/<model-id>: <canonical-model-id>
  exclude:
    - <provider-id>/<model-id>
```

`provider-id` 是跨选择与 auth 查找使用的规范 provider 键。

`equivalence` 是可选的，用于在具体 provider 模型之上配置规范模型分组：

- `overrides` 将精确的具体选择器（`provider/modelId`）映射到官方上游规范 id
- `exclude` 将某个具体选择器从规范分组中排除

## Provider 级字段

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false # set true for Anthropic-compatible endpoints that reject the strict field
    discovery:
      type: ollama
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        imageInputDecoder: stb # local STB decoder; OMP converts WebP before dispatch
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
```

### 允许的 provider/model `api` 值

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

### 允许的 auth/discovery 值

- `auth`：`apiKey`（默认）、`none` 或 `oauth`；对于 `models.yml` 自定义模型，schema 接受 `oauth`，但并不免除 `apiKey` 要求
- `discovery.type`：`ollama`、`llama.cpp`、`lm-studio`、`openai-models-list`、`proxy` 或 `litellm`
- `transport`：仅 `pi-native`。设置后，该 provider 下的每个模型都通过 `POST /v1/pi/stream` 发送到兼容 `musepi auth-gateway` 的 `baseUrl`；`apiKey` 是 gateway 的 bearer。
- `imageInputDecoder`：仅 `stb`。当服务后端使用无法接受 WebP 的 STB 兼容图像解码器时，在自定义模型或 `modelOverrides` 条目上设置此项；OMP 在发给 provider 之前会转换附带的和历史 WebP 图像。

## 验证规则（当前）

### 完整自定义 provider（`models` 非空）

必需项：

- `baseUrl`
- `apiKey` 除非 `auth: none`
- provider 级或每个 model 的 `api`

### 仅覆盖 provider（`models` 缺失或为空）

必须至少定义以下一项：

- `baseUrl`
- `apiKey`
- `auth: none`
- `headers`
- `compat`
- `disableStrictTools`
- `modelOverrides`
- `discovery`

### 发现

- `discovery` 需要 provider 级 `api`，`discovery.type: proxy` 除外（每模型 wire 自动检测）。

### Model 值检查

- `id` 必需
- `contextWindow` 与 `maxTokens` 若提供则必须为正数

### 命令解析的密钥

Provider `apiKey` 值和 provider/model `headers` 值可以以 `!` 开头，以从命令 stdout 读取密钥。命令以 10 秒超时运行，stdout 会被 trim，空命令或失败命令会被省略：

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password musepi-team-key"
```

成功的命令输出会在进程生命周期内缓存，因此不会为每个模型重新运行该命令。

## 合并与覆盖顺序

ModelRegistry 管线（刷新时）：

1. 从 `@musepi/pi-catalog` 加载内置 providers/models（`getBundledProviders` / `getBundledModels`）。
2. 加载 `models.yml` / `models.yaml` 自定义配置。
3. 将 provider 覆盖（`baseUrl`、`headers`、`disableStrictTools`）应用到内置模型。
4. 应用 `modelOverrides`（按 provider + model id）。
5. 合并自定义 `models`：
   - 相同的 `provider + id` 替换现有项
   - 否则追加
6. 加载缓存/运行时发现的模型（Ollama、llama.cpp、LM Studio，以及内置 provider 管理器），然后重新应用 model 覆盖。

### Provider-model 缓存与静态指纹

每个 provider 的缓存模型列表持久化在 model-cache SQLite 数据库（当前 schema 版本 6）中，带有一个 `static_fingerprint` 列，对合并进该行的静态 catalog 切片进行哈希。当 `resolveProviderModels` 跳过网络拉取且内存静态 catalog 的指纹与缓存匹配时，缓存行按原样返回——完全绕过静态 + 动态合并。指纹通过给 static-models 数组添加 symbol 属性按进程 memoize，因此重复的冷启动调用不会重新哈希。

## 规范模型等价与合并

Registry 保留每个具体的 provider 模型，然后在它们之上构建一层规范层。

规范 id 仅为官方上游 id，例如：

- `claude-opus-4-6`
- `claude-haiku-4-5`
- `gpt-5.3-codex`

### `models.yml` 等价配置

示例：

```yaml
providers:
  zenmux:
    baseUrl: https://api.zenmux.example/v1
    apiKey: ZENMUX_API_KEY
    api: openai-codex-responses
    models:
      - id: codex
        name: Zenmux Codex
        reasoning: true
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 200000
        maxTokens: 32768

equivalence:
  overrides:
    zenmux/codex: gpt-5.3-codex
    p-codex/codex: gpt-5.3-codex
  exclude:
    - demo/codex-preview
```

规范分组构建顺序：

1. 来自 `equivalence.overrides` 的精确用户覆盖
2. 来自内置 model metadata 的捆绑官方 id 匹配
3. 针对 gateway/provider 变体的保守启发式规范化
4. 回退到具体模型自身的 id

当前启发式有意保持狭窄：

- 存在嵌入的上游前缀时会被剥离，例如 `anthropic/...` 或 `openai/...`
- 点号与连字符的版本变体仅在映射到现有官方 id 时规范化，例如 `4.6 -> 4-6`
- 没有捆绑匹配或显式覆盖时，不合并模糊的家族或版本

### 规范解析行为

当多个具体变体共享一个规范 id 时，解析使用：

1. 可用性与 auth
2. `config.yml` 的 `modelProviderOrder`
3. 若未设置 `modelProviderOrder`，则使用现有 registry/provider 顺序

被禁用或未认证的 provider 会被跳过。

Session 状态与 transcript 仍记录实际执行该轮的 concrete provider/model。

Provider 默认值 vs 每模型覆盖：

- Provider `headers` 是基线。
- Model `headers` 覆盖 provider 的 header 键。
- `modelOverrides` 可以覆盖 model metadata（`name`、`reasoning`、`thinking`、`input`、`imageInputDecoder`、`supportsTools`、`cost`、`premiumMultiplier`、`contextWindow`、`maxTokens`、`omitMaxOutputTokens`、`headers`、`compat`、`contextPromotionTarget`、`compactionModel` 和 `remoteCompaction`）。
- `compat` 对嵌套路由块（`openRouterRouting`、`vercelGatewayRouting`、`extraBody` 和 `whenThinking`）做 deep merge。

## 运行时发现集成

### 隐式 Ollama 发现

若未显式配置 `ollama`，registry 会添加一个隐式可发现的 provider：

- provider：`ollama`
- api：`openai-responses`
- base URL：`OLLAMA_BASE_URL`、`OLLAMA_HOST` 或 `http://127.0.0.1:11434`
- context window：若设置则用 `OLLAMA_CONTEXT_LENGTH`，否则用 Ollama `/api/show` metadata，否则 `128000`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现会调用 Ollama 端点，并将发现的 OpenAI 兼容模型规范化为 `openai-responses`。

`OLLAMA_CONTEXT_LENGTH` 不配置 Ollama 运行时的 `num_ctx`；请在 Ollama/model 配置中单独设置。

### 隐式 llama.cpp 发现

若未显式配置 `llama.cpp`，registry 会添加一个隐式可发现的 provider：

- provider：`llama.cpp`
- api：`openai-responses`
- base URL：`LLAMA_CPP_BASE_URL` 或 `http://127.0.0.1:8080`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现会调用 llama.cpp model 端点，并用本地默认值合成模型条目。

### 隐式 LM Studio 发现

若未显式配置 `lm-studio`，registry 会添加一个隐式可发现的 provider：

- provider：`lm-studio`
- api：`openai-completions`
- base URL：`LM_STUDIO_BASE_URL` 或 `http://127.0.0.1:1234/v1`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现会拉取模型（`GET /models`）并用本地默认值合成模型条目。

此路径也适用于并非 LM Studio 的本地 OpenAI 兼容服务器。例如，如果 oMLX 绑定到 Ollama 常用端口，设置 `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1` 可通过现有的 `/v1/models` 流程发现它。同时运行 oMLX 和 Ollama 需要为其中一方分配不同端口。不要把 oMLX 配置为 `ollama`：Ollama 发现使用原生 `/api/tags` 和 `/api/show` 端点，而非 OpenAI 的 `/v1/models`。

### LiteLLM provider 发现

当 `litellm` 活跃时（例如通过 `LITELLM_API_KEY` 或存储的 auth），运行时发现使用 LiteLLM 代理：

- provider：`litellm`
- api：`openai-completions`
- base URL：显式 provider 的 `baseUrl` / `models.yml` 配置，否则 `LITELLM_BASE_URL`，否则 `http://localhost:4000/v1`
- auth 模式：代理需要密钥时用 `LITELLM_API_KEY` 或存储的 LiteLLM auth

运行时发现按顺序探测 LiteLLM 管理 metadata：`GET /model_group/info`、`GET /v2/model/info`、`GET /model/info` 和 `GET /v1/model/info`。配置的密钥必须被授权读取这些路由中的至少一个；在限制管理端点的部署上，请通过 LiteLLM 的 `allowed_routes` 访问控制授予该路由，或使用 master/admin 密钥进行发现。

若每个 metadata 路由都不可用，发现会回退到 OpenAI 兼容的 `GET /models` 列表。被禁止或失败的 metadata 请求会以其端点和状态记录一次；`404` 被视为路由不存在。富 metadata 映射每模型的 context 与能力字段，而裸回退 id 会在可用时对照捆绑的 reference metadata 进行富化。因此，不在捆绑 catalog 中的模型在回退后可能具有未知的 context 与定价。

### 显式 provider 发现

你可以自行配置发现：

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

自定义 LiteLLM gateway 可以使用相同的富发现路径：

```yaml
providers:
  litellm-gateway:
    baseUrl: http://gateway.example:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

LiteLLM metadata 端点使用配置的 base URL，仅为了发现而剥离尾部的 `/v1`，保留任何前置代理路径。运行时 model 调用保留配置的 OpenAI 兼容 `/v1` base URL。

### 代理发现（`discovery.type: proxy`）

对于在同一主机后同时暴露 `/v1/messages` 与 `/v1/chat/completions` 的 Anthropic+OpenAI 兼容代理（new-api / one-api / 类似）。发现会命中 `GET /v1/models`（10 秒超时，OpenAI 风格 payload），并从条目的 `supported_endpoint_types` 推导每个模型的 `api`：

- 包含 `"anthropic"` -> `api: anthropic-messages`（经由 `/v1/messages` 路由）
- 包含 `"openai"` -> `api: openai-completions`（经由 `/v1/chat/completions` 路由）
- 否则 -> 若设置了则回退到 provider 级 `api`，否则丢弃

使用 `discovery.type: proxy` 时 provider 级 `api` 是**可选的**，因为每模型的 wire 会自动检测。Anthropic SDK 在追加 `/v1/messages` 前会从 `baseUrl` 剥离尾部的 `/v1`，因此单个 discovery `baseUrl`（以 `/v1` 结尾）可正确往返于两种 wire。

```yaml
providers:
  newapi-reseller:
    baseUrl: https://api.example.com/v1
    apiKey: xxxx
    authHeader: true # injects Authorization: Bearer for openai models
    disableStrictTools: true # most anthropic-fronted proxies reject `strict`
    discovery:
      type: proxy
```

### 扩展 provider 注册

扩展可以在运行时注册 provider（`pi.registerProvider(...)`），包括：

- 某个 provider 的模型替换/追加
- 为新的 API ID 注册自定义 stream handler
- 注册自定义 OAuth provider

## Auth 与 API key 解析顺序

请求某个 provider 的密钥时，生效顺序为：

1. 运行时覆盖（CLI `--api-key`）
2. 配置覆盖（`models.yml` 的 `providers.<name>.apiKey`）
3. 存储的 OAuth 凭据（含刷新）
4. 登录来源的存储 API key
5. 环境变量映射（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）
6. 其他存储的 API key，例如 broker-migrated 副本
7. ModelRegistry 回退解析器（`models.yml` 自定义 provider，使用 env-name-or-literal 语义）

`models.yml` 的 `apiKey` 行为：

- 值首先被当作环境变量名。
- 若不存在该环境变量，则使用字面字符串作为 token。

若设置了 `authHeader: true` 且 provider `apiKey` 已配置，模型会得到：

- 注入 `Authorization: Bearer <resolved-key>` header。

无密钥 provider：

- 标记为 `auth: none` 的 provider 被视为无需凭据即可用。
- `getApiKey*` 为它们返回 `kNoAuth`。

### Broker 模式

当设置了 `OMP_AUTH_BROKER_URL`（或 `auth.broker.url`）时，本地 SQLite 凭据存储会被 `RemoteAuthCredentialStore` 替换。上述第 3、4、6 层（存储的 OAuth 和 API key 凭据）由 broker 提供的快照提供服务，其 `refresh` token 会被脱敏；过期会触发 broker 上的 `POST /v1/credential/:id/refresh`，而非本地刷新。

`AuthStorage.setConfigApiKey` 可以让 `models.yml` 的 `apiKey` 胜出 broker 解析的 OAuth token，且不覆盖运行时的 `--api-key`。完整的 broker/gateway 设计与 env 表面（`OMP_AUTH_BROKER_URL`、`OMP_AUTH_BROKER_TOKEN`、`auth.broker.url`、`auth.broker.token`）见 [`auth-broker-gateway.md`](./auth-broker-gateway.html)。

## Model 可用性 vs 全部模型

- `getAll()` 返回已加载的 model registry（内置 + 合并的自定义 + 发现的）。
- `getAvailable()` 过滤到无密钥或具有可解析 auth 的模型。

因此某个模型可能存在于 registry 中，但在 auth 可用之前不可选择。

## 运行时 model 解析

### CLI 与 pattern 解析

`model-resolver.ts` 支持：

- 精确 `provider/modelId`
- 精确的规范 model id
- 精确 model id（推断 provider）
- 模糊/子串匹配
- `--models` 中的 glob 作用域 pattern（例如 `openai/*`、`*sonnet*`）
- 可选的 `:thinkingLevel` 后缀（`off|minimal|low|medium|high|xhigh|max`）

`--provider` 是遗留项；`--model` 更受推荐。

精确选择器的解析优先级：

1. 精确 `provider/modelId` 绕过合并
2. 精确规范 id 通过规范索引解析
3. 精确的裸具体 id 仍然可用
4. 模糊与 glob 匹配在精确路径之后运行

### 初始 model 选择优先级

`findInitialModel(...)` 使用此顺序：

1. 显式的 CLI provider+model
2. 第一个 scoped 模型（若未恢复）
3. 已保存的默认 provider/model
4. 可用模型中的已知 provider 默认值（例如 OpenAI/Anthropic 等）
5. 第一个可用模型

### Role 别名与设置

支持的 model role：

- `default`、`smol`、`slow`、`vision`、`plan`、`designer`、`commit`、`tiny`、`task`、`advisor`

`tiny` role 覆盖用于轻量后台任务的在线模型（session 标题、memory、`auto` 思考难度分类、异常停止检测）；未设置时，这些回退到 `@smol`。在 `/models` 中选择一个。

诸如 `@smol` 的 role 别名通过 `settings.modelRoles` 展开；`*` 选择 `@default`。在 YAML 值中给 `@` 别名加引号（`fable: "@slow"`）。每个 role 值也可以追加 thinking 选择器，如 `:minimal`、`:low`、`:medium` 或 `:high`。

若一个 role 指向另一个 role，目标模型仍正常继承，且引用 role 上的任何显式后缀在该 role 特定用途中胜出。

相关设置：

- `modelRoles`（record）
- `enabledModels`（作用域 pattern 列表）
- `modelProviderOrder`（全局规范 provider 优先级）
- `providers.kimiApiFormat`（`openai` 或 `anthropic` 请求格式）
- `providers.openaiWebsockets`（OpenAI Codex 传输的 `auto|off|on` websocket 偏好）

`modelRoles` 可以存储：

- `provider/modelId` 以固定某个具体 provider 变体
- 规范 id，如 `gpt-5.3-codex`，以允许 provider 合并

对于 `enabledModels` 和 CLI `--models`：

- 精确规范 id 展开为该规范组中的所有具体变体
- 显式 `provider/modelId` 条目保持精确
- glob 与模糊匹配仍作用于具体模型

全局 `enabledModels` 与 `disabledProviders` 条目也可以限定到某个路径前缀：

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/claude-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

字符串条目处处适用。作用域条目在当前工作目录是配置路径或其子目录之一时生效。使用 `path`、`paths`、`pathPrefix` 或 `pathPrefixes`；对 `enabledModels` 使用 `models`，对 `disabledProviders` 使用 `providers`，或对两者使用 `values`。

## `/model` 与 `musepi models`

两个界面都保持 provider 前缀模型可见且可选。

它们现在也暴露规范/合并模型：

- `/model` 在 provider 标签旁包含一个规范视图
- `musepi models` 打印每个具体模型的 provider 分组表格，`musepi models canonical` 打印合并后的规范视图

选择规范条目会存储规范选择器。选择 provider 行会存储显式的 `provider/modelId`。

## Context 提升（model 级回退链）

Context 提升是小 context 变体（例如 `*-spark`）的一种溢出恢复机制，当 API 以 context 长度错误拒绝请求时，会自动提升到更大 context 的同级模型。

### 触发与顺序

当一轮因 context 溢出错误（例如 `context_length_exceeded`）失败时，`AgentSession` 会在回退到压缩**之前**尝试提升：

1. 若 `contextPromotion.enabled` 为 true，解析一个提升目标（见下文）。
2. 若找到目标，切换到它并重试请求——无需压缩。
3. 若没有可用目标，则在当前模型上落入自动压缩。

### 目标选择

选择是显式且 model 驱动的：

1. `currentModel.contextPromotionTarget`（若已配置）

只考虑配置的目标；context 提升不会自动选择更大的同 provider/API 同级模型。除非凭据可解析（`ModelRegistry.getApiKey(...)`），否则忽略配置的目标。

### OpenAI Codex websocket 交接

若从/向 `openai-codex-responses` 切换，session provider 状态键 `openai-codex-responses` 会在 model 切换前关闭。这会丢弃 websocket 传输状态，使下一轮在被提升的模型上干净启动。

### 持久化行为

提升使用临时切换（`setModelTemporary`）：

- 在 session 历史中记录为临时的 `model_change`
- 不重写已保存的 role 映射

### 配置显式回退链

通过 `contextPromotionTarget` 在 model metadata 中直接配置回退。

`contextPromotionTarget` 接受：

- `provider/model-id`（显式）
- `model-id`（在当前 provider 内解析）

显式 OpenAI 回退的示例（`models.yml`）：

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.5:
        contextPromotionTarget: openai-codex/gpt-5.4
```

内置 model 策略目前在同 provider/API 上存在目标时，将 OpenAI `codex-spark` 变体链接到 `gpt-5.5`，将 `gpt-5.5` 链接到 `gpt-5.4`。

## 兼容性与路由字段

Provider 或 model 上的 `compat` 块会覆盖 `packages/catalog/src/compat/openai.ts` 中基于 URL 的自动检测（`buildOpenAICompat`）。它由 `packages/coding-agent/src/config/models-config-schema.ts` 中的 `OpenAICompatSchema` 验证，并被每个 `openai-completions` 传输（`packages/ai/src/providers/openai-completions.ts`）消费。规范类型是 `packages/catalog/src/types.ts` 中的 `OpenAICompat`。

与这些字段交互的端点特定例外在 [Provider endpoint constraints](./provider-endpoint-constraints.html) 中有目录。

`models.yml` 接受以下键（全部可选；未设置时回退到 URL 检测）：

请求整形：

- `supportsStore` — 在请求上发出 `store: false`。默认：auto（对非标准端点关闭）。
- `supportsDeveloperRole` — 对 reasoning 模型使用 `developer` 系统角色而非 `system`。默认：auto。
- `supportsMultipleSystemMessages` — 保留分开的前导 system/developer 消息而非合并。默认：auto（已知的 OpenAI 兼容托管 API 保留；严格模板/本地主机合并）。
- `supportsUsageInStreaming` — 发送 `stream_options: { include_usage: true }` 以在流式响应中接收 token 用量。默认：`true`。
- `maxTokensField` — `"max_completion_tokens"` 或 `"max_tokens"`。默认：auto。
- `supportsToolChoice` — 当调用方强制指定某个 tool 时发出 `tool_choice` 参数。默认：`true`。对 `tool_choice` 返回 400 的端点（例如开启 reasoning 的 DeepSeek）设为 `false`。
- `supportsForcedToolChoice` — 接受强制要求某个特定 tool 的 `tool_choice`。默认：`true`。为 `false` 时，强制选择器会被降级为 `auto`，使 tool 保持可用，适用于拒绝强制 tool 调用的端点（例如某些需要 reasoning 的 OpenAI 兼容模型）。
- `disableReasoningOnForcedToolChoice` — 每当 `tool_choice` 强制调用时丢弃 `reasoning_effort` / OpenRouter `reasoning`。默认：auto（Kimi/Anthropic 前端端点）。
- `disableReasoningOnToolChoice` — 只要发送任何 `tool_choice` 就丢弃 reasoning 字段。默认：auto（DeepSeek reasoning 模型）。
- `alwaysSendMaxTokens` — 当调用方未提供时始终发送 max-token 字段。默认：auto（Kimi 家族模型从 `max_tokens` 推导 TPM 限制）。
- `strictResponsesPairing` — Responses-API 的 tool-call/result 历史必须严格配对。默认：auto（Azure OpenAI、GitHub Copilot）。
- `streamIdleTimeoutMs` — 慢 reasoning 主机的 stream-watchdog 空闲超时下限（毫秒）。默认：auto（GLM 编码计划主机、直连 DeepSeek reasoning）。
- `cacheControlFormat` — `"anthropic"` 以使 chat-completions payload 包含 Anthropic 风格的 prompt-cache 标记。默认：auto（OpenRouter `anthropic/*` 模型）。
- `supportsLongPromptCacheRetention` — 主机在 Responses API 上遵守 `prompt_cache_retention: "24h"`。默认：auto（api.openai.com）。
- `extraBody` — 合并进每个请求体的额外顶层字段（gateway 提示、controller 选择器等）。

Reasoning / thinking：

- `supportsReasoningEffort` — 接受 `reasoning_effort`。默认：auto（对 Grok、Z.ai/Zhipu 和 Xiaomi MiMo 关闭）。
- `supportsReasoningParams` — 请求整形是否可以在任何情况下发送 reasoning 参数。默认：auto（对 GitHub Copilot chat-completions 关闭）。
- `reasoningEffortMap` — 从内部 effort 级别（`minimal|low|medium|high|xhigh|max`）到 provider 特定字符串的部分映射（例如 Fireworks GLM 将 `minimal -> "none"`）。
- `thinkingFormat` — thinking 的请求形状：`"openai"`（`reasoning_effort`）、`"openrouter"`（`reasoning: { effort }`）、`"zai"`（`thinking: { type: "enabled" }`）、`"qwen"`（顶层 `enable_thinking`）或 `"qwen-chat-template"`（`chat_template_kwargs.enable_thinking`）。默认：`"openai"`。
- `reasoningContentField` — 携带思维链的 assistant 字段：`"reasoning_content"`、`"reasoning"` 或 `"reasoning_text"`。默认：auto。
- `requiresReasoningContentForToolCalls` — assistant tool-call 轮必须往返传递 reasoning 字段（DeepSeek-R1、Kimi，以及开启 reasoning 的 OpenRouter）。默认：`false`。
- `allowsSyntheticReasoningContentForToolCalls` — 当先前的 assistant tool-call 轮缺少 provider reasoning content 时，允许占位 reasoning 字段。默认：`true`；对验证精确 reasoning 值的 provider 设为 `false`。
- `requiresAssistantContentForToolCalls` — assistant tool-call 轮必须包含非空文本内容（Kimi）。默认：`false`。
- `whenThinking` — 仅在请求实际启用 thinking 模式时应用的局部 compat 覆盖（在基线 compat 之上做 deep merge）。

Tool / 消息规范化：

- `requiresToolResultName` — tool-result 消息需要 `name` 字段（Mistral）。默认：auto。
- `requiresAssistantAfterToolResult` — tool result 之后的用户消息需要中间有一个 assistant 轮。默认：auto。
- `requiresThinkingAsText` — 将 thinking 块转换为包裹在 `<thinking>` 分隔符中的文本（Mistral）。默认：auto。
- `requiresMistralToolIds` — 将 tool-call id 规范化为恰好 9 个字母数字字符。默认：auto。
- `supportsStrictMode` — 接受 tool schema 上每个 tool 的 `strict` 字段。默认：按 provider/baseUrl 保守自动检测。
- `toolStrictMode` — `"all_strict"` 强制每个 tool 严格，`"none"` 强制关闭；未设置则保留现有的每 tool 混合行为。

Gateway 路由（仅在 `baseUrl` 匹配 gateway 时应用）：

- `openRouterRouting.only` / `openRouterRouting.order` — `openrouter.ai` 上的 provider 路由（见 <https://openrouter.ai/docs/provider-routing>）。
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — `ai-gateway.vercel.sh` 上的 provider 路由（见 <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>）。

Provider 级 `compat` 是基线；每模型的 `compat` 在其上做 deep merge，`openRouterRouting`、`vercelGatewayRouting` 和 `extraBody` 作为嵌套对象合并。

### Anthropic 兼容性（`anthropic-messages`）

对于 `anthropic-messages` 模型，运行时使用单独的 `AnthropicCompat` 形状（`packages/catalog/src/types.ts`）。`models.yml` schema 将 strict-tools 退出暴露为顶层 provider 字段（见下文），外加同一 `compat` 槽位中的两个 Anthropic 侧 flag——`requiresToolResultId`（针对 Z.AI 风格代理，`tool_result` 块上的非标准 `id` 别名）和 `replayUnsignedThinking`（将未签名 thinking 块重放为原生 thinking，而不是降级为文本）；其余 Anthropic 侧旋钮（`disableAdaptiveThinking`、`supportsEagerToolInputStreaming`、`supportsLongCacheRetention`、`supportsMidConversationSystem`、`supportsForcedToolChoice`、`supportsSamplingParams`、`escapeBuiltinToolNames`）由内置 catalog metadata 设置，不能从 `models.yml` 用户配置。

### 严格 tool schema（`disableStrictTools`）

Anthropic 的 API 在 tool 定义上支持 `strict` 字段，强制模型始终严格遵循所提供的 schema。OMP 默认对一小撮高频内置 `anthropic-messages` tool 的 allowlist（`bash`、`python`、`edit` 和 `find`）启用它，这些 tool 的 schema 符合 Anthropic 的严格语法限制；其他 tool 仍发送规范化 schema，但省略 `strict`。

位于 Anthropic API 之前的第三方 provider（AWS Bedrock、Azure、自托管代理）并不总是实现该字段，并且会拒绝包含它的请求。在 provider 级设置 `disableStrictTools: true` 可对白名单 tool 退出严格模式：

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools` 是 provider 级 flag，应用于该 provider 中的所有模型。它仅为 OMP 否则会标记为 strict 的 tool 禁用 Anthropic `strict` 标记；它不改变运行时 tool 参数验证。OMP 可以在 Anthropic 于首个流式 token 前报告 strict-grammar-too-large 错误后自动无 strict tool 重试，但出于其他原因拒绝 `strict` 字段的代理应显式设置此 flag。

线上发送的 tool schema 由 `packages/ai/src/utils/schema/normalize.ts` 中的统一流程规范化（Google/CCA/MCP 分发器外加 OpenAI 严格模式 sanitize+enforce 管线）。strict 模式边界情况（本地 `$ref` 内联、单项 `allOf` 折叠、`anyOf` 包装描述上提、enum/const 原始类型推断）与按 provider 的分发器映射见 [`ai-schema-normalize.md`](./ai-schema-normalize.html)。

## 实用示例

### 本地 OpenAI 兼容端点（无 auth）

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

对于具有可发现 `/v1/models` 端点的 oMLX 或另一个本地 OpenAI 兼容服务器，优先使用发现而非手动列出模型。将 `api` 设置为你的服务器实际暴露的端点族：`openai-completions` 使用 `/v1/chat/completions`；暴露 `/v1/responses` 的服务器则需要 `openai-responses`。

```yaml
providers:
  omlx:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

内置 vLLM provider 可以指向非默认端点，而无需声明自定义 discovery 类型。OMP 使用 vLLM 的 `/v1/models` metadata，并将 vLLM 的 `max_model_len` 字段保留为发现的 context window。

```yaml
providers:
  vllm:
    baseUrl: http://192.168.5.3:8085/v1
    auth: none
```

对于多个 vLLM 端点，使用任意 provider ID 配合通用 OpenAI 兼容发现路径。本地无 auth 服务器设置 `auth: none`，需要认证的服务器设置 `apiKey`。通用发现先读取 `max_model_len`，然后作为通用 OpenAI 兼容回退读取 `context_length`。

```yaml
providers:
  vllm-fast:
    baseUrl: http://host-a:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
  vllm-long:
    baseUrl: http://host-b:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

### 带环境变量密钥的托管代理

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true # if the proxy doesn't support strict tool schemas
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

### 覆盖内置 provider 路由 + model metadata

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/claude-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

## 遗留消费者注意事项

大多数 model 配置现在通过 `ModelRegistry` 经 `models.yml` / `models.yaml` 流动。显式的 `.json` / `.jsonc` 路径仅在以编程方式传给 `ModelRegistry` 时仍然支持；默认用户配置优先 `~/.musepi/agent/models.yml`，然后回退到 `~/.musepi/agent/models.yaml`。

## 故障模式

若 `models.yml` / `models.yaml` 未通过 schema 或验证检查：

- registry 继续使用内置模型运行
- 错误通过 `ModelRegistry.getError()` 暴露，并在 UI/通知中呈现
