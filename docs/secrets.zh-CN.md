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

| 工具             | 输入                       | 返回                                                     |
| ---------------- | -------------------------- | -------------------------------------------------------- |
| `request_secret` | `name`、`purpose`、`delivery?` | 环境变量名或私有文件路径，以及状态；永不包含值        |
| `list_secrets`   | 无                         | 名字、用途、scope、交付方式与可用性；永不包含值         |

`name` 必须匹配 `/^[A-Z][A-Z0-9_]{0,63}$/`。只有值可解密、且 scope 覆盖当前会话的工作目录时，才立即返回。值已保存但只属于其他工作目录时，会推送 `kind:"allow"` 卡片：允许后把当前工作目录加入 scope，不必重新输入值。名字缺失或值不可解密时推送 `kind:"fill"`。`delivery` 默认 `"env"`；`"file"` 用于需要文件路径的命令（证书、kubeconfig、service-account JSON）。已存条目保留保存时的交付方式。卡片十分钟无应答按取消处理。交互式收集要求宿主实现 `requestSecret` UI 通道（daemon 的 approval bridge）；无头/TUI 宿主会返回错误，提示用户到「设置 → 智能体 → 保险库」添加。

### 存储

```
<agentDir>/agent-secrets/
  secrets.json          # 每个名字一个 AES-256-GCM 信封（仅值）
  metadata.json         # name、purpose、scope、delivery、时间戳（0600，原子写）
  .master.key           # 每 profile 主密钥（0600）——明文形态
  .master.key.wrapped   # 同一把主密钥、由口令包裹（0600）——受保护形态
  files/                # file 交付的工作副本（0700；每个文件 0600）
```

存储恒为加密，不提供明文模式。值是以 profile 主密钥经 HKDF 派生的 AES-256-GCM 信封，复用 connector vault 的信封实现。元数据 sidecar 不含值，加密文件同样不含值。

`scope` 为 `"all"` 或一组绝对工作目录根。根覆盖自己的子目录；Windows 上比较不区分大小写。无法识别的已存值会收窄为空列表（任何会话都不可用），绝不放宽为 `"all"`。不带新选择地替换值时保留原 scope。

### 口令保护

主密钥只有两种形态之一：明文 `0600` 文件，或被用户口令包裹的同一把主密钥。「设置 → 智能体 → 保险库」显示当前形态并可在两者间切换；对应的 daemon 方法是 `secret.encrypt`、`secret.decrypt` 与 `secret.unlock`。

`secret.encrypt` 用 scrypt（N=2^15、r=8、p=1）在 16 字节随机盐上派生密钥加密密钥，再用 AES-256-GCM（AAD `musepi-agent-master-key v1`）包裹 32 字节主密钥，写出 `.master.key.wrapped` 并删除 `.master.key`。已有信封不会重写：主密钥本身没有变，变的只是它的存放形式。

存在包裹文件而本进程拿不到口令时，保险库处于**锁定**状态：读取一律报告无可用值，写入失败，`secret.status` 返回 `protectedBy: "passphrase"`、`locked: true` 以及原因（`missing-passphrase`、`wrong-passphrase` 或 `passphrase-source`）。元数据仍可读，因此设置页仍能列出已存条目。解锁从不把密钥写回磁盘：`secret.unlock` 把解包后的主密钥留在本进程内存里，把刚变得可读的值注册进每个活跃会话的 obfuscator，包裹文件保持不变。`secret.decrypt` 验证口令后恢复 `.master.key` 并删除包裹文件。

无人值守启动可把口令放在 `MUSEPI_AGENT_SECRET_PASSPHRASE`，或放在 `MUSEPI_AGENT_SECRET_PASSPHRASE_FILE` 指向的文件里（尾部一个换行会被去掉）。`MUSEPI_AGENT_SECRET_KEY` 的优先级仍高于这三者：设置了它的部署会按设计绕过口令。

### Bash 注入

每个可解密、交付方式为 **`env`** 且 scope 覆盖当前会话工作目录的条目，都会以 `MUSEPI_SECRET_<NAME>` 进入每个 bash 子进程。`file` 条目**不会**进入环境变量：值写到 `agent-secrets/files/<NAME>`（目录 0700、文件 0600，适用于有 POSIX 权限的平台），工具结果给出该路径。值只存在于该子进程的环境里：

