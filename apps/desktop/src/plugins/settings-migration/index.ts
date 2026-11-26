/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-migration` 桌面 Cordis 插件、`settings.section` 设置页（id `migration`）。
 * - 输入：宿主传入的 rpc；页面读 `migration.*` 状态并触发迁移动作。
 * - 输出：设置页「数据迁移」整页 —— 导入路径、扫描结果与执行。
 * - 生命周期：页面随设置页导航挂载/卸载；页面内表单与请求状态属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「数据迁移」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `migration` 页；不接管 `migration.*` 的 daemon 迁移实现。
 * - 检视入口：本目录与 `apps/desktop/test/settings-migration-plugin.test.tsx`。
 */
interface SettingsPagePluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "migration";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-settings-migration";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SettingsPagePluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "migration",
		moduleUrl: "./page.tsx",
		label: "数据迁移",
		icon: "download",
		order: 15,
		keywords: ["迁移", "migration", "导入", "import", "数据", "data", "安装", "install"],
		availability: "always",
	});
}
