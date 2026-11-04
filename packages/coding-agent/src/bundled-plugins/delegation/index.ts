import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerDelegationPrompts } from "./prompts";

export const name = "musepi-delegation";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	pi.setLabel("任务委托");
	if (pi.promptHost) registerDelegationPrompts(pi.promptHost);
}

export default { name, inject, provide, apply };
