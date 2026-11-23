/**
 * 可视化卡片与内联页面，作为内置 Cordis 插件。
 *
 * 能力缝声明（索引：docs/capability-seams.md「可视化插件」）：
 * - 名称+ns：`musepi-visuals` 插件、`widget` Agent 工具、`provide: "genui"`
 *   服务（看板插件依赖它）。
 * - 职责边界：**只负责会话内的可视化**——回复里的 `ui` 块与 `widget` 页面。
 *   看板的卡片类型表（`WIDGET_TYPES`）已迁到 `bundled-plugins/board`，本插件
 *   不再知道看板的存在。
 * - 输入：`title` / `html` / `awaitAnswer`（一页自包含 HTML）。
 * - 输出：page 的 `details` 载荷（GUI 渲染成 html 卡面）。
 * - 生命周期：无状态、无后台任务；卸载即从会话工具面移除。
 * - 启停：`widget.enabled` 设置经工具定义上的 `enabled` 闸门生效；插件
 *   启停走 Cordis fiber。
 * - 冲突：独占 `widget` 工具名。
 * - 检视入口：`src/bundled-plugins/visuals/`、`docs/gui-widget-spec.md`。
 */
import type { PluginAPI } from "../../extensibility/extensions/types";
import { registerVisualPrompts } from "./prompts";
import { WidgetTool } from "./tool";

export const name = "musepi-visuals";
export const inject = [] as const;
/** The service the board plugin depends on: blocks + pages for a session. */
export const provide = ["genui"] as const;

export function apply(ctx: PluginAPI): void {
	ctx.tools.register(new WidgetTool());
	// The visual contract travels with the plugin that owns it, exactly like the
	// browser plugin's verification section.
	ctx.on("session_start", () => {
		if (ctx.promptHost) registerVisualPrompts(ctx.promptHost);
	});
}
