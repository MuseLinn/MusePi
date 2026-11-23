/**
 * 桌面看板读写，作为内置 Cordis 插件。
 *
 * 能力缝声明（索引：docs/capability-seams.md「看板插件」）：
 * - 名称+ns：`musepi-board` 插件、`board` Agent 工具、`board.list` /
 *   `board.save` daemon RPC 共用的存储（`store.ts`）。
 * - 输入：board id / 完整看板对象；RPC 侧为 boards 数组。
 * - 依赖：`inject: ["genui"]` —— 看板渲染的是会话可视化插件产出的块/页面，
 *   卡片类型表由本插件自己拥有（`catalog.ts` 的 `WIDGET_TYPES`）。
 * - 输出：看板清单与单板内容；保存前按 `WIDGET_TYPES` 校验卡片类型与整数坐标。
 * - 生命周期：无状态；存储是 `~/.musepi/boards/boards.json`（原子写）。
 * - 启停：`board.enabled` 经工具定义的 `enabled` 闸门；插件启停走 Cordis fiber。
 * - 冲突：独占 `board` 工具名与看板存储文件；`widget.schema` RPC 由 daemon
 *   暴露，读的就是本插件的类型表。
 * - 检视入口：`src/plugins/media/board/`、`docs/gui-widget-spec.md`。
 */
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { BoardTool } from "./tool";

export const name = "musepi-board";
/** A board renders what the session's visual surface produces, so it loads after it. */
export const inject = ["genui"] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	ctx.tools.register(new BoardTool());
	// No seed faces: a board card is generated content now (block or page).
}
