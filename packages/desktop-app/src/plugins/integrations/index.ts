/**
 * 六字段能力缝声明：
 * - 名称+ns：`integrations` 桌面 Cordis 插件、`settings.tab.integrations` 设置页槽位。
 * - 输入：宿主传入的 rpc；`mcp.servers.list/add/remove`（用户级
 *   `<agentDir>/mcp.json`，与 discovery、`/mcp add` 同一份配置）、
 *   `extensions.list/setEnabled`（内置插件清单与启停）；组件模型另用既有的
 *   `marketplace.install/remove` 与 `skills.install/delete`，不新增 RPC。
 * - 输出：设置页「集成」整页 —— 精选集成卡片的搜索/类别浏览与一键安装/移除，
 *   卡片按主组件判定安装态并显示组件类型徽标；以及「内置插件」section —— 随应用
 *   自带、默认关闭的插件清单与开关。
 * - 生命周期：页面随设置页导航挂载/卸载；安装态与插件启停态每次进入页面重读，
 *   开关成功后重拉列表，不做本地持久缓存。
 * - 启停：停用后槽位消失，导航项随 `ext:settings.tab.integrations` 一起消失；
 *   mcp.json、内置插件开关与已安装连接器不受影响。
 * - 冲突：独占 `settings.tab.integrations`；不接管内置「MCP 服务器」页，
 *   也不引入第二套凭据存储或第二份插件清单。
 * - 检视入口：本目录、`integrations/catalog.ts`、`integrations/builtin-plugins.ts`
 *   与 `test/integrations-plugin.test.tsx`。
 */
interface IntegrationsPluginApi {
	setLabel(label: string): void;
	registerComponent(component: {
		slot: "settings.tab.integrations";
		moduleUrl: "./page.tsx";
		label: string;
		availability: "always";
	}): void;
}

export const name = "musepi-integrations";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: IntegrationsPluginApi): void {
	pi.setLabel("MusePi 集成");
	pi.registerComponent({
		slot: "settings.tab.integrations",
		moduleUrl: "./page.tsx",
		label: "集成",
		availability: "always",
	});
}

export default apply;
