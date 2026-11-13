import type { AgentSnapshot, SubagentProgressPayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { type AgentSignals, activityVerbForTool } from "../lib/agent-signals";
import type { OrbState } from "../vendor/thinking-orbs";
import { AgentAvatar } from "./AgentAvatar";

/** Project a subagent's snapshot/progress onto the shared presence contract. */
export function subagentSignals(
	agent: AgentSnapshot,
	payload?: SubagentProgressPayload,
	now = Date.now(),
): AgentSignals {
	const progress = payload?.progress;
	if (progress?.awaitingApproval) {
		return {
			phase: "awaiting-user",
			approvals: 1,
			toolName: progress.currentTool ?? null,
			working: agent.status === "running",
		};
	}
	if (agent.status === "running") {
		const tool = progress?.currentTool ?? null;
		const startedAt = (progress as { currentToolStartMs?: unknown } | undefined)?.currentToolStartMs;
		return {
			phase: tool ? "tool" : "thinking",
			activity: tool ? activityVerbForTool(tool) : "thinking",
			toolName: tool,
			startedAt: typeof startedAt === "number" ? startedAt : agent.lastActivity,
			now,
			working: true,
		};
	}
	if (agent.status === "aborted" || progress?.status === "failed") {
		return { phase: "error", toolFailed: true };
	}
	if (progress?.status === "completed") {
		return { justFinished: true, outcome: { kind: "success", at: agent.lastActivity } };
	}
	if (agent.status === "parked") return { phase: "paused" };
	return { phase: "idle" };
}

/** The classic presets still read OrbState; Aora reads the full signals. */
export function orbStateForSubagent(signals: AgentSignals): OrbState {
	if ((signals.approvals ?? 0) > 0 || signals.toolFailed || signals.phase === "error") return "waiting";
	if (signals.phase === "streaming") return "composing";
	if (signals.phase === "tool" || signals.working) {
		switch (signals.activity) {
			case "searching":
			case "browsing":
			case "reading":
				return "searching";
			case "writing":
			case "coding":
			case "generating":
				return "composing";
			default:
				return "working";
		}
	}
	if (signals.phase === "thinking") return "solving";
	return "listening";
}

export function SubagentAvatar({
	agent,
	payload,
	size = 20,
	now,
}: {
	agent: AgentSnapshot;
	payload?: SubagentProgressPayload;
	size?: 20 | 32 | 64;
	now?: number;
}): ReactNode {
	const signals = subagentSignals(agent, payload, now);
	return <AgentAvatar state={orbStateForSubagent(signals)} signals={signals} seed={agent.id} size={size} />;
}
