/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-general` 桌面 Cordis 插件、`settings.section` 设置页（id `general`）。
 * - 输入：宿主传入的 rpc；页面读取 `system.*`（版本、数据目录）、更新检查能力与欢迎语偏好。
 * - 输出：设置页「常规」整页 —— 版本信息、数据目录、检查更新、欢迎语，以及常规偏好行。
 * - 生命周期：页面随设置页导航挂载/卸载；更新检查状态属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「常规」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `general` 页；不接管 `system.*` 与更新器实现。
 * - 检视入口：本目录与 `apps/desktop/test/settings-general-plugin.test.tsx`。
 */
interface GeneralSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "general";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-settings-general";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: GeneralSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "general",
		moduleUrl: "./page.tsx",
		label: "常规",
		icon: "settings-3",
		order: 0,
		keywords: ["常规", "general", "版本", "version", "更新", "update", "数据目录", "welcome", "欢迎"],
		availability: "always",
	});
}
