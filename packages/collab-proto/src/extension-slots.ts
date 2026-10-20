/**
 * 内核↔渲染端槽位契约(单一权威;daemon 校验 + GUI 挂载诊断共用)。
 *
 * exact = 精确槽位名;prefixes = 前缀槽位族(任意 <prefix><id> 均合法)。
 * 新增槽位先在此声明,daemon 的 extensions.list 自动下发,GUI 诊断随之可见。
 *
 * transcript.node —— DSH 粒度(对应 DSH `conversation.chat.node`):单一
 * “聊天节点 seat”槽,按节点 kind(entryKey)分发;turn-tail / tool / user /
 * assistant 都是该 seat 的节点 kind,而非独立槽。宿主(渲染器)按 kind
 * 派发到注册的渲染器,无注册时回退到内建渲染(fallback)。
 *
 * ## 输入区席位与 DSH 的对应关系
 *
 * 我们的输入区席位沿用 `composer.*` 前缀(不改成 DSH 的
 * `conversation.input.*`——改名会作废所有已注册组件),但**席位集合与容量
 * 语义**逐条对齐 DSH 的输入区面:
 *
 * | 本仓库 | DSH | 容量 | 位置 |
 * |---|---|---|---|
 * | `composer.dock` | `conversation.input.dock` | list | 输入卡上方的整宽条目 |
 * | `composer.left` | `conversation.input.left` | list | 工具栏左端 |
 * | `composer.right` | `conversation.input.right` | list | 提交键之前的紧凑控件 |
 * | `composer.overlay` | `conversation.input.overlay` | list | 输入卡内的浮层 |
 * | `composer.model` | `conversation.input.model` | **single** | 模型选择器旁 |
 * | `composer.attachments` | `conversation.input.attachments` | **single** | 附件栏 |
 * | `composer.permission` | `conversation.input.permission` | **single** | 权限控件 |
 * | `composer.plan` | `conversation.input.plan` | **single** | 计划控件 |
 * | `composer.activity` | `conversation.input.activity` | **single** | 模型选择器之后的动作 |
 * | `composer.requestDraft` | `conversation.input.requestDraftInitialization` | list | 草稿初始化 |
 * | `composer.for` | `conversation.input.for` | list | 「为…生成的输入」上下文 |
 *
 * ## `single` 与 `list` 的区别(不是可选的细节)
 *
 * - `list`:多个贡献者**同时**渲染,按 `order` 排。
 * - `single`:该位置**只有一个**占据者。第二个贡献者注册时**取代**前一个
 *   (不是并排显示)——这是 DSH 的语义。`composer.model` 上并排出现两个
 *   模型读数会让用户不知道该信哪个。
 *
 * 声明了但宿主还没有挂载点的席位仍然合法:daemon 侧校验通过,组件只是不会被
 * 渲染。这让「插件先占住席位、宿主随后实现挂载」成为可能。
 */

/** 一个席位的容量语义。 */
export type SlotKind = "single" | "list";

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
		"panel.right": { kind: "list" },
		"rail.right": { kind: "list" },
		"settings.extensions": { kind: "list" },
		// 输入区(见上表与 DSH 的对应关系)。list 组在前、single 组在后,
		// 与 DSH 的声明顺序一致,便于逐行对照。
		"composer.dock": { kind: "list" },
		"composer.overlay": { kind: "list" },
		"composer.left": { kind: "list" },
		"composer.right": { kind: "list" },
		"composer.requestDraft": { kind: "list" },
		"composer.for": { kind: "list" },
		"composer.activity": { kind: "single" },
		"composer.attachments": { kind: "single" },
		"composer.plan": { kind: "single" },
		"composer.permission": { kind: "single" },
		"composer.model": { kind: "single" },
		"transcript.node": { kind: "list" },
	} as const satisfies Record<string, SlotDeclaration>,
	prefixes: ["panel.tab.", "settings.tab.", "rail.", "settings.item.", "settings.action."] as const,
} as const;

/** Every exact slot name, in UI order. */
export const EXTENSION_SLOT_NAMES = Object.keys(EXTENSION_SLOT_DECLARATION.exact) as ReadonlyArray<
	keyof typeof EXTENSION_SLOT_DECLARATION.exact
>;

/** The composer (input area) slot names, in the order they appear in the UI. */
export const COMPOSER_SLOTS = [
	"composer.left",
	"composer.right",
	"composer.dock",
	"composer.activity",
	"composer.attachments",
	"composer.plan",
	"composer.permission",
	"composer.model",
	"composer.overlay",
	"composer.requestDraft",
	"composer.for",
] as const;

/**
 * The capacity semantics of one exact slot; `undefined` for a name outside the
 * declaration (the daemon rejects those).
 */
export function slotKindOf(slot: string): SlotKind | undefined {
	const declaration = (EXTENSION_SLOT_DECLARATION.exact as Record<string, SlotDeclaration | undefined>)[slot];
	return declaration?.kind;
}
