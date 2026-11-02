import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-terminal";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	terminal(pi);
}

export default function terminal(pi: ExtensionAPI): void {
	pi.setLabel("终端");
}
