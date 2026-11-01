import type { ToolApprovalRequest } from "@musepi/pi-wire";
import type { CollabApprovalProvider } from "../collab/host";
import type { ApprovalBridge } from "../daemon/approval-bridge";

export interface RemoteApprovalSession {
	sessionId: string;
	approvals: ApprovalBridge;
}

export interface RemoteApprovalProvider extends CollabApprovalProvider {
	/** Rebind change notifications after the workspace focus changes. */
	refresh(): void;
}

/** Adapt the focused daemon session's approval bridge to the remote-access host. */
export function createRemoteApprovalProvider(getFocus: () => RemoteApprovalSession | null): RemoteApprovalProvider {
	const listeners = new Set<() => void>();
	let focus: RemoteApprovalSession | null = null;
	let unsubscribe: (() => void) | undefined;
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	const refresh = (): void => {
		const next = getFocus();
		if (next === focus) return;
		unsubscribe?.();
		focus = next;
		unsubscribe = focus?.approvals.subscribe(notify);
		notify();
	};
	return {
		list(): ToolApprovalRequest[] {
			return [...(getFocus()?.approvals.pending.values() ?? [])].map(record => ({
				requestId: record.requestId,
				tool: record.tool,
				args: null,
				prompt: record.prompt,
			}));
		},
		resolve(requestId, approved) {
			return getFocus()?.approvals.resolve(requestId, approved) ?? false;
		},
		subscribe(listener) {
			listeners.add(listener);
			refresh();
			return () => listeners.delete(listener);
		},
		refresh,
	};
}
