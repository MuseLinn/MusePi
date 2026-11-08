import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerHostIntegrationPrompts } from "./prompts";

export const name = "musepi-host-integrations";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("宿主集成");
	// Prompt contributions are session-scoped (dsh: register when the agent
	// exists), so a shared instance can serve several sessions.
	ctx.on("session_start", () => {
		if (ctx.promptHost) registerHostIntegrationPrompts(ctx.promptHost);
	});
}
