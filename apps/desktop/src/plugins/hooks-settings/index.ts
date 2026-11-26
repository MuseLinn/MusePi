/**
 * 六字段能力缝声明：
 * - 名称+ns：`hooks-settings` 桌面 Cordis 插件、`settings.section` 设置页（id `hooks`）。
 * - 输入：宿主传入的 rpc；页面读取 `extensions.list` 与 `extensions.setEnabled`。
 * - 输出：设置页「钩子」整页 —— hook 能力扩展与各自的启用开关。
 * - 生命周期：页面随设置页导航挂载/卸载；数据来自共享注册表单例。
 * - 启停：停用后槽位消失，SettingsView 回退内置 `HooksSection`。
 * - 冲突：独占 `settings.section` 的 `hooks` 页；不接管 hook 执行引擎。
 * - 检视入口：本目录与 `apps/desktop/test/hooks-settings-plugin.test.tsx`。
 */
interface HooksSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "hooks";
			moduleUrl: "./page.tsx";
			label: string;
			availability: "always";
		}): void;
	};
}

export const name = "musepi-hooks-settings";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: HooksSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "hooks",
		moduleUrl: "./page.tsx",
		label: "钩子",
		availability: "always",
	});
}
