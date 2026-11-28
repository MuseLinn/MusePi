/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-commands` 桌面 Cordis 插件、`settings.section` 设置页（id `commands`）。
 * - 输入：宿主传入的 rpc；read-only slash 命令目录（commands.list）。
 * - 输出：设置页「命令」整页。
 * - 生命周期：页面随设置页导航挂载/卸载。
 * - 启停：停用/编译失败时槽位消失，「命令」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `commands` 页；不接管 `commands.list` 的 daemon 服务。
 * - 检视入口：本目录与 `apps/desktop/test/settings-commands-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "commands";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-commands";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "commands",
		moduleUrl: "./page.tsx",
		label: "命令",
		icon: "command",
		order: 4,
		keywords: ["命令", "command", "slash", "斜杠", "自定义", "快捷"],
		availability: "always",
	});
}
