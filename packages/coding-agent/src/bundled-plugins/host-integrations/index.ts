import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerHostIntegrationPrompts } from "./prompts";

export const name = "musepi-host-integrations";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("宿主集成");
	if (ctx.promptHost) registerHostIntegrationPrompts(ctx.promptHost);
}
