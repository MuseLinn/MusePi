import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-browser";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	browser(pi);
}

export default function browser(pi: ExtensionAPI): void {
	pi.setLabel("浏览器");
}
