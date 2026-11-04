/**
 * Host integration guidance owned by the `host-integrations` bundled plugin.
 *
 * Three distinct contributions:
 * - `host:xd-tools` follows the injected-device context; it is not a tool
 *   section because the devices are mounted under `xd://` instead of being
 *   top-level tools.
 * - `host:auto-qa` is a write-tool section that only renders while automated
 *   QA is enabled.
 * - `host:runtime-context` composes the host runtime appendices (memory
 *   instructions, auto-learn guidance, mounted MCP routes, MCP server
 *   instructions, user append prompt) at order 250 — after the project
 *   sections, before the repo context.
 *
 * The model-visible prose lives in `xd-tools.md`, `auto-qa.md`,
 * `mcp-xdev-guidance.md` and `mcp-server-instructions.md`; this module only
 * collects the template data, keeps the gates, and renders. The runtime
 * context and the xd device docs carry user/server-controlled text whose
 * braces are literal, so both sections are registered with
 * `interpolate: false` — `{{unknown}}` and similar sequences in dynamic data
 * pass through untouched instead of hitting strict variable resolution.
 */

import { prompt } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../prompts/host";
import { PROMPT_ORDERS } from "../../prompts/orders";
import type { PromptContributionContext } from "../../prompts/types";
import { wireName } from "../prompt-context";
import autoQaTemplate from "./auto-qa.md" with { type: "text" };
import mcpServerInstructionsTemplate from "./mcp-server-instructions.md" with { type: "text" };
import mcpXdevGuidanceTemplate from "./mcp-xdev-guidance.md" with { type: "text" };
import xdToolsTemplate from "./xd-tools.md" with { type: "text" };

export const HOST_INTEGRATIONS_PROMPT_OWNER = "bundled:host-integrations";

/** Runtime-context slot: between `PROMPT_ORDERS.project` (200) and `repoContext` (300). */
export const HOST_RUNTIME_CONTEXT_ORDER = 250;

/**
 * Runtime context fields supplied by the host for `host:runtime-context`.
 * Kept permissive (`unknown` leaves) because the values originate outside
 * the plugin boundary; the renderer narrows them defensively.
 */
export interface HostRuntimeContextData {
	memoryInstructions?: unknown;
	autoLearnInstructions?: unknown;
	mcpXdevGuidance?: {
		mappings?: Array<{ label?: string; path?: string }>;
		hasOmittedMappings?: boolean;
	};
	mcpServerInstructions?: Array<{ name?: string; instructions?: string }>;
	appendSystemPrompt?: unknown;
}

export function renderXdTools(context: PromptContributionContext): string | undefined {
	const devices = context.xdevTools;
	if (!Array.isArray(devices) || devices.length === 0) return undefined;
	return prompt.render(xdToolsTemplate, {
		write: wireName(context, "write"),
		docs: typeof context.xdevDocs === "string" ? context.xdevDocs : "",
	});
}

export function renderAutoQa(context: PromptContributionContext): string {
	return prompt.render(autoQaTemplate, { write: wireName(context, "write") });
}

/**
 * Compose the host runtime appendices in the established append order:
 * memory instructions, auto-learn guidance, mounted MCP route guidance,
 * MCP server instructions, user append prompt. Non-empty parts join with
 * a blank line; an entirely empty runtime context renders nothing.
 *
 * MCP server instructions arrive already truncated by the host — this
 * renderer never truncates them again.
 */
export function renderRuntimeContext(context: PromptContributionContext): string | undefined {
	const data = context as HostRuntimeContextData;
	const parts: string[] = [];
	const pushText = (value: unknown): void => {
		if (typeof value === "string" && value.trim().length > 0) parts.push(value);
	};
	pushText(data.memoryInstructions);
	pushText(data.autoLearnInstructions);

	const guidance = data.mcpXdevGuidance;
	if (guidance && typeof guidance === "object") {
		const mappings = Array.isArray(guidance.mappings) ? guidance.mappings : [];
		const hasOmittedMappings = guidance.hasOmittedMappings === true;
		if (mappings.length > 0 || hasOmittedMappings) {
			parts.push(
				prompt
					.render(mcpXdevGuidanceTemplate, {
						tools: mappings.map(mapping => ({ mcpToolName: mapping.label, path: mapping.path })),
						hasOmittedTools: hasOmittedMappings,
					})
					.trim(),
			);
		}
	}

	const serverInstructions = Array.isArray(data.mcpServerInstructions) ? data.mcpServerInstructions : [];
	if (serverInstructions.length > 0) {
		parts.push(prompt.render(mcpServerInstructionsTemplate, { servers: serverInstructions }).trim());
	}

	pushText(data.appendSystemPrompt);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function registerHostIntegrationPrompts(host: PromptHostSurface): () => void {
	host.removeByOwner(HOST_INTEGRATIONS_PROMPT_OWNER);
	const disposers = [
		host.registerSection({
			name: "host:xd-tools",
			order: PROMPT_ORDERS.injection,
			interpolate: false,
			text: renderXdTools,
			owner: HOST_INTEGRATIONS_PROMPT_OWNER,
		}),
		host.registerTool({
			tool: "write",
			wireNames: ["write", "apply_patch"],
			name: "host:auto-qa",
			order: PROMPT_ORDERS.tool,
			text: context => (context.autoQaEnabled === true ? renderAutoQa(context) : undefined),
			owner: HOST_INTEGRATIONS_PROMPT_OWNER,
		}),
		host.registerSection({
			name: "host:runtime-context",
			order: HOST_RUNTIME_CONTEXT_ORDER,
			cacheScope: "snapshot",
			interpolate: false,
			text: renderRuntimeContext,
			owner: HOST_INTEGRATIONS_PROMPT_OWNER,
		}),
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
