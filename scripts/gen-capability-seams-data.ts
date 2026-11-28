/**
 * Declarative source for the capability-seams index.
 *
 * The generator (scripts/gen-capability-seams.ts) renders this into the table
 * inside `docs/capability-seams.md`. Cells hold verbatim prose interleaved with
 * `{ pkg, path }` anchors so the generated table points at the package that owns
 * the code, not at a path that moves when a directory is renamed.
 */

export interface SeamAnchor {
	/** Workspace package name; resolved to its directory at generation time. */
	readonly pkg: string;
	/** Path inside that package. */
	readonly path: string;
}

/** One cell: verbatim prose interleaved with package-relative anchors. */
export type SeamCell = string | SeamAnchor;

export interface SeamRow {
	readonly domain: string;
	readonly anchor: readonly SeamCell[];
	readonly declaration: readonly SeamCell[];
}

export const SEAM_ROWS: readonly SeamRow[] = [
	{
		domain: "daemon L2 服务（RPC 面）",
		anchor: [{ pkg: "@musepi/pi-coding-agent", path: "src/daemon/services/types.ts" }, "（`DaemonService` 接口）"],
		declaration: ["各服务文件头注释（样板：`schedule-service.ts`）"],
	},
	{
		domain: "GUI 编辑器语言智能",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/daemon/services/editor-service.ts" },
			"（`EditorService`；`editor.sync` / `editor.saved` / `editor.hover` / `editor.completion` / `editor.definition` / `editor.implementation` / `editor.typeDefinition` / `editor.references` / `editor.rename`）",
		],
		declaration: ["同文件头部"],
	},
	{
		domain: "设计体系注册表（M3 §3）",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/presets/design-systems.ts" },
			"（内置预设表 + 扩展注册表）",
		],
		declaration: ["同文件头部"],
	},
	{
		domain: "内置工具",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/tools/index.ts" },
			"（`BUILTIN_TOOLS` / `HIDDEN_TOOLS` / `isToolAllowed`）",
		],
		declaration: [
			"同文件头部；有副作用的工具执行前 flush 唯一 start intent 与 daemon journal，只读工具可声明 `requiresDurableIntent: false` 或按参数豁免，未知插件/MCP 工具默认需要屏障；LSP 仅只读 action 豁免，raw/未知 action 与写操作保留",
		],
	},
	{
		domain: "斜杠命令",
		anchor: [{ pkg: "@musepi/pi-coding-agent", path: "src/slash-commands/builtin-registry.ts" }],
		declaration: ["同文件头部"],
	},
	{
		domain: "hooks 引擎",
		anchor: [{ pkg: "@musepi/pi-coding-agent", path: "src/extensibility/hooks/types.ts" }, "（`HookEvent` union）"],
		declaration: ["同文件头部"],
	},
	{
		domain: "命令钩子（Claude Code / Codex / 目录脚本）",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/extensibility/hooks/command/" },
			"（config/matcher/executor/codec/merge/engine/bridge）＋ ",
			{ pkg: "musepi-hooks-claude-code", path: "" },
			"、",
			{ pkg: "musepi-hooks-codex", path: "" },
			"、",
			{ pkg: "musepi-hooks-scripts", path: "" },
		],
		declaration: [
			"`command/types.ts` 与 `command/bridge.ts` 文件头；共享引擎，方言只差 matcher 模式与 `${…}` 替换；三个包均为 `presetOnly`",
		],
	},
	{
		domain: "channels（IM 通道）",
		anchor: [{ pkg: "@musepi/pi-coding-agent", path: "src/channels/types.ts" }, "（`ChannelAdapter`）"],
		declaration: ["同文件头部"],
	},
	{
		domain: "扩展 API（register* 面）",
		anchor: [{ pkg: "@musepi/pi-coding-agent", path: "src/extensibility/extensions/types.ts" }, "（`ExtensionAPI`）"],
		declaration: ["同文件头部 + `docs/extensions-dev.md`"],
	},
	{
		domain: "会话提示词宿主与注册表（section/context/variable/tool、scope/lane/owner/cacheScope）",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/prompts/host.ts" },
			"（`PromptHost`；存储 `store.ts`，兼容注册表 `registry.ts`，顺序 `orders.ts`）＋ 核心提示词包装载表 ",
			{ pkg: "@musepi/pi-coding-agent", path: "src/plugins-runtime/loader.ts" },
			"（`SESSION_PROMPT_PACKAGE_DIRS`）",
		],
		declaration: ["`host.ts` / `store.ts` 文件头注释 + `docs/extensions-dev.md` §20"],
	},
	{
		domain: "GUI 渲染侧（widget/插槽/节点 kind）",
		anchor: [
			{ pkg: "@musepi/client-core", path: "src/widgets/registry.ts" },
			"、",
			{ pkg: "@musepi/collab-proto", path: "src/extension-slots.ts" },
		],
		declaration: ["各文件头部"],
	},
	{
		domain: "编译插件的宿主模块表",
		anchor: [
			{ pkg: "@musepi/collab-proto", path: "src/extension-host-modules.ts" },
			"（`EXTENSION_HOST_MODULES` / `matchExtensionHostModule`）",
		],
		declaration: ["同文件头部；渲染端实例表见 ", { pkg: "@musepi/desktop-app", path: "src/lib/host-modules.ts" }],
	},
	{
		domain: "Android 模拟器插件",
		anchor: [{ pkg: "musepi-android-emulator", path: "index.ts" }, "（扩展隔离的 RPC / `android_emulator`）"],
		declaration: ["同文件头部"],
	},
	{
		domain: "生成式 UI 插件（会话可视化：`ui` 块 + 内联页面）",
		anchor: [{ pkg: "musepi-visuals", path: "index.ts" }, '（`widget` 工具 / `provide: "genui"`）'],
		declaration: ["同文件头部"],
	},
	{
		domain: "看板插件（依赖 `genui`：卡片类型表 + 持久化画布）",
		anchor: [
			{ pkg: "musepi-board", path: "index.ts" },
			"（`board` 工具 / `tool.ts` / 看板存储 ",
			{ pkg: "@musepi/pi-coding-agent", path: "src/board/store.ts" },
			"）",
		],
		declaration: ["同文件头部"],
	},
	{
		domain: "Cordis preset 组合运行时",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/extensibility/plugins/preset-runtime.ts" },
			"（`CordisPresetRuntime`）",
		],
		declaration: ["同文件头部"],
	},
	{
		domain: "预设自带 MCP 服务器 / 文件技能",
		anchor: [
			{ pkg: "musepi-mcp-client", path: "index.ts" },
			"（一行一服务器，`session_start` 内 `registerMcpServer`）、",
			{ pkg: "musepi-skill-filesystem", path: "index.ts" },
			"（`roots` 快照 → `registerSkill`）",
		],
		declaration: ["各包入口头部；均为 `presetOnly`，随 preset generation 装载与回收"],
	},
	{
		domain: "Cordis 会话页",
		anchor: [{ pkg: "musepi-chat-view", path: "index.ts" }, "（`main.conversation`）"],
		declaration: ["同文件头部"],
	},
	{
		domain: "Cordis 输入卡",
		anchor: [
			{ pkg: "musepi-chat-view", path: "index.ts" },
			"（`conversation.composer.bar`，与 `main.conversation` 同插件）",
		],
		declaration: ["同文件头部"],
	},
	{
		domain: "Cordis 空态席位",
		anchor: [
			{ pkg: "@musepi/desktop-app", path: "src/components/HeroComposer.tsx" },
			"（`conversation.hero.brand.mark/workspace/agentPreset/options`，宿主内建回退）",
		],
		declaration: [
			"席位声明在 ",
			{ pkg: "@musepi/collab-proto", path: "src/extension-slots.ts" },
			"；插件占住 single 席位即替换对应控件",
		],
	},
	{
		domain: "Cordis 能力中心",
		anchor: [{ pkg: "musepi-capability-center", path: "index.ts" }, "（`main.capability`）"],
		declaration: ["同文件头部"],
	},
	{
		domain: "Cordis 右栏壳",
		anchor: [{ pkg: "musepi-panel", path: "index.ts" }, "（`panel.shell`）"],
		declaration: ["同文件头部；最大化由 `lib/panel-maximize.ts` 宿主控制器提交"],
	},
	{
		domain: "Cordis 内置浏览器 UI",
		anchor: [{ pkg: "musepi-browser-ui", path: "index.ts" }, "（`panel.tab.browser` / `browser.host`）"],
		declaration: ["同文件头部；页面与常驻 guest 宿主分离，store 经 `MusePiManagedBrowserHost` 共享"],
	},
	{
		domain: "Cordis 文件工作区",
		anchor: [{ pkg: "musepi-file-workspace", path: "index.ts" }, "（`panel.tab.files`）"],
		declaration: ["同文件头部"],
	},
	{
		domain: "Cordis 会话管理",
		anchor: [{ pkg: "musepi-session-manager", path: "index.ts" }, "（`settings.section`，id `sessions`）"],
		declaration: ["同文件头部；接管内置会话设置页，插件缺失或编译失败时宿主回退 `SessionsSection`"],
	},
	{
		domain: "Cordis 连接器设置页",
		anchor: [{ pkg: "musepi-connectors-settings", path: "index.ts" }, "（`settings.section`，id `connectors`）"],
		declaration: [
			"同文件头部；原位接管内置连接器页，停用/编译失败回退 `ConnectorsSection`；页面实现暂由宿主源持有、构建期内联",
		],
	},
	{
		domain: "Cordis 索引库设置页",
		anchor: [{ pkg: "musepi-index-library", path: "index.ts" }, "（`settings.section`，id `indexes`）"],
		declaration: ["同文件头部；原位接管内置索引库页，停用/编译失败回退 `IndexesSection`"],
	},
	{
		domain: "Cordis 记忆设置页",
		anchor: [{ pkg: "musepi-memory", path: "index.ts" }, "（`settings.section`，id `memory`）"],
		declaration: ["同文件头部；接管内置记忆设置页，插件缺失或编译失败时宿主回退 `MemorySection`"],
	},
	{
		domain: "Cordis 会话信息分区",
		anchor: [{ pkg: "musepi-session-info-plugins", path: "index.ts" }, "（`chat.session-info.plugins`）"],
		declaration: ["同文件头部；卡片只透传只读读数，插件停用/编译失败时回退内置列表"],
	},
	{
		domain: "Cordis 会话信息任意分区",
		anchor: [
			{ pkg: "@musepi/desktop-app", path: "src/components/session-info-card.tsx" },
			"（`chat.session-info.<id>` 前缀自动挂载）",
		],
		declaration: [
			"同文件头部；按前缀渲染所有贡献，`chat.session-info.plugins` 保留内置回退，插件新增分区无需宿主改动",
		],
	},
	{
		domain: "Cordis 会话信息子代理分区",
		anchor: [{ pkg: "musepi-session-info-agents", path: "index.ts" }, "（`chat.session-info.agents`）"],
		declaration: ["同文件头部；宿主只透传只读投影（百分比/阻塞/耗时/成本），插件停用或编译失败时回退内置分区"],
	},
	{
		domain: "Cordis 主题 bundle（滚动条皮肤）",
		anchor: [{ pkg: "musepi-ui-theme", path: "index.ts" }, "（`settings.item.appearance.rail`）"],
		declaration: [
			"同文件头部；皮肤目录 `skins.ts`、配方 CSS `skins.css`、外观分区 `settings.tsx` 全归该 bundle；滚动条本身是原生的（",
			{ pkg: "@musepi/client-core", path: "src/styles/base.css" },
			"），停用/编译失败时外观分区消失，`classic` 配方与原生条仍工作",
		],
	},
	{
		domain: "滚动条皮肤贡献（daemon 主题插件）",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/extensibility/extensions/types.ts" },
			"（`registerScrollbarSkin` / `ctx.skins.register`）",
		],
		declaration: [
			"类型声明 + `docs/extensions-dev.md` §9.2；皮肤经 `extensions.list.scrollbarSkins` 下发，contributed → imported → built-in 按 id 合并",
		],
	},
	{
		domain: "Cordis 二级左栏面板",
		anchor: [
			{ pkg: "musepi-scheduled-panel", path: "index.ts" },
			"（`sidebar.panel.scheduled`）、",
			{ pkg: "musepi-capability-panel", path: "index.ts" },
			"（`sidebar.panel.capability`）；前缀声明在 ",
			{ pkg: "@musepi/collab-proto", path: "src/extension-slots.ts" },
		],
		declaration: [
			"同文件头部；宿主按 `data-panel` 选面板，插件缺失/编译失败回退内置组件；`task-nav` 与 `capability-nav` 经宿主模块表共享（页面与面板是独立 React 子树）；悬停预览按 rail 按钮的 `panelId` 派发",
		],
	},
	{
		domain: "第一方子系统插件与 entry 组件",
		anchor: [
			"`packages/coding-agent/src/plugins/*/package.json`、",
			{ pkg: "@musepi/pi-coding-agent", path: "src/daemon/cordis-dynamic-plugins.ts" },
			"（`musepi.host` / `musepi.components` / `CordisDynamicPluginRuntime`）",
		],
		declaration: ["各包入口与运行时文件头部"],
	},
	{
		domain: "记忆后端 provider seam",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/memory-backend/providers.ts" },
			"（`MemoryBackendProvider` / `registerMemoryBackendProvider`）",
		],
		declaration: [
			"同文件头部；插件可替换内置后端或新增 id，`memory.backend` 枚举与设置选项由注册表合并，卸载即恢复。`memory.*` 是核心契约，路由只调用活动后端；`workspaceDir` 可选能力决定 `memory.workspace*` 是否可用",
		],
	},
	{
		domain: "设置描述符注册表（core / provider / extension 组合）",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/config/settings-registry.ts" },
			"（`SettingsRegistry` / `settingsRegistry`）",
		],
		declaration: [
			"同文件头部；核心 schema 在模块尾部登记为 `core`，provider/extension 后续登记，跨来源重复键拒绝、同来源按 owner 计数（多会话挂载同一扩展时先卸载的会话不会摘掉仍在使用的那份）；`getUi` / `getType` / `getDefault` / `getPathsForTab`、daemon `settings.schema` 与 TUI 设置适配器都读这里，插件装卸经 `onDidChange` 失效 TUI 缓存。`registerSetting` 现在把扩展设置登记进同一注册表，`ui.condition` 支持声明式 `{ key, equals / notEquals / in }`，GUI 与 TUI 共用一个求值器。值仍归 `Settings`（`getSettingValue` / `setSettingValue` 兼容 schema 外键），描述符只拥有元数据与默认值；移除描述符不删除已存值。首个迁移项：`musemem.globalScope`、Mnemopi 的 17 行与 Hindsight 的 10 行由各自插件注册（声明式后端条件）；核心保留值与默认值，插件缺席时只隐藏界面、不改变行为",
		],
	},
	{
		domain: "热重载服务（`ctx.hmr`）",
		anchor: [
			{ pkg: "musepi-hmr", path: "index.ts" },
			'（host 插件，`provide: ["hmr"]`）+ `extensibility/plugins/hmr/service.ts`',
		],
		declaration: [
			"同文件头部；服务对象经 `extensibility/plugins/runtime/host-services.ts` 发布，插件与宿主都从注册表读取；daemon 收到批次后失效扩展缓存并广播 `extensions.changed`，TUI 只失效发现缓存",
		],
	},
	{
		domain: "宿主级（host-half）内置插件",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/extensibility/plugins/runtime/host-runtime.ts" },
			'（`ensureHostPlugins` / `reloadHostPlugins` / `inspectHostPlugins`）、清单 `musepi.scope: "host"`、能力 `host-plugins`',
		],
		declaration: [
			"同文件头部；进程级 cordis 运行时经 `mountPlugin` 装载一次（daemon 开监听前、其它宿主首个会话前），fiber 与服务发布随 `resetHostPlugins` 回收；ensure/reload/reset 共用生命周期队列，服务名冲突拒绝并清理，异步 stop 等待完成，替换失败保留旧实例且不重放 apply，注册恢复失败时请求重启；HMR 批次按包目录内文件/入口/manifest 与有效配置差异选中记录原地替换（失败回滚旧模块；无关配置保存不选中，亦不触发 HMR 重启）；包外宿主模块与 `hmr` 提供者的变更经 `ctx.hmr.requestRestart` 交给宿主决定是否重启，请求去重保留，`acknowledgeRestart` 确认后移除，dispose 清空；宿主包只进 `host-plugins` 能力（标记 `hidden`，不进能力列表 UI），会话发现面 `extension-modules` 不含它们；扩展中心经 `inspectHostPlugins` 读取宿主 fiber 状态；首个消费者为 `plugins/prompt/memory-sharpshooter` 注册后端 provider",
		],
	},
	{
		domain: "第三方 Cordis 插件适配",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/extensibility/plugins/compat/modern-web-guidance-adapter.ts" },
			"（`modern_web_guidance` / 同名虚拟技能）",
		],
		declaration: ["同文件头部；安装缓存适配见 `third-party-cordis.ts`"],
	},
	{
		domain: "外部产品子智能体",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/task/types.ts" },
			"（`task.external-subagent` / `AgentDefinition.external`）、",
			{ pkg: "@musepi/pi-coding-agent", path: "src/task/external-executable-probe.ts" },
			"（`probeExecutable`）",
		],
		declaration: ["同文件 `ExternalSubagentUpdate` 前六字段声明；探针声明见探针文件头部"],
	},
	{
		domain: "连接器目录（catalog / state / runtime projection）",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/daemon/services/connector-catalog-service.ts" },
			"（`connectors.catalog.*` / `connect` / `disconnect` / `setEnabled`）＋ `packages/coding-agent/src/connectors/*`",
		],
		declaration: [
			"同文件头部；MCP provider 见 `discovery/connector-catalog.ts`，agent 工具见 `tools/connector-catalog.ts`，`docs/connectors.md`",
		],
	},
	{
		domain: "应用目录 provider seam",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/tools/computer/app-provider.ts" },
			"（`ApplicationProvider` / `ApplicationProviderRegistry` / `registerApplicationProvider`）",
		],
		declaration: [
			"同文件头部；宿主注册后 worker 经 `provider-call`/`provider-reply` 桥回调，`ComputerSessionSnapshot.applicationProvider` 声明本次运行由谁回答；disposer 释放即回退内置原生/文件系统目录",
		],
	},
	{
		domain: "computer-use provider 槽位",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/tools/computer/provider-slot.ts" },
			"（`ComputerProvider` / `ComputerProviderSlot` / `registerComputerProvider`）",
		],
		declaration: [
			"同文件头部；槽位只锁 provider 名，工具面由 provider 自己注册，disposer 先停止接单再等待其自有工作（owner 释放上限 3s）；`ComputerSessionSnapshot.computerProvider` 记接单中的 provider，空槽或释放中为 `builtin`",
		],
	},
	{
		domain: "Web 搜索 provider 注册表",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/web/search/registry.ts" },
			"（`registerSearchProvider` / `unregisterSearchProvider` / 内置 18 项同表登记）",
		],
		declaration: [
			"同文件头部；候选链为「显式 → 用户 order → 内置顺序 → 注册顺序」，扩展注册随实例生命周期释放；`docs/extensions-dev.md` §8.1",
		],
	},
	{
		domain: "压缩方法 provider seam",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/session/compaction-method-provider.ts" },
			"（`CompactionMethodProvider` / `registerCompactionMethodProvider`）+ 内置五方法 `compaction-builtin-methods.ts`",
		],
		declaration: [
			"同文件头部；`compaction.methodOrder` 的可用性判定与选择项由 provider 回答，`settings.schema` 合并插件贡献的方法（同 `memory.backend` 规则），未注册 id 在配置里被丢弃并回退内置顺序；执行体仍归会话维护（提交、花费记账、上下文重锚不外包）",
		],
	},
	{
		domain: "压缩阈值策略 seam",
		anchor: [
			{ pkg: "@musepi/pi-coding-agent", path: "src/session/compaction-threshold-strategy.ts" },
			"（`CompactionThresholdStrategy` / `registerCompactionThresholdStrategy`），内置「按模型阈值」规则以优先级 0 注册于 `model-compaction-threshold.ts`",
		],
		declaration: [
			"同文件头部；策略按 priority 依次询问，第一个返回结果的生效，内置规则先手，插件策略只看到它未覆盖的模型；策略只能改写阈值字段，开关、方法顺序与保留预算仍归用户配置；`ExtensionAPI.registerCompactionThresholdStrategy` 经 `registerEffect` 随实例释放",
		],
	},
	{
		domain: "压缩档位插件（阈值策略的首个消费者）",
		anchor: [{ pkg: "musepi-compaction-tiers", path: "index.ts" }, "（`compactionTiers.premiumCap`）"],
		declaration: [
			"同文件头部；对 `cost.longContext` 有档位的模型把触发点压到 `Config.capPercent`（默认 70），其余模型原样交回配置；内置按模型规则先手，显式条目仍胜出",
		],
	},
];
