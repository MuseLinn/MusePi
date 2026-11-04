/**
 * LSP guidance owned by the `lsp` bundled plugin.
 *
 * Both the routing rule and the references-before-edit gate live here so the
 * core template keeps only cross-tool contracts. The model-visible prose
 * lives in `lsp.md`; this module only collects the template data and renders
 * it.
 */

import { prompt } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../prompts/host";
import { PROMPT_ORDERS } from "../../prompts/orders";
import type { PromptContributionContext } from "../../prompts/types";
import { wireName } from "../prompt-context";
import lspTemplate from "./lsp.md" with { type: "text" };

export const LSP_PROMPT_OWNER = "bundled:lsp";

export function renderLsp(context: PromptContributionContext): string {
	return prompt.render(lspTemplate, { lsp: wireName(context, "lsp") });
}

export function registerLspPrompts(host: PromptHostSurface): () => void {
	host.removeByOwner(LSP_PROMPT_OWNER);
	return host.registerTool({
		tool: "lsp",
		order: PROMPT_ORDERS.tool,
		text: renderLsp,
		owner: LSP_PROMPT_OWNER,
	});
}
