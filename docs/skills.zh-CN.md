# Skills

[English](skills.md) | 中文

Skills 是启动时发现的文件型能力包，并以以下形式暴露给模型：

- 系统提示词中的轻量级元数据（name + description）
- 通过 `read` 工具按需读取的 `skill://...` 内容
- 可选的交互式 `/skill:<name>` 命令

本文档涵盖 `src/extensibility/skills.ts`、`src/discovery/builtin.ts`、`src/internal-urls/skill-protocol.ts` 以及 `src/discovery/agents-md.ts` 中的当前运行时行为。

## 本代码库中 skill 的含义

一个被发现的 skill 由以下内容表示：

- `name`
- `description`
- `filePath`（即 `SKILL.md` 的路径）
- `baseDir`（skill 所在目录）
- 来源元数据（`provider`、`level`、path）

运行时只要求 `name` 和 `path` 即可判定有效。但在实践中，匹配质量取决于 `description` 是否有意义。

## 必需的目录布局与对 SKILL.md 的要求

### 目录布局

对基于 provider 的发现（native/Claude/Codex/Agents/plugin provider）而言，skills 以 **`skills/` 下一层目录**的形式被发现：

- `<skills-root>/<skill-name>/SKILL.md`

类似 `<skills-root>/group/<skill>/SKILL.md` 的嵌套模式不会被 provider loader 发现。

对于 `skills.customDirectories`，扫描采用同样的非递归布局（`*/SKILL.md`）。

```text
Provider 发现的布局（skills/ 下非递归）：

<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ 会被发现
  ├─ pdf/
  │   └─ SKILL.md      ✅ 会被发现
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ provider loader 不会发现

自定义目录扫描同样是非递归的，因此嵌套路径会被忽略，除非你将 `customDirectories` 指向那个嵌套父目录。
```

### `SKILL.md` frontmatter

skill 类型支持的 frontmatter 字段：

- `name?: string`
- `description?: string`
- `globs?: string[]`
- `alwaysApply?: boolean`
- `hide?: boolean`
- `disableModelInvocation?: boolean`（Agent Skills 中等价于 `hide` 的字段；由 kebab-case 的 `disable-model-invocation` 归一化而来）
- 其余键会作为未知元数据原样保留

当前的运行时行为：

- `name` 默认取 skill 目录名
- `description` 在下列场景中是必需的：
  - native `.musepi` provider 的 skill 发现（`requireDescription: true`）
  - `omp-plugins` 扩展包 skills 以及 `github` provider（`.github/skills/`），二者同样传入 `requireDescription: true`
  - 通过 `src/discovery/helpers.ts` 中的 `scanSkillsFromDir` 进行的 `skills.customDirectories` 扫描（非递归）
- claude/codex/agents/opencode/claude-plugins 这些 provider 允许加载没有 description 的 skills

## 发现流水线

`src/extensibility/skills.ts` 中的 `loadSkills()` 会做三轮处理：

1. **能力 provider**，通过 `loadCapability("skills")` 加载（managed/auto-learn provider 的 skills 在此跳过，留到第 3 轮处理）
2. **自定义目录**，通过 `scanSkillsFromDir(..., { requireDescription: true })` 加载（一层目录枚举）
3. **Managed（auto-learn）skills**（`musepi-managed` provider）最后解析并遵循 first-wins 原则，因此任何同名的手写 skill——无论来自哪个 provider 或自定义目录——都会优先生效

若 `skills.enabled` 为 `false`，发现结果为空。

### 内置 skill provider 与优先级

provider 排序先按优先级（高者胜出），并列时按注册顺序。

当前注册的 skill provider：

1. `native`（priority 100）——通过 `src/discovery/builtin.ts` 提供 `.musepi` 用户/项目 skills
2. `omp-plugins`（priority 90）——随扩展包一同打包的 `skills/`，扩展包通过 `extensions:`、`--extension`/`-e` 或安装在 `~/.musepi/plugins/node_modules` 下的插件加载
3. `claude`（priority 80）
4. priority 70 组（按注册顺序）：
   - `claude-plugins`
   - `agents`
   - `codex`
5. `opencode`（priority 55）
6. `github`（priority 30）——`.github/skills/<name>/SKILL.md`（GitHub Agent Skills 布局，仅项目级）
7. `musepi-managed`（priority 5）——位于 `~/.musepi/agent/managed-skills` 下的 auto-learn skills，注册于 `src/discovery/builtin.ts` 且无条件参与发现（只有写入/提示受 `autolearn.enabled` 门控）；总是让位于同名的手写 skill

去重键是 skill 名。给定名称的第一个条目胜出。

### 来源开关与过滤

`loadSkills()` 应用以下控制项：

- 来源开关：`enableCodexUser`、`enableClaudeUser`、`enableClaudeProject`、`enablePiUser`、`enablePiProject`、`enableAgentsUser`、`enableAgentsProject`
- `disabledExtensions` 中带 `skill:<name>` 的条目
- `ignoredSkills`（排除；glob 模式）
- `includeSkills`（包含白名单；glob 模式；为空表示全部包含）

过滤顺序为：

1. 未被 `disabledExtensions` 禁用
2. 来源已启用
3. 未被忽略
4. 在包含列表内（如果存在包含列表）

