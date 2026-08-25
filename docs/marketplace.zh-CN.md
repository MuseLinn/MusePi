# Marketplace 插件系统

[English](marketplace.md) | 中文

marketplace 系统让你能够从 Git、本地或直接目录源（direct-catalog sources）发现、安装和管理插件。它与 Claude Code plugin registry 格式兼容。

## 快速开始

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

在 TUI 中，不带参数执行 `/marketplace` 会打开交互式插件浏览器。在非 TUI 命令处理中，`/marketplace` 列出已配置的 marketplace；使用 `/marketplace discover` 来浏览。

## 概念

**marketplace** 是一个 Git 仓库（或本地目录），其中在 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容后备）存放 catalog 文件。catalog 列出可用插件及其来源、描述和元数据。

**plugin** 是一个目录，包含 Claude/OMP 插件内容，如 skills、commands、agents、hooks、tools、MCP servers 或 LSP servers。Marketplace 安装还会加载由 `package.json` 的 `omp.extensions` 声明的扩展模块：安装时把缓存的插件符号链接到 scope 的 `node_modules` 树，并将其记录在 `musepi-plugins.lock.json` 中——这与 npm 安装及 `musepi plugin link` 的插件所用的运行时表面相同。插件以 `name@marketplace` 标识（例如 `code-review@claude-plugins-official`）。

**Scopes**（作用域）：marketplace 插件可以安装到两个作用域：

- **user**（默认）—— 在所有项目中可用，存储于 `~/.musepi/plugins/installed_plugins.json`
- **project** —— 仅在当前活动项目中可用，存储于最近的项目 `.musepi/plugins/installed_plugins.json`

已启用的 project 作用域安装会遮蔽同一插件的已启用 user 作用域安装。已禁用的 project 安装不会遮蔽 user 安装。

## 命令

### 交互模式

| 命令        | 效果                                       |
| ----------- | ------------------------------------------ |
| `/marketplace` | 打开交互式插件浏览器（安装）             |

### Marketplace 管理

| 命令                         | 效果                                          |
| ---------------------------- | --------------------------------------------- |
| `/marketplace add <source>`  | 添加一个 marketplace 来源                    |
| `/marketplace remove <name>` | 移除一个 marketplace                          |
| `/marketplace update [name]` | 重新拉取 catalog；省略 name 则更新全部         |
| `/marketplace list`          | 列出已配置的 marketplaces                       |

### 插件操作

| 命令                                                                     | 效果                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| `/marketplace discover [marketplace]`                                    | 浏览可用插件                                     |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | 安装一个插件                                   |
| `/marketplace uninstall [--scope user\|project] name@marketplace`        | 卸载一个插件；不带参数时打开 TUI 选择器           |
| `/marketplace installed`                                                 | 列出已安装的 marketplace 插件                   |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]`        | 升级一个或全部插件                               |
| `/plugins list`                                                          | 列出 npm/link 与 marketplace 插件               |
| `/plugins enable [--scope user\|project] name@marketplace`               | 启用一个 marketplace 插件                       |
| `/plugins disable [--scope user\|project] name@marketplace`              | 禁用一个 marketplace 插件                       |

### CLI 等价命令

同样的操作也可以在命令行中使用：

```
musepi plugin marketplace add <source>
musepi plugin marketplace remove <name>
musepi plugin marketplace update [name]
musepi plugin marketplace list
musepi plugin discover [marketplace]
musepi plugin install [--force] [--scope user|project] name@marketplace
musepi plugin uninstall [--scope user|project] name@marketplace
musepi plugin upgrade [--scope user|project] [name@marketplace]
musepi plugin enable [--scope user|project] name@marketplace
musepi plugin disable [--scope user|project] name@marketplace
```

## Marketplace 来源

当你运行 `/marketplace add <source>` 时，系统会对来源进行分类：

| 来源格式                            | 类型                                      | 示例                                |
| ----------------------------------- | ----------------------------------------- | ----------------------------------- |
| `owner/repo`                        | GitHub 简写                               | `anthropics/claude-plugins-official` |
| `https://...*.json`                 | 直接 catalog URL                          | `https://example.com/marketplace.json` |
| `https://...` / `http://...`        | Git 仓库，除非 URL 路径以 `.json` 结尾     | `https://github.com/org/repo`        |
| `git@...` / `ssh://...`             | Git 仓库                                  | `git@github.com:org/repo.git`        |
| `./path` 或 `~/path` 或 `/path`     | 本地目录                                  | `./my-marketplace`                   |

