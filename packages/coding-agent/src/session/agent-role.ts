/**
 * Which seat a session's agent runs in.
 *
 * The role is data, not a label: `id` is the stable contract the daemon
 * publishes (`session.list` rows) and clients read back, while the readable
 * name is localized by the client. A main workbench session is the `coder`;
 * a task subagent keeps its own definition name (`session_init.agent`) so it
 * is never read as the session's coder; an advisor transcript is the
 * `advisor`. Sessions recorded before roles existed, and rows with no
 * identity facts at all, fall back to `coder` — the lane the workbench runs.
 *
 * A later lane (a bot, for instance) adds an id here. Consumers already fall
 * back to the id when they have no localized name for it, so an unknown id
 * still renders instead of disappearing.
 */

export type AgentRoleId = "coder" | "subagent" | "advisor";

export interface AgentRole {
	/** Stable role id — a contract and a DOM attribute, never a display string. */
	id: AgentRoleId;
	/** Agent definition name of a subagent transcript (`session_init.agent`). */
	name?: string;
}

/** The workbench lane's agent; also the fallback for a session with no role. */
export const DEFAULT_AGENT_ROLE: AgentRole = { id: "coder" };

/** The identity facts a listing row actually carries about its transcript. */
export interface AgentRoleFacts {
	/** Task subagent transcript (hierarchical child session). */
	subagent?: boolean;
	/** Advisor transcript (`__advisor[.<slug>].jsonl`) — checked first: an
	 *  advisor row is also a child transcript but is not a task subagent. */
	advisor?: boolean;
	/** Agent definition name recorded in `session_init`. */
	agentName?: string;
}

export function agentRoleOf(facts?: AgentRoleFacts | null): AgentRole {
	if (facts?.advisor === true) return { id: "advisor" };
	if (facts?.subagent === true) {
		return facts.agentName ? { id: "subagent", name: facts.agentName } : { id: "subagent" };
	}
	// A fresh object: callers own the result and must not mutate the default.
	return { id: "coder" };
}
