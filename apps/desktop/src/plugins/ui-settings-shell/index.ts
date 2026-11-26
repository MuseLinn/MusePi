/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-shell` 桌面 Cordis 插件、`settings.section` 设置页（id `shell`）。
 * - 输入：宿主传入的 rpc；页面读 `settings.schema` 的 `shell` tab 与 minimizer 统计（`stats.*`）。
 * - 输出：设置页「Shell」整页 —— bash/求值相关设置与 minimizer 节省统计。
 * - 生命周期：页面随设置页导航挂载/卸载；页面内表单与统计请求属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「Shell」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `shell` 页；不接管 shell 执行器与 minimizer 实现。
 * - 检视入口：本目录与 `apps/desktop/test/settings-shell-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "shell";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-settings-shell";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "shell",
		moduleUrl: "./page.tsx",
		label: "Shell",
		icon: "terminal-window",
		order: 11,
		keywords: ["shell", "bash", "终端", "terminal", "求值", "eval", "minimizer", "压缩", "savings"],
		availability: "always",
	});
}
