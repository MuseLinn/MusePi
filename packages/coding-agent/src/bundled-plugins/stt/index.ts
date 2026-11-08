import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-stt";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	stt(ctx);
}

function stt(ctx: ExtensionAPI): void {
	ctx.setLabel("语音输入（STT）");
}
