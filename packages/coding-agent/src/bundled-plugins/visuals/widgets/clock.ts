/**
 * Market clock, second plugin-contributed widget type.
 *
 * Kept beside the renderer so the daemon table (`widget`/`board` validation)
 * and the GUI registration read one declaration. `market` is the only field;
 * the three session states are computed locally from the clock.
 */
import type { ExtensionWidget } from "../../../extensibility/extensions/types";

export const CLOCK_WIDGET: ExtensionWidget = {
	type: "clock",
	label: "时钟",
	description: "市场时钟 + CN / US / EU 交易时段",
	tone: "dark",
	fields: [{ key: "market", type: "select", label: "市场", options: ["cn", "us", "eu"] }],
	defaults: () => ({ market: "cn" }),
	moduleUrl: "./ui/clock.tsx",
};
