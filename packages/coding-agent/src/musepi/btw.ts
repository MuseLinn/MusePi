// ============================================================
// MusePi /btw — side-channel ("by the way") conversation.
//
// A lightweight child session forked from the main session's context
// snapshot with all tools disabled and a side-channel system reminder
// (kimi-code btw domain, pi-native seams). The first /btw seeds the
// child with the parent's current messages; follow-up /btw turns reuse
// the same child, so the side channel keeps its own conversation.
// Nothing is persisted — the child is in-memory and dies with the
// process (or when the parent session is replaced).
// ============================================================

import type { AgentSession } from "../core/agent-session.ts";
import { createExtensionRuntime } from "../core/extensions/loader.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";

export const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Answer with text only, based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`.trim();

function createBtwResourceLoader(basePrompt: string): ResourceLoader {
	const systemPrompt = `${basePrompt}\n\n---\n${SIDE_QUESTION_SYSTEM_REMINDER}`;
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export interface BtwTurn {
	question: string;
	answer: string;
}

let btwSession: AgentSession | null = null;
let btwParentRef: AgentSession | null = null;

/** Drop the side channel (parent session replaced or process teardown). */
export function resetBtwSession(parent?: AgentSession): void {
	if (parent !== undefined && parent === btwParentRef) return;
	try {
		btwSession?.dispose();
	} catch {
		/* best effort */
	}
	btwSession = null;
	btwParentRef = null;
}

/**
 * Run one side-channel turn. Creates the child on first use (context
 * snapshot from the parent), then keeps reusing it for follow-ups.
 */
export async function runBtwTurn(parent: AgentSession, question: string): Promise<string> {
	if (btwParentRef !== parent) resetBtwSession();

	if (!btwSession) {
		if (!parent.model) throw new Error("No model selected — pick a model before using /btw.");
		const result = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model: parent.model,
			modelRuntime: parent.modelRuntime,
			// DenyAll: no built-in tools and no extension/custom tools (kimi btw
			// registers a deny-all permission policy; here we simply enable none).
			noTools: "all",
			customTools: [],
			resourceLoader: createBtwResourceLoader(""),
		});
		btwSession = result.session;
		// Context inheritance: seed the child with the parent's current view.
		// The child owns this array copy from here on — later parent turns do
		// not leak in (it is a snapshot, not a live view).
		btwSession.agent.state.messages = [...parent.agent.state.messages];
		btwParentRef = parent;
	}

	let answer = "";
	const unsubscribe = btwSession.subscribe((event) => {
		if (event.type !== "message_end") return;
		const message = (event as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role !== "assistant") return;
		const content = Array.isArray(message.content) ? message.content : [];
		const texts = content.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
		);
		if (texts.length > 0) answer = texts.map((block) => block.text).join("\n");
	});
	try {
		await btwSession.prompt(question);
	} finally {
		unsubscribe();
	}
	return answer;
}
