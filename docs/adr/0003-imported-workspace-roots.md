# ADR 0003：从 Codex 导入会话时如何引入多根工作区

- 状态：已接受（2026-11-17），已实现于 `codex-session-store.ts`、`foreign-session-store.ts` 与 `import.sources` 的行投影；导入界面的根数提示见"影响"。
- 背景：Codex 的"项目"是主目录 + 有序参考目录，实测 `project_roots` 给出 `[D:\Projects\Agents\MusePi, D:\Projects\Agents\references, D:\Projects\Agents\magpie-agent-musepi]`；MusePi 会话本身支持多根（`SessionManager` 的 `additionalDirectories`），但导入链路此前只有单一 `cwd`。
- 目标：导入后的会话在 MusePi 里仍是同一个工作区——同一个项目分组、同样的目录可达、同样的 AGENTS.md 与 skills 注入——而不是被压成一个目录，也不是把别人的信任判断搬过来。

## Codex 的两套机制（实证）

Codex 把"工作区是哪几个目录"和"这个目录是否被信任"分成互不相干的两处存储，混用任何一个都会得出错误结论。

**项目 = 一个主目录 + 有序参考目录。** 权威来源是 state 库的 `projects(id, name, metadata, position, …)` 与 `project_roots(project_id, position, path)`（主键 `(project_id, position)`）。`threads.project_id` 是可空外键，`ON DELETE SET NULL`；实测两条 thread 的 `project_id` 均为 `NULL`，而同一会话 rollout 首行 `session_meta.payload.runtime_workspace_roots` 已带三个根。所以归属要走两条路：有 `project_id` 时用它，没有时按 `cwd` 命中的项目根反查；两条都不成，才只剩 `cwd`。`runtime_workspace_roots` 是同一信息的会话级副本，也是老库没有项目表时的回退来源。

**信任 = 逐路径的单值标记，与项目无关。** 存在 `~/.codex/config.toml` 的 `[projects.'<path>'] trust_level`，取值只有 `trusted` / `untrusted`（`codex-rs/protocol/src/config_types.rs:642-645`），键缺席即"未表态"。查找规则（`codex-rs/config/src/project_trust.rs:50-96`）：候选路径先 cwd、后 git 仓库根，cwd 的键整体优先于仓库根的键，包括一个没有 `trust_level` 的空条目；每个路径先试规范化拼写再试原始拼写；Windows 下键按 ASCII 小写比较（`loader/mod.rs:1612-1618`），多键仅大小写不同时取字典序最小者以保证确定性（`project_trust.rs:85-93`），POSIX 大小写敏感。

**信任的作用域比"项目"窄，但比"配置层"宽。** 它不决定 agent 能读写哪些目录——目录来自项目记录，`runtime_workspace_roots` 直接物化进 sandbox（`codex-rs/protocol/src/permissions.rs:1254` 起）。它决定的是这个目录下的会话被交到 agent 手上时的宽松程度。判定只用 cwd，其次 git 仓库根（`codex-rs/core/src/config/mod.rs:3714-3721`），因此**一次判定套用于整个会话的每一个根**：主目录被信任时，同项目的参考目录一并获得宽松待遇，反之亦然——没有任何逐根表态。

| 行为 | trusted | untrusted | 未表态 |
| --- | --- | --- | --- |
| 加载 AGENTS.md | 是 | 否（`core/src/agents_md.rs:65`） | 是 |
| shell 快照 | 是 | 否（`core/src/unified_exec/shell_snapshot.rs:47`） | 是 |
| 默认审批策略 | `on-request` | `unless-trusted`（`core/src/config/mod.rs:4046-4053`） | 全局默认 |
| 默认权限档 | workspace | workspace（任何显式表态） | read-only（`core/src/config/permissions.rs:73-84`） |
| 默认 `sandbox_mode` | workspace-write | workspace-write | 平台回退（`config/src/config_toml.rs:900-909`） |
| 目录内 `.codex/config.toml` 生效 | 是 | 否 | 否 |

两点容易误读：app-server 在请求带 cwd、而该 cwd 尚无信任表态时会自动把 git 根（无仓库时用 cwd）写成 `trusted`（`app-server/src/request_processors/thread_processor.rs:1498-1526`），所以 config.toml 里的 `trusted` 可能只是某次启动的副产品，不是用户的决定；项目级 MCP 服务器同样要求该目录已信任。

由此得到第一条前提：**信任与根集合正交，但信任本身就是一份真实的宽松度授权。** 一个多根项目里只有主目录被信任是正常状态；"已信任"也不能当作参考根应当被无条件接纳的理由——它意味着的正是"少问、少隔离"。

## 决定

### 1. 导入携带根列表，不携带信任

`ForeignSessionInfo` 增加可选字段 `additionalDirectories`，语义是"除 `cwd` 之外的工作区目录，按源记录顺序"：

