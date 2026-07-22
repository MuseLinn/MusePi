// ============================================================
// MusePi native advisor — host seam.
//
// OMP's advisor closed loop (pick review model → serialize context →
// get guidance → inject) mapped onto an explicit `advisor` tool the
// primary agent calls: the core loop is ported, the background
// watchdog machinery (passive per-turn review, steer/aside routing,
// WATCHDOG.yml roster, status line) is deliberately not.
//
// The pure pieces live in @musepi/core/advisor (transcript window,
// prompts, gate, model-spec chain — zero pi imports). This module owns:
//   1. the `advisor` tool (zero args, or a specific `question`);
//   2. review-model resolution: musepi.advisor.model →
//      modelRoles.advisor → modelRoles.default → session model;
//   3. the one-shot review call through the session's stream function
//      (same auth path as compaction);
//   4. the enable gate: musepi.advisor.enabled = false strips the tool
//      from the active set (memory pattern) — zero surface when off.
//
// Injection: the tool result IS the injection — guidance returns as an
// <advisory> block stamped "weigh, don't blindly obey" (OMP's frame).
// ============================================================

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	ADVISOR_SYSTEM_PROMPT,
	buildAdvisorTranscript,
	buildAdvisorUserPrompt,
	formatAdvisorResult,
	isAdvisorEnabled,
	parseRoleModelSpec,
	resolveAdvisorModelSpec,
	type SnapMessage,
} from "@musepi/core";
import { Type } from "typebox";
import type { AgentSession } from "../core/agent-session.ts";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { findModelForSpec } from "./model-roles.ts";

const ADVISOR_TOOL_NAME = "advisor";
/** Cap on the review model's answer; guidance is meant to be terse. */
const ADVISOR_MAX_OUTPUT_TOKENS = 4_096;

export interface ResolvedAdvisorModel {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	/** Human label for the result frame (provider/id). */
	label: string;
}

export interface AdvisorCompletionRequest extends ResolvedAdvisorModel {
	systemPrompt: string;
	userPrompt: string;
	signal?: AbortSignal;
}

/** Host-side runtime state for one bound session (module singleton, memory pattern). */
export interface AdvisorBinding {
	enabled: boolean;
	maxContextChars: number;
	getMessages: () => AgentMessage[];
	resolveModel: () => Promise<ResolvedAdvisorModel>;
	complete: (req: AdvisorCompletionRequest) => Promise<string>;
}

let binding: AdvisorBinding | null = null;

/** Test hook: install a binding directly. */
export function initMusepiAdvisorForTest(testBinding: AdvisorBinding | null): void {
	binding = testBinding;
}

function requireBinding(): AdvisorBinding {
	if (!binding || !binding.enabled) {
		throw new Error(
			"advisor is not enabled for this session. Set musepi.advisor.enabled: true in settings to turn on the native advisor.",
		);
	}
	return binding;
}

// =============================================================================
// Message mapping (pi AgentMessage → SnapMessage, snapcompact-native pattern)
// =============================================================================

function toAdvisorMessage(message: AgentMessage): SnapMessage | undefined {
	if (message.role === "user") {
		return {
			role: "user",
			content:
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => ({ type: "text" as const, text: block.text })),
		};
	}
	if (message.role === "assistant") {
		const blocks: SnapMessage["content"] = [];
		for (const block of message.content) {
			if (block.type === "text") blocks.push({ type: "text", text: block.text });
			else if (block.type === "thinking") blocks.push({ type: "thinking", thinking: block.thinking });
			else if (block.type === "toolCall") {
				blocks.push({
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: (block.arguments ?? {}) as Record<string, unknown>,
				});
			}
		}
		return { role: "assistant", content: blocks };
	}
	if (message.role === "toolResult") {
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		return {
			role: "toolResult",
			content: text,
			toolCallId: message.toolCallId,
			isError: message.isError,
		};
	}
	return undefined;
}

// =============================================================================
// Review-model resolution and the one-shot call
// =============================================================================

async function resolveAdvisorModel(
	session: AgentSession,
	settingsManager: SettingsManager,
): Promise<ResolvedAdvisorModel> {
	const musepi = settingsManager.getMusepi();
	const spec = resolveAdvisorModelSpec(musepi.advisor, musepi.modelRoles);
	if (spec) {
		const parsed = parseRoleModelSpec(spec);
		if (!parsed.ok) {
			throw new Error(`advisor: invalid model spec "${spec}" — ${parsed.error}`);
		}
		const available = await session.modelRuntime.getAvailable();
		const model = findModelForSpec(parsed.spec, [...available] as Model<any>[], spec);
		if (!model) {
			throw new Error(
				`advisor: configured model "${spec}" is not in the model registry. ` +
					`Fix musepi.advisor.model / musepi.modelRoles.advisor, or clear it to use the session model.`,
			);
		}
		return {
			model,
			thinkingLevel: parsed.spec.thinkingLevel as ThinkingLevel | undefined,
			label: `${model.provider}/${model.id}`,
		};
	}
	const current = session.model;
	if (!current) {
		throw new Error(
			"advisor: no review model available — set musepi.advisor.model or musepi.modelRoles.advisor " +
				"(no session model to fall back to).",
		);
	}
	return { model: current, label: `${current.provider}/${current.id}` };
}

