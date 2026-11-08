/**
 * 能力缝声明（索引：docs/capability-seams.md「Cordis 会话页」）：
 * - 名称+ns：`chat-view` 桌面 Cordis 插件、`app.chat` single 槽位。
 * - 输入：宿主唯一的会话 store、工作区状态和 daemon RPC。
 * - 输出：欢迎页、会话 transcript 与输入区；右栏由 panel.shell 独立挂载。
 * - 生命周期：页面随插件 fiber 与槽位挂载/卸载；宿主状态所有权不变。
 * - 启停：停用时移除会话页，不保留静态 ChatView 备用实现。
 * - 冲突：不复制会话 store 或右栏状态，不建立第二个 ChatView。
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
	ctx.setLabel("MusePi 会话页");
	ctx.slots.register({
		slot: "app.chat",
		moduleUrl: "./page.tsx",
		label: "会话",
	});
}
