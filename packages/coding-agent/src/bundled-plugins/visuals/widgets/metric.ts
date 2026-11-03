/**
 * The first widget type contributed through `registerWidget` (the seam pilot).
 *
 * Metadata lives in the plugin package next to the renderer: the daemon reads
 * it for `widget` payload validation, the agent schema and the board editor;
 * the GUI compiles `moduleUrl` and registers the component beside the built-in
 * types. `defaults()` is a function so two boards never share one object.
 */
import type { ExtensionWidget } from "../../../extensibility/extensions/types";

export const METRIC_WIDGET: ExtensionWidget = {
	type: "metric",
	label: "指标",
	description: "滚动数字 + 涨跌标签 + 迷你走势",
	tone: "default",
	fields: [
		{ key: "label", type: "string", label: "标签" },
		{ key: "value", type: "number", label: "数值" },
		{ key: "delta", type: "number", label: "涨跌" },
	],
	defaults: () => ({
		label: "月活跃",
		value: 4200,
		delta: 0.12,
		history: [3, 4, 3.5, 5, 4.5, 6, 5.5, 7, 6.5, 8, 7.5, 9],
	}),
	moduleUrl: "./ui/metric.tsx",
};