`agents` provider（`.agent[s]/skills`）是规范的 OMP 原生位置，拥有自己的 `enableAgentsUser`/`enableAgentsProject` 开关——禁用 Claude/Codex/Pi **不会**把它一并关掉。对于没有专属开关的 provider（`claude-plugins`、`opencode`、`gemini`、`github` 等），启用逻辑回退为：只要**任意一个**具名来源开关处于启用状态即为启用。

### 冲突与重复处理

- 能力去重已经保证每个名称保留第一个 skill（来自最高优先级的 provider）
- `extensibility/skills.ts` 额外：
  - 按 `realpath` 对相同文件去重（symlink 安全）
  - 当较后的 skill 名称发生冲突时发出冲突警告
  - 将便捷 API `loadSkillsFromDir({ dir, source })` 保留为 `scanSkillsFromDir` 之上的薄适配层
- 自定义目录 skills 在 provider skills 之后合并，并遵循同样的冲突行为

## 运行时使用行为

### 系统提示词暴露

系统提示词构建（`src/system-prompt.ts`）按以下方式使用发现的 skills：

- 若 `read` 工具可用：
  - 在提示词中加入已发现的 skills 列表，但排除 `hide: true` 的 skills
- 否则：
  - 省略已发现列表

`hide: true` 并不会禁用该 skill。被隐藏的 skills 仍会加载，并且在 skill 命令启用时仍可通过 `skill://<name>` 和 `/skill:<name>` 访问。

Task tool subagent 会经由正常的会话创建收到本次会话发现/提供的 skills 列表；不存在针对单个 task 的 skill 固定覆盖机制。

### 交互式 `/skill:<name>` 命令

若 `skills.enableSkillCommands` 为 true，interactive mode 会为每个发现的 skill 注册一条 slash command。

`/skill:<name> [args]` 的行为：

- 直接从 `filePath` 读取 skill 文件
- 剥离 frontmatter
- 将 skill 正文作为 custom message 注入
- 投递模式跟随**提交快捷键**：
  - **Enter** → 流式输出期间把 skill 投递到 `steer` 队列（与自由文本 Enter 一致，后者同样是 steer），agent 非流式时则作为普通 idle prompt
  - **Ctrl+Enter**（`app.message.followUp`）→ 流式输出期间投递到 `followUp` 队列，agent 非流式时则作为普通 idle prompt
- 追加元数据（`Skill: <path>`，可选 `User: <args>`）

没有任何 flag、mode 选择器或 frontmatter 开关可以改变这一行为——快捷键**本身就是**选择，与自由文本在流式期间的路由方式完全一致（Enter 见 `input-controller.ts:562-568`，Ctrl+Enter 见 `input-controller.ts:961-966`；两者都经由 `#invokeSkillCommand` 分发）。

## `skill://` URL 行为

`src/internal-urls/skill-protocol.ts` 支持：

- `skill://<name>` → 解析到该 skill 的 `SKILL.md`
- `skill://<name>/<relative-path>` → 在该 skill 目录内解析

```text
skill:// URL 解析

skill://pdf
  -> <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  -> <pdf-base>/references/tables.md

守卫规则：
- 拒绝绝对路径
- 拒绝 `..` 穿越
- 拒绝任何逃逸出 <pdf-base> 的解析路径
```

解析细节：

- skill 名称必须精确匹配
- 相对路径经过 URL 解码
- 绝对路径被拒绝
- 路径穿越（`..`）被拒绝
- 解析后的路径必须仍在 `baseDir` 内
- 文件缺失时返回明确的 `File not found` 错误

Content type：

- `.md` => `text/markdown`
- 其他一切 => `text/plain`

缺失资源不会触发回退搜索。

## Skills 与 AGENTS.md、commands、tools、hooks 的对比

### Skills 与 AGENTS.md

- **Skills**：具名的、可选的能力包，按任务上下文选择或被显式请求
- **AGENTS.md/context files**：作为 context-file 能力加载、按 level/depth 规则合并的持久化指令文件

`src/discovery/agents-md.ts` 从 `cwd` 向上遍历祖先目录来发现独立的 `AGENTS.md` 文件。对于位于用户 home directory 之下的仓库，它会继续向上穿越外层 workspace 目录，直到但不包含 home directory。若 home 下不存在任何仓库根，home 边界本身仍然包含在内。否则它会停在仓库根，或者在 home 之外不存在已知仓库根时停在文件系统根。隐藏 owner 目录中的文件会被跳过。

### Skills 与 slash commands

- **Skills**：模型可读的知识/工作流内容
- **Slash commands**：用户调用的命令入口
- `/skill:<name>` 只是注入 skill 文本的便捷封装，并不改变 skill 发现阶段语义

### Skills 与 custom tools

- **Skills**：通过 prompt context 和 `read` 加载的文档/工作流内容
- **Custom tools**：模型可调用的可执行 tool API，带 schema 和运行时副作用

### Skills 与 hooks

- **Skills**：被动内容
- **Hooks**：事件驱动的运行时拦截器，可在执行期间阻断/修改行为

## 与发现逻辑绑定的实用编写指南

- 每个 skill 放在独立目录：`<skills-root>/<skill-name>/SKILL.md`
- 始终在 frontmatter 中写明 `name` 和 `description`
- 引用的资源放在同一 skill 目录下，并用 `skill://<name>/...` 访问
- 对于嵌套分类（`team/domain/skill`），把 `skills.customDirectories` 指向嵌套父目录；扫描本身保持非递归
- 避免跨来源重名；按 provider 优先级第一个匹配者胜出
