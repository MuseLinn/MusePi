import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tts";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	tts(ctx);
}

function tts(ctx: ExtensionAPI): void {}
