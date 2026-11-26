/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`notifications-settings` 桌面 Cordis 插件、`settings.section` 设置页（id `notifications`）。
 * - 输入：宿主传入的 rpc；桌面通知与音效：投递总开关、每个事件一行（toast 开关 + 音色）、模板、交互提示与共享音量/免打扰。
 * - 输出：设置页「通知与音效」整页。
 * - 生命周期：页面随设置页导航挂载/卸载。
 * - 启停：停用/编译失败时槽位消失，「通知与音效」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `notifications` 页；不接管 `lib/notify` 与 `lib/sfx` 的投递实现。
 * - 检视入口：本目录与 `apps/desktop/test/notifications-settings-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "notifications";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-notifications-settings";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "notifications",
		moduleUrl: "./page.tsx",
		label: "通知与音效",
		icon: "notification-3",
		order: 6,
		keywords: ["通知", "notification", "音效", "sound", "声音", "免打扰", "quiet"],
		availability: "always",
	});
}
