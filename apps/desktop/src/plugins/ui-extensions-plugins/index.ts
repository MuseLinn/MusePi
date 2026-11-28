/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`ui-extensions-plugins` 桌面 Cordis 插件、`settings.section` 设置页（id `skills`）。
 *   这页不是某个 schema 标签页，而是扩展控制中心本身，故按领域命名而非 `ui-settings-<page>`。
 * - 输入：宿主传入的 rpc；页面读 `extensions.*`、技能与上下文文件目录。
 * - 输出：设置页「扩展与插件」整页 —— 提供方标签、分类清单与详情面板。
 * - 生命周期：页面随设置页导航挂载/卸载；两栏各自滚动，页面本身不滚。
 * - 启停：停用/编译失败时槽位消失，「扩展与插件」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `skills` 页；不接管 `extensions.*` 的 daemon 装载。
 * - 检视入口：本目录与 `apps/desktop/test/ui-extensions-plugins-plugin.test.tsx`。
 */
interface ExtensionsSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "skills";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-extensions-plugins";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionsSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "skills",
		moduleUrl: "./page.tsx",
		label: "扩展与插件",
		icon: "sparkling",
		order: 19,
		keywords: ["扩展", "插件", "extension", "plugin", "技能", "skill", "上下文", "context"],
		availability: "always",
	});
}
