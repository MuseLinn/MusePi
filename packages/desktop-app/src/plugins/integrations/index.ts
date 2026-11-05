/**
 * 六字段能力缝声明：
 * - 名称+ns：`integrations` 桌面 Cordis 插件、`settings.tab.integrations` 设置页槽位。
 * - 输入：宿主传入的 rpc，以及 `mcp.servers.list/add/remove`（用户级
 *   `<agentDir>/mcp.json`，与 discovery、`/mcp add` 同一份配置）。
 * - 输出：设置页「集成」整页 —— 12 个精选服务的搜索/类别浏览、一键安装与移除；
 *   token 类服务在卡片上收集令牌并写入该服务器的 headers。
 * - 生命周期：页面随设置页导航挂载/卸载；安装态每次进入页面重读，不做本地持久缓存。
 * - 启停：停用后槽位消失，导航项随 `ext:settings.tab.integrations` 一起消失；
 *   mcp.json 与已安装连接器不受影响。
 * - 冲突：独占 `settings.tab.integrations`；不接管内置「MCP 服务器」页，
 *   也不引入第二套凭据存储。
 * - 检视入口：本目录、`integrations/catalog.ts` 与 `test/integrations-plugin.test.tsx`。
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
