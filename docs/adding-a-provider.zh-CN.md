# 添加 Provider


[English](adding-a-provide.md) | 中文
一个 provider 由两半组成：

- **Catalog half**（`packages/catalog`）：`CATALOG_PROVIDERS` 表（`packages/catalog/src/provider-models/descriptors.ts`）中的一条条目，携带 `id`、`defaultModel`、runtime model-discovery factory，以及 catalog-generation wiring。`KnownProvider`、`PROVIDER_DESCRIPTORS` 和 `DEFAULT_MODEL_PER_PROVIDER` 均由此表派生。
- **Auth half**（`packages/ai`）：registry 中的一条声明式 `ProviderDefinition`，携带 env-key fallback 与 login/refresh flows。`OAuthProvider` union、env-key map、`/login` provider 列表、`refreshOAuthToken` / `AuthStorage.login` dispatch，以及 coding-agent callback maps 均派生自该 registry。

**Scope。** 本文适用于复用一个既有 wire API（`openai-completions`、`anthropic-messages`、`google-generative-ai`，……）的 provider——这是 gateway 和 API-key provider 的常见情况，因为 stream dispatch keys 作用于 `model.api`，而非 `model.provider`。添加一个*新的 wire protocol*（新的 `KnownApi`）是独立任务，还需改动 `stream.ts` dispatch、`api-registry.ts` 和 catalog `types.ts`。

## Shape

针对常见情况，一个 provider 是**一条 catalog entry + 一个 def file + 一条 registry line**：

1. 在 `packages/catalog/src/provider-models/descriptors.ts` 中为 `CATALOG_PROVIDERS` 添加一条 entry，包含 `id`、`defaultModel`、plain API-key env var(s) 作为 `envVars`，以及（通常）`createModelManagerOptions` factory。对于简单的 OpenAI-compatible gateway，可在 `packages/catalog/src/provider-models/openai-compat.ts` 中构建 factory，或以内联方式使用导出的 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)`。
2. 创建 `packages/ai/src/registry/<id>.ts`，导出 `export const <camelId>Provider = { … } as const satisfies ProviderDefinition;` 并填 auth 字段（`login`，……）。Plain env-var 名放在 catalog entry 的 `envVars`；仅在需要计算式 resolver（Foundry/ADC/Bedrock-style probes）时才设置 `envKeys`。
3. 将该 provider 加入 `packages/ai/src/registry/registry.ts` 的 `ALL` 数组（一条 import + 一条数组 entry）。`ALL` 顺序即为 `/login` 中可登录 provider 的显示顺序。

以上即为以下场景的完整改动：
- 纯 env-key provider；
- 带简单 inline API-key login flow 的 provider；
- 大多数 OpenAI-compatible gateway。

对于**非 trivial 的 provider-local OAuth flow**，把实现放在 `packages/ai/src/registry/oauth/<vendor>.ts`，并让 def file 做 lazy import。其复用的共享 OAuth flow infrastructure 位于同一 `registry/oauth/` 目录。

Descriptors、default-model map、env-key map、login 列表和 refresh dispatch 均自动更新；`KnownProvider` union 从 catalog table 获得新的 id，`OAuthProvider` 从 registry 获得。

## Field reference

**Catalog table entry**（`ProviderCatalogEntry`，JSDoc 见 `packages/catalog/src/provider-models/descriptor-types.ts`）：

| 字段 | 效果 |
| --- | --- |
| `id` | 必填。`KnownProvider` 成员。 |
| `defaultModel` | 必填。未显式选择时的首选模型。 |
| `envVars` | 按顺序排列的 env var 名，供 runtime API-key fallback（`getEnvApiKey`）使用。 |
| `createModelManagerOptions` | Runtime model-discovery factory。存在且不等于 `specialModelManager` ⇒ 出现在 `PROVIDER_DESCRIPTORS` 中。 |
| `allowUnauthenticated` | Runtime 在无 key 时也创建 model manager。 |
| `dynamicModelsAuthoritative` | 成功的 discovery 替换 bundled models。 |
| `catalogDiscovery` | 用于离线 catalog generation（`generate-models.ts`）的 `{ label, envVars?, oauthProvider?, allowUnauthenticated? }`。此处的 `envVars` 在 generation 使用不同凭据时覆盖 entry-level 列表（如 `cursor`）。 |
| `specialModelManager` | 定制 runtime factory（`google-antigravity` / `google-gemini-cli` / `openai-codex`）；从 `PROVIDER_DESCRIPTORS` 中排除。 |

**Registry definition**（`ProviderDefinition`，类型见 `packages/ai/src/registry/types.ts`）：

| 字段 | 效果 |
| --- | --- |
| `id`、`name` | 必填。`name` 显示在 `/login` 列表。 |
| `envKeys` | `getEnvApiKey` 的计算式 env fallback，覆盖 catalog entry 的 `envVars`：可为 var name 字符串或 `() => string \| undefined` resolver。若 `envVars` 已覆盖则省略。 |
| `login` | 交互式登录。存在 ⇒ 成为 `OAuthProvider` 成员，显示在 `/login` 中，可通过 `AuthStorage.login` dispatch。返回 api-key `string` 或 `OAuthCredentials`。 |
| `refreshToken` | OAuth refresher；静态 token provider 省略（dispatch 原样返回 credentials）。 |
| `storeCredentialsAs` | 将凭据存储到不同 provider id 下（如 `openai-codex-device` ⇒ `openai-codex`）。 |
| `callbackPort` | 存在 ⇒ 加入 auth-broker 的 `CALLBACK_PORTS` map。 |
| `pasteCodeFlow` | OAuth flow 需要粘贴 code/redirect URL ⇒ 加入 `PASTE_CODE_LOGIN_PROVIDERS`。 |

## Conventions

- 使用 `... as const satisfies ProviderDefinition`，使字面量 `id` 被保留用于 union 推导。
- 简单 API-key 或 validation-based flow 的 `login` / `refreshToken` 可直接放在 provider def file 中（在那里导出具名 login 函数，以便测试直接导入）。
- 重型 provider-local OAuth flow 的 `login` / `refreshToken` **必须** 通过 dynamic-import thunk（`const { loginX } = await import("./oauth/x"); return loginX(cb);`）调用相邻的 `registry/oauth/*` 模块，保持这些 flow 不出现在 eager startup graph 中。
- 所有 OAuth 代码位于 `registry/oauth/` 下：共享 flow infra（`callback-server`、`pkce`、`google-oauth-shared`、`types`、runtime API `index`）以及每个 provider flow，包括被 streaming 和 usage layer 复用的 `github-copilot` / `kimi` / `openai-codex` helpers。非 OAuth 的 API-key helpers（`api-key-login`、`api-key-validation`）位于 `registry/` 下与 def 文件并列，因为它们支持简单 paste-an-API-key 登录。
- 简单 OpenAI-compatible gateway 使用与导出 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` 内联构建 manager——无需改动 `openai-compat.ts`。
- `ProviderDefinition` 也可在 runtime 由扩展通过 `registerOAuthProvider` 注册（`AuthStorage.login` dispatcher 统一处理 built-in 和 extension）。
