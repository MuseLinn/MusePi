---
title: Secret Obfuscation
status: living
summary: 阻止敏感值进入模型请求；包含 secrets.yml、Agent 密钥存储、bash 注入、Provider 边界与 daemon RPC 契约。
scope:
  - packages/coding-agent/src/secrets
  - packages/coding-agent/src/tools/request-secret.ts
  - packages/coding-agent/src/tools/list-secrets.ts
  - packages/coding-agent/src/daemon/services/secret-service.ts
  - packages/wire/src/secret.ts
---

# 密钥混淆

[English](secrets.md) | 中文

阻止敏感值（API 密钥、Token、密码）被发送给 LLM provider。开启后，出站文本离开进程前会先替换其中的密钥；会话上下文在展示或恢复重建时，会把可逆的混淆占位符还原。`replace` 模式的替换是单向的，不会还原。

## 开启

默认关闭。通过 `/settings` 界面或直接编辑 `config.yml` 开启：

```yaml
secrets:
  enabled: true
```

## 工作原理

1. 会话启动时，条目来自配置来源与 Agent 密钥存储：
   - **环境变量**：名称匹配常见密钥模式（`KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`PASS`、`AUTH`、`CREDENTIAL`、`PRIVATE`、`OAUTH`），且值长度不少于 8 个字符
   - **`secrets.yml` 文件**（见下文）
   - **内置凭据模式**（GitHub/GitLab/OpenAI 风格 Token），首次匹配时惰性解析
   - **Agent 密钥**：通过 `request_secret` 卡片保存（始终加载，不依赖 `secrets.enabled`；见 [Agent 密钥](#agent-密钥)）

2. 发给 LLM 的出站文本消息中，密钥值会被替换为确定性占位符，例如 `#AB12#`、`#AB12:L#` 或 `#GITHUBTOKEN_AB12:L#`。

3. 构建展示/恢复上下文时，会深度遍历会话上下文并还原混淆占位符。`replace` 模式的替换是单向的，不会还原。

每个密钥用两种模式之一处理：

| 模式                  | 行为                                                                                          | 可逆                                         |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `obfuscate`（默认）   | 替换为确定性占位符 `#[A-Z0-9]+(?::[ULCM])?#`，可带名称前缀                                    | 是（在展示/恢复上下文中反混淆）              |
| `replace`             | 替换为确定性的等长字符串                                                                      | 否（单向）                                   |

## secrets.yml

用 YAML 定义自定义密钥条目。会检查两个位置：

| 级别   | 路径                          | 用途             |
| ------ | ----------------------------- | ---------------- |
| 全局   | `~/.musepi/agent/secrets.yml` | 所有项目共用的密钥 |
| 项目   | `<cwd>/.musepi/secrets.yml`   | 项目专属密钥     |

`content` 相同的条目，项目条目覆盖全局条目。

### Schema

数组中的每个条目包含以下字段：

| 字段           | 类型                         | 必填 | 说明                                                       |
| -------------- | ---------------------------- | ---- | ---------------------------------------------------------- |
| `type`         | `"plain"` 或 `"regex"`       | 是   | 匹配方式                                                   |
| `content`      | string                       | 是   | 密钥值（plain）或正则模式（regex）                         |
| `mode`         | `"obfuscate"` 或 `"replace"` | 否   | 默认：`"obfuscate"`                                        |
| `replacement`  | string                       | 否   | 自定义替换文本（仅 replace 模式）                          |
| `flags`        | string                       | 否   | 正则 flags（仅 regex 类型）                                |
| `friendlyName` | string                       | 否   | 经清洗后对模型可见的标签，用于 obfuscate 模式占位符        |

### 示例

#### Plain 密钥

```yaml
# 混淆一个具体的 API 密钥（默认模式）
- type: plain
  content: sk-proj-abc123def456

# 把数据库密码替换为固定字符串
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### 友好名称

`friendlyName` 为可逆混淆占位符增加语义上下文，同时不暴露密钥值：

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

这会生成形如 `#GITHUBTOKEN_AB12:L#` 的占位符。友好名称会清洗为大写字母与数字，最长 32 个字符；清洗后为空则省略。可选的 `friendlyName` 元数据无效时不会停用该密钥条目；密钥仍会以无标签占位符混淆。