- 从不修改 `process.env`。
- 模型通过 `env` 参数传入同名变量时，已存储的值会覆盖它。
- 工具输出（前台结果、超时/取消错误、流式分块、异步作业文本、ACP 终端轮询）会把值替换为 `[secret:NAME]`。原值、JSON 转义形态与 URL 编码形态都会被替换，因此出现在查询串或 JSON 文档里的令牌同样不会留存。流式分块按累计 tail 脱敏，因此被切成两半的值仍会被替换。
- 命令打印该变量时，`[secret:NAME]` 是预期的脱敏标记，不是命令失败；模型会被告知不要因此重试或报错。
- `secrets.bashInjection` 默认 `"all"`。设为 `"referenced"` 时，只有命令文本里出现 `MUSEPI_SECRET_<NAME>` 的条目会进入子进程环境；脱敏仍覆盖全部已存值，因此从文件读取其他值的命令同样会被清洗。

### Provider 边界

会话启动时，已存储的 Agent 密钥以 plain、obfuscate 模式条目加入会话的 `SecretObfuscator`，`friendlyName` 为密钥名；每个值同时以原值、JSON 转义形态与 URL 编码形态加入，因此编码后的副本也不会到达 provider。短于 8 个字符的值以单向、整词替换加入，而不是可逆占位符。会话中途保存时，值会立即注册进每个活跃会话的 obfuscator，包括启动时存储为空、由这次保存第一次写入密钥的那个会话。因此 provider 请求只会携带可逆占位符（如 `#GITHUBTOKEN_AB12:L#`），永不携带值。

Agent 密钥**始终**受覆盖：用户在安全检查卡中显式保存的值，与通用扫描特性是两份不同的授权。即使 `secrets.enabled=false`，会话也会构建 Agent 密钥 obfuscator。该开关只控制通用来源（环境变量扫描、`secrets.yml`、内置凭据模式）；关闭时这些来源不注册，但 Agent 卡片保存的值仍然注册。

### 本地写入

记忆写入会把文本原样落盘，因此每个已存 Agent 密钥都会把原值、JSON 转义形态与 URL 编码形态注册进精确值守卫；即使启发式漏掉一个很短、不显眼的值，`redactMemorySecrets` 也会把它替换成 `[REDACTED]`。注册在进程生命周期内有效，所以删掉密钥并不会停止清洗已经写进记忆文件的值。

### MCP 配置引用

MCP server 的 `env` 或 `headers` 值可以整个写成 `${vault:NAME}`。连接时 daemon 会按该 server 的工作区读取条目，因此配置文件永不包含值；条目缺失、不可解密或不在范围内时，该 env/header 会被省略。这是让 MCP 使用保险库值、而不把值写进 `mcp.json` 或进程环境的路径。

### Daemon RPC

| RPC              | 参数                                             | 结果                                       |
| ---------------- | ------------------------------------------------ | ------------------------------------------ |
| `secret.status`  | `{}`                                             | `{ mode, count, protectedBy?, locked?, reason? }` |
| `secret.list`    | `{}`                                             | `{ entries: SecretEntryView[], count }`    |
| `secret.set`     | `{ name, value, purpose?, scope?: "all" \| "workspace", delivery?: "env" \| "file" }` | `{ entry }`  |
| `secret.update`  | `{ name, scope: "all" }`                         | `{ entry }`                                |
| `secret.delete`  | `{ name }`                                       | `{ ok: true }`（幂等）                     |
| `secret.answer`  | `{ requestId, action, value?, scope?: "all" \| "workspace", delivery?: "env" \| "file" }` | `{ ok: true }` |
| `secret.unlock`  | `{ passphrase }`                                 | `SecretStatus`                             |
| `secret.encrypt` | `{ passphrase }`                                 | `SecretStatus`                             |
| `secret.decrypt` | `{ passphrase }`                                 | `SecretStatus`                             |

