import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerDelegationPrompts } from "./prompts";

export const name = "musepi-delegation";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("任务委托");
	// Prompt contributions are session-scoped (dsh: register when the agent
	// exists), so a shared instance can serve several sessions.
	ctx.on("session_start", () => {
		if (ctx.promptHost) registerDelegationPrompts(ctx.promptHost);
	});
}
