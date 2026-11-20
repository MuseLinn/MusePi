/**
 * 内核↔渲染端槽位契约(单一权威;daemon 校验 + GUI 挂载诊断共用)。
 *
 * exact = 精确槽位名;prefixes = 前缀槽位族(任意 <prefix><id> 均合法)。
 * 新增槽位先在此声明,daemon 的 extensions.list 自动下发,GUI 诊断随之可见。
 *
 * ## 根层席位
 *
 * `main` 是根级 keyed 席位族（对齐参考实现的 root `main` 槽）：保留键
 * `conversation` 挂完整会话页，`capability` 挂能力中心页。一个键只有一个
 * 占据者；无贡献或编译失败时宿主渲染内建实现。
 *
 * | 席位 | 容量 | 位置 |
 * |---|---|---|
 * | `main.conversation` | **single** | 完整会话页（欢迎页 + 会话 transcript） |
 * | `main.capability` | **single** | 完整能力中心页 |
 * | `shell.overlay` | **single** | 窗口级覆盖层（滚动进度轨），宿主保留回退 |
 * | `panel.shell` | **single** | 右侧面板外壳，与会话页独立替换 |
 * | `browser.host` | **single** | 常驻的受管浏览器宿主（webview 存活层） |
 *
 * ## 会话层级
 *
 * `conversation.chat.node` —— 「聊天节点 seat」槽，按节点 kind（entryKey）
 * 分发；turn-tail / tool / user / assistant 都是该 seat 的节点 kind，而非
 * 独立槽。宿主按 kind 派发到注册的渲染器，无注册时回退到内建渲染。
 *
 * `chat.session-info.<id>` —— 会话信息卡的分区座位：收起的面板右缘那张卡片
 * 逐区贡献（当前是「插件」分区）。分区无占据者时宿主渲染内建实现。
 *
 * | 席位 | 容量 | 位置 |
 * |---|---|---|
 * | `conversation.composer.bar` | **single** | 整个输入卡（hero/session 两种模式）；无贡献时宿主回退内建 |
 * | `conversation.composer.dock` | list | 输入卡下方的整行条目（读数类内容，自居中） |
 * | `conversation.input.dock` | list | 输入卡上方的整行条目（队列、待办） |
 * | `conversation.input.left` | list | 工具栏左端 |
 * | `conversation.input.right` | list | 提交键之前的紧凑控件 |
 * | `conversation.input.overlay` | list | 输入卡内的浮层 |
 * | `conversation.input.model` | **single** | 模型选择器旁 |
 * | `conversation.input.attachments` | **single** | 附件栏 |
 * | `conversation.input.permission` | **single** | 权限控件 |
 * | `conversation.input.plan` | **single** | 计划控件 |
 * | `conversation.input.activity` | **single** | 模型选择器之后的动作 |
 * | `conversation.input.requestDraft` | list | 草稿初始化 |
 * | `conversation.input.for` | list | 「为…生成的输入」上下文 |
 * | `conversation.hero.frame` | **hoc** | 欢迎区外框：贡献组件接收 `children`（宿主内容），可包一层装饰/背景（dsh `conversation.hero.frame` 的鲸鱼就是这个形状）；无贡献时宿主直接渲染 children |
 * | `conversation.hero.brand.mark` | **single** | 空态品牌标记 |
 * | `conversation.hero.workspace` | **single** | 空态工作区/项目选择 |
 * | `conversation.hero.agentPreset` | **single** | 空态工作模式选择 |
 * | `conversation.hero.options` | list | 空态输入卡下方的快捷选项 |
 * | `conversation.chat.node` | list | transcript 节点 seat，按 kind 派发 |
 *
 * ## `single` 与 `list` 的区别(不是可选的细节)
 *
 * - `list`:多个贡献者**同时**渲染,按 `order` 排。
 * - `single`:该位置**只有一个**占据者。第二个贡献者注册时**取代**前一个
 *   (不是并排显示)——这是 single 的语义。`conversation.input.model` 上并排出现两个
 *   模型读数会让用户不知道该信哪个。
 *
 * 声明了但宿主还没有挂载点的席位仍然合法:daemon 侧校验通过,组件只是不会被
 * 渲染。这让「插件先占住席位、宿主随后实现挂载」成为可能。
 */

/** 一个席位的容量语义。
 *
 *  `hoc`：包装语义。贡献组件收到宿主内容作为 `children`，必须原样渲染它
 *  （fragment 不产生盒子，布局不变），可在外层叠加自己的装饰/背景层。
 *  无贡献时宿主直接渲染 children——这是 dsh `conversation.hero.frame` 的
 *  形状（官方鲸鱼画布画在 children 之下）。 */
