# P5 实施计划:会话级扩展热重载(HMR v2)

> 2026-08-16。基于 Phase 0 代码取证,不含过度设计。目标:**已运行会话内扩展代码
> (tools/commands/handlers)热替换**——补齐 P4 v1(缓存级 + GUI 即时)缺的最后一块。
> 范围决策全部有证据;三条用户补充项经调研后逐条裁决(见 §2)。

## 0. Phase 0 事实(已验证,代码证据)

| 事实 | 证据 | 结论 |
|---|---|---|
| Bun 模块缓存同路径命中 | 实测:`import(path)` 两次同一实例 | 重载必须绕过 |
| `?mtime=` query 绕过缓存 | 实测:不同 query 重新执行 | 绕过方案 |
| **加载层已有 mtime cache-bust** | `extensibility/plugins/legacy-pi-compat.ts` `loadLegacyPiModule`:`import(\`${specifier}?mtime=...\`)` | 重载**无需新机制**,复用现有 query |
| 注册流向 | 扩展工厂 → `extension.{tools,commands,handlers,...}` Maps → `ExtensionRunner` 聚合 → `onToolRegistered` listener 推入会话 `#toolRegistry`(name-keyed Map) | 工具移除 = `registry.delete(name)`(`session-tools.ts:543` 先例) |
| 忙闲检测 | `agentSession.isStreaming`(agent.state.isStreaming OR `#promptInFlightCount>0`);daemon 经 `live.agentSession` 读(`server.ts:1584`) | 门控可行,无现成 reload 锁(需新增简单标志) |
| MCP 连接所有权 | `MCPManager` 按 cwd 共享,会话不拥有;`SourceMeta` 是**配置**来源非扩展来源 | 见 §2-③ 裁决 |

## 1. 能保证 / 不保证(如实标注)

**能保证**:扩展代码全量热替换(复用 mtime-bust 加载);进行中 tool call 不中断(工具按名替换,新定义对下次调用生效);忙会话不半替换(门控);GUI 已即时(P4)。

**不能保证(文档化为边界)**:
- 扩展内存态不迁移(重载重建实例;扩展自行持久化到 settings/磁盘);
- 在途异步副作用(已发出的 fetch/定时器)不回收 —— 尽力而为,非事务性;
- handler 重载存在 ~ms 级"新旧双跑"窗口(handlers 是数组语义,先推新后删旧);
- 核心代码(daemon/GUI 自身)不热重载(应用开发非扩展)。

## 2. 三条用户补充项裁决(调研后)

1. **Bun 缓存绕过 → 做(零成本)**:加载层已带 `?mtime=` query;重载时机 = 文件变更 → mtime 变 → 天然新实例。计划仅在契约文档写明,不写新代码。
2. **忙/闲门控 → 做(最小)**:`AgentSession` 加 `#extensionReloadPending` 标志。忙(`isStreaming`)时置 pending 跳过;`agent_end` 会话事件触发补做(pending 单槽,多次变更合并)。不搞队列/锁。
3. **MCP 连接按扩展关闭 → 不做(调研后排除)**:MCP 连接由 mcp 配置层启动、`MCPManager` 按 cwd **多会话共享**,`SourceMeta` 是配置来源(非扩展来源)。按扩展关闭会**误伤共享连接的其它会话**;扩展自身代码建立的连接无法可靠追踪。边界:扩展自行管理自有连接;MCP server 生命周期由配置层负责,扩展重载不触碰。

## 3. 分阶段实施

### Phase 1:ExtensionRunner 按 path 重载(核心,无会话耦合)

**改** `extensibility/extensions/runner.ts`:
- 新增 `reloadExtension(entryPath, cwd): Promise<{ removedTools: string[]; errors: string[] }>`:
  1. 定位 `extensions[]` 中 `resolvedPath === entryPath` 的旧 Extension(无则空操作);
  2. 收集旧 `extension.tools` 的 name 列表(`removedTools`);
  3. 旧 handlers 从各事件数组按 path 过滤移除(防双跑);
  4. `loadExtensions([entryPath], cwd)` 重新加载(mtime-bust 天然新模块实例),工厂执行 → 新注册项经既有 listener 推入(工具按名覆盖);
  5. `extensions[]` 替换旧条目;
  6. 返回 `removedTools`(供会话侧删旧名)。
