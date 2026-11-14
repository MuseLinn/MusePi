/**
 * 六字段能力缝声明(docs/capability-seams.md 的 Cordis 行待补):
 * - 名称+ns:`session-info-agents` 桌面 Cordis 插件、`chat.session-info.agents`
 *   会话信息卡分区槽位(前缀族见 collab-proto EXTENSION_SLOT_DECLARATION)。
 * - 输入:宿主经 `SlotComponentProps.sessionInfo` 传入的只读 `agents[]` +
 *   `openTrajectory` —— 百分比、阻塞态、耗时、成本都由卡片读好。
 * - 输出:信息卡「子代理」分区:运行中行(进度条/等待审批文案)与已结束折叠列表。
 * - 生命周期:随信息卡挂载/卸载;分区不轮询,1s 的耗时刷新由卡片重渲染带下来。
 * - 启停:停用或编译失败时槽位无占据者,卡片回退内置同构分区。
 * - 冲突:独占 `chat.session-info.agents`;不接管卡片其他分区。
 * - 检视入口:本目录与 `test/session-info-agents.test.tsx`。
 */
interface SessionInfoAgentsPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-session-info-agents";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SessionInfoAgentsPluginApi): void {
	ctx.setLabel("MusePi 会话信息子代理分区");
	ctx.slots.register({
		slot: "chat.session-info.agents",
		moduleUrl: "./page.tsx",
		label: "子代理",
	});
}