/**
 * One-shot review completion. Uses the session's stream function when set
 * (same seam compaction uses, so custom auth gateways keep working) and
 * falls back to completeSimple. Auth is best-effort: whatever the runtime
 * resolves rides along; providers that need a key fail with their own
 * clear error.
 */
async function completeAdvisorRequest(session: AgentSession, req: AdvisorCompletionRequest): Promise<string> {
	let auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } = {};
	try {
		const result = await session.modelRuntime.getAuth(req.model);
		if (result) {
			auth = {
				apiKey: result.auth.apiKey,
				headers: result.auth.headers
					? Object.fromEntries(
							Object.entries(result.auth.headers).filter(
								(entry): entry is [string, string] => entry[1] !== null,
							),
						)
					: undefined,
				env: result.env,
			};
		}
	} catch {
		// OAuth / custom stream path may still authenticate downstream.
	}

	const options: SimpleStreamOptions = {
		maxTokens: ADVISOR_MAX_OUTPUT_TOKENS,
		signal: req.signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	if (req.model.reasoning && req.thinkingLevel && req.thinkingLevel !== "off") {
		options.reasoning = req.thinkingLevel;
	}

	const context: Context = {
		systemPrompt: req.systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: req.userPrompt }], timestamp: Date.now() }],
	};

	const streamFn = session.agent.streamFunction;
	const response = streamFn
		? await (await streamFn(req.model, context, options)).result()
		: await completeSimple(req.model, context, options);

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`advisor: review call failed — ${response.errorMessage || response.stopReason}`);
	}
	const text = contentText(response.content).trim();
	if (!text) {
		throw new Error("advisor: the review model returned an empty response.");
	}
	return text;
}

// =============================================================================
// Tool
// =============================================================================

const ADVISOR_DESCRIPTION = `Ask a second model (the advisor) to review this session and return guidance.

The advisor sees a serialized transcript of the session so far (your reasoning, tool calls, and results) and answers as a peer programmer: sharper strategy, missed edge cases, drift from the user's ask, thin verification, rabbit holes.

Use it:
- before declaring a task done (a fresh pair of eyes on the verification story);
- when stuck, churning, or unsure between approaches;
- when you want a specific design or correctness question answered with full session context.

Pass a specific question, or omit it for a general review. The guidance comes back as an <advisory> block — weigh it, don't blindly obey it. Calls are not free: one review per genuine need, not per step.`;

export const musepiAdvisorToolDef: ToolDefinition = {
	name: ADVISOR_TOOL_NAME,
	label: "Advisor",
	description: ADVISOR_DESCRIPTION,
	parameters: Type.Object({
		question: Type.Optional(
			Type.String({
				description: "Specific question for the reviewer. Omit for a general review of the session so far.",
			}),
		),
	}),
	async execute(_toolCallId, params, signal) {
		const b = requireBinding();
		const question = (params as { question?: string }).question;
		const messages = b
			.getMessages()
			.map(toAdvisorMessage)
			.filter((msg): msg is SnapMessage => msg !== undefined);
		if (messages.length === 0) {
			throw new Error("advisor: nothing to review yet — the session has no messages.");
		}
		const transcript = buildAdvisorTranscript(messages, { maxChars: b.maxContextChars });
		const resolved = await b.resolveModel();
		const guidance = await b.complete({
			...resolved,
			systemPrompt: ADVISOR_SYSTEM_PROMPT,
			userPrompt: buildAdvisorUserPrompt({ transcript, question }),
			signal,
		});
		return {
			content: [{ type: "text", text: formatAdvisorResult(guidance, { advisor: resolved.label }) }],
			details: { model: resolved.label, question, transcriptChars: transcript.length },
		};
	},
};

/**
 * Bind the advisor for one session. Disabled = the advisor tool is
 * removed from the active set (zero surface). Mode-independent: call
 * once per session right after AgentSession construction
 * (initMusepiMemory pattern).
 */
export function initMusepiAdvisor(session: AgentSession, settingsManager: SettingsManager): void {
	const config = settingsManager.getMusepi().advisor;
	if (!isAdvisorEnabled(config)) {
		binding = null;
		const active = session.getActiveToolNames();
		if (active.includes(ADVISOR_TOOL_NAME)) {
			session.setActiveToolsByName(active.filter((name) => name !== ADVISOR_TOOL_NAME));
		}
		return;
	}
	binding = {
		enabled: true,
		maxContextChars: config.maxContextChars,
		getMessages: () => session.messages,
		resolveModel: () => resolveAdvisorModel(session, settingsManager),
		complete: (req) => completeAdvisorRequest(session, req),
	};
}
