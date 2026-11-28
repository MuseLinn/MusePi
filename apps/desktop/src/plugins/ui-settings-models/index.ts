/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-model` 桌面 Cordis 插件、`settings.section` 设置页（id `model`）。
 * - 输入：宿主传入的 rpc 与 sessionId；页面经 `lib/use-provider-catalog` 读
 *   `providers.list` / `models.listCustom`，并自己订阅 daemon 的 `provider-*` 授权事件。
 * - 输出：设置页「模型与供应商」整页 —— 供应商登录、API 密钥、自定义供应商、
 *   模型目录与思考默认值。
 * - 生命周期：页面随设置页导航挂载/卸载；登录面板与新增表单属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「模型与供应商」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `model` 页；不接管 `providers.*` 的 daemon 认证流程。
 * - 检视入口：本目录与 `apps/desktop/test/settings-model-plugin.test.tsx`。
 */
interface ModelSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "model";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-settings-models";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ModelSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "model",
		moduleUrl: "./page.tsx",
		label: "模型与供应商",
		icon: "ai-agent",
		order: 9,
		keywords: ["模型", "model", "供应商", "provider", "登录", "login", "密钥", "key", "自定义", "custom"],
		availability: "always",
	});
}