`SecretEntryView` 中的时间戳是 epoch 毫秒。`secret.answer` 在 daemon 内先落盘再落定工具的 promise，因此工具只看得到最终动作。`"workspace"` 会解析为待决请求所属会话的工作目录；`secret.set` 不接受它（设置页没有会话上下文），`secret.update` 只把收窄的条目放宽为 `"all"`。未知或已过期的 request id 会报 `Unknown secret request: <id>`。任何响应、推送、日志或 transcript 都不包含值。口令同样不会出现在结果与错误里：口令错误与包裹文件损坏时 `secret.unlock` 返回同一句话，长度限定 8–1024 个字符。

### 已知限制

- 值至少 4 个字符。短于 8 个字符的值使用单向 marker，且只在独立出现时替换（两侧没有字母或数字）：它在显示上下文里不会被还原，出现在更长单词内部时会有意保留。低于 4 个字符会被拒绝。
- scope 为 `"all"` 或工作目录。任何不在已覆盖根之内的会话都会收到 allow 卡片；若要再次收窄，只能以「仅本工作区」重新保存，因为设置页只提供放宽。
- `file` 交付的工作副本会一直保留到条目被删除或替换；暂无按文件计的 TTL。它是普通的「仅本人可读」文件，管理员或同一用户下的其他进程可以读取。值按 UTF-8 文本写入，证书与 JSON 可用，二进制内容不支持。
- 保险库不参与会话导出与工作区文件操作，但 profile 备份或目录同步会把 `agent-secrets/` 连同 `.master.key` 或 `.master.key.wrapped` 原样复制。包裹文件离开口令不可用，因此请把 profile 与口令分开备份。目前没有主密钥轮换，也没有重新包裹：更换口令需要先解密、再以新口令加密，忘记口令则无法恢复。
- 解锁是按进程、只在内存中生效的。同一 agent 目录上的另一个进程（第二个 daemon、一次 TUI 运行）会重新处于锁定；应用重启也会再次询问口令，除非口令来自环境变量。该进程一旦解锁，bash 注入立即可用，不需要重启。
- 信封无法解密的条目仍会列为不可用。通过 `request_secret` 或「设置 → 智能体 → 保险库」重新保存该值来修复；不要手工编辑 sidecar。
- 删除密钥会从磁盘和未来的 bash 注入中移除它，但运行中会话里已经存活的 obfuscator 会在该会话生命周期内继续替换这个旧值。这是有意为之：撤掉覆盖可能让已经出现过的值重新对 provider 可见。
- Bash 的原始输出 artifact 由执行器在输出清洗之前写入，因此回显了值的命令可能把值留在该本地 artifact 文件里。值不会进入工具结果；若该 artifact 被读回模型上下文，provider 边界混淆（对 Agent 密钥始终生效）仍会替换它。
- 信封与元数据是两次独立的原子写。两者之间崩溃可能留下孤儿加密值（不可见、无害），或留下一个已列出但值缺失的名字（显示为不可用）。

## 关键文件

- `packages/coding-agent/src/secrets/index.ts` -- 加载、合并、环境变量收集
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` 类、占位符生成、消息混淆
- `packages/coding-agent/src/secrets/regex.ts` -- 正则字面量解析与编译
- `packages/coding-agent/src/secrets/agent-store.ts` -- 加密的 Agent 密钥存储、元数据 sidecar、校验
- `packages/coding-agent/src/secrets/encrypted-store.ts` -- 信封加密、主密钥文件与口令包裹
- `packages/coding-agent/src/secrets/agent-runtime.ts` -- 会话加载、动态 obfuscator 注册、bash 环境与输出清洗
- `packages/coding-agent/src/tools/request-secret.ts` -- 交互式密钥卡片工具
- `packages/coding-agent/src/tools/list-secrets.ts` -- 只读元数据的列表工具
- `packages/coding-agent/src/daemon/services/secret-service.ts` -- `secret.*` RPC 实现
- `packages/coding-agent/src/daemon/approval-bridge.ts` -- 密钥卡片 pending 表、超时与结算
- `packages/wire/src/secret.ts` -- daemon/GUI 密钥契约
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` 设置定义

## 参见

- [`auth-broker-gateway.md`](./auth-broker-gateway.html) -- 远端凭据保险库与转发代理，把 provider OAuth 刷新令牌与访问令牌完全留在开发者主机之外（与进程内混淆互补）。