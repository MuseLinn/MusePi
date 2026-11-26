/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-appearance` 桌面 Cordis 插件、`settings.section` 设置页（id `appearance`）。
 * - 输入：宿主传入的 rpc；页面读 `appearance.*`（主题、强调色、玻璃材质），头像与品牌图标
 *   偏好由 `lib/avatar-preference` 与 `lib/brand-icon-style` 的订阅式模块自持。
 * - 输出：设置页「外观」整页 —— 主题与强调色、头像开关、品牌图标样式、伙伴形象、对话预览。
 * - 生命周期：页面随设置页导航挂载/卸载；预览与拾色器状态属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「外观」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `appearance` 页；不接管 `lib/appearance` 的主题应用逻辑。
 * - 检视入口：本目录与 `apps/desktop/test/settings-appearance-plugin.test.tsx`。
 */
interface AppearanceSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "appearance";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-settings-appearance";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: AppearanceSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "appearance",
		moduleUrl: "./page.tsx",
		label: "外观",
		icon: "palette",
		order: 1,
		keywords: ["外观", "appearance", "主题", "theme", "强调色", "accent", "头像", "avatar", "品牌"],
		availability: "always",
	});
}
