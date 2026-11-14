# VS Code / OpenChamber 编辑器与 PR 评论吸收设计（送审）

> 状态：送审，未实施。
>
> 范围：第一阶段 Monaco + LSP；第二阶段 GitHub Review Thread + Agent 修复闭环。
>
> 本文是工作设计，不是长期规格。能力落地后，把稳定契约移入 `docs/gui-design*`、
> `docs/gui-implementation*` 和相关协议文档，再删除本文。

## 1. 证据基线

### 1.1 VS Code

参考检出：`3c3d4ac933c97e9df32058196cbf7c6e40672e8c`。

- `src/vs/editor/standalone/browser/standaloneEditor.ts` 提供独立编辑器和 Diff 编辑器入口。
- `src/vs/workbench/contrib/comments/` 提供评论线程、范围和编辑器承载模型，但依赖 Workbench 服务。
- `src/vs/workbench/services/extensions/` 的 Extension Host 依赖完整工作台、配置、资源与生命周期服务。
- 截图中的 GitHub PR 行内评论由独立扩展 `github.vscode-pull-request-github` 提供，不是 VS Code Core 的独立功能。本设计不声称已读取该扩展的业务实现。

### 1.2 OpenChamber

参考包版本：`@openchamber/ui` 2.5.3。

可吸收：

- `components/comments/`：行范围归一化、行内 Block Widget、评论草稿和 Diff 左右侧。
- `lib/diffCommentOrigin.ts`：评论必须绑定来源；PR、commit、branch 和磁盘文件不是同一个行号空间。
- `lib/messages/contextParts.ts`：模型可读文本与结构化展示元数据由同一个构造函数生成，避免两者漂移。
- `server/lib/github/reference-search.js`：Review Thread 读取、回复、权限和评论摘录。
- `server/lib/github/mutations.js`：写入前验证全局 thread id 确实属于目标仓库和 PR。

不吸收：

- CodeMirror 编辑器本体。OpenChamber 没有可复用的 LSP 集成；移植其编辑器还需要补齐 Diff 和 LSP 界面。
- 自动保存。它不是本次闭环的必要条件，并会扩大文件写入风险。
- 多代码托管平台抽象。本阶段只实现 GitHub，不为未来 provider 预先增加分层。

### 1.3 MusePi 现状

- `FilePane.tsx` 已拥有文件读取、未保存 buffer、保存、脏状态和离开保护。
- `file-viewers.ts` 已拥有预览注册、优先级和降级；本设计不新建第二套预览系统。
- `panel-tabs.ts` 已拥有右侧异构标签和双列布局；不引入 VS Code editor group。
- Composer 已使用 CodeMirror 6；它继续服务输入框，不与文件编辑器强行统一。
- `lsp/client.ts` 已支持未保存文本同步、诊断、跳转、引用和重命名，但缺少 completion 能力声明与 GUI RPC。
- `pr-center.tsx` 和 `github.prView` 只有普通评论，没有行级 Review Thread。
- `DisplayContext` 只有浏览器标注、聊天引用和文件引用，且字段注释明确它是展示来源，不替代模型可读文本。

## 2. 设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 文件编辑器 | Monaco standalone | 同一边界提供代码编辑、Diff、装饰和行内评论区域 |
| 编辑器外壳 | 保留 FilePane 和 panel tabs | 避免引入第二套文件与布局状态 |
| 非代码预览 | 保留 FileViewer 注册表 | 已有稳定契约和测试 |
| Composer | 保留 CodeMirror 6 | 输入框与文件编辑需求不同，统一不是本次目标 |
| LSP | 复用 daemon 现有 client | 不启动第二套语言服务器，不重复配置和生命周期 |
| 评论模型 | 新建 GitHub ReviewThread DTO | 本地批注与远端已发布线程是不同对象 |
| 评论 UI | 自研 Monaco zone / decoration | 借鉴 VS Code 和 OpenChamber，不搬 Workbench 组件 |
| Agent 上下文 | 新增 `pr-review` + 模型可读文本 | 同时保证展示、持久化和模型语义 |
| VS Code 插件 | 不在本阶段支持 | 不引入 Extension Host 或 VSIX 运行时 |

