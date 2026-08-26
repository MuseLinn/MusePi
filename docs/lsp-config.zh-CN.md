# LSP 配置


[English](lsp-config.md) | 中文
本指南说明如何为 OMP coding agent 配置 language server。

代码中的事实来源:

- Server config type:`packages/coding-agent/src/lsp/types.ts`（`ServerConfig`）
- Config loader:`packages/coding-agent/src/lsp/config.ts`
- 内置 server 定义:`packages/coding-agent/src/lsp/defaults.json`

## 自动检测

当不存在 LSP config 文件时，OMP 通过对两个条件的交集进行自动检测:

1. 项目目录包含该 server 的至少一个 `rootMarkers`。
2. 该 server 二进制文件可用——先检查项目本地 bin 目录（例如 `node_modules/.bin/`、`.venv/bin/`），然后检查 `$PATH`。

常见配置无需手动配置。内置 server 列表覆盖大多数主流语言；完整集合见 [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json)。

## 配置文件位置

OMP 从多个文件合并 LSP 配置，从低到高优先级:

| 优先级 | 位置                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 5（最低） | `~/lsp.json`、`~/.lsp.json`、`~/lsp.yaml`、`~/.lsp.yaml`、`~/lsp.yml`、`~/.lsp.yml`                                       |
| 4      | Plugin LSP configs（marketplace / `--plugin-dir` roots）                                                                 |
| 3      | 用户配置目录:`~/.musepi/agent/lsp.*`、`~/.claude/lsp.*`、`~/.codex/lsp.*`、`~/.gemini/lsp.*`                                |
| 2      | 项目配置目录:`<project>/.musepi/lsp.*`、`<project>/.claude/lsp.*`、`<project>/.codex/lsp.*`、`<project>/.gemini/lsp.*`       |
| 1（最高） | 项目根目录:`<project>/lsp.*` 和 `<project>/.lsp.*`                                                                      |

每个位置都接受 `.json`、`.yaml` 和 `.yml` 变体，包括隐藏文件版本（`.lsp.json`、`.lsp.yaml`、`.lsp.yml`）。文件按顺序合并:更高优先级的文件对同一 server 覆盖更低优先级的字段。在任何 override 文件中都未提到的 server 保持其内置默认值。

**推荐位置:**

- 用户级偏好 → `~/.musepi/agent/lsp.json`
- 项目特定 override → `<project>/.musepi/lsp.json`

> **注意:** 仅当至少一个配置文件贡献 server overrides 时，才会跳过自动检测。只设置 `idleTimeoutMs` 的配置文件仍允许 OMP 自动检测内置 servers。当存在 server overrides 时，OMP 将它们与 defaults 合并，然后加载具有匹配 `rootMarkers`、可用二进制文件且未显式 `disabled` 的 servers。

## 文件结构

JSON 和 YAML 都被接受。顶层对象可以使用 `servers` 包装键，也可以直接使用 flat map:

```json
{
  "servers": {
    "server-name": { ... }
  },
  "idleTimeoutMs": 300000
}
```

或（flat，不带 `servers` 包装）:

```json
{
  "server-name": { ... },
  "idleTimeoutMs": 300000
}
```

顶层键:

- `servers` — server 名称到 `ServerConfig` 的映射（可选包装；flat 形式等价）
- `idleTimeoutMs` — 在指定毫秒数后关闭空闲 language server；默认禁用

## ServerConfig 字段

