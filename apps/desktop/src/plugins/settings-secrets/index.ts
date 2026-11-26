/**
 * 六字段能力缝声明（docs/capability-seams.md）：
 * - 名称+ns：`settings-secrets` 桌面 Cordis 插件、`settings.section` 设置页（id `secrets`）。
 * - 输入：宿主传入的 rpc；页面读取 `secret.list` / `secret.set` / `secret.remove` /
 *   `secret.status` / `secret.protection.*` / `secret.importEnv`。
 * - 输出：设置页「保险库」整页 —— 只写条目的表单、作用域、最近使用与主密钥保护开关。
 * - 生命周期：页面随设置页导航挂载/卸载；表单草稿只存在于页面状态，卸载即丢。
 * - 启停：停用/编译失败时槽位消失，「保险库」导航项随之消失（本页无宿主内建回退）。
 * - 冲突：独占 `settings.section` 的 `secrets` 页；不接管 `secret.*` 的 daemon 服务。
 * - 检视入口：本目录与 `apps/desktop/test/settings-secrets-plugin.test.tsx`。
 */
interface SecretsSettingsPluginApi {
	slots: {
		register(component: {
			slot: "settings.section";
			id: "secrets";
			moduleUrl: "./page.tsx";
			label: string;
			icon?: string;
			order?: number;
			keywords?: readonly string[];
			availability: "always";
		}): void;
	};
}

export const name = "musepi-settings-secrets";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: SecretsSettingsPluginApi): void {
	ctx.slots.register({
		slot: "settings.section",
		id: "secrets",
		moduleUrl: "./page.tsx",
		label: "保险库",
		icon: "key",
		order: 3,
		keywords: ["保险库", "secret", "secrets", "vault", "凭据", "密钥", "env"],
		availability: "always",
	});
}
