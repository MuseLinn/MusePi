/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`index-library` 桌面 Cordis 插件、`settings.section` 设置页（id `indexes`）。
 * - 输入：宿主传入的 rpc 与 cwd；页面读取 `file.index.status` / `file.index.search`。
 * - 输出：设置页「索引库」整页 —— 开关、目录、扫描状态、即时搜索与命中片段。
 * - 生命周期：页面随设置页导航挂载；搜索按输入防抖，卸载即取消防抖。
 * - 启停：停用/编译失败时槽位消失，「索引库」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `indexes` 页；不接管文件索引服务本身。
 * - 检视入口：本目录与 `test/settings-plugin-tabs.test.tsx`。
 */
interface IndexLibraryPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "indexes";
			moduleUrl: "./page.tsx";
			label: string;
			/** dsh settings.section owner options. */
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-index-library";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: IndexLibraryPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "indexes",
		moduleUrl: "./page.tsx",
		label: "索引库",
		icon: "book",
		order: 0,
		keywords: ["索引", "index", "库", "搜索", "scan", "工作区"],
		availability: "always",
	});
}
