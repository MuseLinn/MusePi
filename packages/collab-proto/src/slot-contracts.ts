/**
 * 槽位契约的机器可读元数据（容量在 `extension-slots.ts` 里声明，这里补它
 * 承载不了的部分：作用域、注册选项、宿主传给组件的 props、谁声明并挂载它）。
 *
 * 为什么单独一份：容量是**校验**用的（daemon 拒绝未声明槽位），契约是
 * **发现**用的（模型写插件前要知道这个座位能挂什么、注册时传什么、组件
 * 会收到什么）。两者消费方不同，混在一起会让校验表越写越长。
 *
 * 已占者不在这里写死——它由 `bun run gen:slot-catalog` 从真实的
 * `slots.register({ slot: ... })` 调用点扫描生成，见 `slot-catalog.generated.ts`。
 * 写死会与插件漂移，而漂移的目录比没有目录更糟。
 */

/** 一个注册调用可传的选项。 */
export interface SlotRegisterOption {
	name: string;
	requirement: "required" | "optional";
	/** 源码里的写法，例如 `string`、`"./page.tsx"`、`"always" | "on-demand"`。 */
	type: string;
	/** 从注册者视角说明它做什么。 */
	doc: string;
}

/** 一个座位的契约。 */
export interface SlotContract {
	/** `root` 全窗口唯一；`session` 跟随活动会话。 */
	scope: "root" | "session";
	/** 一句话：这个位置是干什么的。 */
	summary: string;
	/** 注册调用除 `slot` 外可传的选项。 */
	registerOptions: readonly SlotRegisterOption[];
	/** 宿主注入给组件的 `SlotComponentProps` 字段名。 */
	ownerProps: readonly string[];
	/** 哪个宿主模块渲染它（仓库相对路径）。 */
	declaredBy: string;
	/**
	 * 谁声明这个座位、它什么时候消失。
	 *
	 * - `core`：壳层常驻，进程内一直存在；启动时声明一次（`CORE_SEATS`）。
	 * - `component`：由渲染它的那个组件声明，父组件卸载即塌缩（`provides`）。
	 *
	 * 贡献者用 `ctx.slots.inject(slot, …)` 等待任何已声明座位；读到 `component`
	 * 时，它消失与父组件同寿命，而不是随进程。
	 */
	lifetime: "core" | "component";
	/**
	 * `shadows-shipped-ui`：注册即替换宿主界面；`additive`：与内建并存。
	 */
	replaceRisk: "shadows-shipped-ui" | "additive";
}

const MODULE: SlotRegisterOption = {
	name: "moduleUrl",
	requirement: "required",
	type: 'string (e.g. "./page.tsx")',
	doc: "扩展内相对模块路径；构建期编译成组件产物。",
};
const LABEL: SlotRegisterOption = {
	name: "label",
	requirement: "optional",
	type: "string",
	doc: "显示名（导航行、标签、错误信息）。",
};
const ORDER: SlotRegisterOption = {
	name: "order",
	requirement: "optional",
	type: "number",
	doc: "list 座位的渲染顺序（升序，默认按注册顺序）。",
};
const ID: SlotRegisterOption = {
	name: "id",
	requirement: "optional",
	type: "string",
	doc: "list 座位内的条目身份；同插件可在同一座位挂多条，第三方可按 id 精确替换。",
};
const AVAILABILITY: SlotRegisterOption = {
	name: "availability",
	requirement: "optional",
	type: '"always" | "on-demand"',
	doc: "`panel.tab.*`：是否在右缘图标轨给出常驻入口。",
};
const PAGE_ID: SlotRegisterOption = {
	name: "id",
	requirement: "required",
	type: "string",
	doc: "页 id（可为 `sessions` / `memory` 这类能力别名）；命中既有页即原位接管。",
};
const ICON: SlotRegisterOption = {
	name: "icon",
	requirement: "optional",
	type: "string (icon sprite key)",
	doc: "导航图标名；未知名字回退默认图标。",
};
const KEYWORDS: SlotRegisterOption = {
	name: "keywords",
	requirement: "optional",
	type: "readonly string[]",
	doc: "设置搜索关键词，叠加在内建词表上。",
};

