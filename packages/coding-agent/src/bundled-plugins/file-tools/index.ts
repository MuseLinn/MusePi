import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-file-tools";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	fileTools(pi);
}

export default function fileTools(pi: ExtensionAPI): void {
	pi.setLabel("文件工具与索引");
}
