/**
 * 六字段能力缝声明(docs/capability-seams.md 的 Cordis 行):
 * - 名称+ns:`ui-theme` 桌面 Cordis 主题 bundle、`settings.item.appearance.rail`
 *   内置外观页分区。
 * - 输入:宿主注入的 `rpc`(可为空)与 `scrollbar-skins` 宿主模块里的皮肤目录,
 *   不新开后端。
 * - 输出:滚动条皮肤选择/导入设置分区。滚动条本身是原生的
 *   (`packages/client-core/src/styles/base.css`),本 bundle 只提供皮肤目录与
 *   配方 CSS,不拥有任何覆盖层或滚动行为。
 * - 生命周期:设置分区随外观页挂载,读写 localStorage + 窗口事件;皮肤在应用
 *   启动时由 `app.tsx` 调 `applyScrollbarSkin` 写到 `<html>`。
 * - 启停:停用或编译失败时设置分区消失;已应用的皮肤属性留在 `<html>` 上,
 *   原生滚动条与 `classic` 配方仍然工作。
 * - 冲突:独占 `settings.item.appearance.rail`;不接管外观页其他设置。其他插件
 *   可自行选择 `settings.section`(页)或 `settings.item.<page>.<row>`(页内行)座位。
 * - 检视入口:本目录、`skins.ts`、`skins.css` 与 `test/scrollbar-skins.test.ts`。
 */
interface UiThemePluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-ui-theme";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: UiThemePluginApi): void {
	// The skin picker/import section sits in the built-in Appearance page: a
	// page-owned row rides `settings.item.<page>.<row>`. A settings card for the
	// extension center uses `settings.item.<extId>`; an entry may take both seats
	// and branch on the injected `slot` prop.
	ctx.slots.register({
		slot: "settings.item.appearance.rail",
		moduleUrl: "./settings.tsx",
		label: "滚动条皮肤",
	});
}
