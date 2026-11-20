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

**configured marketplace（已配置市场）** 是一个 Git 仓库（或本地目录），其中在 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容后备）存放 catalog 文件。catalog 列出可用插件及其来源、描述和元数据。通过 `/marketplace add` 添加的来源属于这种已配置市场；它与**索引市场**（见[插件索引格式](#插件索引格式musepi-plugin-index)）供给同一个插件市场，但只有索引固定精确版本与 commit。

**catalog plugin directory（目录插件目录）** 存放 Claude 或 OMP 兼容内容，如 skills、commands、agents、hooks、tools、MCP servers 或 LSP servers。安装时把缓存目录符号链接到 scope 的 `node_modules` 树，并将其记录在 `musepi-plugins.lock.json` 中——这与 npm 安装及 `musepi plugin link` 的插件所用的运行时表面相同；由 `package.json` 的 `omp.extensions` 声明的扩展模块也在那里加载。目录插件以 `name@marketplace` 标识（例如 `code-review@claude-plugins-official`）。

**Scopes**（作用域）：marketplace 插件可以安装到两个作用域：

- **user**（默认）—— 在所有项目中可用，存储于 `~/.musepi/plugins/installed_plugins.json`
- **project** —— 仅在当前活动项目中可用，存储于最近的项目 `.musepi/plugins/installed_plugins.json`

已启用的 project 作用域安装会遮蔽同一插件的已启用 user 作用域安装。已禁用的 project 安装不会遮蔽 user 安装。

### 词汇表

以下术语在市场文档与代码中各自只有一个含义：

| 术语 | 含义 |
| --- | --- |
| **index（索引）** | 市场发布的一份 `musepi-plugin-index` JSON 文档。它携带列表行需要显示的全部字段以及每个可安装版本，因此浏览一次读取即可，而不是每行一次请求。 |
| **catalog（目录）** | 与 Claude 兼容的 `marketplace.json`（优先 `.omp-plugin/`，回退 `.claude-plugin/`）。它列出插件条目与来源，但不固定精确版本或 commit。 |
| **market（市场）** | 能力中心的插件市场界面，只由用户配置的来源供数。市场发布索引（或目录），本身不是插件宿主。 |
| **plugin（插件）** | 能力包。原生 MusePi 插件的清单是 `package.json` 的 `musepi` 块；`omp`/`pi` 清单属于 `pi` vendor。 |
| **vendor（血统）** | 插件声明的宿主血统：`musepi`、`pi`、`claude` 或 `codex`。它表示清单与内容布局；实际能跑什么由宿主按安装产物判定，下方支持矩阵就是该判定。 |
| **compat plugin（兼容插件）** | vendor 不是 `musepi` 的插件（`pi`、`claude`、`codex`），经兼容层处理。支持程度按 vendor 不同，见下文支持矩阵。 |
| **dock（停靠位）** | **已加载**插件可以占用的固定 GUI 席位：composer dock（`conversation.composer.dock`）或右侧栏面板中的一个 tab。浏览或安装不会创建停靠位；启用插件才可能。 |
| **lane（分区）** | 市场列表的一个分区。原生插件（`musepi`）占主分区；`pi`、`claude`、`codex` 在同一个兼容分区中，各带 vendor 徽章。 |

**主列表只列原生 MusePi 插件。** 索引条目声明 `vendor: "musepi"` 即为原生插件。`pi`、`claude` 与 `codex` 插件只出现在兼容分区中，各带自己的 vendor 徽章，绝不混入主列表。

`vendor` 是索引声明与展示轴，不承诺四种等价支持。**支持程度由宿主按实际安装产物判定**——看它实际找到的清单与内容——而不是看徽章、包名或索引：

| `vendor` | 声明的清单 | 宿主当前支持程度 |
| --- | --- | --- |
| `musepi` | `package.json` `musepi` 块 | 完整运行时：作为一等扩展加载的原生 Cordis 插件。 |
| `pi` | `package.json` `omp` 或 `pi` 块 | 经 `compat/legacy-pi-compat.ts` 作为 legacy 扩展加载；并非所有能力都有保证。 |
| `claude` | `.claude-plugin/plugin.json` | 部分支持：`discovery/claude-plugins.ts` 读取 skills、commands、hooks、MCP servers 与 custom tools；Claude 扩展入口不会被加载，但 `tools/` 下的工具模块会被 custom-tools loader 导入执行。 |
| `codex` | `.codex-plugin/plugin.json` | 暂无运行时支持：市场详情读取其 `interface` 展示字段、`skills/*/SKILL.md` 与图标（列表卡片也使用该图标）；不加载也不执行任何内容。 |

兼容徽章不能被读成「与原生等价」：它表示条目声明的血统，以及由此应预期的支持程度。索引条目若夸大自己的 vendor，安装后仍会得到宿主的真实待遇。

**安装后以实际产物为准。** 安装完成后，宿主检查真正落盘的内容：原生与 `pi` 插件回读 `package.json`（先 `musepi`，再 `omp`/`pi`），`claude` 与 `codex` 插件读取各自的清单。名称、版本与显示标签都来自该产物，宿主的 vendor/支持判定也随之确定。索引是市场未经签名的声明：它的标题、标签甚至包名都不能压过真正落盘的产物。

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

## 插件索引格式（`musepi-plugin-index`）

市场可以只发布一份索引，而不发布目录。索引是一份文档，包含列表要渲染的全部内容以及每个可安装版本；宿主只从用户配置的来源读取它，并把它作为一个整体校验。格式 1 由 `index-format.ts`（`parsePluginIndex`）定义，由 `index-source.ts` 读取。

```json
{
  "format": 1,
  "name": "musepi-market",
  "title": { "en": "MusePi Market", "zh": "MusePi 市场" },
  "description": { "en": "Community MusePi plugins", "zh": "社区 MusePi 插件" },
  "owner": { "name": "MusePi" },
  "metadata": {
    "categories": { "productivity": { "title": { "en": "Productivity", "zh": "效率" } } },
    "labels": { "official": { "title": { "en": "Official", "zh": "官方" } } },
    "sortKeys": { "downloads": { "title": { "en": "Downloads", "zh": "下载量" }, "order": "desc" } }
  },
  "plugins": [
    {
      "name": "@musepi/auto-review",
      "vendor": "musepi",
      "title": { "en": "Auto Review", "zh": "自动审查" },
      "description": { "en": "Per-tool authorization review" },
      "author": "MusePi",
      "homepage": "https://example.com/auto-review",
      "repository": { "url": "https://github.com/musepi/plugins", "directory": "auto-review" },
      "license": "MIT",
      "metadata": {
        "category": "productivity",
        "labels": ["official"],
        "keywords": ["review", "authorization"],
        "sortKeys": { "downloads": 12034 }
      },
      "versions": [
        {
          "version": "0.2.0",
          "publishedAt": 1790476800,
          "source": { "type": "npm", "registry": "https://registry.example.com/npm" },
          "engines": { "musepi": ">=0.2.0 <0.3.0" }
        },
        {
          "version": "0.1.0",
          "publishedAt": 1789872000,
          "source": {
            "type": "git",
            "url": "https://github.com/musepi/plugins",
            "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4",
            "path": "auto-review"
          },
          "engines": { "musepi": "*" }
        }
      ]
    }
  ]
}
```

`LocalizedText` 是非空字符串，或「语言 id → 非空字符串」的对象。语言 id 匹配 `^[a-z]{2,8}(-[a-z0-9]{1,8})*$`；对象至少声明一种语言。

### 根字段

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `format` | 是 | 整数 `1`。其他值（或缺失）都会拒绝整份索引。 |
| `name` | 是 | 市场名称；与 marketplace 名称相同的小写名称段规则（最多 64 字符）。 |
| `title` | 是 | 命名该市场的 `LocalizedText`。 |
| `description` | 否 | `LocalizedText`。 |
| `owner` | 是 | `{ "name": string, "email"?: string }`。 |
| `metadata` | 否 | 下文的声明映射；缺失即无声明。 |
| `plugins` | 是 | 插件数组，可以为空。数组顺序即初始显示顺序。 |

`metadata.categories` 与 `metadata.labels` 把 id 映射到 `{ "title": LocalizedText }`。`metadata.sortKeys` 把 id 映射到 `{ "title": LocalizedText, "order": "asc" | "desc" }`。分类、标签与排序键的 id 都是不透明的：市场只按它们过滤、排序并显示 title，从不解释 id 的含义。

### 插件字段

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `name` | 是 | 小写 npm 包名；索引内唯一。 |
| `vendor` | 是 | `"musepi"`（原生）、`"pi"`（`omp`/`pi` 清单）、`"claude"`（`.claude-plugin`）或 `"codex"`（`.codex-plugin`）。 |
| `title` | 否 | `LocalizedText`；缺失时读取方显示 `name`。 |
| `description` | 否 | `LocalizedText`。 |
| `icon` | 否 | 内联 `data:<type>;base64,<payload>`（`image/svg+xml`、`image/png`、`image/jpeg`、`image/webp`；canonical 带填充 base64；解码后最多 32 KiB），或绝对 `https:` URL。 |
| `glyph` | 否 | 短文本/emoji 替代图形，最多 32 个 UTF-16 码元。 |
| `author` | 否 | 非空字符串。 |
| `homepage` | 否 | 不含凭据的绝对 `http:`/`https:` URL。 |
| `repository` | 否 | `{ "url": string, "directory"?: string }`。仅用于展示，绝不作为安装来源。`url` 是不含凭据、query 或 fragment 的绝对 `http:`/`https:` URL；`directory` 是安全的相对路径。 |
| `license` | 否 | 非空字符串。 |
| `metadata` | 否 | `category`（一个已声明 id）、`labels`（互不重复的已声明 id）、`keywords`（自由字符串）、`sortKeys`（已声明 id → 有限数值或 `null`）。 |
| `versions` | 是 | 非空数组；精确版本字符串在插件内唯一。 |

引用未声明的分类、标签或排序键会拒绝整份索引。任意层级上的未知成员会被丢弃，并连同 JSON 路径一起报告，因此更新写出的额外字段既不会破坏旧读取方，也不会悄悄通过。无法识别的 `source.type` 属于错误而非未知成员：读取方不理解的固定形式无法安装。

### 版本字段

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `version` | 是 | canonical 形式的精确 SemVer。区间（`^1.0.0`、`>=1`）、标签（`latest`）、`v` 前缀与前导零写法一律拒绝。 |
| `publishedAt` | 是 | 整数 Unix 秒时间戳，`0 ≤ publishedAt < 10^11`。 |
| `source` | 是 | 下文两种形式之一。 |
| `engines` | 是 | `{ "musepi": <合法 npm SemVer 区间> }`，从被安装的清单原样复制。`*` 表示支持任意宿主版本。 |

`source` 形式：

- **npm** —— `{ "type": "npm", "registry"?: string }`。`registry` 是不含凭据、query 或 fragment 的 `http:`/`https:` URL。缺失时安装器使用自身配置的 registry。
- **git** —— `{ "type": "git", "url": string, "commit": string, "path"?: string }`。`url` 是 canonical `https:` URL（等于其 WHATWG 序列化结果），至少两个路径段，无结尾斜杠，无凭据/query/fragment，且不以 `.tgz`/`.tar.gz` 结尾。`commit` 是小写 40 位十六进制 SHA。`path` 是以 `/` 分隔的相对目录，每段只含 ASCII 字母、数字与 `._@+-`，且不得为 `.` 或 `..`；缺失表示仓库根目录。

索引中不存在自由形式的安装字段。宿主从精确版本与结构化 `source` 推导安装参数，因此读取方可以确认安装确实固定在列表展示的内容上：

- npm → `name@exactVersion`，指定的 registry 只作用于这一次安装。
- git → `git+<url>.git#<commit>`；存在 `path` 时追加 `&path:/<path>`；已有 `.git` 后缀不会重复追加。

**默认版本**：最高的兼容稳定版（不含预发布段）。只有当没有任何稳定版兼容时，宿主才选择最高的兼容预发布版。不存在 npm `latest` 回退——未发布的标签绝不能决定索引条目安装什么。兼容指宿主版本满足该版本的 `engines.musepi` 区间（预发布宿主还会按其基础版本复检）。

### 读取索引

- 索引 URL 属于用户配置。读取器只读取已配置来源，不提供抓取任意 URL 的方法。
- 只允许 `http:` 与 `https:`；含凭据或 fragment 的 URL 会被拒绝。
- 重定向只在配置 URL 的同一 origin 内跟随，最多三跳。市场无法把读取方弹到另一个宿主。
- 响应体在 JSON 解析前有上限（默认 8 MiB）。
- 成功读取的文档按 TTL 缓存（默认 5 分钟）。读取结果报告文档的 `fetchedAt`；同一 URL 的并发读取共享一次在途请求。
- 托管在 git 上的索引留给下一阶段：位置类型与文档已经预留，读取器会以具名错误拒绝，而不是抓取。

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

## 发布到市场索引

`musepi-plugin-index` 条目的包名与发现面：

- **官方 MusePi 插件**：`@musepi/plugin-<name>`。scope 已经表明组织身份，与 dsh 的 `@deepseek-ai/dsh-plugin-market` 同构；不要再写成 `@musepi/musepi-plugin-<name>`，那是 `musepi/musepi` 的重复。
- **社区插件**：`musepi-plugin-<name>` 或 `@author/musepi-plugin-<name>`。
- **发现约定**：发布 npm keyword `musepi-plugin` 与 GitHub topic `musepi-plugin`。topic 命中只是候选来源；列入索引前必须核对包清单。
- **官方判定**看 npm scope 前缀（`@musepi/`）；徽章与分区看索引的 `vendor` 值，绝不看包名。
