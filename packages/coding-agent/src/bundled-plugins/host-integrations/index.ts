import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerHostIntegrationPrompts } from "./prompts";

export const name = "musepi-host-integrations";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	pi.setLabel("宿主集成");
	if (pi.promptHost) registerHostIntegrationPrompts(pi.promptHost);
}

export default { name, inject, provide, apply };
