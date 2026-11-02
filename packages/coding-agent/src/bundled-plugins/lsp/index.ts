import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-lsp";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	lsp(pi);
}

export default function lsp(pi: ExtensionAPI): void {
	pi.setLabel("语言服务（LSP）");
}
