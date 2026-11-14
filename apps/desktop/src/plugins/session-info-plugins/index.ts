/**
 * 六字段能力缝声明(docs/capability-seams.md 的 Cordis 行待补):
 * - 名称+ns:`session-info-plugins` 桌面 Cordis 插件、`chat.session-info.plugins`
 *   会话信息卡分区槽位(前缀族见 collab-proto EXTENSION_SLOT_DECLARATION)。
 * - 输入:宿主经 `SlotComponentProps.sessionInfo` 传入的只读
 *   `{ runningPlugins, pluginEntries }` —— 卡片已从共享扩展注册表读好。
 * - 输出:信息卡「插件」分区:运行中计数 + 可展开的运行/禁用列表。
 * - 生命周期:随信息卡挂载/卸载;分区不轮询,注册表刷新由卡片重渲染带下来。
 * - 启停:停用或编译失败时槽位无占据者,卡片回退内置同构列表。
 * - 冲突:独占 `chat.session-info.plugins`;不接管卡片其他分区。
 * - 检视入口:本目录与 `test/session-info-plugins.test.tsx`。
 */
interface SessionInfoPluginsPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-session-info-plugins";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SessionInfoPluginsPluginApi): void {
	ctx.setLabel("MusePi 会话信息插件分区");
	ctx.slots.register({
		slot: "chat.session-info.plugins",
		moduleUrl: "./page.tsx",
		label: "插件",
	});
}
