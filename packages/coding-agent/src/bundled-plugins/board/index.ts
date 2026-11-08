/**
 * 桌面看板读写，作为内置 Cordis 插件。
 *
 * 能力缝声明（索引：docs/capability-seams.md「看板插件」）：
 * - 名称+ns：`musepi-board` 插件、`board` Agent 工具、`board.list` /
 *   `board.save` daemon RPC 共用的存储（`store.ts`）。
 * - 输入：board id / 完整看板对象；RPC 侧为 boards 数组。
 * - 输出：看板清单与单板内容；保存前按 `WIDGET_TYPES` 校验卡片类型与整数坐标。
 * - 生命周期：无状态；存储是 `~/.musepi/boards/boards.json`（原子写）。
 * - 启停：`board.enabled` 经工具定义的 `enabled` 闸门；插件启停走 Cordis fiber。
 * - 冲突：独占 `board` 工具名与看板存储文件；`widget.schema` RPC 仍由 daemon
 *   暴露（读 visuals 插件的类型表）。
 * - 检视入口：`src/bundled-plugins/board/`、`docs/gui-widget-spec.md`。
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { BoardTool } from "./tool";

export const name = "musepi-board";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi 看板");
	ctx.tools.register(new BoardTool());
}
