/**
 * The role a session's agent sits in, as the GUI needs it.
 *
 * The daemon owns the fact: every `session.list` row carries `agentRole`
 * (`{ id, name? }`), derived from the transcript's own identity — a main
 * workbench session is the `coder`, a task subagent keeps its definition name,
 * an advisor transcript is the `advisor`. `id` is the contract (it becomes the
 * `data-agent-role` hook); the readable name is localized here, so the two
 * never collapse into one string.
 *
 * The card and the agent tab read it through {@link useAgentRole} with a
 * synchronous fallback: the workbench's own `coder`, or `advisor` when the app
 * already opened a read-only advisor transcript. A failed or unknown read
 * keeps that fallback instead of blanking the identity, and a facet the
 * daemon may add later (a bot lane) still renders — an id without a localized
 * name falls back to its own name/id.
 */
import { t } from "@musepi/client-core";
import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";

export interface AgentRole {
	/** Stable role id (never a display string). */
	id: string;
	/** Subagent definition name (`session_init.agent`), when the row has one. */
	name?: string;
}

/** The workbench lane's agent; also the fallback for a session with no role. */
export const DEFAULT_AGENT_ROLE: AgentRole = { id: "coder" };

/** A read-only advisor transcript, known before any read lands. */
export const ADVISOR_AGENT_ROLE: AgentRole = { id: "advisor" };

/** Readable name for the lane a role runs in. Short by design — it rides
 *  beside the live state in the capsule as a tag. Known ids are localized; a
 *  subagent lane reads as its lane (its definition name is the agent's NAME,
 *  see {@link agentDisplayName}); anything else falls back to the name/id the
 *  daemon sent so a future lane still renders. */
export function agentRoleLabel(role: AgentRole): string {
	switch (role.id) {
		case "coder":
			return t("general.agentRoleCoder");
		case "advisor":
			return t("general.agentRoleAdvisor");
		case "subagent":
			return t("general.agentRoleSubagent");
		default:
			return role.name ?? role.id;
	}
}

/** The agent's own name in this conversation: the assistant for the workbench
 *  lane, the definition name for a subagent, the advisor's label for an
 *  advisor transcript, and whatever name a future lane sends. */
export function agentDisplayName(role: AgentRole): string {
	switch (role.id) {
		case "subagent":
			return role.name ?? t("general.agentRoleSubagent");
		case "advisor":
			return t("general.agentRoleAdvisor");
		default:
			return role.name ?? t("general.assistant");
	}
}

/** Validate one `agentRole` payload from a session row. */
function readAgentRole(value: unknown): AgentRole | null {
	if (!value || typeof value !== "object") return null;
	const { id, name } = value as { id?: unknown; name?: unknown };
	if (typeof id !== "string" || !id) return null;
	return typeof name === "string" && name ? { id, name } : { id };
}

/**
 * The session's role, read once per session from its `session.list` row.
 *
 * Scoping the list to one id keeps this to a single small row instead of the
 * whole workspace; the daemon's listing scan is cached, so opening sessions
 * back to back costs nothing extra.
 */
export function useAgentRole(
	rpc: RpcClient | null | undefined,
	sessionId: string | null | undefined,
	fallback: AgentRole = DEFAULT_AGENT_ROLE,
): AgentRole {
	const [role, setRole] = useState<AgentRole>(fallback);
	const fallbackId = fallback.id;
	const fallbackName = fallback.name;
	useEffect(() => {
		// Session switch (or a different fallback): show the synchronous answer
		// until the row lands, never the previous session's role.
		setRole({ id: fallbackId, ...(fallbackName ? { name: fallbackName } : {}) });
		if (!rpc || !sessionId) return;
		let cancelled = false;
		void rpc
			.request<Array<{ agentRole?: unknown }> | null>("session.list", { sessionId })
			.then(rows => {
				if (cancelled) return;
				const next = readAgentRole(rows?.[0]?.agentRole);
				if (next) setRole(next);
			})
			.catch(() => {
				// The fallback already stands; a failed read must not blank the
				// identity or turn the card into an error surface.
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, sessionId, fallbackId, fallbackName]);
	return role;
}
