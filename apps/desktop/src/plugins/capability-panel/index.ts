/**
 * 能力缝声明（索引：docs/capability-seams.md「Cordis 二级左栏面板」）：
 * - 名称+ns：`capability-panel` 桌面 Cordis 插件、`sidebar.panel.capability` 前缀席位。
 * - 输入：宿主共享的 `capability-nav` 快照（经 MusePiHostModules，非 bundle 内副本）、
 *   keeper 上的 `--gui-side-w` 宽度变量，以及 `data-panel` 显隐权威。
 * - 输出：能力中心二级左栏——整宽主操作、搜索、扁平分组下三个整宽入口行、
 *   计数徽标与选中态；点击回传 select / add 动作。
 * - 生命周期：随插件 fiber 与槽位挂载/卸载；面板搜索词与选中态在目的地切换
 *   和 hover-peek 期间因宿主常驻挂载而保留。
 * - 启停：父插件停用或编译失败时宿主回退内置 `CapabilitySidePanel`，不阻断能力中心。
 * - 冲突：不注册第二个 rail 目的地，不在 `app.capability` 页面内复制左列；
 *   页面页头不再渲染三个 tab 按钮，只保留标题 / 描述 / 返回。
 * - 检视入口：本目录与 `test/capability-panel-plugin.test.tsx`。
 */
interface CapabilityPanelPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-capability-panel";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: CapabilityPanelPluginApi): void {
	ctx.setLabel("MusePi 能力中心左栏");
	ctx.slots.register({
		slot: "sidebar.panel.capability",
		moduleUrl: "./page.tsx",
		label: "技能 / 插件 / 市场",
	});
}