Git 和本地来源必须在 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容后备）中提供 catalog。直接 catalog URL 只缓存 JSON catalog；URL 来源 catalog 中的插件不能使用像 `"./plugins/foo"` 这样的相对字符串来源。

## Catalog 格式（marketplace.json）

marketplace catalog 位于仓库根目录的 `.omp-plugin/marketplace.json`。当 musepi 是唯一预期的消费者时，优先使用此路径。若要继续兼容 Claude Code（musepi 从任一路径加载相同结构），请改为发布到 `.claude-plugin/marketplace.json`——当 `.omp-plugin/marketplace.json` 不存在时，musepi 会将其用作后备。仓库可以同时提供两个：musepi 读取 `.omp-plugin/` 副本，Claude Code 读取 `.claude-plugin/` 副本。两种路径的 catalog 格式相同：

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "metadata": {
    "description": "A collection of plugins",
    "version": "1.0.0",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### 必需字段

| 字段         | 描述                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `name`       | marketplace 名称。小写字母数字、连字符和点。必须以字母数字开头和结尾。最多 64 个字符。               |
| `owner.name` | marketplace 所有者名称                                                                            |
| `plugins`    | 插件条目数组                                                                                       |

顶层 `metadata.description`、`metadata.version` 和 `metadata.pluginRoot` 是可选的。当设置了 `metadata.pluginRoot` 时，它会前置到相对的插件 `source` 路径。

### 插件条目字段

| 字段         | 必需 | 描述                                                                                    |
| ------------ | ---- | --------------------------------------------------------------------------------------- |
| `name`       | 是   | 插件名称（规则与 marketplace 名称相同）                                                  |
| `source`     | 是   | 插件在哪里（见下文）                                                                     |
| `description`| 否   | 简短描述                                                                                 |
| `version`    | 否   | 版本字符串；安装版本依次回退到插件 manifest、来源 SHA，然后是 `0.0.0`                    |
| `author`     | 否   | `{ name, email? }`                                                                       |
| `homepage`   | 否   | URL                                                                                      |
| `repository` | 否   | 仓库 URL/字符串                                                                          |
| `license`    | 否   | 许可证字符串                                                                             |
| `keywords`   | 否   | 字符串关键字数组                                                                         |
| `category`   | 否   | 类别字符串（例如 `development`、`productivity`、`security`）                              |
| `tags`       | 否   | 字符串标签数组                                                                           |
| `strict`     | 否   | 布尔值                                                                                   |
| `commands`   | 否   | 提供的斜杠命令                                                                           |
| `agents`     | 否   | 提供的 agents                                                                            |
| `hooks`      | 否   | Hook 定义                                                                                |
| `mcpServers` | 否   | MCP server 定义                                                                          |
| `lspServers` | 否   | LSP server 定义或路径；安装时复制到 `.lsp.json`                                          |

### 插件来源格式

`source` 字段支持以下格式。字符串来源必须以 `./` 开头，并在可选的 `metadata.pluginRoot` 前置之后、在 marketplace 根目录内解析：

**相对路径**（在 marketplace 仓库内）：

```json
"source": "./my-plugin"
```

**Git 仓库 URL**：

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub 简写**：

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git 子目录**（monorepo）：

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm 包**（可解析但尚不可安装）：

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

当前的安装器行为会用 `npm plugin sources are not yet supported` 拒绝 npm marketplace 来源；请使用 relative、GitHub、URL 或 git-subdir 来源。

## 磁盘上的布局

```
~/.musepi/
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped marketplace plugins (version: 2)
    musepi-plugins.lock.json         # Runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
    cache/
      marketplaces/<name>/       # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.musepi/
  plugins/
    installed_plugins.json       # Project-scoped marketplace plugins (version: 2)
    musepi-plugins.lock.json         # Project runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
```

## 命名规则

marketplace 和插件名称必须：

- 以小写字母或数字开头和结尾
- 仅包含小写字母、数字、连字符和点
- 最多 64 个字符

插件 ID（`name@marketplace`）总长最多 128 个字符。

有效示例：`my-plugin`、`code-review`、`wordpress.com`、`ai-firstify`
无效示例：`-bad`、`bad-`、`.bad`、`Bad`、`under_score`
