/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-files` 桌面 Cordis 插件、`settings.section` 设置页（id `files`）。
 * - 输入：宿主传入的 rpc；页面读 daemon 的 `settings.schema`（`files` tab：编辑/读取/摘要/LSP）。
 * - 输出：设置页「文件与 LSP」整页 —— 由共享 schema 渲染，与终端面板同一份事实来源。
 * - 生命周期：页面随设置页导航挂载/卸载；schema 数据由宿主缓存提供。
 * - 启停：停用/编译失败时槽位消失，「文件与 LSP」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `files` 页；不接管 `settings.schema` 的 daemon 服务。
 * - 检视入口：本目录与 `apps/desktop/test/settings-files-plugin.test.tsx`。
 */
interface FilesSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "files";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-settings-files";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: FilesSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "files",
		moduleUrl: "./page.tsx",
		label: "文件与 LSP",
		icon: "file-text",
		order: 8,
		keywords: ["文件", "file", "lsp", "语言服务", "编辑", "edit", "读取", "read", "摘要", "summarize"],
		availability: "always",
	});
}
