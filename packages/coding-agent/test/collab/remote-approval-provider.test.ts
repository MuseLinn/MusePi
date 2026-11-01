import { describe, expect, it } from "bun:test";
import { createApprovalBridge } from "../../src/daemon/approval-bridge";
import { createRemoteApprovalProvider, type RemoteApprovalSession } from "../../src/remote-access/approval-provider";

const noop = (): void => {};

function session(sessionId: string): RemoteApprovalSession {
	return { sessionId, approvals: createApprovalBridge(noop, noop) };
}

describe("remote approval provider", () => {
	it("rebinds to the focused session and never resolves an old session request", async () => {
		const first = session("first");
		const second = session("second");
		let focus = first;
		const provider = createRemoteApprovalProvider(() => focus);
		let changes = 0;
		provider.subscribe(() => changes++);

		const firstPending = first.approvals.uiContext.select("Allow tool: bash", ["Approve", "Deny"]);
		const firstId = [...first.approvals.pending.keys()][0]!;
		expect(provider.list().map(request => request.requestId)).toEqual([firstId]);
		expect(changes).toBe(2);

		focus = second;
		provider.refresh();
		expect(provider.list()).toEqual([]);
		expect(provider.resolve(firstId, true)).toBe(false);

		const secondPending = second.approvals.uiContext.select("Allow tool: edit", ["Approve", "Deny"]);
		const secondId = [...second.approvals.pending.keys()][0]!;
		expect(provider.list().map(request => request.requestId)).toEqual([secondId]);
		expect(provider.resolve(secondId, false)).toBe(true);
		expect(await secondPending).toBe("Deny");
		expect(provider.list()).toEqual([]);

		// The first session remains untouched and no longer drives notifications.
		first.approvals.resolve(firstId, true);
		expect(await firstPending).toBe("Approve");
		expect(changes).toBe(5);
	});
});
