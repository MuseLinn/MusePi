import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-compaction-summary";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi 压缩摘要");
	ctx.slots.register({
		slot: "panel.tab.compaction",
		moduleUrl: "./ui/summary-panel.tsx",
		label: "压缩摘要",
		order: 20,
		availability: "on-demand",
	});
}
