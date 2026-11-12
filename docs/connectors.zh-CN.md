---
layout: default
title: 连接器目录
status: living
summary: 目录来源、启用状态、MCP 投影、OAuth 复用，以及面向 agent 的只读连接器工具。
scope:
  - packages/coding-agent/src/connectors
  - packages/coding-agent/src/discovery/connector-catalog.ts
  - packages/coding-agent/src/daemon/services/connector-catalog-service.ts
  - packages/coding-agent/src/tools/connector-catalog.ts
---

# 连接器目录

[English](connectors.md) | 中文

连接器是一个可发现的远端 MCP 服务器，外加客户端渲染所需的展示与认证元数据。目录只负责发现与启用；连接、健康态与 OAuth 仍由 MCP manager 负责。这一层不保存任何 token。

## 来源

加载器按优先级读取三类来源：

1. `MUSEPI_CONNECTOR_CATALOG` — 绝对 JSON 文件路径、相对 agent 目录的路径，或 `http(s)` URL。远端索引有 10 秒超时，失败不会阻塞其他来源。
2. `<agentDir>/connectors/catalog.json` — 默认本地索引。
3. `<agentDir>/connectors/marketplace/<id>/` — 兼容 WorkBuddy 的包：`plugin.json` 加 `mcp.json`。

条目按 id 去重，索引条目优先于包条目。目录接受远端 `http`/`sse` 端点、本地 `stdio` 命令与托管 CLI 包。stdio 条目只有在用户批准该命令指纹后才会挂载；目录不安装包，命令必须已经可用（`npx`/`uvx` 或已安装的二进制）。

### 索引结构

本地 MCP 进程使用同样的条目结构，用命令替代 URL：

```json
{
  "id": "local-demo",
  "name": "Local demo",
  "server": { "type": "stdio", "command": "npx", "args": ["-y", "demo-mcp"] },
  "auth": { "mode": "none" }
}
```

托管 CLI 包声明安装/版本/认证/状态命令：

```json
{
  "id": "meeting-cli",
  "name": "Meeting CLI",
  "cli": {
    "init": { "win32": "npm install -g @scope/meeting-cli", "linux": "npm install -g @scope/meeting-cli" },
    "versionCheck": { "command": { "win32": "meeting-cli --version" }, "minVersion": "1.1.0" },
    "auth": { "win32": "meeting-cli auth login --no-browser" },
    "status": { "win32": "meeting-cli auth status" },
    "unAuth": { "win32": "meeting-cli auth logout" },
    "statusMatch": "Logged in"
  }
}
```

安装进入 `<agentDir>/cli-connectors/packages`，使用独立 npm cache；安装器只允许 `npm`/`pnpm`/`yarn`/`bun`/`uv`。`connect` 先返回 `needsApproval` 与安装/认证命令；`approve: true` 后在需要时安装、检查 `minVersion`、启动 `auth`，并返回 `flowId` 与解析出的 URL/设备码。客户端轮询 `connectors.cli.status` 直到出现 `statusMatch`，连接器随后启用；`connectors.cli.cancel` 停止认证进程。

远端索引结构：

```json
{
  "version": 1,
  "connectors": [
    {
      "id": "example",
      "name": "Example",
      "description": "卡片上显示的一句话。",
      "category": "productivity",
      "icon": "https://example.com/icon.png",
      "docsUrl": "https://example.com/docs",
      "examples": ["总结我未读的内容"],
      "server": { "type": "http", "url": "https://example.com/mcp" },
      "auth": { "mode": "oauth" }
    }
  ]
}
```

`auth.mode` 为 `oauth`（默认）、`none` 或 `token`。可选的 `oauth` 提示（`clientId`、`authorizationUrl`、`tokenUrl`、`scopes`、`callbackPort`、`callbackPath`）映射到现有 MCP OAuth 配置；省略时回退到运行时发现。`token` 条目必须声明表单 schema；值存入加密的连接器密钥库，绝不写进目录：

```json
{
  "auth": { "mode": "token" },
  "tokenSchema": {
    "title": "连接示例",
    "fields": [{ "key": "API_KEY", "label": "API 密钥", "type": "password", "required": true }],
    "header": { "name": "Authorization", "template": "Bearer ${value}" }
  }
}
```

`header` 可选；默认 `Authorization: Bearer ${value}`，`${value}` 指第一个字段，`${KEY}` 指命名字段。注入前会去掉换行。

### 包结构

包使用插件市场布局：

```
marketplace/<dir>/
  plugin.json      # name、description、version、extensions["musepi.connector"].display
  mcp.json         # mcpServers.<name>.url / .type / .headers
  ai.workbuddy/token-schema.json  # 可选；存在即选择 token 认证
  assets/icon.png  # 可选
```

`extensions["musepi.connector"].display` 可携带 `name`、`description`、`examples`、`icon`、`docsUrl`；`auth.mode` 与 `oauth` 与之并列。同时接受旧的 `extensions["ai.workbuddy"]` 键，已有包无需修改即可使用。`ai.workbuddy/` 或 `musepi.connector/` 下的 `token-schema.json` 提供表单 schema；除非 `auth.mode` 另有声明，存在该文件即按 token 认证处理。

## 启用与投影

启用状态是每个连接器一个布尔值，保存在 `<agentDir>/connectors/state.json`，原子写入且仅属主可读。这是本层唯一持有的状态。连接状态不落盘：MCP manager 是唯一能观察活动连接的组件，复制一份会让过期的 `connected` 标记比死掉的 socket 活得更久。

