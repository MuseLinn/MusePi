/**
 * 能力缝声明（索引：docs/capability-seams.md「Cordis 会话页」）：
 * - 名称+ns：`chat-view` 桌面 Cordis 插件；`main.conversation` 与 `conversation.composer.bar` 两个 single 槽位。
 * - 输入：宿主唯一的会话 store、工作区状态和 daemon RPC。
 * - 输出：欢迎页、会话 transcript，以及输入卡（与页面同插件注册，颗粒度对齐参考实现的 conversation 插件）；右栏由 panel.shell 独立挂载。
 * - 生命周期：页面随插件 fiber 与槽位挂载/卸载；宿主状态所有权不变。
 * - 启停：停用时移除会话页，不保留静态 ChatView 备用实现。
 * - 冲突：不复制会话 store 或右栏状态，不建立第二个 ChatView/输入卡。
 * - 检视入口：本目录与 `chat-view-plugin.test.tsx`。
 */
interface ChatViewPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-chat-view";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ChatViewPluginApi): void {
	ctx.slots.register({
		slot: "main.conversation",
		moduleUrl: "./page.tsx",
		label: "会话",
	});
	// The input card is this plugin's own surface, mirroring the reference
	// conversation plugin (which registers the composer bar itself). Sibling
	// plugins contribute into `composer.*`; none of them owns the card.
	ctx.slots.register({
		slot: "conversation.composer.bar",
		moduleUrl: "./composer.tsx",
		label: "输入卡",
	});
}
