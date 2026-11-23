import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export const name = "musepi-stt";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	stt(ctx);
}

function stt(ctx: PluginAPI): void {}
