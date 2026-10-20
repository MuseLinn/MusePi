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
 * ## 输入区席位(composer.*)与 DSH 的对应关系
 *
 * 我们的输入区席位沿用 `composer.*` 前缀(不改成 DSH 的
 * `conversation.input.*`——改名会作废所有已注册组件),但**席位集合**对齐
 * DSH 的输入区面,逐条对应关系写在这里,便于对照与移植:
 *
 * | 本仓库 | DSH | 位置 |
 * |---|---|---|
 * | `composer.left` | `conversation.input.left` | 工具栏左端 |
 * | `composer.right` | `conversation.input.right` | 工具栏右端 |
 * | `composer.dock` | `conversation.input.dock` | 输入区下方的停靠区 |
 * | `composer.model` | `conversation.input.model` | 模型选择器旁(模型相关的事实) |
 * | `composer.attachments` | `conversation.input.attachments` | 附件区 |
 * | `composer.permission` | `conversation.input.permission` | 权限模式旁 |
 * | `composer.plan` | `conversation.input.plan` | 计划模式旁 |
 * | `composer.activity` | `conversation.input.activity` | 进行中的活动 |
 * | `composer.overlay` | `conversation.input.overlay` | 输入区浮层 |
 * | `composer.requestDraft` | `conversation.input.requestDraftInitialization` | 请求草稿初始化 |
 * | `composer.for` | `conversation.input.for` | 「为…生成的输入」上下文 |
 *
 * ⚠️ 席位**只声明不实现**的位置同样有效:声明了的席位若没有渲染端挂载点,
 *    组件不会被渲染,但 daemon 侧的合法性校验仍然通过——这让「先占位、后挂载」
 *    成为可能,而不必让插件作者等宿主的 GUI 改动。
 */
export const EXTENSION_SLOT_DECLARATION = {
	exact: [
		"panel.right",
		"rail.right",
		"settings.extensions",
		// 输入区(见上表与 DSH 的对应关系)。
		"composer.dock",
		"composer.left",
		"composer.right",
		"composer.model",
		"composer.attachments",
		"composer.permission",
		"composer.plan",
		"composer.activity",
		"composer.overlay",
		"composer.requestDraft",
		"composer.for",
		"transcript.node",
	] as const,
	prefixes: ["panel.tab.", "settings.tab.", "rail.", "settings.item.", "settings.action."] as const,
} as const;

/** The composer (input area) slot names, in the order they appear in the UI. */
export const COMPOSER_SLOTS = [
	"composer.left",
	"composer.right",
	"composer.dock",
	"composer.model",
	"composer.attachments",
	"composer.permission",
	"composer.plan",
	"composer.activity",
	"composer.overlay",
	"composer.requestDraft",
	"composer.for",
] as const;