### 2.1 为什么不再改用 CodeMirror

OpenChamber 的 CodeMirror 行内评论很适合参考，但 MusePi 当前只有 Composer 使用 CodeMirror，
没有同等完整的文件编辑器、Diff 和 LSP 界面。选择 CodeMirror 仍需移植这些能力。
Monaco 已提供缺失的基础件，因此维持 Monaco 决策。

若 Monaco 的 worker 打包或 2 MiB 门槛内性能验收失败，应记录实测证据并重新评审，
不能在不改变设计的情况下静默换成第二套编辑器。

## 3. 目标结构

```text
FilePane：文件、buffer、保存、脏状态、离开保护
  │
  ├─ FileCodeEditor：Monaco 生命周期、选区、装饰、评论区域
  │     ├─ monaco-lsp adapter：位置与结果转换
  │     └─ ReviewThreadCard：远端评论展示与动作
  │
  ├─ EditorService（daemon L2）
  │     └─ 现有 LSP client / servers
  │
  └─ ReviewThreadStore（renderer）
        ├─ PrCenter：PR 详情、回复、解决、发送到 Agent
        └─ FilePane：按当前文件订阅可定位线程

GitHubReviewService（daemon L2）
  └─ gh api graphql：读取、回复、解决、目标归属校验

Composer / ChatView
  └─ pr-review 卡片 + 模型可读 prompt → 现有 session.send
```

约束：

1. Monaco 不成为文件内容的权威来源；FilePane 的 `edit.text` 仍是权威。
2. EditorService 不读取 renderer 私有状态，也不直接写文件。
3. ReviewThreadStore 不成为 PR 详情的第二份持久事实；它只保存当前已拉取快照和活动作用域。
4. Agent 不通过评论服务直接回复或解决线程；这两个动作必须由用户显式触发。

## 4. 第一阶段：Monaco + LSP

### 4.1 组件边界

新增 `FileCodeEditor`，只替换 `FilePane.tsx` 内联编辑器中的 `textarea`。

建议 props：

```ts
interface FileCodeEditorProps {
  path: string;
  value: string;
  language: string;
  readOnly: boolean;
  onChange(text: string): void;
  onSave(): void;
  onExit(): void;
  onQuote(selection: FileQuoteSelection): void;
}
```

第二阶段再增加 `threads` 和评论动作 props，不预先塞入第一阶段组件。

保留：

- `unsavedBufferCache`；
- `EDIT_MAX_BYTES = 2 MiB`；
- `fs.write` 保存路径；
- dirty tab 和离开确认；
- 非代码 FileViewer；
- 新建文件、外部 reveal 和文件标签行为。

不加入自动保存。超过现有大小门槛的文件继续只读。

### 4.2 内容同步顺序

用户输入时：

1. Monaco 产生 `onDidChangeModelContent`。
2. `FileCodeEditor` 调用 `onChange(editor.getValue())`。
3. FilePane 更新 `edit.text`，并计算 dirty。
4. React 把相同文本传回 `value`。
5. 包装层识别这是自己刚刚发出的值，不调用 `setValue()`。

第 5 步必须存在。否则每次击键都会重置光标、选区、撤销栈和 Composition 状态。

打开另一文件、放弃修改或恢复缓存时，FilePane 给出新的权威值。此时包装层才替换 Model，
并保存／恢复该路径的 view state。

IME 输入期间不得用外部值覆盖正在组合的文档。

### 4.3 文本与选区契约

- GitHub 和 FileQuote 行号使用 1-based。
- Monaco 对外行号使用 1-based；列号在适配层转换为 LSP 的 0-based position。
- 初始文本含 CRLF 时，Model 必须保持 CRLF；保存不能只因为接入编辑器而全文件换行。
- 保留文件末尾是否有换行。
- 编辑态引用从 Monaco selection 生成，不再依赖 DOM Selection。
- 空选区不生成 `file-quote`；多行选区必须包含准确的起止行。

### 4.4 Monaco 打包与降级

实施时使用正式 `monaco-editor` 包，不复制 VS Code `src/vs`。

