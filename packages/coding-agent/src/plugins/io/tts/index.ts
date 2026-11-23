import type { PluginAPI } from "../../../extensibility/extensions/types";

export const name = "musepi-tts";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	tts(ctx);
}

function tts(ctx: PluginAPI): void {}
