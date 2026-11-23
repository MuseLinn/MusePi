# 连接 MCP server

MCP server 通过 `musepi-mcp-client` 插件包声明，**一行配置一条连接**：它的工具以 `mcp__<serverName>__<tool>` 进入当前会话的工具面，并随插件卸载断开。

## 字段

| 字段 | 说明 |
| --- | --- |
| `serverName` | 决定工具前缀；同一会话内唯一 |
| `transport` | `stdio` / `http` / `sse` |
| `command` | `stdio`：可执行文件 |
| `args` | `stdio`：参数数组，如 `["-y","@modelcontextprotocol/server-github"]` |
| `env` | `stdio`：子进程环境变量 |
| `cwd` | `stdio`：子进程工作目录；缺省为会话项目目录 |
| `url` | `http` / `sse`：端点 |
| `headers` | `http` / `sse`：请求头 |
| `timeout` | 连接超时 |
| `enabled` | 关掉后保留配置、断开连接 |

## 连接

在工作区或 `~/.musepi/plugins/<name>/` 建一个包，`package.json` 的 `musepi.extensions` 指向本包入口，`config` 声明上表字段，字段值写你要连的 server。然后在插件页启用，或让用户在插件页启用。

## 验证

连上后调用一个 `mcp__<serverName>__<tool>`，确认工具出现在工具面并且能返回结果。仅仅「配置写完了」不算连上。

工具没出现时按顺序查：`enabled` 是否为真、`transport` 与 `url`/`command` 是否匹配、超时是否过短、子进程是否真的能启动。

## 凭据

不要把手上的密钥抄进对话或仓库。运行时凭据走环境变量（`env`）或用户已有的凭据存储（`request_secret` / `list_secrets`），由宿主注入。

`env` 与 `headers` 里出现明文密钥时，它会跟着配置落盘——这对本地个人环境可以接受，对共享项目目录不行。分不清场景时先问用户。