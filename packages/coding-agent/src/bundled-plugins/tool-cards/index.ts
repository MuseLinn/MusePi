import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tool-cards";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	toolCards(pi);
}

export default function toolCards(pi: ExtensionAPI): void {
	pi.setLabel("工具卡片渲染器");
}