export type SlotKind = "single" | "list" | "hoc";

/** 一个席位的声明。 */
export interface SlotDeclaration {
	/** 容量:单占据者(后注册者取代)或多贡献者(并排)。 */
	kind: SlotKind;
}

/**
 * 精确槽位 → 声明。
 *
 * ⚠️ 键序即 UI 顺序,但消费方应当按**名字**取用(见 GUI 的 `slot()`),
 *    不要按下标——加一个席位会让所有下标静默错位。
 */
export const EXTENSION_SLOT_DECLARATION = {
	exact: {
		"main.conversation": { kind: "single" },
		"main.capability": { kind: "single" },
		/** Root-level overlay (floating scroll rail): one contributor owns the
		 *  whole window layer; the host keeps a built-in fallback. */
		"shell.overlay": { kind: "single" },
		"panel.shell": { kind: "single" },
		"browser.host": { kind: "single" },
		"panel.right": { kind: "list" },
		"rail.right": { kind: "list" },
		"settings.extensions": { kind: "list" },
		/** Row-level preference in the General settings page (dsh
		 *  `settings.general.item`): a feature contributes one row without a page
		 *  of its own. One spelling — no legacy alias. */
		"settings.general.item": { kind: "list" },
		// 输入区(见上表)。list 组在前、single 组在后。
		/** 整个输入卡本身(single):占住者渲染 hero/session 两种模式,
		 *  宿主在无贡献或编译失败时渲染内建 Composer。 */
		"conversation.composer.bar": { kind: "single" },
		"conversation.composer.dock": { kind: "list" },
		"conversation.input.dock": { kind: "list" },
		"conversation.input.overlay": { kind: "list" },
		"conversation.input.left": { kind: "list" },
		"conversation.input.right": { kind: "list" },
		"conversation.input.requestDraft": { kind: "list" },
		"conversation.input.for": { kind: "list" },
		"conversation.input.activity": { kind: "single" },
		"conversation.input.attachments": { kind: "single" },
		"conversation.input.plan": { kind: "single" },
		"conversation.input.permission": { kind: "single" },
		"conversation.input.model": { kind: "single" },
		"conversation.hero.frame": { kind: "hoc" },
		"conversation.hero.brand.mark": { kind: "single" },
		"conversation.hero.workspace": { kind: "single" },
		"conversation.hero.agentPreset": { kind: "single" },
		"conversation.hero.options": { kind: "list" },
		"conversation.chat.node": { kind: "list" },
	} as const satisfies Record<string, SlotDeclaration>,
	prefixes: [
		"panel.tab.",
		/** Settings page (dsh vocabulary): `settings.section.<id>`. One
		 *  spelling — no legacy alias. */
		"settings.section.",
		"rail.",
		"settings.item.",
		"chat.session-info.",
		/** Second-tier sidebar panel: `sidebar.panel.<destination id>` (e.g.
		 *  `scheduled`, `capability`). The host mounts the contribution whose
		 *  id matches the active or hovered rail destination; destinations
		 *  without one keep a one-column surface. */
		"sidebar.panel.",
	] as const,
} as const;

/** Every exact slot name, in UI order. */
export const EXTENSION_SLOT_NAMES = Object.keys(EXTENSION_SLOT_DECLARATION.exact) as ReadonlyArray<
	keyof typeof EXTENSION_SLOT_DECLARATION.exact
>;

/** The composer (input area) slot names, in the order they appear in the UI. */
export const COMPOSER_SLOTS = [
	"conversation.input.dock",
	"conversation.input.left",
	"conversation.input.right",
	"conversation.composer.dock",
	"conversation.input.activity",
	"conversation.input.attachments",
	"conversation.input.plan",
	"conversation.input.permission",
	"conversation.input.model",
	"conversation.input.overlay",
	"conversation.input.requestDraft",
	"conversation.input.for",
] as const;

/** The empty-state (hero) slot names, in the order they appear in the UI. */
export const CONVERSATION_HERO_SLOTS = [
	"conversation.hero.frame",
	"conversation.hero.brand.mark",
	"conversation.hero.workspace",
	"conversation.hero.agentPreset",
	"conversation.hero.options",
] as const;

/**
 * The capacity semantics of one exact slot; `undefined` for a name outside the
 * declaration (the daemon rejects those).
 */
export function slotKindOf(slot: string): SlotKind | undefined {
	const declaration = (EXTENSION_SLOT_DECLARATION.exact as Record<string, SlotDeclaration | undefined>)[slot];
	return declaration?.kind;
}
