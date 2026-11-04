/**
 * Computer-use guidance owned by the `computer` bundled plugin.
 *
 * The safety block in `prompts/system/computer-safety.md` remains host-owned
 * for now; this package owns only the routing and verification text that used
 * to live in the core template. The model-visible prose lives in
 * `computer.md`; this module only collects the template data and renders it.
 */

import { prompt } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../prompts/host";
import { PROMPT_ORDERS } from "../../prompts/orders";
import type { PromptContributionContext } from "../../prompts/types";
import { wireName } from "../prompt-context";
import computerTemplate from "./computer.md" with { type: "text" };

export const COMPUTER_PROMPT_OWNER = "bundled:computer";

export function renderComputer(context: PromptContributionContext): string {
	return prompt.render(computerTemplate, { computer: wireName(context, "computer") });
}

export function registerComputerPrompts(host: PromptHostSurface): () => void {
	host.removeByOwner(COMPUTER_PROMPT_OWNER);
	return host.registerTool({
		tool: "computer",
		order: PROMPT_ORDERS.tool,
		text: renderComputer,
		owner: COMPUTER_PROMPT_OWNER,
	});
}