| 字段             | 类型       | 必填 | 描述                                                                                                      |
| ---------------- | ---------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `command`        | `string`   | 是   | 二进制名称（通过 PATH/local bins 解析）或绝对路径                                                         |
| `args`           | `string[]` | 否   | 传递给二进制的参数                                                                                        |
| `fileTypes`      | `string[]` | 是   | 该 server 处理的文件扩展名，例如 `[".ts", ".tsx"]`                                                         |
| `rootMarkers`    | `string[]` | 是   | 指示项目根目录的文件/目录；支持 glob 模式（例如 `*.cabal`）                                               |
| `initOptions`    | `object`   | 否   | 在 LSP 握手期间作为 `initializationOptions` 发送                                                          |
| `settings`       | `object`   | 否   | 通过 `workspace/didChangeConfiguration` 推送的 workspace 设置                                              |
| `disabled`       | `boolean`  | 否   | 设为 `true` 以完全禁用该 server                                                                          |
| `warmupTimeoutMs`| `number`   | 否   | 该 server 的启动超时（毫秒）；覆盖全局默认值                                                              |
| `isLinter`       | `boolean`  | 否   | 将 server 标记为仅 linter/formatter；从 type-intelligence 操作（hover、go-to-definition 等）中排除           |
| `capabilities`   | `object`   | 否   | 按 server 开启的可选特性；见 [Capabilities](#capabilities)                                                |

`resolvedCommand` 会在运行时自动填充——不要手动设置。

### Capabilities

`capabilities` 对象启用 OMP 按 server 支持的可选特性:

```json
{
  "capabilities": {
    "flycheck": true,
    "ssr": true,
    "expandMacro": true,
    "runnables": true,
    "relatedTests": true
  }
}
```

所有字段都是布尔值且可选。目前仅 `rust-analyzer` 使用它们。

## 常见做法

### 覆盖内置 server 的设置

部分覆盖会合并到内置默认值上。你只需指定要更改的字段。

```json
{
  "servers": {
    "typescript-language-server": {
      "args": ["--stdio", "--log-level", "4"]
    }
  }
}
```

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

### 禁用内置 server

```json
{
  "servers": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### 注册自定义 server

新 server 需要 `command`、`fileTypes` 和 `rootMarkers`。所有其他字段都是可选的。

```json
{
  "servers": {
    "my-lsp": {
      "command": "my-lsp-server",
      "args": ["--stdio"],
      "fileTypes": [".xyz"],
      "rootMarkers": [".xyz-project", ".git"]
    }
  }
}
```

### 设置全局空闲超时

关闭空闲超过五分钟的 language server:

```json
{
  "idleTimeoutMs": 300000
}
```

### 在单个项目中禁用 server，全局保留

将 override 放在 `<project>/.musepi/lsp.json`:

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

`~/.musepi/agent/lsp.json` 中的用户级配置不受影响；pylsp 仅在这个项目中被抑制。

## 内置 server 列表

以下 servers 包含在 `defaults.json` 中，并且符合自动检测条件:

| Server key                    | 语言                              | Binary                            |
| ----------------------------- | --------------------------------- | --------------------------------- |
| `rust-analyzer`               | Rust                              | `rust-analyzer`                   |
| `clangd`                      | C, C++, ObjC                      | `clangd`                          |
| `zls`                         | Zig                               | `zls`                             |
| `gopls`                       | Go                                | `gopls`                           |
| `typescript-language-server`  | TypeScript, JavaScript            | `typescript-language-server`      |
| `denols`                      | TypeScript, JavaScript (Deno)     | `deno`                            |
| `biome`                       | TS/JS/JSON（linter）              | `biome`                           |
| `eslint`                      | TS/JS/Vue/Svelte（linter）        | `vscode-eslint-language-server`   |
| `vscode-html-language-server` | HTML                              | `vscode-html-language-server`     |
| `vscode-css-language-server`  | CSS, SCSS, Less                   | `vscode-css-language-server`      |
| `vscode-json-language-server` | JSON                              | `vscode-json-language-server`     |
| `tailwindcss`                 | HTML, CSS, TS/JS                  | `tailwindcss-language-server`     |
| `svelte`                      | Svelte                            | `svelteserver`                    |
| `vue-language-server`         | Vue                               | `vue-language-server`             |
| `astro`                       | Astro                             | `astro-ls`                        |
| `pyright`                     | Python                            | `pyright-langserver`              |
| `basedpyright`                | Python                            | `basedpyright-langserver`         |
| `pylsp`                       | Python                            | `pylsp`                           |
| `ruff`                        | Python（linter）                  | `ruff`                            |
| `jdtls`                       | Java                              | `jdtls`                           |
| `kotlin-lsp`                  | Kotlin                            | `kotlin-lsp`                      |
| `metals`                      | Scala                             | `metals`                          |
| `hls`                         | Haskell                           | `haskell-language-server-wrapper` |
| `ocamllsp`                    | OCaml                             | `ocamllsp`                        |
| `elixirls`                    | Elixir                            | `elixir-ls`                       |
| `expert`                      | Elixir                            | `expert`                          |
| `erlangls`                    | Erlang                            | `erlang_ls`                       |
| `gleam`                       | Gleam                             | `gleam`                           |
| `solargraph`                  | Ruby                              | `solargraph`                      |
| `ruby-lsp`                    | Ruby                              | `ruby-lsp`                        |
| `rubocop`                     | Ruby（linter）                    | `rubocop`                         |
| `bashls`                      | Bash, Zsh                         | `bash-language-server`            |
| `lua-language-server`         | Lua                               | `lua-language-server`             |
| `intelephense`                | PHP                               | `intelephense`                    |
| `phpactor`                    | PHP                               | `phpactor`                        |
| `omnisharp`                   | C#                                | `omnisharp`                       |
| `yamlls`                      | YAML                              | `yaml-language-server`            |
| `terraformls`                 | Terraform                         | `terraform-ls`                    |
| `dockerls`                    | Dockerfile                        | `docker-langserver`               |
| `helm-ls`                     | Helm                              | `helm_ls`                         |
| `nixd`                        | Nix                               | `nixd`                            |
| `nil`                         | Nix                               | `nil`                             |
| `ols`                         | Odin                              | `ols`                             |
| `dartls`                      | Dart                              | `dart`                            |
| `marksman`                    | Markdown                          | `marksman`                        |
| `texlab`                      | LaTeX                             | `texlab`                          |
| `graphql`                     | GraphQL                           | `graphql-lsp`                     |
| `prismals`                    | Prisma                            | `prisma-language-server`          |
| `vimls`                       | Vim script                        | `vim-language-server`             |
| `emmet-language-server`       | HTML, CSS, JSX                    | `emmet-language-server`           |
| `sourcekit-lsp`               | Swift                             | `sourcekit-lsp`                   |
| `swiftlint`                   | Swift（linter）                   | `swiftlint`                       |
| `tlaplus`                     | TLA+                              | `tlapm_lsp`                       |
