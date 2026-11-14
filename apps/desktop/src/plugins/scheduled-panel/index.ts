/**
 * 能力缝声明（索引：docs/capability-seams.md「Cordis 二级左栏面板」）：
 * - 名称+ns：`scheduled-panel` 桌面 Cordis 插件、`sidebar.panel.scheduled` 前缀席位。
 * - 输入：宿主共享的 `task-nav` 快照（经 MusePiHostModules，非 bundle 内副本）、
 *   keeper 上的 `--gui-side-w` 宽度变量，以及 `data-panel` 显隐权威。
 * - 输出：任务中心二级左栏——主操作、搜索/状态过滤、工作区分组、选中与新建动作。
 * - 生命周期：随插件 fiber 与槽位挂载/卸载；面板状态（搜索词、过滤、选中）在
 *   目的地切换与 hover-peek 期间因宿主常驻挂载而保留。
 * - 启停：父插件停用或编译失败时宿主回退内置 `ScheduledTasksPanel`，不阻断任务中心页。
 * - 冲突：不注册第二个 rail 目的地，不在页面内复制左列；页面仍只渲染详情一列。
 * - 检视入口：本目录与 `test/scheduled-panel-plugin.test.tsx`。
 */
interface ScheduledPanelPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-scheduled-panel";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ScheduledPanelPluginApi): void {
	ctx.setLabel("MusePi 任务中心左栏");
	ctx.slots.register({
		slot: "sidebar.panel.scheduled",
		moduleUrl: "./page.tsx",
		label: "任务列表",
	});
}
