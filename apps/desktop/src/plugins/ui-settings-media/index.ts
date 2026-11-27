/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`ui-settings-media` 桌面 Cordis 插件、`settings.section` 设置页（id `media`）。
 * - 输入：宿主传入的 rpc；页面经 `lib/use-provider-catalog` 读供应商目录与登录流程，
 *   并自己订阅 daemon 的 `provider-*` 授权事件。
 * - 输出：设置页「图像与视频生成」整页 —— 内置与扩展贡献的供应商、凭据与登录。
 * - 生命周期：页面随设置页导航挂载/卸载；登录面板属页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「图像与视频生成」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `media` 页；不接管供应商凭据存储与登录流程本身。
 * - 检视入口：本目录与 `apps/desktop/test/ui-settings-media-plugin.test.tsx`。
 */
interface MediaSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "media";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-ui-settings-media";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: MediaSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "media",
		moduleUrl: "./page.tsx",
		label: "图像与视频生成",
		icon: "image-download",
		order: 20,
		keywords: ["图像", "image", "视频", "video", "生成", "generate", "供应商", "provider"],
		availability: "always",
	});
}
