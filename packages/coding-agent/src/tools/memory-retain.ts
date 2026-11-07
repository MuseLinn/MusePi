import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { isGlobalMemoryScopeAvailable } from "../memory-backend/global-scope";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"scope?": type("'project' | 'global'").describe(
			"storage scope; defaults to project, global is for durable cross-project knowledge",
		),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;
export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		return new MemoryRetainTool(session);
	}

	async execute(toolCallId: string, params: MemoryRetainParams): Promise<AgentToolResult> {
		const backend = this.session.settings.get("memory.backend");
		if (params.items.some(item => item.scope === "global") && !isGlobalMemoryScopeAvailable(this.session)) {
			throw new Error(`Global memory scope is not available with the ${backend} memory backend.`);
		}
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}

			for (const item of params.items) {
				state.rememberScoped(
					item.content,
					{
						source: "coding-agent-retain",
						importance: 0.75,
						metadata: {
							session_id: state.sessionId,
							cwd: state.session.sessionManager.getCwd(),
							context: item.context ?? null,
							tool: "retain",
						},
						scope: "bank",
						extract: true,
						extractEntities: true,
						veracity: "tool",
						memoryType: "fact",
					},
					item.scope === "global" ? state.getGlobalRetainTarget() : undefined,
				);
			}

			const count = params.items.length;
			const noun = count === 1 ? "memory" : "memories";
			return {
				content: [{ type: "text", text: `${count} ${noun} stored.` }],
				details: { count },
			};
		}

		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}

		// Persist every item to the durable outbox before acknowledging. Delivery
		// happens on a later drain and retries from disk after a failure.
		await state.enqueueRetain(
			toolCallId,
			params.items.map(item => ({ content: item.content, context: item.context, scope: item.scope })),
		);

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
