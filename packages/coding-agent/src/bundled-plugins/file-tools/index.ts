import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerFileToolPrompts } from "./prompts";

export const name = "musepi-file-tools";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	fileTools(pi);
	// The session prompt host is optional in the extension API type (external
	// callers may omit it), so guard before registering the tool sections.
	if (pi.promptHost) registerFileToolPrompts(pi.promptHost);
}

export default function fileTools(pi: ExtensionAPI): void {
	pi.setLabel("文件工具与索引");
}
