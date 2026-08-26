# Mnemopi 记忆后端

English | [中文](mnemosyne-memory-backend.md)

MusePi 可以把 `@musepi/pi-mnemopi` 用作本地长期记忆后端。

设置：

```yaml
memory:
  backend: mnemopi
```

示例：

```yaml
memory:
  backend: mnemopi
mnemopi:
  scoping: per-project-tagged
```

启用该后端后，coding agent：

1. 根据配置的 bank scoping 打开一个或多个本地 Mnemopi SQLite 数据库。
2. 在会话首次模型轮次时把相关记忆回填到 `<memories>` block；若回填发生在 `agent_start` listener，则刷新 base prompt。
3. 在 agent 轮次结束后，按 `mnemopi.retainEveryNTurns` 限定的频率把已完成的对话轮次写入 retain bank。
4. 当 compaction 向记忆后端请求 `preCompactionContext` 时，把回填记忆作为额外 compaction 上下文加入。
5. 通过共享记忆后端接口使用常规 `/memory view`、`/memory stats`、`/memory diagnose`、`/memory clear` 和 `/memory enqueue` 命令。

回填的记忆是 background context，不是 instructions。与当前用户消息和工具输出冲突时，以后者为准。

## Settings

| Setting                         | Default                | Description                                                                                                                                                             |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                | `off`                  | 设为 `mnemopi` 以启用该后端。                                                                                                                                          |
| `mnemopi.dbPath`              | agent memories dir     | 可选的 SQLite 数据库路径。                                                                                                                                          |
| `mnemopi.bank`                | unset                  | 传给 `Mnemopi` 的可选共享 bank 基名；coding-agent wrapper 会按 `mnemopi.scoping` 从此基名派生作用域。未设置 → 共享 bank 为 `default`；per-project 模式会从工作目录 basename 加上其绝对路径的稳定哈希推导出项目 bank。 |
| `mnemopi.scoping`             | `per-project`          | 记忆可见性模式：`global` = 一个共享 bank，`per-project` = 隔离项目记忆，`per-project-tagged` = 项目本地写入 + 全局回填可见。 |
| `mnemopi.autoRecall`          | `true`                 | 在会话首轮回填记忆。                                                                                                                                   |
| `mnemopi.autoRetain`          | `true`                 | 自动保留已完成轮次。                                                                                                                                   |
| `mnemopi.polyphonicRecall`    | `false`                | 启用 4-voice polyphonic recall（vector、graph、fact、temporal）并做 reciprocal rank fusion；设置 `MNEMOPI_POLYPHONIC_RECALL` 可覆盖。                            |
| `mnemopi.enhancedRecall`      | `false`                | 启用分层查询结果缓存以支持重复/相似回填查询；设置 `MNEMOPI_ENHANCED_RECALL` 可覆盖。                                                  |
| `mnemopi.retainEveryNTurns`   | `4`                    | 自动 retain 写入之间的最小用户轮次数。                                                                                                                     |
| `mnemopi.recallLimit`         | `8`                    | prompt block 中最多回填的记忆条数。                                                                                                                          |
| `mnemopi.recallContextTurns`  | `3`                    | 回填查询中包含的先前用户 bounded 轮次。                                                                                                                    |
| `mnemopi.recallMaxQueryChars` | `4000`                 | 组合后的回填查询最大长度。                                                                                                                                   |
| `mnemopi.injectionTokenLimit` | `5000`                 | 记忆 prompt 注入的大致 token 预算。                                                                                                                   |
| `mnemopi.debug`               | `false`                | 启用后端失败调试日志。                                                                                                                              |
| `mnemopi.noEmbeddings`        | `false`                | 向 `Mnemopi` 传入 `noEmbeddings` 并强制走 FTS-only recall。                                                                                                           |
| `mnemopi.embeddingVariant`    | `en`                   | 本地 embedding 模型变体：`en` = `BAAI/bge-base-en-v1.5`（768d），`multilingual` = `intfloat/multilingual-e5-large`（1024d）。`mnemopi.embeddingModel`/`MNEMOPI_EMBEDDING_MODEL` 可覆盖它；修改后会在下次可写启动时重建已存储 embeddings。 |
| `mnemopi.embeddingModel`      | variant default        | 显式 embedding 模型 id；覆盖 `mnemopi.embeddingVariant`。优先级：本设置 > `MNEMOPI_EMBEDDING_MODEL` 环境变量 > variant default。                          |
| `mnemopi.embeddingApiUrl`     | env/default            | 传给 `Mnemopi` 的 OpenAI-compatible embedding endpoint。                                                                                                             |
| `mnemopi.embeddingApiKey`     | env/default            | 传给 `Mnemopi` 的 embedding API key。                                                                                                                                |
| `mnemopi.llmMode`             | `smol`                 | `smol` 使用配置的 pi-ai smol 模型，`remote` 使用下方设置，`none` 禁用 LLM 调用。                                                           |
| `mnemopi.llmBaseUrl`          | env/default            | `llmMode: remote` 使用的 OpenAI-compatible LLM endpoint。                                                                                                                   |
| `mnemopi.llmApiKey`           | env/default            | `llmMode: remote` 使用的 LLM API key。                                                                                                                                      |
| `mnemopi.llmModel`            | env/default            | `llmMode: remote` 使用的 LLM 模型 id。                                                                                                                                     |

