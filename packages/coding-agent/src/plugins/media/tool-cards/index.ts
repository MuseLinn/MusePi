import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export const name = "musepi-tool-cards";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	toolCards(ctx);
}

function toolCards(ctx: PluginAPI): void {}
