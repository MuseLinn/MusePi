/**
 * 六字段能力缝声明(docs/capability-seams.md 的 Cordis 行):
 * - 名称+ns:`ui-theme` 桌面 Cordis 主题 bundle、`shell.overlay` 根级覆盖层 +
 *   `settings.section.appearance.item` 内置外观页分区。
 * - 输入:宿主注入的 `rpc`(可为空)与 `slot-host` 契约;轨道只读 DOM 几何与
 *   `scrollbar-skins` 宿主模块里的皮肤目录,不新开后端。
 * - 输出:横向/纵向浮动滚动进度轨(portal 到 body)与滚动条皮肤/常显设置分区。
 * - 生命周期:轨道随 `shell.overlay` 挂载/卸载(窗口监听、探活、Observer、rAF
 *   由 rail.tsx 自回收);设置分区随外观页挂载,读写 localStorage + 事件。
 * - 启停:停用或编译失败时 `shell.overlay` 回退宿主内置 `<FloatingScrollbar/>`,
 *   外观分区消失;皮肤目录里的内置项仍由宿主兜底。
 * - 冲突:独占 `shell.overlay` 与 `settings.section.appearance.item`;不接管外观页其他设置。
 *   其他插件可自行选择 `settings.section.<page>` / `settings.item.<id>` 座位。
 * - 检视入口:本目录、`rail.tsx`、`skins.ts` 与 `test/ui-theme.test.tsx`。
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
	// The rail is a window-level fixed layer; its component portals to body.
	ctx.slots.register({ slot: "shell.overlay", moduleUrl: "./rail.tsx", label: "滚动进度轨" });
	// The skin picker/import/always-visible section sits in the built-in
	// Appearance page. A plugin may also register `settings.item.<id>` for the
	// extension center, or both and branch on the injected `slot` prop.
	ctx.slots.register({
		slot: "settings.section.appearance.item",
		moduleUrl: "./settings.tsx",
		label: "滚动进度轨",
	});
}
