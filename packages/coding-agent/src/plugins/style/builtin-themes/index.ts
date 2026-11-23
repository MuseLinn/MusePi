import type { PluginAPI } from "../../../extensibility/extensions/types";

export const name = "musepi-builtin-themes";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	builtinThemes(ctx);
}

function builtinThemes(ctx: PluginAPI): void {}
