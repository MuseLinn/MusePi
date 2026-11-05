/**
 * Agent identity published to the desktop managed-browser bridge.
 *
 * The shell normalizes `agentId`/`agentName` out of the CDP request params and
 * badges the panel tab with the operator ("操作者：X"). An unidentified caller
 * must send NEITHER field: the shell treats an empty id as "user tab" and the
 * pre-existing payload shape has to stay byte-identical for those callers.
 *
 * Only the creating agent is published. Parent/hand-off ownership is a
 * supervisor concern (`releaseTabsForOwner`); the bridge has no field for it.
 */
export interface BrowserAgentIdentity {
	agentId?: string;
	agentName?: string;
}

/** CDP params for `identity`, or `{}` when the caller has no agent id. */
export function agentCdpParams(identity?: BrowserAgentIdentity): Record<string, string> {
	const agentId = identity?.agentId?.trim();
	if (!agentId) return {};
	// The registry id is the fallback display name, mirroring `#agentIdentity()`.
	const agentName = identity?.agentName?.trim();
	return { agentId, agentName: agentName || agentId };
}

/**
 * True when `error` is the endpoint rejecting `method` as unimplemented.
 * Chrome and the managed bridge both answer an unknown method with
 * `'<method>' wasn't found`, so this is how version skew is detected.
 */
export function isUnknownCdpMethodError(error: unknown, method: string): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes(method) && /wasn't found|isn't found|not found/i.test(message);
}
