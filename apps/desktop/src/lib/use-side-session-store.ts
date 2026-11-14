import type { SubagentProgressPayload } from "@musepi/pi-wire";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "./rpc";
import { GuiSessionStore } from "./session-store";
import { registerSideSessionStore, unregisterSideSessionStore } from "./side-session-stores";

/** The subset of `session.resume` / `session.subscribe` the store consumes. */
interface SideSnapshot {
	entries?: unknown[];
	state?: unknown;
	cursor?: number;
	header?: { cwd?: string };
	tail?: { hasMore: boolean; beforeId: string | null };
	activeTools?: {
		toolCallId: string;
		toolName: string;
		args: unknown;
		intent?: string;
		partialResult?: unknown;
		startedAt: number;
	}[];
	agentsProgress?: SubagentProgressPayload[];
	roundDurations?: [number, number][];
	pendingApprovals?: Array<{ requestId: string; tool: string; prompt?: string }>;
}

async function loadSideSnapshot(rpc: RpcClient, sessionId: string): Promise<SideSnapshot | null> {
	try {
		const res = await rpc.request<{ initial?: SideSnapshot } | null>("session.resume", { sessionId });
		if (res?.initial) return res.initial;
	} catch {
		// History-only sessions reject resume; subscribe returns the same snapshot.
	}
	const res = await rpc.request<{ initial?: SideSnapshot } | null>("session.subscribe", { sessionId });
	return res?.initial ?? null;
}

export interface SideSessionStoreState {
	store: GuiSessionStore | null;
	loading: boolean;
	error: string | null;
	retry(): void;
}

/**
 * One live store for a session shown beside the active chat.
 *
 * The store is created from the daemon's snapshot, registered for the app's
 * event pump (see side-session-stores.ts), and disposed with the view. The
 * active session is never registered twice: the panel tab for it is rejected
 * upstream, and this hook reports it as a normal "already visible" state.
 */
export function useSideSessionStore(
	sessionId: string | null,
	rpc: RpcClient | null,
	activeSessionId: string | null,
): SideSessionStoreState {
	const [store, setStore] = useState<GuiSessionStore | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [version, setVersion] = useState(0);
	const retry = useCallback(() => setVersion(value => value + 1), []);

	useEffect(() => {
		if (!sessionId || !rpc || sessionId === activeSessionId) {
			setStore(null);
			setLoading(false);
			setError(null);
			return;
		}
		let disposed = false;
		let created: GuiSessionStore | null = null;
		setStore(null);
		setError(null);
		setLoading(true);
		void (async () => {
			try {
				const initial = await loadSideSnapshot(rpc, sessionId);
				if (disposed) return;
				if (!initial) throw new Error("empty session snapshot");
				created = new GuiSessionStore(
					sessionId,
					{
						entries: (initial.entries ?? []) as never,
						state: initial.state as never,
						cursor: initial.cursor ?? 0,
						roundDurations: initial.roundDurations,
						tail: initial.tail,
						activeTools: initial.activeTools,
						agentsProgress: initial.agentsProgress,
						pendingApprovals: initial.pendingApprovals,
					},
					typeof initial.header?.cwd === "string" ? initial.header.cwd : "",
					{
						onGapDetected: async (afterSeq: number) => {
							const result = await rpc.request<{ resyncRequired?: boolean } | null>("session.catchup", {
								sessionId,
								afterSeq,
							});
							return { resyncRequired: result?.resyncRequired === true };
						},
						onResyncRequired: () => setVersion(value => value + 1),
					},
				);
				registerSideSessionStore(created);
				setStore(created);
				setLoading(false);
			} catch (err) {
				if (disposed) return;
				setLoading(false);
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			disposed = true;
			if (created) {
				unregisterSideSessionStore(sessionId);
				created.dispose();
			}
		};
	}, [sessionId, rpc, activeSessionId, version]);

	return { store, loading, error, retry };
}