## Scoping

coding-agent wrapper 在底层 `Mnemopi` 包之上应用 scoping：

- `global` 使用一个共享 bank 做 recall 和 writes。
- `per-project` 向一个基于当前工作目录推导的 bank 写入和回填——即 basename 加上其绝对路径的稳定哈希，独立于周围的 git 布局。
- `per-project-tagged` 写入项目本地 bank，并从项目本地 bank 与共享 global bank 两边回填，重复回填结果会被合并。

项目 + 全局的组合行为实现在 wrapper 中。`@musepi/pi-mnemopi` 包本身仍直接暴露 banks 和 constructor options，包括用于选择 bank 名称的 `bank`。除共享 bank 外的项目本地 banks 作为 sibling bank databases 存储，由 Mnemopi 的 `BankManager` 管理。

## LLM and embeddings

后端将这些设置传给 `Mnemopi` constructor；如果某设置被省略，Mnemopi 会回退到其 `MNEMOPI_*` 环境默认值。后端不会下载或运行本地 GGUF LLM。依赖 LLM 的路径使用配置的 pi-ai 模型、可选的本地 on-device memory 模型（`providers.memoryModel`，ONNX — 设为本地模型时覆盖 `smol`/`remote`）、动态 completion function、远程 OpenAI-compatible endpoint，或确定性的 no-LLM fallbacks。

FTS-only：

```yaml
memory:
  backend: mnemopi
mnemopi:
  noEmbeddings: true
```

等价 constructor：

```ts
new Mnemopi({ noEmbeddings: true });
```

Remote embeddings：

```yaml
mnemopi:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

等价 constructor：

```ts
new Mnemopi({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

Remote LLM：

```yaml
mnemopi:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

等价 constructor：

```ts
new Mnemopi({ llm: { baseUrl, apiKey, model } });
new Mnemopi({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

用于轮换 OAuth token 的动态 function LLM：

```ts
new Mnemopi({
  llm: async (prompt, opts) => {
    const token = await getFreshOauthToken();
    return await completeWithPiAi(prompt, {
      token,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });
  },
});
```

pi-ai smol 模型 LLM：

```yaml
mnemopi:
  llmMode: smol
```

coding agent 会解析其配置的 smol 角色，并传入一个动态 completion function，使每次 Mnemopi LLM 调用都能在调用时取回当前 provider credentials：

```ts
new Mnemopi({
  llm: async (prompt, opts) => completeSmolWithCurrentAuth(prompt, opts),
});
```

## Operational notes

- 默认共享数据库位于 agent memories 目录下的 `mnemopi/mnemopi.db`；项目级 banks 使用该 Mnemopi 目录下的 sibling database paths。
- `/memory clear` 会删除当前配置下所有已作用域的 Mnemopi SQLite 数据库以及 sidecar WAL/SHM 文件。
- `/memory enqueue` 会强制保留当前会话、flush 待处理 fact extraction，并运行 Mnemopi sleep/consolidation。
- 当 Mnemopi 后端激活时，`/memory stats` 和 `/memory diagnose` 会渲染后端特定的 bank statistics/diagnostics。
- Subagents 不拥有独立的 Mnemopi retain loop；存在父级 Mnemopi state 时会 alias 父级状态，否则保持 inert。