Token 值保存在 `<agentDir>/connectors/secrets.json`：每个连接器一个 AES-256-GCM 信封，密钥由 `<agentDir>/connectors/.master.key` 的 32 字节主密钥经 HKDF-SHA256 派生（托管部署可用 `MUSEPI_CONNECTOR_MASTER_KEY`）。文件不含明文；解密失败时保持文件不变并把连接器视为未配置；`disconnect` 会删除对应条目。

OAuth 授权仍落在 AuthStorage。MCP 客户端拥有的行（`mcp_oauth:` 与旧前缀 `mcp_oauth_`）在 `agent.db` 中加密：`data` 列保留标记与明文哈希供 compare-and-swap 刷新使用，密文放在 `secret` 列，密钥位于数据库旁的 `mcp-oauth.key`（或 `MUSEPI_MCP_OAUTH_KEY`）。其他供应商在各自迁移设计完成前保持原有存储路径。

`connector-catalog` 发现 provider（priority 40）把每个已启用条目投影为名为 `connector:<id>` 的规范 MCP 服务器。该命名空间避免目录条目遮蔽手写的 `mcp.json` 服务器，也让 `/mcp` 输出能区分两者。声明了静态 header 时标记为 `origin-locked`；凭据由 auth storage 按服务器 URL 解析。

## RPC 面

| 路由 | 行为 |
| --- | --- |
| `connectors.catalog.list` | 目录行，带启用状态与实时 `connected` / `connecting` / `disconnected`；可选 `query`。 |
| `connectors.catalog.detail` | 单行及其 OAuth 提示。 |
| `connectors.catalog.refresh` | 丢弃 5 秒目录缓存并重新扫描所有来源。 |
| `connectors.connect` | 启用一个连接器，重载 manager，返回 `{ serverName, needsAuth, status }`；stdio 条目在带 `approve: true` 调用前返回 `{ needsApproval, command, args, envKeys }`。 |
| `connectors.disconnect` | 禁用一个连接器并重载。 |
| `connectors.setEnabled` | 对上述两个操作的显式开关。 |
| `connectors.token.save` | 按 schema 校验 Token 表单值，合并进加密库，并要求所有必填字段。空值保留已存值。 |
| `connectors.cli.status` | 为待授权流程运行 CLI `status` 命令；`success` 时启用连接器。 |
| `connectors.cli.cancel` | 停止认证进程并忘记该流程。 |
| `mcp.servers.probe` | 握手后立即释放，不进入任何会话、不缓存。带 `url`/`command` 时按 `add` 的同一套输入校验；只给 `name`（可带 `cwd`/`sessionId`）时，先解析用户 `mcp.json`、再读该工作区 live manager 的配置，经 `prepareConfig` 注入已存凭据后连接。返回 `{ ok, serverInfo?, toolNames?, resourceCount?, promptCount?, error? }`；缺少 live manager 时返回明确的失败原因，绝不降级成无凭据重试。 |

`connect` 不启动 OAuth。当 `needsAuth` 为真时，客户端用返回的服务器名调用现有的 `mcp.oauth.start`；授权落在 auth storage，manager 随后重连。桌面端还会传 `redirectUri: musepi://oauth/callback`：Electron shell 注册 `musepi://`，把 URL 转给渲染器，渲染器再调 `mcp.oauth.callback`。state 与 PKCE 在 flow 内校验，因此其他应用唤起该协议也无法完成授权。当 `needsTokenConfig` 为真时，连接器不会被启用，客户端显示 Token 表单，经 `connectors.token.save` 保存后再次调用 `connect`。这样手写服务器与目录连接器共用一套 OAuth 实现和一套凭据存储。

## 安全边界

- 线上目录行不包含 `headers`；不返回 token、client secret 或凭据 id。
- 携带凭据的静态 header（`Authorization`、`Cookie`、`X-Api-Key` 等）会被丢弃并告警；目录无法通过包元数据偷带 token。
- Token 值加密落盘且从不返回；`connectors.catalog.list` 只暴露 schema 与 `tokenSet` 布尔值。
- 本地命令绝不会仅凭元数据挂载：`connect` 返回 `needsApproval` 与确切命令/参数及环境变量名（CLI 连接器展示安装/认证命令），只有 `connect { approve: true }` 才写入已批准指纹。命令变化会使批准失效。
- CLI 安装器限制为已知包管理器并在隔离 prefix 中运行。命令先分词再以 argv 启动；Windows 上裸命令名按 `PATH`/`PATHEXT` 解析，`.cmd`/`.bat` 垫片（npm 及其安装的 CLI 就是这种形态）经 `cmd.exe` 以 verbatim 命令行执行，因为批处理文件无法被直接 spawn。
- 静态 header 锁定到配置的 URL 源。
- 损坏的来源降级为其余来源并给出警告，不会让全部 MCP 发现失败。
- 启用连接器是用户动作。agent 工具只读，不能写状态。

## Agent 面

`connector_catalog` 是只读内置工具，提供 `list`、`search`、`detail` 三个动作。它读取同一份加载器与状态文件，返回展示元数据与启用状态，绝不返回端点 header 或凭据。其模型侧提示词（`packages/coding-agent/src/prompts/tools/connector-catalog.md`）要求模型只从真实行推荐、不臆造 id，并把启用与 OAuth 留给连接器 UI。

## 不在范围内

企业注册表、连接器间 token 注入不在范围内。

## 实现

- `packages/coding-agent/src/connectors/types.ts`
- `packages/coding-agent/src/connectors/catalog.ts`
- `packages/coding-agent/src/connectors/state.ts`
- `packages/coding-agent/src/connectors/runtime.ts`
- `packages/coding-agent/src/connectors/secrets.ts`
- `packages/coding-agent/src/discovery/connector-catalog.ts`
- `packages/coding-agent/src/daemon/services/connector-catalog-service.ts`
- `packages/coding-agent/src/tools/connector-catalog.ts`
