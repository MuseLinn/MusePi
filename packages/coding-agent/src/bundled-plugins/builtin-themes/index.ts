import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-builtin-themes";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	builtinThemes(pi);
}

export default function builtinThemes(pi: ExtensionAPI): void {
	pi.setLabel("内置主题包");
}