哈希基数是密钥在每次安装私有的密钥（存储在 `~/.musepi/agent/secret-placeholder.key`，XDG 安装则为 `$XDG_STATE_HOME/omp/secret-placeholder.key`，永不发送给模型）下的 HMAC，因此读取 transcript 的人无法通过字典把占位符还原成密钥。基数以精确的密钥值为键，所以仅大小写不同的两个密钥会得到互相独立的基数，provider 看到一个占位符也无法通过替换大小写提示合成另一个密钥的 Token。大小写提示后缀向模型标注被遮蔽值的大小写：

| 提示 | 含义                                       |
| ---- | ------------------------------------------ |
| `:U` | 所有有大小写的 ASCII 字母均为大写          |
| `:L` | 所有有大小写的 ASCII 字母均为小写          |
| `:C` | 首个有大小写的 ASCII 字母大写，其余小写    |
| `:M` | ASCII 大小写混合                           |

regex 条目上的 `friendlyName` 标注的是配置的正则条目，而不是匹配到的值。正则标签要保持足够宽泛，对每个匹配都为真。

#### Regex 密钥

```yaml
# 混淆任何 AWS 风格的密钥
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# 使用显式 flags 做大小写不敏感匹配
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# 正则字面量语法（模式与 flags 写在同一个字符串里）
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

regex 条目始终全局扫描（自动强制 `g` flag）。除了分开的 `content` + `flags` 字段，也支持正则字面量语法 `/pattern/flags`。模式中转义斜杠（`\\/`）会被正确处理。

#### Regex 的 replace 模式

```yaml
# 单向替换连接字符串（不可逆）
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## 与环境变量检测的交互

先收集环境变量，再追加文件定义的条目。文件条目可以覆盖不存放在环境变量里的密钥（配置文件、硬编码值等）。环境变量条目与文件条目之间不做去重，因此同时出现在两处的 plain 值会注册两次；两个占位符都还原为同一个密钥，反混淆不受影响。

## Agent 密钥

Agent 密钥是模型在运行时才发现需要的凭据——例如 `curl` 用的 API Token、私有仓库密码。与 `secrets.yml` 不同，值由用户在 Agent 提出请求后输入卡片，模型只知道名字，永远看不到值。

### 工具

| 工具             | 输入                | 返回                                                     |
| ---------------- | ------------------- | -------------------------------------------------------- |
| `request_secret` | `name`、`purpose`   | 环境变量名与状态；永不包含值                             |
| `list_secrets`   | 无                  | 名字、用途、scope 与可用性；永不包含值                   |

`name` 必须匹配 `/^[A-Z][A-Z0-9_]{0,63}$/`。已存储且可解密的值会立即返回环境变量名；工具唯一会推送的卡片是 `kind:"fill"` 的 `secret-request`。`kind:"allow"` 仍作为 wire/service 层可接受的动作，留给未来增加同意策略的宿主。卡片十分钟无应答按取消处理。交互式收集要求宿主实现 `requestSecret` UI 通道（daemon 的 approval bridge）；无头/TUI 宿主会返回错误，提示用户到「设置 → 密钥」添加。

### 存储

```
<agentDir>/agent-secrets/
  secrets.json    # 每个名字一个 AES-256-GCM 信封（仅值）
  metadata.json   # name、purpose、scope、时间戳（0600，原子写）
  .master.key     # 每 profile 主密钥（0600；可用 MUSEPI_AGENT_SECRET_KEY 覆盖）
```

存储恒为加密，不提供明文模式。值是以 profile 主密钥经 HKDF 派生的 AES-256-GCM 信封，复用 connector vault 的信封实现。元数据 sidecar 不含值，加密文件同样不含值。

P0 的 `scope` 为 `"all"`：每个已存储密钥对所有会话可用。workspace/bot scope 是未来的 union 扩展，不是当前字段。

### Bash 注入

每个可解密且 scope 与当前会话匹配的已存储条目，都会以 `MUSEPI_SECRET_<NAME>` 进入每个 bash 子进程（P0：`"all"`）。值只存在于该子进程的环境里：

- 从不修改 `process.env`。
- 模型通过 `env` 参数传入同名变量时，已存储的值会覆盖它。
- 工具输出（前台结果、超时/取消错误、流式分块、异步作业文本、ACP 终端轮询）会把值替换为 `[secret:NAME]`。流式分块按累计 tail 脱敏，因此被切成两半的值仍会被替换。
- 命令打印该变量时，`[secret:NAME]` 是预期的脱敏标记，不是命令失败；模型会被告知不要因此重试或报错。

