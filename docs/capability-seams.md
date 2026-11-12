# 能力缝索引（Capability Seams）

每个内置能力在自己的权威注册表文件头部带六字段缝声明（名称+ns / 输入 / 输出 / 生命周期 / 启停 / 冲突 + 检视入口）；本页只做锚点索引，不复制声明内容。格式定义与七域盘点：`docs/review/0.5.0-m2.4-capability-seams.md`（§3）。纪律见根 `AGENTS.md`「能力缝声明」条。

| 域 | 权威锚点 | 声明位置 |
|---|---|---|
| daemon L2 服务（RPC 面） | `packages/coding-agent/src/daemon/services/types.ts`（`DaemonService` 接口） | 各服务文件头注释（样板：`schedule-service.ts`） |
| GUI 编辑器语言智能 | `packages/coding-agent/src/daemon/services/editor-service.ts`（`EditorService`；`editor.sync` / `editor.saved` / `editor.hover` / `editor.completion` / `editor.definition` / `editor.implementation` / `editor.typeDefinition` / `editor.references` / `editor.rename`） | 同文件头部 |
| 设计体系注册表（M3 §3） | `packages/coding-agent/src/presets/design-systems.ts`（内置预设表 + 扩展注册表） | 同文件头部 |
| 内置工具 | `packages/coding-agent/src/tools/index.ts`（`BUILTIN_TOOLS` / `HIDDEN_TOOLS` / `isToolAllowed`） | 同文件头部；有副作用的工具执行前 flush 唯一 start intent 与 daemon journal，只有只读工具声明 `requiresDurableIntent: false`，未知插件/MCP 工具默认需要屏障 |
| 斜杠命令 | `packages/coding-agent/src/slash-commands/builtin-registry.ts` | 同文件头部 |
| hooks 引擎 | `packages/coding-agent/src/extensibility/hooks/types.ts`（`HookEvent` union） | 同文件头部 |
| channels（IM 通道） | `packages/coding-agent/src/channels/types.ts`（`ChannelAdapter`） | 同文件头部 |
| 扩展 API（register* 面） | `packages/coding-agent/src/extensibility/extensions/types.ts`（`ExtensionAPI`） | 同文件头部 + `docs/extensions-dev.md` |
| 会话提示词宿主与注册表（section/context/variable/tool、scope/lane/owner/cacheScope） | `packages/coding-agent/src/prompts/host.ts`（`PromptHost`；存储 `store.ts`，兼容注册表 `registry.ts`，顺序 `orders.ts`）＋ 核心提示词包装载表 `packages/coding-agent/src/bundled-plugins/loader.ts`（`SESSION_PROMPT_PACKAGE_DIRS`） | `host.ts` / `store.ts` 文件头注释 + `docs/extensions-dev.md` §20 |
| GUI 渲染侧（widget/插槽/节点 kind） | `packages/client-core/src/widgets/registry.ts`、`packages/collab-proto/src/extension-slots.ts` | 各文件头部 |
| 编译插件的宿主模块表 | `packages/collab-proto/src/extension-host-modules.ts`（`EXTENSION_HOST_MODULES` / `matchExtensionHostModule`） | 同文件头部；渲染端实例表见 `packages/desktop-app/src/lib/host-modules.ts` |
| Android 模拟器插件 | `packages/coding-agent/src/bundled-plugins/android-emulator/index.ts`（扩展隔离的 RPC / `android_emulator`） | 同文件头部 |
| 可视化插件（卡片 + 内联页面） | `packages/coding-agent/src/bundled-plugins/visuals/index.ts`（`widget` 工具 / 类型表） | 同文件头部 |
| 看板插件 | `packages/coding-agent/src/bundled-plugins/board/index.ts`（`board` 工具 / 看板存储） | 同文件头部 |
| Cordis preset 组合运行时 | `packages/coding-agent/src/extensibility/plugins/preset-runtime.ts`（`CordisPresetRuntime`） | 同文件头部 |
| Cordis 会话页 | `packages/desktop-app/src/plugins/chat-view/index.ts`（`app.chat`） | 同文件头部 |
| Cordis 能力中心 | `packages/desktop-app/src/plugins/capability-center/index.ts`（`app.capability`） | 同文件头部 |
| Cordis 右栏壳 | `packages/desktop-app/src/plugins/panel/index.ts`（`panel.shell`） | 同文件头部；最大化由 `lib/panel-maximize.ts` 宿主控制器提交 |
| Cordis 内置浏览器 UI | `packages/desktop-app/src/plugins/browser-ui/index.ts`（`panel.tab.browser` / `browser.host`） | 同文件头部；页面与常驻 guest 宿主分离，store 经 `MusePiManagedBrowserHost` 共享 |
| Cordis 文件工作区 | `packages/desktop-app/src/plugins/file-workspace/index.ts`（`panel.tab.files`） | 同文件头部 |
| Cordis 会话管理 | `packages/desktop-app/src/plugins/session-manager/index.ts`（`settings.tab.sessions`） | 同文件头部；接管内置会话设置页，插件缺失或编译失败时宿主回退 `SessionsSection` |
| Cordis 记忆设置页 | `packages/desktop-app/src/plugins/memory/index.ts`（`settings.tab.memory`） | 同文件头部；接管内置记忆设置页，插件缺失或编译失败时宿主回退 `MemorySection` |
| Cordis 会话信息分区 | `packages/desktop-app/src/plugins/session-info-plugins/index.ts`（`chat.session-info.plugins`） | 同文件头部；卡片只透传只读读数，插件停用/编译失败时回退内置列表 |
| Cordis 会话信息任意分区 | `packages/desktop-app/src/components/session-info-card.tsx`（`chat.session-info.<id>` 前缀自动挂载） | 同文件头部；按前缀渲染所有贡献，`chat.session-info.plugins` 保留内置回退，插件新增分区无需宿主改动 |
| Cordis 会话信息子代理分区 | `packages/desktop-app/src/plugins/session-info-agents/index.ts`（`chat.session-info.agents`） | 同文件头部；宿主只透传只读投影（百分比/阻塞/耗时/成本），插件停用或编译失败时回退内置分区 |
| Cordis 主题 bundle（滚动进度轨） | `packages/desktop-app/src/plugins/ui-theme/index.ts`（`app.overlay` + `settings.appearance.item`） | 同文件头部；轨道组件 `rail.tsx`、CSS `rail.css`、皮肤目录 `skins.ts`、外观分区 `settings.tsx` 全归该 bundle；停用/编译失败时 `app.overlay` 回退内置 `<FloatingScrollbar/>`，外观分区消失 |
| 滚动条皮肤贡献（daemon 主题插件） | `packages/coding-agent/src/extensibility/extensions/types.ts`（`registerScrollbarSkin` / `ctx.skins.register`） | 类型声明 + `docs/extensions-dev.md` §9.2；皮肤经 `extensions.list.scrollbarSkins` 下发，contributed → imported → built-in 按 id 合并 |
| Cordis 二级左栏面板 | `packages/desktop-app/src/plugins/scheduled-panel/index.ts`（`sidebar.panel.scheduled`）、`packages/desktop-app/src/plugins/capability-panel/index.ts`（`sidebar.panel.capability`）；前缀声明在 `packages/collab-proto/src/extension-slots.ts` | 同文件头部；宿主按 `data-panel` 选面板，插件缺失/编译失败回退内置组件；`task-nav` 与 `capability-nav` 经宿主模块表共享（页面与面板是独立 React 子树）；悬停预览按 rail 按钮的 `panelId` 派发 |
| 第一方子系统插件与 entry 组件 | `packages/coding-agent/src/bundled-plugins/*/package.json`、`packages/coding-agent/src/daemon/cordis-dynamic-plugins.ts`（`musepi.host` / `musepi.components` / `CordisDynamicPluginRuntime`） | 各包入口与运行时文件头部 |
| 记忆后端 provider seam | `packages/coding-agent/src/memory-backend/providers.ts`（`MemoryBackendProvider` / `registerMemoryBackendProvider`） | 同文件头部；插件可替换内置后端或新增 id，`memory.backend` 枚举与设置选项由注册表合并，卸载即恢复。`memory.*` 是核心契约，路由只调用活动后端；`workspaceDir` 可选能力决定 `memory.workspace*` 是否可用 |
| 热重载服务（`ctx.hmr`） | `packages/coding-agent/src/bundled-plugins/hmr/index.ts`（host 插件，`provide: ["hmr"]`）+ `extensibility/plugins/hmr/service.ts` | 同文件头部；服务对象经 `extensibility/plugins/runtime/host-services.ts` 发布，插件与宿主都从注册表读取；daemon 收到批次后失效扩展缓存并广播 `extensions.changed`，TUI 只失效发现缓存 |
| 宿主级（host-half）内置插件 | `packages/coding-agent/src/extensibility/plugins/runtime/host-runtime.ts`（`ensureHostPlugins` / `reloadHostPlugins` / `inspectHostPlugins`）、清单 `musepi.scope: "host"`、能力 `host-plugins` | 同文件头部；进程级 cordis 运行时经 `mountPlugin` 装载一次（daemon 开监听前、其它宿主首个会话前），fiber 与服务发布随 `resetHostPlugins` 回收；HMR 批次按包目录内文件/入口/manifest 与有效配置差异选中记录原地替换（失败回滚旧模块；无关配置保存不选中，亦不触发 HMR 重启）；包外宿主模块与 `hmr` 提供者的变更经 `ctx.hmr.requestRestart` 交给宿主决定是否重启；宿主包只进 `host-plugins` 能力（标记 `hidden`，不进能力列表 UI），会话发现面 `extension-modules` 不含它们；扩展中心经 `inspectHostPlugins` 读取宿主 fiber 状态；首个消费者为 `bundled-plugins/memory-sharpshooter` 注册后端 provider |
| 第三方 Cordis 插件适配 | `packages/coding-agent/src/extensibility/plugins/compat/modern-web-guidance-adapter.ts`（`modern_web_guidance` / 同名虚拟技能） | 同文件头部；安装缓存适配见 `third-party-cordis.ts` |
| 外部产品子智能体 | `packages/coding-agent/src/task/types.ts`（`task.external-subagent` / `AgentDefinition.external`）、`packages/coding-agent/src/task/external-executable-probe.ts`（`probeExecutable`） | 同文件 `ExternalSubagentUpdate` 前六字段声明；探针声明见探针文件头部 |
| 连接器目录（catalog / state / runtime projection） | `packages/coding-agent/src/daemon/services/connector-catalog-service.ts`（`connectors.catalog.*` / `connect` / `disconnect` / `setEnabled`）＋ `packages/coding-agent/src/connectors/*` | 同文件头部；MCP provider 见 `discovery/connector-catalog.ts`，agent 工具见 `tools/connector-catalog.ts`，`docs/connectors.md` |

存量声明按「触及时顺手补」推进，不做批量回填；新增能力无声明不得过评审。

## 易变 context 的归属

易变 context 按 owner 分担。AGENTS context 文件与工作区树、嵌套活动仓库是会话 `PromptHost` 上的 `project:context` / `project:active-repo` snapshot 区块（owner `session:project-context`；custom prompt 布局仍在自己的模板中渲染 context 文件）。记忆指令、auto-learn 指南、MCP 路由指引、MCP 服务器说明（按名称排序、4000 字符截断在宿主侧施加）与默认用户 append 由 `host-integrations` 插件的 `host:runtime-context` 区块（order 250）唯一渲染。`packages/coding-agent/src/system-prompt.ts` 的 `buildSystemPrompt` 仍装配日期、cwd、skills/rules、工具清单与 persona/预设数据；这些未插件化。plan/goal/vibe 运行时上下文由 `packages/coding-agent/src/session/agent-session.ts` 以 custom 消息持久化——流式 steer、模式退出 marker 与 resume/branch 去重依赖该传输——最近一次已投递副本内容相同时跳过，内容变化时只投递最新副本。
