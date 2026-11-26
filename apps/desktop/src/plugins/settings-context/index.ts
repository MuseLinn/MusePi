/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-context` 桌面 Cordis 插件、`settings.section` 设置页（id `context`）。
 * - 输入：页面读 `settings.get`（`workspace.additionalDirectories`）与 `pickDirectory` 选目录；其余行来自 `settings.schema` 的 `context` tab。
 * - 输出：设置页「上下文」整页 —— 默认工作区目录与压缩窗口。
 * - 生命周期：页面随设置页导航挂载/卸载；页面内表单与统计请求属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「上下文」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `context` 页；不接管 `settings.schema` 的 daemon 服务。
 * - 检视入口：本目录与 `apps/desktop/test/settings-context-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "context";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-settings-context";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "context",
		moduleUrl: "./page.tsx",
		label: "上下文",
		icon: "stack",
		order: 10,
		keywords: [
			"上下文",
			"context",
			"压缩",
			"compact",
			"窗口",
			"window",
			"token",
			"令牌",
			"限制",
			"limit",
			"目录",
			"directory",
		],
		availability: "always",
	});
}