`apps/desktop/vite.config.ts` 负责 editor worker 与启用语言 worker 的开发环境解析。
生产入口是 `apps/desktop/package.json` 的 `build:bundle`（Bun build），不是 Vite。
因此实施必须分别接通并验证两条 worker／asset 路径，不能用开发环境成功代替 Electron 生产验证。

按需加载编辑器。Monaco 初始化或 worker 失败时：

- 保留文本预览；
- 显示明确错误；
- 提供重试；
- 不自动写文件，不丢未保存 buffer。

第一阶段的语法范围跟随实际启用 worker 和语言贡献，不宣称覆盖 VS Code 全语言列表。

### 4.5 新增 EditorService

新增 L2 服务 `editor-service.ts`，服务键 `editor`。路由只委托该服务，不加入 legacy 清单。

| RPC | 输入 | 输出 / 事件 |
|---|---|---|
| `editor.lsp.sync` | `documentId, cwd, path, content, version` | 实际同步的 `version`、参与服务器 |
| `editor.lsp.saved` | `documentId, cwd, path` | 完成 `didSave` |
| `editor.lsp.hover` | `documentId, cwd, path, position, version` | 当前版本 hover 或空 |
| `editor.lsp.completion` | 同上 | 当前版本 completion items |
| `editor.lsp.definition` | 同上 | 标准化文件位置列表 |

全局事件：

```ts
type EditorLspDiagnosticsEvent = {
  type: "editor.lspDiagnostics";
  documentId: string;
  cwd: string;
  path: string;
  serverName: string;
  version: number;
  diagnostics: Diagnostic[];
};
```

事件走现有 `global-event` 通道，不进入 session journal 水位。renderer 按 `documentId` 和规范化路径过滤。

服务头注释必须声明输入、输出、生命周期、启停、冲突和检视入口。服务停止时移除 LSP 诊断监听；
语言服务器进程仍由现有 LSP 生命周期管理，EditorService 不另行启动或杀死进程。

### 4.6 版本规则

定义：

- `documentId`：一个 FileCodeEditor 文档实例的稳定 id。
- `version`：该实例每次文本变化递增的整数，从 1 开始。
- LSP server version：现有 `syncContent()` 维护的协议版本。它与 `version` 不是同一个值。

规则：

1. 同一 `documentId` 的 sync 请求按发送顺序串行执行。
2. daemon 只应用不落后于最近已同步版本的请求；旧请求返回 `stale: true`，不得再发给语言服务器。
3. hover / completion / definition 响应回传请求版本；renderer 丢弃与当前版本不匹配的结果。
4. 诊断事件携带该文档最近完成同步的版本。renderer 只应用与已确认同步版本匹配的事件。
5. 新编辑尚未同步时，旧诊断可以保留显示，但必须标为可能过期；不能冒充最新结果。
6. 同一路径只允许一个可写未保存 buffer 源。第二编辑器在本阶段只读，防止共享 LSP client 被两个内存版本互相覆盖。

### 4.7 LSP 能力补齐

`lsp/client.ts`：

- 增加 completion capability；第一阶段关闭 snippet support，避免未实现片段语义。
- 在 `publishDiagnostics` 更新缓存的同一位置通知订阅者，缓存与事件不得分叉。
- 不开放任意 raw LSP request 给 GUI。

`lsp/types.ts`：增加本阶段需要的 completion 和文档类型。

服务器选择：

- sync 和 diagnostics 沿用现有多服务器配置。
- hover / completion / definition 选择第一个声明对应能力的项目级服务器。
- 无可用服务器返回空结果和明确状态，不当作语言错误。

第一阶段不做 completion resolve、snippet、signature help、rename 和 code action UI。

## 5. 第二阶段：Review Thread + Agent 闭环

### 5.1 独立 RPC 与局部失败

不扩张现有 `github.prView` 的必选字段。新增：

- `github.prReviewThreads`；
- `github.prReviewThreadReply`；
- `github.prReviewThreadResolve`。

理由：GraphQL 拉取失败时，普通 PR 详情仍应可用；线程分页和错误也不能让已有详情整体失败。

新增 `GitHubReviewService`，服务键 `githubReviews`。现有 `github.prView` 可继续留在 legacy，
本阶段不顺手抽取全部 GitHub 功能。

