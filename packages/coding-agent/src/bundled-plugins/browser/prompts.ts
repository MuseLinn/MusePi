/**
 * Browser verification guidance owned by the `browser` bundled plugin.
 *
 * The core template keeps the fallback rule for surfaces with no runtime tool;
 * this section is the browser-specific half of the verification workflow.
 * The model-visible prose lives in `browser.md`; this module only collects the
 * template data and renders it.
 */

import { prompt } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../prompts/host";
import { PROMPT_ORDERS } from "../../prompts/orders";
import type { PromptContributionContext } from "../../prompts/types";
import { wireName } from "../prompt-context";
import browserTemplate from "./browser.md" with { type: "text" };

export const BROWSER_PROMPT_OWNER = "bundled:browser";

export function renderBrowser(context: PromptContributionContext): string {
	return prompt.render(browserTemplate, { browser: wireName(context, "browser") });
}

export function registerBrowserPrompts(host: PromptHostSurface): () => void {
	host.removeByOwner(BROWSER_PROMPT_OWNER);
	return host.registerTool({
		tool: "browser",
		order: PROMPT_ORDERS.tool,
		text: renderBrowser,
		owner: BROWSER_PROMPT_OWNER,
	});
}
