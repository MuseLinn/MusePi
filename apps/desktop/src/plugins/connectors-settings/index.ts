/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`connectors-settings` 桌面 Cordis 插件、`settings.section.connectors` 设置页槽位。
 * - 输入：宿主传入的 rpc、`onApplyPrompt`（把示例交给输入框并关闭设置）；页面读取
 *   `connectors.catalog.list` / `connectors.connect` / `mcp.oauth.*` / `connectors.cli.*`。
 * - 输出：设置页「连接器」整页 —— 目录分组、搜索、详情弹窗、凭据表单、设备码登录、
 *   CLI 授权与本地进程批准。
 * - 生命周期：页面随设置页导航挂载；设备码轮询与 CLI 轮询属页面内 timer，卸载即停。
 * - 启停：停用/编译失败时槽位消失，SettingsView 回退内置 `ConnectorsSection`
 *   （同一 RPC 契约，验收与状态不丢失）。
 * - 冲突：独占 `settings.section.connectors`；不接管 `connectors.*` 的 daemon 服务。
 * - 检视入口：本目录与 `test/settings-plugin-tabs.test.tsx`。
 *
 * 现阶段页面实现仍由宿主源文件持有（插件在构建期内联，单一事实源）；下一步把实现
 * 搬进本包时，宿主保留同构回退，回退走同一 daemon 契约。
 */
interface ConnectorsSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section.connectors";
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

export const name = "musepi-connectors-settings";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ConnectorsSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section.connectors",
		moduleUrl: "./page.tsx",
		label: "连接器",
		icon: "plug",
		order: 2,
		keywords: ["连接器", "connector", "mcp", "oauth", "授权", "远端", "remote"],
		availability: "always",
	});
}