```ts
readonly additionalDirectories?: readonly string[];
```

它与 `SessionManager` 的同名 header 字段同名同义，因此下游不需要转换层。能确定时填值，确定不了就省略——省略即当前的单根行为。

- Codex store 的取值顺序：`threads.project_id` 非空时取该项目的 `project_roots.path`（按 `position`）；否则按 `cwd` 反查命中的项目；仍无则用 rollout 首行 `session_meta.payload.runtime_workspace_roots`；都没有就只有 `cwd`。
- 主目录始终从列表中剔除并做路径键去重，所以 `runtime_workspace_roots` 常常把 `cwd` 重复一遍也不会产生重复项。
- **不读取 `config.toml` 的 `trust_level`。** 它是逐路径宽松度，不是"这个根属于这个项目"的证据；把它当许可会在导入时伪造一条 MusePi 从未做过的判断，而它授权的内容（少问、加载目录内配置、注入 AGENTS.md）恰恰需要目标机器上的用户自己表态。导入不写 `~/.codex` 的任何文件。
- **不采纳 `projects.name` 作为会话名。** 实测该值是 `agent开发`，属于项目标签而非会话标签；会话名继续来自 thread 自身（`threads.title`、`session_index.jsonl` 的 `thread_name`、rollout 的 `thread_name_updated`）。否则同一项目下 N 个会话会被改成同一个名字。

### 2. 非主根经既有 `additionalDirectories` 落地

store 在自己的 `load()` 里把非主根交给 `manager.setAdditionalDirectories()`，再由既有的 `persistCopy` 写入 header——它已显式拷贝该字段（`session-manager.ts:1616-1618`），恢复侧由 `SessionManager.open` 经 `#setSessionFile` 读回（`:2758-2780`、`:1387`）。不新增 header 字段、不新增 RPC、不新增 store 方法。

`load()` 里有两处取值：优先用 `info.additionalDirectories`（列表阶段算好的），缺失时回退到同一 rollout 首行的 `runtime_workspace_roots`。这让"只给定 cwd 的调用方"仍然拿到多根，而列表与导入不会给出不同答案。

### 3. 顺序保留，但不宣示层级

MusePi 的 `SessionWorkspace` 明确"目录顺序稳定但不承载语义层级"（`session-workspace.ts:11`）。导入按源顺序写入，不重排，也不把 `position` 解释成优先级；每个参考根与主根在提示注入、技能合并、git 读数与 `@` 补全上地位相同。

### 4. 主目录与参考目录的存在性要求不同

这是刻意的非对称：

- **主目录**即使在本机不存在也保留。它决定会话归到哪个项目；换成 `fallbackCwd` 会把别人的会话塞进错误的项目（`foreign-session-import.ts:73-80` 已确立：只有源完全没记录 cwd 时才用 fallback）。
- **参考目录**同样保留，不做存在性裁剪。裁剪看似更安全，实则不可逆：外接盘或网络盘临时未挂载时，悄悄删掉一个根会改写用户的会话记录，而界面本可以如实显示"该根当前不存在"。清单阶段与导入阶段因此不会给出不同答案。

### 5. 路径必须先规范化再比较

