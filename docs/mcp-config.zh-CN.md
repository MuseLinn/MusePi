# OMP 中的 MCP 配置

[English](mcp-config.md) | 中文

本指南说明如何为 OMP coding agent 添加、编辑和校验 MCP server。

代码中的事实来源：

- Runtime 配置类型：`packages/coding-agent/src/mcp/types.ts`
- 配置写入器：`packages/coding-agent/src/mcp/config-writer.ts`
- 加载器 + 校验：`packages/coding-agent/src/mcp/config.ts`
- 独立 `mcp.json` 发现：`packages/coding-agent/src/discovery/mcp-json.ts`
- Schema：`packages/coding-agent/src/config/mcp-schema.json`

## 推荐的配置位置

OMP 可以从多个 tool（`.claude/`、`.cursor/`、`.vscode/`、`opencode.json` 等）发现 MCP server，但对于 OMP 原生配置，通常应使用以下主要文件之一：

- 项目：`.musepi/mcp.json`
- 用户：`~/.musepi/agent/mcp.json`（当命名 profile 处于激活状态时使用 `~/.musepi/profiles/<name>/agent/mcp.json`——见 [Profiles](#profiles)）

原生 provider 也会读取 `.musepi/.mcp.json` 和 `~/.musepi/agent/.mcp.json` 以保持兼容，但 OMP 写入的是上面这些主要的 `mcp.json` 路径。

OMP 还接受项目根目录下的回退独立文件：

- `mcp.json`
- `.mcp.json`

当你想让 OMP 拥有该配置时，使用 `.musepi/mcp.json` 或 `~/.musepi/agent/mcp.json`。仅当你想使用一个其他 MCP client 也可能读取的可移植回退文件时，才使用根目录的 `mcp.json` / `.mcp.json`。

### 导入的 tool 配置

OMP 还会转换以下这些当前 tool 原生的来源：

- Claude Code：`~/.claude.json`、`~/.claude/mcp.json` 以及项目 `.claude/.mcp.json` / `.claude/mcp.json`
- Codex：`~/.codex/config.toml` 和 `.codex/config.toml`（`[mcp_servers.*]`）
- Gemini CLI：`~/.gemini/settings.json` 和 `.gemini/settings.json`
- OpenCode：`~/.config/opencode/opencode.json` 和项目根目录 `opencode.json`
- Cursor：`~/.cursor/mcp.json` 和 `.cursor/mcp.json`
- Windsurf：`~/.codeium/windsurf/mcp_config.json` 和 `.windsurf/mcp_config.json`
- VS Code：仅项目 `.vscode/mcp.json`，使用 `mcp.servers`
- 已安装的 Claude marketplace 插件以及声明了 MCP server 的 OMP extension 包

对于 Claude Code、Codex、Gemini CLI、Cursor 和 Windsurf，项目条目先于同名的用户条目被遇到——这与 OMP 原生配置一致，其项目条目先于其激活 profile 的用户条目——因此项目的 `enabled: false` 会抑制同名用户 server。OpenCode 当前先遇到用户条目。跨 provider 的优先级见 [发现与优先级](#发现与优先级)。

### Profiles

命名 profile（`musepi --profile <name>`、`--alias` 快捷方式，或 `OMP_PROFILE`/`PI_PROFILE`）隔离用户级 MCP 配置。当 profile 处于激活状态时，**用户**作用域解析为该 profile 的 agent 目录而非默认目录：

- 默认 profile：`~/.musepi/agent/mcp.json`
- Profile `<name>`：`~/.musepi/profiles/<name>/agent/mcp.json`

发现流程、`/mcp` 命令以及配置写入器都遵循激活的 profile，因此一个 profile **只能**看到它自己的用户级 server——绝不会看到默认 profile 的 `~/.musepi/agent/mcp.json`。要为某个 profile 添加 server，可在其下启动（`musepi --profile <name>`）并运行 `/mcp add` → User 级别，或直接编辑 `~/.musepi/profiles/<name>/agent/mcp.json`。

项目级 MCP 配置（`.musepi/mcp.json`）以工作目录为键，而不是以 profile 为键，因此它适用于每个 profile。外部 tool 配置（`.claude/`、`.cursor/` 等）也与 profile 无关，因为它们属于那些 tool 而非 OMP profile。

MCP 遵循与 OMP 原生配置其余部分相同的 profile 规则；见 [Configuration Discovery → Profiles](./config-usage.md#profiles)。

## 添加 schema 引用

在文件顶部添加这一行以获得编辑器自动补全和校验：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

当 `/mcp add`、`/mcp enable`、`/mcp disable`、`/mcp reauth` 或其他配置写入流程创建或更新由 OMP 管理的 MCP 文件时，OMP 现在会自动写入这一行。

## 文件结构

OMP 支持以下顶层结构：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

顶层键：

- `$schema` — 供 tooling 使用的可选 JSON Schema URL
- `mcpServers` — server 名称到 server 配置的映射
- `disabledServers` — 用户级 denylist，用于按名称关闭已发现的 server；runtime 加载会从激活 profile 的用户 MCP 文件（`~/.musepi/agent/mcp.json`，或在命名 profile 下为 `~/.musepi/profiles/<name>/agent/mcp.json`）读取此列表

Server 名称必须匹配 `^[a-zA-Z0-9_.-]{1,100}$`。

## 支持的 server 字段

每种传输共有的字段：

- `enabled?: boolean` — 为 `false` 时跳过该 server
- `timeout?: number` — MCP 请求超时（毫秒）；`0` 禁用 client 侧 MCP 超时
- `auth?: { ... }` — OMP 用于 OAuth/API-key 流程的 auth 元数据
- `oauth?: { ... }` — 在 auth/reauth 期间使用的显式 OAuth client 设置

设置 `OMP_MCP_TIMEOUT_MS=0` 可为当前进程中的每个 MCP server 禁用 client 侧超时。将其设为正的毫秒值（例如 `OMP_MCP_TIMEOUT_MS=120000`）可应用一个全局超时，而无需逐个编辑 server 条目。

### stdio 传输

当省略 `type` 时，`stdio` 是默认值。

必需：

- `command: string`

可选：

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

这遵循官方的 Filesystem MCP server 包（`@modelcontextprotocol/server-filesystem`）。

### http 传输

必需：

- `type: "http"`
- `url: string`

可选：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

这对应 GitHub 托管的 GitHub MCP server 端点。

### sse 传输

必需：

- `type: "sse"`
- `url: string`

可选：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` 仍为兼容而有效，但 MCP 规范现在对新的 server 更推荐 Streamable HTTP（`type: "http"`）。

## Auth 字段

OMP 理解两个与 auth 相关的对象。

### `auth`

```json
{
  "type": "oauth" | "apikey",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

当 OMP 应记住如何为某个 server 重建凭据时使用此对象。

通常你不需要写这个块：当 OMP 为 `http`/`sse` server 完成 OAuth 流程时，它会将凭据存储在一个由激活 profile 和 server URL 派生的确定性 id 下（`mcp_oauth:profile:<profile>:<url>`），其中内嵌了刷新材料。任何指向同一 URL 的配置——包括共享项目 `mcp.json` 中完全没有 `auth` 块的*仅定义*条目——都会自动解析激活 profile 自己的凭据，即使 auth 存储由共享 auth broker 支撑也是如此。这就是项目级 server 能跨 profile 安全使用的原因：提交定义，然后每个 profile 通过 `/mcp reauth <name>` 授权（并保持登录）自己的账户。显式提供的 `credentialId` 在可解析时仍然会被尊重；如果它指向另一个 profile 的行，OMP 会回退到以 profile 为作用域、按 URL 键控的绑定。

对仅定义条目执行 `/mcp reauth` 不会改动文件——凭据（含刷新材料）完全存放在激活 profile 的 auth 存储（本地 `agent.db` 或 broker）中，因此已提交的项目配置永远不会带上本地 auth 状态。显式配置的 `Authorization` 头总是优先于按 URL 键控的绑定。

该绑定按 profile 而非按项目：一旦某个 profile 授权了一个 URL，*任何*在其 `mcp.json` 中定义了该 URL 上 server 的 checkout 都会自动使用该 profile 的凭据连接。已提交的 MCP 定义是受信任的输入——同样的逻辑已经适用于运行任意命令的 `stdio` 条目——因此在用持有你关心的凭据的 profile 打开某个仓库的 `mcp.json` 之前请先审查，或为不受信任的 checkout 使用一个专门的 profile。

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

当 MCP server 需要显式 OAuth client 设置时使用此对象。

`prompt` 控制随授权请求发送的 OAuth `prompt` 参数。默认值为 `"consent"`，使 provider 始终显示其 consent/account 屏——否则，拥有活动浏览器会话的 provider 会静默地再次批准同一账户，导致重新授权时无法切换账户或工作区（例如为每个 OMP profile 使用不同的 Linear 工作区）。将其设为 `""` 以对拒绝该参数的 provider 省略该参数，或设为 provider 理解的另一个值（例如 `"select_account"`）。

Slack 是最清晰的当前示例。Slack 的 MCP server 托管于 `https://mcp.slack.com/mcp`，使用 Streamable HTTP，并要求使用你的 Slack app client 凭据进行 confidential OAuth。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

来自 Slack 文档的相关 Slack 端点：

- MCP 端点：`https://mcp.slack.com/mcp`
- 授权端点：`https://slack.com/oauth/v2_user/authorize`
- Token 端点：`https://slack.com/api/oauth.v2.user.access`

## 常见示例（可直接复制）

### 通过 stdio 的 Filesystem server

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### 通过 HTTP 的 GitHub 托管 server

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### 通过 Docker 的 GitHub 本地 server

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

这对应 GitHub 官方的本地 Docker 镜像 `ghcr.io/github/github-mcp-server`。

### 通过 OAuth 的 Slack 托管 server

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## 凭据与变量解析

这是通常让人困惑的部分。

### 发现阶段的 `${...}` 展开

OMP 在从 OMP 原生文件和独立回退文件发现 MCP 配置时展开 `${VAR}` 和 `${VAR:-default}` 占位符。展开会递归应用于 `command`、`args`、`env`、`cwd`、`url`、`headers`、`auth` 和 `oauth` 中的字符串值；未解析的占位符保持为字面字符串。

示例：

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

### 连接前的 env/header 解析

在 OMP 启动 stdio server 或发出 HTTP/SSE 请求之前，它会按如下方式解析 stdio `env` 值和 HTTP/SSE `headers` 值：

1. 如果某个值以 `!` 开头，OMP 会以 10s 超时运行其余部分作为 shell 命令，并使用去除头尾空白后的 stdout。
2. 如果命令失败、超时或仅输出空白，则该 `env`/`headers` 条目会被省略。
3. 否则 OMP 检查该值是否命名了一个环境变量。
4. 如果该环境变量被设置为非空值，OMP 使用环境值；否则按字面字符串使用。

示例：

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

这意味着以下写法对本地凭据有效且方便：

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → 从当前 shell 环境复制
- `"Authorization": "Bearer hardcoded-token"` → 使用字面值
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → 从命令构建 header

## `disabledServers`

当 server 从任意来源被发现且你希望 OMP 忽略它而无须编辑那个其他 tool 的配置时，`disabledServers` 从用户配置文件（`~/.musepi/agent/mcp.json`）读取。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github", "slack"]
}
```

## `/mcp add` 与直接编辑 JSON 的对比

当你想要向导式设置时使用 `/mcp add`。

在以下情况直接编辑 JSON：

- 你需要向导尚未提示的传输或 auth 选项
- 你想从另一个 MCP client 粘贴 server 定义
- 你想在编辑器中获得 schema 支撑的校验

编辑后使用：

- `/mcp reload` 重新发现并重连当前 session 中的 server
- `/mcp list` 查看某个 server 来自哪个配置文件
- `/mcp test <name>` 测试单个 server
- `/mcp reconnect <name>` 重连一个 server 而无须重新发现所有配置
- `/mcp resources`、`/mcp prompts` 和 `/mcp notifications` 检查非 tool 的 MCP 能力

## OMP 强制执行的校验规则

来自 `packages/coding-agent/src/mcp/config.ts` 中的 `validateServerConfig()`：

- `stdio` 需要 `command`
- `http` 和 `sse` 需要 `url`
- 一个 server 不能同时设置 `command` 和 `url`
- 未知的 `type` 值会被拒绝

实际含义：

- 省略 `type` 即表示 `stdio`
- 如果你粘贴一个远程 server 配置却忘了 `"type": "http"`，OMP 会将其当作 `stdio` 并抱怨缺少 `command`
- `sse` 仍为兼容而有效，但新的托管 server 通常应配置为 `http`

## 发现与优先级

OMP 不会跨文件合并重复的 server 定义。发现 provider 有优先级，优先级更高的定义胜出。另外，`~/.musepi/agent/mcp.json` 中的 `disabledServers` 可以按名称抑制已发现的 server。

实际中：

- 当你想要特定于 OMP 的覆盖时，优先使用 `.musepi/mcp.json` 或 `~/.musepi/agent/mcp.json`
- 尽可能让 server 名称跨 tool 保持唯一
- 当第三方配置不断重新引入你不想要的 server 时，在用户配置中使用 `disabledServers`

## 故障排查

### `Server "name": stdio server requires "command" field`

你很可能在远程 server 上省略了 `type: "http"`。

### `Server "name": both "command" and "url" are set`

选一种传输。OMP 将 `command` 视为 stdio，将 `url` 视为 http/sse。

### `/mcp add` 已生效但 server 仍无法连接

JSON 是有效的，但 server 可能仍无法访问。使用 `/mcp test <name>` 并检查：

- 二进制或 Docker 镜像是否存在
- 所需的环境变量是否已设置
- 远程 URL 是否可访问
- OAuth 或 API token 是否有效

### server 存在于其他 tool 的配置中但 OMP 里没有

运行 `/mcp list`。OMP 会发现许多第三方 MCP 文件，但项目级加载也可以通过 `mcp.enableProjectConfig` 设置禁用，且用户级 `disabledServers` 条目可以按名称抑制某个 server。

## 参考链接

- MCP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem server package: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP server: https://github.com/github/github-mcp-server
- Slack MCP server docs: https://docs.slack.dev/ai/slack-mcp-server/
