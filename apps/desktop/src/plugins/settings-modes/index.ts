/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-modes` 桌面 Cordis 插件、`settings.section` 设置页（id `modes`）。
 * - 输入：宿主传入的 rpc 与 `onCreateChat`（把描述作为新会话首条消息发送）；页面读 `modes.*`。
 * - 输出：设置页「预设与模式」整页 —— 预设列表、查看/编辑、默认预设与描述式新建。
 * - 生命周期：页面随设置页导航挂载/卸载；编辑对话框与草稿属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「预设与模式」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `modes` 页；不接管 `modes.*` 的 daemon 预设存储。
 * - 检视入口：本目录与 `apps/desktop/test/settings-modes-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "modes";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-settings-modes";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "modes",
		moduleUrl: "./page.tsx",
		label: "预设与模式",
		icon: "stack",
		order: 17,
		keywords: ["预设", "模式", "mode", "preset", "profile", "角色", "role", "work", "design"],
		availability: "always",
	});
}
