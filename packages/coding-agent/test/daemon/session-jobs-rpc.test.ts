import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * session.jobs regression test: for sessions WITHOUT an async job manager
 * (getAsyncJobSnapshot returns null) the handler answers with a fallback
 * snapshot. That fallback must match AsyncJobDeliveryState exactly — the GUI
 * jobs pane reads delivery.pendingJobIds.length, and a missing field crashed
 * the whole right pane into its ErrorBoundary.
 */

describe("session.jobs RPC", () => {
	test("fallback snapshot includes delivery.pendingJobIds when no job manager exists", async () => {
		const host = {
			cwd: () => "/tmp",
			get: () => ({
				sessionId: "s1",
				agentSession: { getAsyncJobSnapshot: () => null },
			}),
			setCollabToolProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const conn = { id: "test" } as unknown as DaemonConnection;
		const result = (await server.handle("session.jobs", { sessionId: "s1" }, conn)) as {
			running: unknown[];
			recent: unknown[];
			delivery: { queued: number; delivering: boolean; pendingJobIds?: string[] };
		};
		expect(result.running).toEqual([]);
		expect(result.recent).toEqual([]);
		expect(result.delivery).toEqual({ queued: 0, delivering: false, pendingJobIds: [] });
	});
});
