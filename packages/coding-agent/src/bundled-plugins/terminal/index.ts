import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-terminal";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	terminal(ctx);
}

function terminal(ctx: ExtensionAPI): void {
	ctx.setLabel("终端");
}