所有请求继续通过 daemon 的 `gh` 执行路径。token 不进入 renderer、事件、日志或 `DisplayContext`。

### 5.2 规范数据模型

共享 DTO 放在 `packages/collab-proto/src/editor.ts` 或同域新文件，避免 renderer 直接依赖 daemon 类型。

```ts
interface ReviewLineRange {
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
}

interface ReviewThread {
  id: string;
  repository: { owner: string; name: string };
  number: number;
  headSha: string;
  path: string;
  currentRange: ReviewLineRange | null;
  originalRange: ReviewLineRange;
  diffSide: "LEFT" | "RIGHT";
  isOutdated: boolean;
  isResolved: boolean;
  canReply: boolean;
  canResolve: boolean;
  comments: ReviewThreadComment[];
  excerpt?: { startLine: number; lines: string[] };
  truncated: boolean;
}
```

约束：

- `currentRange = null` 表示无法安全映射，不能用 `originalRange` 冒充。
- 文件级评论继续留在 PR 详情；本阶段只有 line subject 进入 Monaco。
- 回复数组按时间排序，首条是线程根评论。
- 拉取达到上限时设置 `truncated`，不能表现成完整空列表。
- 活动 key 至少包含 `cwd + repository + number + headSha`。force-push 后不能使用旧 key 的数据。

### 5.3 读取与定位

`github.prReviewThreads` 使用 `gh api graphql`，读取：

- thread id、path、line / originalLine、startLine / originalStartLine；
- diffSide、isOutdated、isResolved；
- viewerCanReply、viewerCanResolve / viewerCanUnresolve；
- comments、diffHunk 和 PR head SHA。

`PrCenter` 与 `FilePane` 不共享同一个 React 父组件，因此新增 renderer `ReviewThreadStore`：

- PrCenter 拉取后写入活动 PR scope 和线程快照；
- FilePane 按当前路径订阅；
- 请求序号或 scope key 防止旧 PR 响应覆盖新选择；
- 回复／解决成功后使当前快照失效并重新拉取，不在本地伪造服务器成功状态。

行内显示门槛：

1. thread 属于活动 PR 和当前 head SHA；
2. thread path 与当前规范化文件路径一致；
3. `currentRange` 存在且 `isOutdated = false`；
4. 打开时本地文档能够锚定到该 PR head 行范围。

满足后由 Monaco decoration 跟踪后续本地编辑。对打开前已经存在的脏 buffer，如果尚未计算 PR head 到当前
buffer 的映射，则只在 PR 中心显示，不猜测行号。

以下情况禁止直接嵌入当前行：

- outdated 或 force-push 后只剩原始行；
- 文件已删除或路径不匹配；
- LEFT / RIGHT 语义不明确；
- 本地 buffer 无法建立可靠锚点。

这些情况仍在 PR 中心完整显示，并提供评论摘录和“发送到 Agent”。

### 5.4 回复与解决安全

回复输入：`cwd, repository, number, threadId, body`。

解决输入：`cwd, repository, number, threadId, resolved`。

daemon 写入前必须通过 GraphQL `node(id:)` 验证：

1. 类型是 `PullRequestReviewThread`；
2. PR number 与请求一致；
3. repository owner / name 与请求一致。

验证失败返回目标无效错误，不得执行 mutation。

其他规则：

- `resolved` 是目标状态，不是服务端 toggle；重复请求保持幂等语义。
- UI 在 mutation 和后续刷新完成前禁用同一 thread 的写动作。
- GraphQL HTTP 200 但含 errors 时仍按失败处理。
- 回复失败保留草稿。
- Agent 完成、用户保存文件或推送 commit 都不自动解决 thread。
- 本阶段不从 Monaco 新建 GitHub review thread，只处理已有线程。

### 5.5 Agent 上下文

`packages/wire/src/index.ts` 新增：

```ts
interface PrReviewDisplayContext {
  kind: "pr-review";
  repository: string; // owner/name
  number: number;
  headSha: string;
  threadId: string;
  path: string;
  startLine: number;
  endLine: number;
  diffSide: "LEFT" | "RIGHT";
  outdated: boolean;
  body: string;
  replyCount: number;
  comment?: string;
}
```

