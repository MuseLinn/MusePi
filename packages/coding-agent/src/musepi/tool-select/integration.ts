// ============================================================
// MusePi Tool-Select Integration
// Extension factory that registers:
//  - shapeTools filter (via shared mutable handler) — removes
//    deferred tools from `context.tools[]` before LLM request
//  - select_tools tool — model calls this to load deferred tools
//  - Gate (tool_call interceptor) — catches calls to unloaded tools
//  - Context announcement — tells model about available deferred tools
// ============================================================

import type { AgentToolResult } from "@musepi/pi-agent-core";
import type { Context, UserMessage } from "@musepi/pi-ai";
import {
	planLoad,
	renderLoadableToolsAnnouncement,
	renderLoadResult,
	SELECT_TOOLS_TOOL_NAME,
} from "@musepi/pi-tool-select";
import type {
	AgentToolUpdateCallback,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../extensibility/extensions/types";
import { MUSEPI_BRANDING } from "../branding";
import { setShapeToolsHandler } from "./shapeToolsFilter";

/** Tools that must always remain visible and active (never deferred). */
const ALWAYS_VISIBLE = new Set([
	SELECT_TOOLS_TOOL_NAME,
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
	"goal",
	"todo",
	"task",
	"swarm",
]);

/**
 * Create the tool-select extension factory.
 *
 * Accepts an options bag:
 * - `enabled`: master switch. When false, the extension is a noop.
 * - `defer`: force-defer these extra tools (overrides auto-discovery).
 * - `never`: tools to never defer even if auto-detected.
 */
export function createToolSelectExtension(options?: {
	/** Enable progressive tool disclosure. When false, the extension is a noop. */
	enabled?: boolean;
	/** Force-defer these extra tools (overrides auto-discovery). */
	defer?: string[];
	/** Tools to never defer even if auto-detected. */
	never?: string[];
}): ExtensionFactory {
	return (api: ExtensionAPI) => {
		if (!options?.enabled) {
			api.logger.debug("tool-select disabled by config");
			return;
		}

		/** Names of tools currently hidden from the LLM but loadable on request. */
		let deferrableNames: string[] = [];
		/** Names of tools the LLM has requested via select_tools. */
		const loadedSet = new Set<string>();

		// ── Helper: discover deferrable tools from the context.tools[] ──
		function ensureDeferrableDiscovered(tools: Array<{ name: string }>): void {
			if (deferrableNames.length > 0) return;

			const forceDeferSet = new Set(options?.defer ?? []);
			const neverSet = new Set([...ALWAYS_VISIBLE, ...(options?.never ?? [])]);

			deferrableNames = tools.filter(t => forceDeferSet.has(t.name) || !neverSet.has(t.name)).map(t => t.name);

			api.logger.info(
				`${MUSEPI_BRANDING.productName} tool-select: ${deferrableNames.length} deferrable tool(s) discovered`,
			);
		}

		// ── shapeTools filter logic ───────────────────────────
		function applyShapeTools(context: Context, _model: unknown): Context {
			if (!context.tools || context.tools.length === 0) return context;

			ensureDeferrableDiscovered(context.tools);

			if (deferrableNames.length === 0) return context;

			const hidden = deferrableNames.filter(n => !loadedSet.has(n));
			if (hidden.length === 0) return context;

			const hiddenSet = new Set(hidden);
			return {
				...context,
				tools: context.tools.filter(t => !hiddenSet.has(t.name)),
			};
		}

		// ── Register/unregister shapeTools on session lifecycle ──
		api.on("session_start", async (_event, _ctx: ExtensionContext) => {
			setShapeToolsHandler(applyShapeTools);
			api.logger.info(`${MUSEPI_BRANDING.productName} tool-select ready`);
		});

		api.on("session_shutdown", async () => {
			setShapeToolsHandler(undefined);
			api.logger.info(`${MUSEPI_BRANDING.productName} tool-select cleaned up`);
		});

		// ── Register the select_tools tool ────────────────────

		const SELECT_TOOLS_TOOL: Parameters<typeof api.registerTool>[0] = {
			name: SELECT_TOOLS_TOOL_NAME,
			label: "Select Tools",
			description:
				"Load tool schemas for previously announced deferrable tools. Call this before using a tool listed in <tools_available>.",
			parameters: {
				type: "object",
				properties: {
					names: {
						type: "array",
						items: { type: "string" },
						description: "Tool names to load (from the <tools_available> announcement)",
					},
				},
				required: ["names"],
			},
			execute: async (
				_toolCallId: string,
				params: { names: string[] },
				_signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback | undefined,
				_ctx: ExtensionContext,
			): Promise<AgentToolResult> => {
				const requestedNames = params.names ?? [];
				if (requestedNames.length === 0) {
					return { content: [{ type: "text", text: "No tools requested." }] };
				}

				const plan = planLoad(requestedNames, {
					deferrable: new Set(deferrableNames),
					active: new Set(loadedSet),
				});

				if (plan.toLoad.length > 0) {
					for (const name of plan.toLoad) {
						loadedSet.add(name);
					}
					api.logger.info(`${MUSEPI_BRANDING.productName} tool-select: loaded ${plan.toLoad.join(", ")}`);
				}

				return { content: [{ type: "text", text: renderLoadResult(plan) }] };
			},
		};

		api.registerTool(SELECT_TOOLS_TOOL);

		// ── Context announcement injection ────────────────────
		api.on("context", (event: ContextEvent, _ctx: ExtensionContext) => {
			if (deferrableNames.length === 0) return;

			const unloaded = deferrableNames.filter(n => !loadedSet.has(n));
			if (unloaded.length === 0) return;

			const announcement = renderLoadableToolsAnnouncement(unloaded);
			if (!announcement) return;

			event.messages.push({
				role: "user",
				content: `\n\n---\n${announcement}`,
				timestamp: Date.now(),
			} as UserMessage);
		});

		// ── Gate: catch calls to unloaded tools ───────────────
		api.on("tool_call", async (event: ToolCallEvent, _ctx: ExtensionContext) => {
			if (event.toolName === SELECT_TOOLS_TOOL_NAME) return;
			if (!deferrableNames.includes(event.toolName)) return;
			if (loadedSet.has(event.toolName)) return;

			return {
				block: true,
				reason: `Tool "${event.toolName}" is not loaded yet. Use \`${SELECT_TOOLS_TOOL_NAME}\` to request its schema first.`,
			} satisfies ToolCallEventResult;
		});
	};
}