Codex 的 `threads.cwd` 是 Windows 扩展长度路径（`\\?\D:\Projects\Agents\MusePi`），同一会话 rollout 首行是干净路径（`D:\Projects\Agents\MusePi`）。实测 `path.resolve` 原样保留该前缀，`path.relative(clean, ext)` 直接返回整条 ext 字符串（判定为互不包含），`path.parse(ext).root` 是 `\\?\D:\`——带前缀的 cwd 会算出不同的项目分组与不同的 session 目录 slug。

约定：store 产出 `cwd` 与 `additionalDirectories` 时一律经 `stripWindowsExtendedLengthPathPrefix`（`packages/utils/src/path.ts:9-28`）剥掉扩展长度前缀，`\\?\UNC\server\share` 收敛为 `\\server\share`。这两个字段的消费者是比较、分组与目录拼接，不是要在 Win32 长路径语义下打开文件；是否需要长路径访问是下游工具的事，不在导入契约里。

规范化之后再来比较：路径键按分隔符归一、去尾部斜杠，Windows 盘符/UNC 形式再转小写。项目归属的反查与去重都用这个键。

### 6. 目录准入必须显式调用，`SessionManager` 不代劳

`SessionManager.setAdditionalDirectories()` 只做规范化、去重与剔除主目录，**不做准入判定**：实测把用户主目录、文件系统根与 72 个目录一起交给它，全部被接受并写入 header。64 条上限与"拒绝主目录/文件系统根"都在 daemon 的 `session.create` 边界上（`daemon/server.ts:1964-1990` 调 `resolveWorkspaceDirectories` / `isSafeAdditionalDirectory`），`MAX_WORKSPACE_DIRECTORIES`（64，`workspace-registry.ts:36`）与 `requireSafeAdditionalDirectory` 的 realpath 检查（`:152-164`）都属于那一层。

因此导入不能只调 `setAdditionalDirectories` 就认为参考根合规，它要在调用前自己走同一套判定。既有代码给了两种取舍：`resolveWorkspaceDirectories` 对调用方显式传入的根是严格的，缺失或不合格即抛错（`workspace-registry.ts:193-223`）；继承来的项目根则先用 `isSafeAdditionalDirectory` 过滤、跳过坏根（`daemon/server.ts:1990`）。导入参考根属于后者——它们是来源记录的默认值，不是用户此刻的选择。主目录继续豁免"拒绝主目录/文件系统根"这一条。

差异只在一处：导入不因单个坏根失败。落在用户主目录、文件系统根或超限之外的根被丢弃，不阻塞整条导入。

**当前实现的缺口**（见"影响"）：`codex-session-store.ts` 直接调用 `setAdditionalDirectories`，还没有接这套准入判定，因此一个把项目根登记成 `D:\` 的 Codex 项目会被原样带进来。

## 边界（不做什么）

1. 不引入 `ForeignWorkspace` 之类的新类型；只给 `ForeignSessionInfo` 加一个可选有序数组。
2. 不把 Codex 的 `trust_level` 映射到 MusePi 的 `tools.approval` 或任何准入开关。两套概念回答不同的问题：Codex 的信任回答"这个目录下的会话该多宽松"，MusePi 的审批策略回答"这条工具调用要不要问用户"，而 `"trusted"` 这个字面值不携带足够信息去映射（它同时改变审批默认值、权限档、AGENTS.md 注入与目录内配置的效力）。导入不改动目标会话的审批策略。
3. 不把 `project_roots` 的 `position` 变成 MusePi 的项目属性，也不写 `projects.json`：导入是复制，不是接管别人的项目注册表。
4. 不做逐根选择 UI。选择粒度仍是"源 + 主目录"；按根勾选留给确有需要时再做。
5. 不改 `threads` 查询以外的 Codex 写面：`projects` / `project_roots` 只读，且只在两张表都存在时尝试——老版本 state 库缺失即退回 rollout 副本与单根。

## 理由

- **分组正确压过功能完整。** 一次导入出错的代价不是少挂一个目录，而是会话被归到错误项目后用户找不到它。所以主目录永不替换，也不拿 fallback 顶替。
- **加根是真实的权限变化。** 在 MusePi 里一个参考根带来读写可达、AGENTS.md 注入、技能合并与 `@` 补全；把它做成"导入时顺手带上的结果"会扩大 agent 的触达面。Codex 对此另设一道信任表态，MusePi 对多根没有对应的信任层，所以这里不照抄它"信任只影响一部分行为"的宽松。
- **不新造机制。** 多根在 MusePi 已经完整（header 字段、`getAdditionalDirectories`、`add/removeWorkspaceDirectory`、`session.directories.*` RPC、git 面板与 `@` 补全），缺口只在导入这一层没有传话。工作压在 `ForeignSessionStore` 的边界上，其余全部复用。
- **可回滚。** `additionalDirectories` 可选；省略即当前行为。不做改动的 store 继续工作，读到不含该字段的旧库也不会退化。

## 影响

- `packages/coding-agent/src/session/foreign-session-store.ts`：`ForeignSessionInfo` 新增 `additionalDirectories`，`load` 签名不变。
- `packages/coding-agent/src/session/codex-session-store.ts`：读取项目表与 rollout 副本、剔除主目录与去重、剥离扩展长度前缀；`load` 里播种参考根。
- `packages/coding-agent/src/session/foreign-session-identity.test.ts` 的 `CodexSessionStore workspace identity` 已有 7 条契约测试：前缀剥离（含 UNC）、项目根投影、`project_id` 优先于路径匹配、`threads` 表早于项目表的库、导入后 header 落盘、无项目表时回退 rollout、无任何记录时保持单根。
- 未实现，需要后续补齐：
  - **准入判定**：`codex-session-store.ts` 直接调 `setAdditionalDirectories`，未经 `isSafeAdditionalDirectory` 与 64 条上限过滤（第 6 节）。这也意味着"丢弃不合格根并计数"目前没有可丢弃的路径。
  - **已补齐**：`import.sources` 经 `foreignSessionRow()` 投影每个会话时带上 `additionalDirectories`（无额外根则省略），`ImportSessionsSetup` 的行上显示"将一并加入 N 个目录"，路径放在悬停标题里。契约测试：`packages/coding-agent/test/daemon/import-sources-roots.test.ts`（走真实 `import.sources` RPC）与 `apps/desktop/test/import-session-roots.test.tsx`（行渲染）。
  - `packages/coding-agent/CHANGELOG.musepi.md` 的 `[Unreleased]` 尚需一条用户可见说明：从 Codex 导入的会话会带回顾有工作目录。
