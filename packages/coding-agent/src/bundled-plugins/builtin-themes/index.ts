import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-builtin-themes";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	builtinThemes(ctx);
}

function builtinThemes(ctx: ExtensionAPI): void {
	ctx.setLabel("内置主题包");
}
