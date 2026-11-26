/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-usage` 桌面 Cordis 插件、`settings.section` 设置页（id `usage`）。
 * - 输入：宿主传入的 rpc；页面读取 `stats.aggregated` / `stats.timeseries` 等统计服务。
 * - 输出：设置页「使用统计」整页 —— 请求构成、token 与成本趋势、按工作区拆分。
 * - 生命周期：页面随设置页导航挂载/卸载；时间范围与刷新属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「使用统计」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `usage` 页；不接管 `packages/stats` 的统计服务。
 * - 检视入口：本目录与 `apps/desktop/test/settings-usage-plugin.test.tsx`。
 */
interface UsageSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "usage";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-settings-usage";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: UsageSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "usage",
		moduleUrl: "./page.tsx",
		label: "使用统计",
		icon: "star",
		order: 7,
		keywords: ["统计", "usage", "用量", "成本", "cost", "token", "模型", "model", "月度", "monthly"],
		availability: "always",
	});
}
