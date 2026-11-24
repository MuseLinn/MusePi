/**
 * The agent identity as both the chat capsule and the Agent tab read it.
 *
 * Status, orb state and role/name projection used to be duplicated between
 * `ChatView` and `AgentInfoPane`, which is how the two surfaces drifted. They
 * now call this hook: the daemon's role row is the identity, the snapshot's
 * approvals/working flags are the live state, and the avatar's animation is
 * derived once from the same facts.
 */
import { t } from "@musepi/client-core";
import type { OrbState } from "../vendor/thinking-orbs";
import { thinkingOrbStateFromSession } from "./companion";
import type { RpcClient } from "./rpc";
import type { GuiSessionState } from "./session-store";
import {
	type AgentRole,
	agentDisplayName,
	agentRoleLabel,
	DEFAULT_AGENT_ROLE,
	useAgentRole,
} from "./surfaces/agent-role";

/** CSS `view-transition-name` shared by the capsule avatar (old snapshot) and
 *  the Agent tab's avatar (new snapshot) for the one-take morph. */
export const AGENT_AVATAR_TRANSITION = "agent-identity-avatar";

export type AgentRunStatusKey = "waiting" | "working" | "idle";

export interface AgentRunStatus {
	key: AgentRunStatusKey;
	label: string;
}

/** The capsule/head's one live-state line. Approvals lead: the agent is
 *  parked on a decision, which is the one state the human can act on. */
export function agentRunStatus(
	snap: Pick<GuiSessionState, "approvals" | "working"> | null | undefined,
): AgentRunStatus {
	if ((snap?.approvals.length ?? 0) > 0) {
		return { key: "waiting", label: t("general.agentCapsuleWaiting") };
	}
	if (snap?.working === true) return { key: "working", label: t("general.agentCapsuleWorking") };
	return { key: "idle", label: t("general.agentCapsuleIdle") };
}

export interface AgentIdentity {
	role: AgentRole;
	displayName: string;
	roleLabel: string;
	status: AgentRunStatus;
	orb: OrbState;
}

export function useAgentIdentity(
	rpc: RpcClient | null | undefined,
	sessionId: string | null | undefined,
	snap: Pick<GuiSessionState, "approvals" | "working" | "streaming"> | null | undefined,
	fallback: AgentRole = DEFAULT_AGENT_ROLE,
): AgentIdentity {
	const role = useAgentRole(rpc, sessionId, fallback);
	return {
		role,
		displayName: agentDisplayName(role),
		roleLabel: agentRoleLabel(role),
		status: agentRunStatus(snap),
		orb: thinkingOrbStateFromSession(snap),
	};
}
