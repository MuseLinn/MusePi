import { useCallback, useEffect, useState } from "react";

/** How long a tab stays marked as agent-controlled after its last operation.
 *  Between tool calls the agent is still holding the page — the pill must not
 *  blink out and restart its timer on every step. */
const AGENT_TAB_IDLE_MS = 90_000;

/** Tab-level takeover state derived from the operation ledger. */
export interface AgentTabControl {
	tabId: string;
	/** When the agent first took this tab, so the elapsed label is continuous. */
	since: number;
	/** Latest operation observed on the tab; may already be settled. */
	activity: ManagedBrowserActivity;
	/** Last time any operation touched the tab (idle-expiry anchor). */
	lastAt: number;
}

/** Fold one ledger push into the current control state. Unknown tabs are
 *  ignored. A settled activity refreshes an existing hold so the pill can say
 *  "agent holds this tab", but it can never start one — otherwise a takeover
 *  (which settles the op) would immediately re-claim the tab. */
export function nextAgentTabControl(
	previous: AgentTabControl | null,
	activity: ManagedBrowserActivity | null,
	knownTabIds: readonly string[],
	now: number,
): AgentTabControl | null {
	if (!activity || !knownTabIds.includes(activity.tabId)) return previous;
	const dispatched = activity.status === "dispatched";
	if (!previous) {
		return dispatched ? { tabId: activity.tabId, since: activity.at || now, activity, lastAt: now } : null;
	}
	if (previous.tabId !== activity.tabId) {
		return dispatched ? { tabId: activity.tabId, since: activity.at || now, activity, lastAt: now } : previous;
	}
	return { ...previous, activity, lastAt: now };
}

/**
 * Follow the browser activity ledger for one chat session.
 *
 * The control survives gaps between tool calls and ends when the user takes
 * over, the tab closes, or nothing touched it for {@link AGENT_TAB_IDLE_MS}.
 */
export function useAgentTabControl(
	activity: ManagedBrowserActivity | null,
	knownTabIds: readonly string[],
	idleMs: number = AGENT_TAB_IDLE_MS,
): { control: AgentTabControl | null; release(): void } {
	const [control, setControl] = useState<AgentTabControl | null>(null);
	const tabKey = knownTabIds.join("\u0000");

	useEffect(() => {
		const ids = tabKey.length === 0 ? [] : tabKey.split("\u0000");
		setControl(previous => nextAgentTabControl(previous, activity, ids, Date.now()));
	}, [activity, tabKey]);

	// A closed tab cannot stay claimed; the renderer's tab list is authoritative.
	useEffect(() => {
		const ids = tabKey.length === 0 ? [] : tabKey.split("\u0000");
		setControl(previous => (previous && !ids.includes(previous.tabId) ? null : previous));
	}, [tabKey]);

	useEffect(() => {
		if (!control) return;
		const timer = window.setTimeout(() => setControl(null), idleMs);
		return () => window.clearTimeout(timer);
	}, [control?.lastAt, control?.tabId, idleMs]);

	const release = useCallback((): void => setControl(null), []);
	return { control, release };
}
