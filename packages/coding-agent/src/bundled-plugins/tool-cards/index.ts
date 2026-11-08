import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tool-cards";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	toolCards(ctx);
}

function toolCards(ctx: ExtensionAPI): void {
	ctx.setLabel("工具卡片渲染器");
}
