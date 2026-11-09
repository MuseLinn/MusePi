/**
 * 六字段能力缝声明（docs/capability-seams.md 的 Cordis 行待补）：
 * - 名称+ns：`session-manager` 桌面 Cordis 插件、`settings.tab.sessions` 设置页槽位。
 * - 输入：宿主传入的 rpc/sessionId，以及既有 `session.list` / `session.lastPrompts` /
 *   `session.search` / `history.messages` / `session.delete` 响应和本地归档 store
 *   （useArchivedSessions）。
 * - 输出：设置页「会话」整页 —— 项目/状态/更新时间筛选、会话与消息搜索、分页表格、
 *   行内消息详情、批量归档/恢复/删除，以及沿用全局自动清理偏好的保留策略设置。
 * - 生命周期：页面随设置页导航挂载/卸载；当前页 prompt 批量读取一次，展开行的
 *   转录按需读取（每个会话一次）。
 * - 启停：停用后槽位消失，SettingsView 回退内置 SessionsSection（保留策略仍在）。
 * - 冲突：独占 `settings.tab.sessions`；接管消息浏览，原「历史会话」分区已删除。
 * - 检视入口：本目录与 `test/session-manager-plugin.test.tsx`。
 */
interface SessionManagerPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-session-manager";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SessionManagerPluginApi): void {
	ctx.setLabel("MusePi 会话管理");
	ctx.slots.register({
		slot: "settings.tab.sessions",
		moduleUrl: "./page.tsx",
		label: "会话",
		availability: "always",
	});
}
