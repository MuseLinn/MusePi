import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerComputerPrompts } from "./prompts";

export const name = "musepi-computer";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	computer(ctx);
	// Prompt contributions are session-scoped (dsh: register when the agent
	// exists), so a shared instance can serve several sessions.
	ctx.on("session_start", () => {
		if (ctx.promptHost) registerComputerPrompts(ctx.promptHost);
	});
}

function computer(ctx: ExtensionAPI): void {
	ctx.setLabel("电脑操作");
}
