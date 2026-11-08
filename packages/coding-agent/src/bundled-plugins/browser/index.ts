import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerBrowserPrompts } from "./prompts";

export const name = "musepi-browser";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	browser(ctx);
	if (ctx.promptHost) registerBrowserPrompts(ctx.promptHost);
}

function browser(ctx: ExtensionAPI): void {
	ctx.setLabel("浏览器");
}
