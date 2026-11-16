/**
 * Visual-answers guidance owned by the `genui` plugin.
 *
 * The section used to live in the core system template behind
 * `{{#if (includes tools "widget")}}`, with `widgetRenderWhen` passed in as a
 * template variable. That put the session's visual contract in the core prompt:
 * removing the plugin left the guidance behind, and editing it meant editing
 * the template every host renders. It is a `registerTool` contribution now —
 * present exactly while the `widget` tool is, released with the plugin.
 *
 * `when.ts` stays the one source of the "when to draw" sentence: the template
 * interpolates it rather than carrying a second copy.
 */

import { prompt } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../prompts/host";
import { PROMPT_ORDERS } from "../../prompts/orders";
import type { PromptContributionContext } from "../../prompts/types";
import section from "./visual-answers.md" with { type: "text" };
import { WIDGET_RENDER_WHEN } from "./when";

export const VISUAL_PROMPT_OWNER = "bundled:visuals";

export function renderVisualAnswers(_context: PromptContributionContext): string {
	return prompt.render(section, { widgetRenderWhen: WIDGET_RENDER_WHEN });
}

export function registerVisualPrompts(host: PromptHostSurface): () => void {
	host.removeByOwner(VISUAL_PROMPT_OWNER);
	return host.registerTool({
		tool: "widget",
		order: PROMPT_ORDERS.tool,
		text: renderVisualAnswers,
		owner: VISUAL_PROMPT_OWNER,
	});
}
