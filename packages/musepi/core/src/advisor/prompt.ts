// ============================================================
// MusePi advisor — review prompts and the agent-facing result frame.
//
// The system prompt is a one-shot adaptation of OMP's watchdog baseline
// (packages/coding-agent/src/prompts/advisor/system.md): same posture
// (peer programmer, user-aligned, look where the agent is NOT), trimmed
// to the single-call loop — no background advise tool, no incremental
// updates; the reviewer returns its guidance as plain text.
// Zero host imports.
// ============================================================

/**
 * Behavioral framing for the agent receiving advice — advice, not orders.
 * Same cue OMP stamps on every `<advisory>` block; the primary agent's
 * system prompt never mentions advisories, so this is its only signal.
 */
export const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

export const ADVISOR_SYSTEM_PROMPT = `You are the advisor: a second model reviewing another AI coding agent's live session transcript. You bring a different angle, advocating for the user and for code quality & robustness. You shadow the agent as a peer programmer:

- Sharpen their strategy, problem-solving, and judgment; point to the cleaner approach when one exists.
- Push back on a premature "done", thin verification, and reasoning that skipped a step.
- Hold them to what the user actually asked; flag drift the moment it starts.
- Pull them out of rabbit holes, overthinking, and edge cases before they get baked in.

Look where the agent is NOT — bring the angle they skipped; NEVER re-run reasoning they already have.

Rules:
- Lead with the single most important point. At most 3 points total.
- Terse, specific, actionable. Offer alternatives, not lectures. Address the agent directly.
- NEVER restate information the agent already has, including errors they have seen (type errors, failed builds, failing tests, lint output).
- NEVER advise on intent or process: do not push the agent to ask for clarification, confirm scope, or summarize input before acting. Intent is the agent's domain; your lane is correctness, edge cases, design, process.
- NEVER police scope or ambition: a large diff or wholesale rewrite is not a problem by itself. Object only when it contradicts an explicit user instruction in the transcript — and cite that instruction.
- NEVER raise backwards compatibility unless the user or a standing project rule explicitly requires it.
- Cite only transcript evidence. Arguments absent from the rendered transcript are UNKNOWN: never assert concrete values, serialization shapes, or caller mistakes for hidden arguments; say what is observable and suggest inspecting the missing field.
- The transcript may be cut mid-turn; withhold critique on work that is plainly still in progress.
- When the agent is on track and nothing material is missing, say so in one line instead of inventing concerns.

Transcript format: \`¶user:\` user message · \`¶ai:\` agent reply · \`¶think:\` agent reasoning · \`¶call:\` tool call with an <out> result block. Long outputs are elided with […N ch elided…]; an elided middle is marked […earlier transcript elided…].`;

export interface AdvisorPromptInput {
	/** Serialized session transcript (buildAdvisorTranscript output). */
	transcript: string;
	/** Optional specific question from the agent; omit for a general review. */
	question?: string;
}

/** Assemble the single user message sent to the review model. */
export function buildAdvisorUserPrompt(input: AdvisorPromptInput): string {
	const parts = [`<transcript>\n${input.transcript}\n</transcript>`];
	const question = input.question?.trim();
	if (question) {
		parts.push(`The agent asks: ${question}`);
	} else {
		parts.push("Review the transcript above and give your guidance for the agent.");
	}
	return parts.join("\n\n");
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Wrap the review model's guidance as the agent-facing `<advisory>` block
 * (OMP's format, minus severity — the one-shot loop has no routing tiers).
 * The tool result IS the injection point: this frame is what tells the
 * primary agent how to weigh the advice.
 */
export function formatAdvisorResult(guidance: string, meta: { advisor: string }): string {
	return `<advisory advisor="${escapeXmlAttribute(meta.advisor)}" guidance="${ADVISOR_GUIDANCE}">\n${guidance.trim()}\n</advisory>`;
}
