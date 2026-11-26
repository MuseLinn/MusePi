/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-subagents` 桌面 Cordis 插件、`settings.section` 设置页（id `subagents`）。
 * - 输入：宿主传入的 rpc；页面读 `settings.get` / `settings.set`（子代理模型）与 `settings.schema` 的 tasks tab。
 * - 输出：设置页「任务与子智能体」整页 —— 子代理模型与任务相关设置。
 * - 生命周期：页面随设置页导航挂载/卸载；模型下拉的加载状态属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「任务与子智能体」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `subagents` 页；不接管子代理运行时与模型解析。
 * - 检视入口：本目录与 `apps/desktop/test/settings-subagents-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "subagents";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-settings-subagents";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "subagents",
		moduleUrl: "./page.tsx",
		label: "任务与子智能体",
		icon: "user",
		order: 16,
		keywords: ["子智能体", "subagent", "任务", "task", "模型", "model", "并行", "parallel"],
		availability: "always",
	});
}
