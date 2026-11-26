/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-pet` 桌面 Cordis 插件、`settings.section` 设置页（id `pet`）。
 * - 输入：页面读伙伴偏好与市场数据；保存经 `dispatchPetChanged` 通知其它界面。
 * - 输出：设置页「伙伴」整页 —— 内置形象、伙伴市场与装饰。
 * - 生命周期：页面随设置页导航挂载/卸载；页面内表单与请求状态属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「伙伴」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `pet` 页；不接管伙伴渲染与市场数据源。
 * - 检视入口：本目录与 `apps/desktop/test/settings-pet-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "pet";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-companion";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "pet",
		moduleUrl: "./page.tsx",
		label: "伙伴",
		icon: "robot-2",
		order: 14,
		keywords: ["伙伴", "pet", "形象", "art", "装饰", "decor", "市场", "market", "companion"],
		availability: "always",
	});
}
