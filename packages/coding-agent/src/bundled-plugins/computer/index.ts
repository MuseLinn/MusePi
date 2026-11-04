import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerComputerPrompts } from "./prompts";

export const name = "musepi-computer";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	computer(pi);
	if (pi.promptHost) registerComputerPrompts(pi.promptHost);
}

export default function computer(pi: ExtensionAPI): void {
	pi.setLabel("电脑操作");
}
