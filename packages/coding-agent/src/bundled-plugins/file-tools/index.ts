import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerFileToolPrompts } from "./prompts";

export const name = "musepi-file-tools";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	fileTools(ctx);
	// The session prompt host is optional in the extension API type (external
	// callers may omit it), so guard before registering the tool sections.
	// Prompt contributions are session-scoped (dsh: register when the agent
	// exists), so a shared instance can serve several sessions.
	ctx.on("session_start", () => {
		if (ctx.promptHost) registerFileToolPrompts(ctx.promptHost);
	});
}

function fileTools(ctx: ExtensionAPI): void {
	ctx.setLabel("文件工具与索引");
}
