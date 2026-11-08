/**
 * 可视化卡片与内联页面，作为内置 Cordis 插件。
 *
 * 能力缝声明（索引：docs/capability-seams.md「可视化插件」）：
 * - 名称+ns：`musepi-visuals` 插件、`widget` Agent 工具、`widget.schema`
 *   RPC 共用的类型表（`WIDGET_TYPES` / `WIDGET_TONES`）。
 * - 输入：结构化卡片的 `type`/`data`/`title`，或一页自包含 HTML。
 * - 输出：cards/pages 的 `details` 载荷（GUI 渲染）；`widget.schema` 的
 *   类型表（看板校验与 agent 自查）。
 * - 生命周期：无状态、无后台任务；卸载即从会话工具面移除。
 * - 启停：`widget.enabled` 设置经工具定义上的 `enabled` 闸门生效；插件
 *   启停走 Cordis fiber。
 * - 冲突：独占 `widget` 工具名与 `widget.schema` RPC。
 * - 检视入口：`src/bundled-plugins/visuals/`、`docs/gui-widget-spec.md`。
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { WidgetTool } from "./tool";
import { CLOCK_WIDGET } from "./widgets/clock";
import { METRIC_WIDGET } from "./widgets/metric";

export const name = "musepi-visuals";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi 可视化");
	ctx.tools.register(new WidgetTool());
	// The seam pilots: metadata + renderer travel as one widget type each.
	ctx.slots.registerWidget(METRIC_WIDGET);
	ctx.slots.registerWidget(CLOCK_WIDGET);
}
