import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export const name = "musepi-builtin-themes";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	builtinThemes(ctx);
}

function builtinThemes(ctx: PluginAPI): void {}
