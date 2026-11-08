import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerBrowserPrompts } from "./prompts";

export const name = "musepi-browser";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	browser(ctx);
	// Prompt contributions are session-scoped (dsh: register when the agent
	// exists), so a shared instance can serve several sessions.
	ctx.on("session_start", () => {
		if (ctx.promptHost) registerBrowserPrompts(ctx.promptHost);
	});
}

function browser(ctx: ExtensionAPI): void {
	ctx.setLabel("浏览器");
}
