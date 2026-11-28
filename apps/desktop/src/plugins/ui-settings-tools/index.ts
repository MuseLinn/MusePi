/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-tools` 桌面 Cordis 插件、`settings.section` 设置页（id `tools`）。
 * - 输入：宿主传入的 rpc；页面读 `settings.schema` 的 `tools` tab 与 `computer.*` 权限。
 * - 输出：设置页「工具」整页 —— 工具开关与计算机使用权限。
 * - 生命周期：页面随设置页导航挂载/卸载；页面内表单与统计请求属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「工具」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `tools` 页；不接管工具注册表与 `computer.*` 权限判定。
 * - 检视入口：本目录与 `apps/desktop/test/settings-tools-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "tools";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-settings-tools";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "tools",
		moduleUrl: "./page.tsx",
		label: "工具",
		icon: "plug-2",
		order: 12,
		keywords: ["工具", "tool", "开关", "toggle", "权限", "permission", "computer", "计算机"],
		availability: "always",
	});
}
