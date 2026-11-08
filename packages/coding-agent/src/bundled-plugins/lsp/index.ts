import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { registerLspPrompts } from "./prompts";

export const name = "musepi-lsp";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	lsp(ctx);
	if (ctx.promptHost) registerLspPrompts(ctx.promptHost);
}

function lsp(ctx: ExtensionAPI): void {
	ctx.setLabel("语言服务（LSP）");
}
