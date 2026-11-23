import type { PluginAPI } from "../../../extensibility/extensions/types";

export const name = "musepi-terminal";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	terminal(ctx);
}

function terminal(ctx: PluginAPI): void {}
