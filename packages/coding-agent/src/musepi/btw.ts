// ============================================================
// MusePi /btw — side-channel ("by the way") conversation.
//
// A lightweight side channel forked from the main session's model.
// Uses streamSimple/completeSimple directly instead of spawning
// a full AgentSession. The side channel keeps its own message
// buffer in memory for follow-up turns.
// ============================================================

import type { AssistantMessage, Context, Message } from "@musepi/pi-ai";
import { completeSimple, streamSimple } from "@musepi/pi-ai/compat";
import type { AgentSession } from "../core/agent-session.ts";

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

const BTW_USER_TEMPLATE = (question: string): string =>
	`The user asks: ${question}\n\nPlease answer concisely and directly based on what you know.`;

export interface BtwTurn {
	question: string;
	answer: string;
}

/** In-memory side-channel user + assistant messages. */
const sideMessages: Message[] = [];
let sideParentRef: AgentSession | null = null;

/** Reset the side channel. */
export function resetBtwSession(parent?: AgentSession): void {
	if (parent && sideParentRef !== parent) return;
	sideMessages.length = 0;
	sideParentRef = null;
}

/**
 * Run one side-channel turn. Creates the context on first use, then
 * appends follow-ups for subsequent turns.
 * Pass an AbortSignal to cancel.
 * onDelta receives streaming text tokens as they arrive.
 */
export async function runBtwTurn(
	parent: AgentSession,
	question: string,
	signal?: AbortSignal,
	onDelta?: (delta: string) => void,
): Promise<string> {
	const model = parent.model;
	if (!model) {
		throw new Error("No model available for /btw");
	}

	// Reset side channel if parent changed
	if (sideParentRef && sideParentRef !== parent) {
		resetBtwSession();
	}
	sideParentRef = parent;

	// Append user question
	sideMessages.push({ role: "user", content: BTW_USER_TEMPLATE(question) } as unknown as Message);

	// Build context from accumulated messages + system reminder
	const context: Context = {
		systemPrompt: SIDE_QUESTION_SYSTEM_REMINDER,
		messages: sideMessages,
	};

	let answer: string;
	if (onDelta) {
		const stream = streamSimple(model, context, { signal, maxTokens: 2048 });
		const assistantMsg = await stream.result();
		answer = extractTextContent(assistantMsg);
		onDelta(answer);
	} else {
		const assistantMsg = await completeSimple(model, context, { signal, maxTokens: 2048 });
		answer = extractTextContent(assistantMsg);
	}

	// Store assistant response for follow-up context
	sideMessages.push({ role: "assistant", content: answer } as unknown as Message);

	return answer;
}

function extractTextContent(msg: AssistantMessage): string {
	const parts = msg.content.filter((p: { type: string }): p is { type: "text"; text: string } => p.type === "text");
	return parts.map((p) => p.text).join("");
}