### Provider 边界

会话启动时，已存储的 Agent 密钥以 plain、obfuscate 模式条目加入会话的 `SecretObfuscator`，`friendlyName` 为密钥名。会话中途保存时，值会立即注册进每个活跃会话的 obfuscator，包括启动时存储为空、由这次保存第一次写入密钥的那个会话。因此 provider 请求只会携带可逆占位符（如 `#GITHUBTOKEN_AB12:L#`），永不携带值。

Agent 密钥**始终**受覆盖：用户在安全检查卡中显式保存的值，与通用扫描特性是两份不同的授权。即使 `secrets.enabled=false`，会话也会构建 Agent 密钥 obfuscator。该开关只控制通用来源（环境变量扫描、`secrets.yml`、内置凭据模式）；关闭时这些来源不注册，但 Agent 卡片保存的值仍然注册。

### Daemon RPC

| RPC              | 参数                                             | 结果                                       |
| ---------------- | ------------------------------------------------ | ------------------------------------------ |
| `secret.status`  | `{}`                                             | `{ mode: "encrypted", count }`             |
| `secret.list`    | `{}`                                             | `{ entries: SecretEntryView[], count }`    |
| `secret.set`     | `{ name, value, purpose?, scope? }`              | `{ entry }`                                |
| `secret.delete`  | `{ name }`                                       | `{ ok: true }`（幂等）                     |
| `secret.answer`  | `{ requestId, action, value?, scope? }`          | `{ ok: true }`                             |

`SecretEntryView` 中的时间戳是 epoch 毫秒。`secret.answer` 在 daemon 内先落盘再落定工具的 promise，因此工具只看得到最终动作。未知或已过期的 request id 会报 `Unknown secret request: <id>`。任何响应、推送、日志或 transcript 都不包含值。

### 已知限制

- 短于 8 个字符的值会被拒绝（`Secret value must be at least 8 characters`）。混淆器只为至少 8 个字符的 plain 值生成可逆占位符，若允许 4 位 PIN，它会被原样发给模型。支持短密钥需要独立的 replace 模式实现，而不是绕过阈值。
- P0 的 scope 为 `"all"`；按 workspace、按 bot 的 scope 是未来扩展。
- 信封无法解密的条目仍会列为不可用。通过 `request_secret` 或「设置 → 密钥」重新保存该值来修复；不要手工编辑 sidecar。
- 删除密钥会从磁盘和未来的 bash 注入中移除它，但运行中会话里已经存活的 obfuscator 会在该会话生命周期内继续替换这个旧值。这是有意为之：撤掉覆盖可能让已经出现过的值重新对 provider 可见。
- Bash 的原始输出 artifact 由执行器在输出清洗之前写入，因此回显了值的命令可能把值留在该本地 artifact 文件里。值不会进入工具结果；若该 artifact 被读回模型上下文，provider 边界混淆（对 Agent 密钥始终生效）仍会替换它。
- 信封与元数据是两次独立的原子写。两者之间崩溃可能留下孤儿加密值（不可见、无害），或留下一个已列出但值缺失的名字（显示为不可用）。

## 关键文件

- `packages/coding-agent/src/secrets/index.ts` -- 加载、合并、环境变量收集
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` 类、占位符生成、消息混淆
- `packages/coding-agent/src/secrets/regex.ts` -- 正则字面量解析与编译
- `packages/coding-agent/src/secrets/agent-store.ts` -- 加密的 Agent 密钥存储、元数据 sidecar、校验
- `packages/coding-agent/src/secrets/agent-runtime.ts` -- 会话加载、动态 obfuscator 注册、bash 环境与输出清洗
- `packages/coding-agent/src/tools/request-secret.ts` -- 交互式密钥卡片工具
- `packages/coding-agent/src/tools/list-secrets.ts` -- 只读元数据的列表工具
- `packages/coding-agent/src/daemon/services/secret-service.ts` -- `secret.*` RPC 实现
- `packages/coding-agent/src/daemon/approval-bridge.ts` -- 密钥卡片 pending 表、超时与结算
- `packages/wire/src/secret.ts` -- daemon/GUI 密钥契约
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` 设置定义

## 参见

- [`auth-broker-gateway.md`](./auth-broker-gateway.html) -- 远端凭据保险库与转发代理，把 provider OAuth 刷新令牌与访问令牌完全留在开发者主机之外（与进程内混淆互补）。