`body` 保存根评论用于卡片和恢复；完整线程在发送时进入模型可读 prompt。
代码片段另行组合现有 `file-quote`，不把两个职责塞进一个字段。

`client-core/messages/display-context.ts` 必须同时更新：

- runtime guard 和构造函数；
- `prReviewPrompt()`；
- `composeDisplayContextPrompt()`；
- `textWithoutDisplayContext()`；
- `displayContextQuote()`。

模型文本至少包含：

```text
Repository / PR number / head SHA / thread id
File / line range / diff side / outdated state
Root comment and replies, in author-time order
User instruction
```

代码选区继续由 `file-quote` 提供。若无法安全取得当前代码，只发送 PR 提供的 excerpt，
并明确它属于哪个 revision，不能让 Agent 误以为它是当前工作区文本。

引用 OpenChamber 的关键原则：模型文本与结构化元数据由同一构造路径生成，测试覆盖往返读取，
避免卡片显示 A、模型实际读到 B。

### 5.6 动作链路

“发送到 Agent”：

1. PrCenter 或行内卡片构造 `pr-review`。
2. 有可靠代码选区时，同时构造 `file-quote`。
3. 通过现有 `musepi-gui-quote-append` 进入 ChatView / WelcomeComposer。
4. Composer 合并模型可读文本，保留结构化 `displayContext`。
5. 继续走现有 `session.send`，不新增 Agent RPC。

“定位代码”：

- 满足 §5.3 门槛时，复用现有 file reveal / openRequest，打开文件并显示 range。
- 不满足时，留在 PR 详情并展示原始摘录，不跳到猜测行。

“修复后回复／解决”：

- Agent 的代码修改走现有工具和 Diff／审批链。
- 用户检查结果后，在评论卡片上单独回复或解决。
- 不根据 Agent 的文本声明推断远端状态已经变化。

## 6. 实施文件清单

### 6.1 第一阶段

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/components/FileCodeEditor.tsx` | 新增 Monaco 包装、选区、view state 和降级 |
| `apps/desktop/src/components/FilePane.tsx` | 仅替换代码编辑表面，保留 buffer 合约 |
| `apps/desktop/src/lib/monaco-lsp.ts` | Monaco ↔ RPC ↔ LSP 类型转换 |
| `apps/desktop/vite.config.ts` | worker 开发解析；生产构建同步验证 |
| `apps/desktop/package.json` / lockfile | 固定 Monaco 依赖 |
| `packages/coding-agent/src/daemon/services/editor-service.ts` | 新增 L2 RPC 与诊断事件 |
| `packages/coding-agent/src/daemon/server.ts` | 只注册服务，保留其他未提交改动 |
| `packages/coding-agent/src/lsp/client.ts` | completion capability、诊断订阅 |
| `packages/coding-agent/src/lsp/types.ts` | 本阶段协议类型 |
| `packages/collab-proto/src/` | GUI LSP DTO 与事件类型 |
| `packages/client-core/src/i18n/{en-US,zh-CN}/settings.ts` | 编辑器与 LSP 状态文案 |
| `apps/desktop/src/styles/gui-chrome.css` | 编辑器、诊断和降级样式 |

### 6.2 第二阶段

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/daemon/services/github-review-service.ts` | GraphQL 读取、回复、解决、归属校验 |
| `packages/coding-agent/src/daemon/server.ts` | 注册 GitHubReviewService |
| `packages/collab-proto/src/` | ReviewThread DTO |
| `apps/desktop/src/lib/review-thread-store.ts` | 活动 PR scope、快照、竞态与失效 |
| `apps/desktop/src/components/pr-center.tsx` | 线程列表、动作和错误展示 |
| `apps/desktop/src/components/review/ReviewThreadCard.tsx` | 共享线程卡片与回复状态 |
| `apps/desktop/src/components/FileCodeEditor.tsx` | 可定位线程的 zone / decoration |
| `packages/wire/src/index.ts` | `pr-review` DisplayContext |
| `packages/client-core/src/messages/display-context.ts` | 构造、校验、prompt、去重文本 |
| `packages/client-core/src/components/transcript/transcript-content.tsx` | PR 来源卡片 |
| `apps/desktop/src/components/composer/quote-cards.tsx` | Composer 内 PR 上下文卡片 |
| `apps/desktop/src/components/{ChatView,WelcomeComposer}.tsx` | 必要时补齐组合上下文接入 |
| `packages/client-core/src/i18n/{en-US,zh-CN}/settings.ts` | 线程与动作文案 |

