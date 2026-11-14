/**
 * 能力缝声明（索引：docs/capability-seams.md「Cordis 能力中心」）：
 * - 名称+ns：`capability-center` 桌面 Cordis 插件、`app.capability` single 槽位。
 * - 输入：页面 tab、返回与 tab 切换回调、daemon RPC。
 * - 输出：技能、普通包/bundle 管理和市场整页。
 * - 生命周期：页面随插件 fiber 与槽位挂载/卸载，应用壳不保留静态备用页。
 * - 启停：父插件停用时整页退出；普通包与 bundle 分别写 runtime lock 和 profile 选择。
 * - 冲突：组合诊断仍归 `bundles.composition`，不保留第二个组合页。
 * - 检视入口：本目录与 `capability-center-plugin.test.tsx`。
 */
interface CapabilityPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-capability-center";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: CapabilityPluginApi): void {
	ctx.setLabel("MusePi 能力中心");
	ctx.slots.register({
		slot: "app.capability",
		moduleUrl: "./page.tsx",
		label: "能力中心",
	});
}
