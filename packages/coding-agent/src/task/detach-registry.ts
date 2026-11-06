/**
 * Detach handles for foreground subagent runs.
 *
 * A spawn that runs inline on the current turn registers a handle keyed by its
 * registry id; the daemon's `agents.detach` RPC (and the desktop card button)
 * calls {@link requestAgentDetach} to adopt that run into a background job
 * without restarting it. Registration is process-wide because the RPC handler
 * has no session object; the handle closure carries everything else.
 */

export interface AgentDetachResult {
	ok: boolean;
	jobId?: string;
	error?: string;
}

export type AgentDetachRequest = () => Promise<AgentDetachResult>;

const handles = new Map<string, AgentDetachRequest>();

/**
 * Register the detach handle for one running agent. Re-registering the same id
 * replaces the previous handle; the returned unregister is identity-checked so
 * an older run settling late cannot remove its successor's handle.
 */
export function setAgentDetachHandle(agentId: string, request: AgentDetachRequest): () => void {
	handles.set(agentId, request);
	return () => {
		if (handles.get(agentId) === request) handles.delete(agentId);
	};
}

/**
 * Ask the foreground run owning `agentId` to continue as a background job.
 * A handle is a one-shot intent: it is consumed before it runs, so a double
 * click cannot register two jobs for the same run. Never throws — an unknown
 * agent, a disabled job manager, or a failing adoption all come back as
 * `ok: false` with a reason.
 */
export async function requestAgentDetach(agentId: string): Promise<AgentDetachResult> {
	const handle = handles.get(agentId);
	if (!handle) return { ok: false, error: "agent is not running in the foreground" };
	handles.delete(agentId);
	try {
		return await handle();
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