/** 精确座位的契约；键必须与 `EXTENSION_SLOT_DECLARATION.exact` 一一对应。 */
export const SLOT_CONTRACTS = {
	"main.conversation": {
		scope: "root",
		summary: "完整会话页（欢迎页 + transcript），替换宿主内建会话面。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["chatView"],
		declaredBy: "apps/desktop/src/components/ChatView.tsx",
		lifetime: "core",
		replaceRisk: "shadows-shipped-ui",
	},
	"main.capability": {
		scope: "root",
		summary: "完整能力中心页。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["page"],
		declaredBy: "apps/desktop/src/components/CapabilityCenter.tsx",
		lifetime: "core",
		replaceRisk: "shadows-shipped-ui",
	},
	"shell.overlay": {
		scope: "root",
		summary: "窗口级固定覆盖层（滚动进度轨等），组件自行 portal 到 body。",
		registerOptions: [MODULE, LABEL],
		ownerProps: [],
		declaredBy: "apps/desktop/src/app.tsx",
		lifetime: "core",
		replaceRisk: "shadows-shipped-ui",
	},
	"panel.shell": {
		scope: "root",
		summary: "完整右栏外壳，与会话页独立替换。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["panelShell"],
		declaredBy: "apps/desktop/src/components/ContextPanel.tsx",
		lifetime: "core",
		replaceRisk: "shadows-shipped-ui",
	},
	"browser.host": {
		scope: "root",
		summary: "常驻受管浏览器 guest 宿主，在应用根部挂载。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["browser"],
		declaredBy: "apps/desktop/src/components/ManagedBrowserHost.tsx",
		lifetime: "core",
		replaceRisk: "shadows-shipped-ui",
	},
	"panel.right": {
		scope: "root",
		summary: "右栏内的分区条目（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId", "cwd"],
		declaredBy: "apps/desktop/src/components/ContextPanel.tsx",
		lifetime: "core",
		replaceRisk: "additive",
	},
	"rail.right": {
		scope: "root",
		summary: "右缘图标轨条目（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc"],
		declaredBy: "apps/desktop/src/components/RightRail.tsx",
		lifetime: "core",
		replaceRisk: "additive",
	},
	"settings.extensions": {
		scope: "root",
		summary: "插件自带设置面板（list），按扩展分组渲染在扩展中心底部。",
		registerOptions: [MODULE, LABEL, ORDER],
		ownerProps: ["rpc", "settingsScope", "configForm"],
		declaredBy: "apps/desktop/src/components/ExtensionsCenter.tsx",
		lifetime: "core",
		replaceRisk: "additive",
	},
	"settings.section": {
		scope: "root",
		summary: "一个设置页（list）；条目自带导航身份，命中既有页即原位接管。",
		registerOptions: [PAGE_ID, LABEL, ORDER, ICON, KEYWORDS, MODULE],
		ownerProps: ["rpc", "sessionId", "cwd", "settingsSection", "onApplyPrompt"],
		declaredBy: "apps/desktop/src/components/SettingsView.tsx",
		lifetime: "core",
		replaceRisk: "shadows-shipped-ui",
	},
	"settings.general.item": {
		scope: "root",
		summary: "「常规」页的行级偏好（list）：贡献一行即可，无需整页。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "settingsScope", "configForm"],
		declaredBy: "packages/client/ui-settings/src/client/contract/slots.ts",
		lifetime: "core",
		replaceRisk: "additive",
	},
	"conversation.composer.bar": {
		scope: "session",
		summary: "整个输入卡（hero 与 session 两种模式）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc", "sessionId", "cwd", "chatView"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.composer.dock": {
		scope: "session",
		summary: "输入卡下方的整行条目（读数类，自居中）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId", "formatTokens"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.input.dock": {
		scope: "session",
		summary: "输入卡上方的整行条目（队列、待办）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.input.overlay": {
		scope: "session",
		summary: "输入卡内的浮层（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.input.left": {
		scope: "session",
		summary: "工具栏左端（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId", "cwd"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.input.right": {
		scope: "session",
		summary: "提交键之前的紧凑控件（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId", "cwd"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.input.requestDraft": {
		scope: "session",
		summary: "草稿初始化钩子（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.input.for": {
		scope: "session",
		summary: "「为…生成的输入」上下文（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.input.activity": {
		scope: "session",
		summary: "模型选择器之后的动作（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.input.attachments": {
		scope: "session",
		summary: "附件栏（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.input.plan": {
		scope: "session",
		summary: "计划控件（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.input.permission": {
		scope: "session",
		summary: "权限控件（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.input.model": {
		scope: "session",
		summary: "模型选择器（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc", "sessionId"],
		declaredBy: "apps/desktop/src/components/Composer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.hero.frame": {
		scope: "session",
		summary: "欢迎区外框（hoc）：收到宿主内容作为 `children`，必须原样渲染。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["children"],
		declaredBy: "apps/desktop/src/components/HeroComposer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.hero.brand.mark": {
		scope: "session",
		summary: "空态品牌标记（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: [],
		declaredBy: "apps/desktop/src/components/HeroComposer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.hero.workspace": {
		scope: "session",
		summary: "空态工作区/项目选择（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc"],
		declaredBy: "apps/desktop/src/components/HeroComposer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.hero.agentPreset": {
		scope: "session",
		summary: "空态工作模式选择（single）。",
		registerOptions: [MODULE, LABEL],
		ownerProps: ["rpc"],
		declaredBy: "apps/desktop/src/components/HeroComposer.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	"conversation.hero.options": {
		scope: "session",
		summary: "空态输入卡下方的快捷选项（list）。",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		ownerProps: ["rpc", "cwd"],
		declaredBy: "apps/desktop/src/components/HeroComposer.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	"conversation.chat.node": {
		scope: "session",
		summary: "transcript 节点 seat（list），按节点 kind（`entryKinds`）派发。",
		registerOptions: [
			MODULE,
			LABEL,
			ORDER,
			ID,
			{
				name: "entryKinds",
				requirement: "required",
				type: "readonly string[]",
				doc: "该渲染器拥有的节点 kind（`transcriptNodeKind` 的 entryKey）；无此字段不参与按 kind 派发。",
			},
		],
		ownerProps: ["node", "turn", "sessionId"],
		declaredBy: "packages/client-core/src/components/transcript/",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
} satisfies Record<string, SlotContract>;

/**
 * Seats the app shell renders for the whole process.
 *
 * Declared once at startup so a contributor's `ctx.slots.inject` runs immediately
 * instead of waiting for a declaration that never comes. Derived from the
 * contracts: `lifetime: "core"` is exactly this set, and the test below keeps the
 * two in step.
 */
export const CORE_SEATS: readonly string[] = Object.entries(SLOT_CONTRACTS)
	.filter(([, contract]) => contract.lifetime === "core")
	.map(([name]) => name);

/** 前缀座位的契约（任意 `<prefix><id>` 均合法）。 */
export interface SlotPrefixContract {
	prefix: string;
	summary: string;
	/** 后缀是什么。 */
	suffix: string;
	registerOptions: readonly SlotRegisterOption[];
	declaredBy: string;
	lifetime: "component";
	replaceRisk: "shadows-shipped-ui" | "additive";
}

export const SLOT_PREFIX_CONTRACTS = [
	{
		prefix: "panel.tab.",
		summary: "右栏标签页；后缀是 surface id。",
		suffix: "surface id (e.g. `browser`, `compaction`)",
		registerOptions: [MODULE, LABEL, ORDER, AVAILABILITY],
		declaredBy: "apps/desktop/src/components/ChatView.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	{
		prefix: "rail.",
		summary: "右缘图标轨条目；后缀是条目 id。",
		suffix: "rail entry id",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		declaredBy: "apps/desktop/src/components/RightRail.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	{
		prefix: "settings.item.",
		summary:
			"设置卡片与页内行：`settings.item.<extId>` 进扩展中心，`settings.item.<page>.<row>` 由该页渲染在正文之后。",
		suffix: "`<extId>` or `<page>.<row>`",
		registerOptions: [MODULE, LABEL, ORDER],
		declaredBy: "apps/desktop/src/components/ExtensionsCenter.tsx / SettingsView.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	{
		prefix: "settings.subnav.",
		summary: "设置页分段子导航的一个标签；后缀是页面 id（如 `session-memory`）。",
		suffix: "page id (e.g. `session-memory`)",
		registerOptions: [MODULE, LABEL, ORDER, ID],
		declaredBy: "apps/desktop/src/components/settings-sections/session-memory.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
	{
		prefix: "chat.session-info.",
		summary: "会话信息卡的分区；后缀是分区 id。",
		suffix: "section id (e.g. `plugins`, `agents`)",
		registerOptions: [MODULE, LABEL, ORDER],
		declaredBy: "apps/desktop/src/components/session-info-card.tsx",
		lifetime: "component",
		replaceRisk: "additive",
	},
	{
		prefix: "sidebar.panel.",
		summary: "二级左栏面板；后缀是 rail 目的地 id，无贡献时回退单栏。",
		suffix: "destination id (e.g. `scheduled`, `capability`)",
		registerOptions: [MODULE, LABEL],
		declaredBy: "apps/desktop/src/app.tsx",
		lifetime: "component",
		replaceRisk: "shadows-shipped-ui",
	},
] as const satisfies readonly SlotPrefixContract[];