实施行为落地时，还必须同步 owning GUI 双语文档及
`packages/coding-agent/CHANGELOG.musepi.md` 的 `[Unreleased]`。本送审文档本身不记 changelog。

## 7. 验证与验收

### 7.1 第一阶段自动测试

- FilePane 现有 dirty、保存、离开保护和 file-quote 测试继续通过。
- 自己发出的 Monaco 文本回流时不重置 selection、undo stack 或 IME composition。
- CRLF、末尾无换行、空文件、2 MiB 边界、只读降级。
- 快速连续输入时旧 LSP 响应被丢弃；旧 sync 不进入语言服务器。
- 未保存 buffer 能触发诊断，保存只发 `didSave`，不重复读盘替换 buffer。
- completion capability 与 plain-text item 转换；无服务器、方法不支持、超时和服务停止。
- 诊断缓存与推送载荷一致；事件不进入 session journal。
- 新 RPC 全部归属服务，路由覆盖测试无 legacy 新增。

### 7.2 第二阶段自动测试

- GraphQL 响应映射：多行、LEFT / RIGHT、outdated、resolved、空回复、分页截断。
- `currentRange` 缺失时不回退成伪造的当前行。
- PR A 慢响应不能覆盖 PR B；旧 head SHA 不污染新 scope。
- 回复失败保留草稿；mutation 期间重复点击不重复写入。
- 跨 PR、跨 repository 的全局 thread id 在写入前被拒绝。
- GraphQL 200 + errors 按失败处理。
- `pr-review` guard、prompt、卡片文本剥离、持久化往返和旧消息兼容。
- 无代码 excerpt 时仍发送完整评论，但不伪造 file-quote。

### 7.3 真实 GUI / 集成验证

- Electron 开发包和生产包均能加载 Monaco worker。
- 大文件、中文、emoji、CRLF、多 tab、分栏、脏 buffer 恢复和外部文件变化。
- 使用真实语言服务器验证未保存补全、诊断、hover 和 definition。
- 使用测试 PR 验证行内定位、回复、解决、重开、force-push 和 outdated。
- 从评论进入 Agent，确认模型实际收到评论、revision、代码来源和用户指令。
- Agent 修改后检查现有 Diff／审批行为；确认没有自动回复或自动解决。
- token 不出现在 renderer 日志、RPC 响应、事件和持久化消息中。

测试和 smoke 必须使用隔离 session / daemon 目录，不能写生产会话存储。

## 8. 实施切分

1. **编辑表面**：Monaco 替换 textarea，保留全部 FilePane 合约；不接 LSP。
2. **LSP 只读面**：sync、diagnostics、hover、completion、definition；不加写入型 code action。
3. **Review Thread 只读面**：PrCenter 展示、活动 scope、安全定位、发送到 Agent。
4. **Review Thread 写入面**：回复、解决、归属校验、刷新与竞态。
5. **Monaco 行内面**：只对满足定位门槛的线程开放，不能用猜测映射换取覆盖率。

每一步都可独立回滚。第 3 步不依赖第 2 步，可先交付“PR 评论 → Agent”的闭环；
第 5 步依赖第 1 步。

## 9. 非目标与后续候选

本阶段不做：

- VS Code Workbench、Extension Host、VSIX 运行兼容；
- 本地代码批注系统；
- 新建 GitHub review thread；
- 自动保存、自动回复、自动解决；
- PR head 到任意脏 buffer 的通用行号映射；
- 多 provider 抽象；
- VS Code 扩展包装 MusePi ACP。

后续优先候选：可靠 revision→buffer 行映射、Monaco PR Diff、静态 VSIX 主题／grammar 导入。
这些候选不得阻塞本次闭环。