- 复用 `runner.ts:365 #reloadHandler` 的既有语义,不新增并发原语。

**改** `session/agent-session.ts`:
- 新增 `reloadExtension(path: string): Promise<...>`:调 runner.reloadExtension → 对 `removedTools` 逐一 `session-tools #toolRegistry.delete(name)`(`:543` 先例;`#extensionMcpTools.delete` 同款)→ 返回结果。
- 忙闲门控:`#extensionReloadPending` 标志;`isStreaming` 时置 pending;`agent_end` 事件处理器里若 pending → 执行补做。

**验证**:runner 级单测(fake 工具注册表:重载后旧名删除、新名可查、handler 无双跑);会话级集成(起会话 → 改扩展工具文件 → 断言新工具可调用)。

### Phase 2:daemon 枚举活跃会话 + 会话内通知

**改** `daemon/server.ts`:
- **Reload 目标判定(审计划修正,不依赖 fs.watch filename)**:Windows recursive watch 的
  `filename` 回调不可靠(常为空/短名),且目录内任意文件变更(组件 .tsx、配置)≠入口变更。
  改为:watcher 触发(仅作"有变化"信号)→ 对活跃会话已加载的扩展做**入口 stat 对比**
  (记录上次加载时的入口 mtime,变了才 reload 该 path)。每次扩展一次 stat,可忽略。
- `#scheduleExtensionReload`(已有)清缓存/广播后,枚举 `host.allSessions()`,对每个
  `live.agentSession` 按入口 mtime 变化执行 `reloadExtension(path)`。
- 会话内通知:重载完成后 emit 会话事件 `extensions.reloaded`(payload:
  `{ extensionPath, errors }`),GUI/TUI 侧可刷新工具面板。

**验证**:E2E(隔离 daemon + 会话 + 改扩展入口 → 断言会话新工具生效 + 忙会话跳过/补做)。

## 2b. 子模块热重载边界(审计划新增,实测证实)

Bun 的模块缓存:`import(path)` 同路径命中进程缓存;`?mtime=` query 只对**入口 specifier**
生效 —— 入口内部 `import "./helper.ts"` 的子模块按裸路径命中缓存(实测:入口 mtime-bust
重载后子模块不重新执行)。因此:

- **能保证**:扩展**入口文件**变更 → 全量热替换;
- **不能保证**:入口 import 的子模块变更不热生效(需 touch 入口或重启会话)—— 这是 Bun
  进程级模块图语义,与既有扩展加载行为一致(非 P5 新增缺陷);
- **DSH 对比**:DSH 的 `cordis-host-runner` 用 **vm 沙箱**,每次重载是全新模块图,**子模块
  天然重新执行** —— 这是 vm 沙箱的真实优势(不止隔离,还规避模块缓存);代价是沙箱复杂度
  与跨 realm 限制。musepi 取舍:进程内 import(简单、共享 react 实例),接受子模块边界,
  文档化为扩展契约(多文件扩展改子模块需 touch 入口)。

### Phase 3:规则与文档

- `AGENTS.md` GUI 规则区:补 `registerComponent`/HMR 行为(扩展文件变更 → UI ~1s / 会话工具下次调用生效)。
- `docs/extensions-dev.md §6`:追加 v2 契约(重载边界:内存态、在途副作用、handler 双跑窗口、忙会话门控、MCP 不随扩展关闭)。
- `docs/extension-hmr-v2-plan.md`(本文档)完成后归档为设计记录。

## 4. 反模式守卫(不做清单)

- 不引入事务性回滚/快照(内存态迁移);
- 不新增并发锁/队列原语(单 pending 标志足够);
- 不新建跨进程模块图(现有 mtime query 已满足);
- 不实现 MCP 按扩展关闭(§2-③);
- 不热重载核心代码;
- 不修改 P4 v1 已交付的 watcher/事件通道(仅扩展其回调)。

## 5. 风险与性能

- **注册表一致性**:工具 name-keyed 覆盖(新先于删,无缺工具窗口);handler ms 级双跑窗口文档化;忙会话门控杜绝半替换。
- **性能**:重载仅文件变更时触发(单文件 mtime-bust import),无轮询;pending 单槽防风暴。
