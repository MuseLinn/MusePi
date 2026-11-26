/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`shortcuts-settings` 桌面 Cordis 插件、`settings.section` 设置页（id `shortcuts`）。
 * - 输入：宿主传入的 rpc；可搜索的动作表，每行是动作名、说明、绑定 chip 与编辑/重置；捕获下一次按键，冲突拒绝并点名占用者。
 * - 输出：设置页「快捷键」整页。
 * - 生命周期：页面随设置页导航挂载/卸载。
 * - 启停：停用/编译失败时槽位消失，「快捷键」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `shortcuts` 页；绑定值仍存 `lib/shortcut-registry`，窗口处理器读同一来源。
 * - 检视入口：本目录与 `apps/desktop/test/shortcuts-settings-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "shortcuts";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-shortcuts-settings";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "shortcuts",
		moduleUrl: "./page.tsx",
		label: "快捷键",
		icon: "command",
		order: 5,
		keywords: ["快捷键", "shortcut", "键位", "keybind", "绑定", "binding"],
		availability: "always",
	});
}
