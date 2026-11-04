import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerBrowserPrompts } from "./prompts";

export const name = "musepi-browser";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	browser(pi);
	if (pi.promptHost) registerBrowserPrompts(pi.promptHost);
}

export default function browser(pi: ExtensionAPI): void {
	pi.setLabel("浏览器");
}
