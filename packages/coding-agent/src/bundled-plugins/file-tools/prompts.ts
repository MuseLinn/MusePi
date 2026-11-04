/**
 * File-tool guidance owned by the `file-tools` bundled plugin.
 *
 * One tool section per tool, registered at the shared tool anchor. The host
 * gates each section on the active tool set and supplies the wire name, so the
 * text names the tool the model will call and disappears as soon as the tool
 * (or this plugin) is disabled. The static prose lives in the sibling `.md`
 * Handlebars templates; these functions only collect the template data (the
 * active wire names) and render.
 */
import { prompt } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../prompts/host";
import { PROMPT_ORDERS } from "../../prompts/orders";
import type { PromptContributionContext } from "../../prompts/types";
import { activeWireName, wireName } from "../prompt-context";
import astTemplate from "./ast.md" with { type: "text" };
import editTemplate from "./edit.md" with { type: "text" };
import globTemplate from "./glob.md" with { type: "text" };
import grepTemplate from "./grep.md" with { type: "text" };
import readTemplate from "./read.md" with { type: "text" };
import writeTemplate from "./write.md" with { type: "text" };

/** Owner recorded on every contribution from this package. */
export const FILE_TOOLS_OWNER = "bundled:file-tools";

export function renderRead(context: PromptContributionContext): string {
	return prompt.render(readTemplate, { read: wireName(context, "read") });
}

export function renderWrite(context: PromptContributionContext): string {
	return prompt.render(writeTemplate, { write: wireName(context, "write") });
}

export function renderEdit(context: PromptContributionContext): string {
	return prompt.render(editTemplate, { edit: wireName(context, "edit") });
}

export function renderGrep(context: PromptContributionContext): string {
	return prompt.render(grepTemplate, { grep: wireName(context, "grep") });
}

export function renderGlob(context: PromptContributionContext): string {
	return prompt.render(globTemplate, { glob: wireName(context, "glob") });
}

/** One AST section covers both tools; each line appears only for an active tool. */
export function renderAst(context: PromptContributionContext): string | undefined {
	const astGrep = activeWireName(context, "ast_grep");
	const astEdit = activeWireName(context, "ast_edit");
	if (!astGrep && !astEdit) return undefined;
	return prompt.render(astTemplate, { astGrep, astEdit });
}

/**
 * Register every file-tool section. Re-registration releases the previous
 * owner first, so an HMR remount cannot leave a second layer behind.
 */
export function registerFileToolPrompts(host: PromptHostSurface): () => void {
	host.removeByOwner(FILE_TOOLS_OWNER);
	const disposers = [
		host.registerTool({ tool: "read", text: renderRead, owner: FILE_TOOLS_OWNER }),
		host.registerTool({ tool: "write", text: renderWrite, owner: FILE_TOOLS_OWNER }),
		host.registerTool({ tool: "edit", wireNames: ["apply_patch"], text: renderEdit, owner: FILE_TOOLS_OWNER }),
		host.registerTool({ tool: "grep", text: renderGrep, owner: FILE_TOOLS_OWNER }),
		host.registerTool({ tool: "glob", text: renderGlob, owner: FILE_TOOLS_OWNER }),
		host.registerSection({
			name: "tool:ast",
			order: PROMPT_ORDERS.tool,
			text: renderAst,
			owner: FILE_TOOLS_OWNER,
		}),
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
