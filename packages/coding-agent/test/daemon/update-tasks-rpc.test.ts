import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * `system.updateTasks` is the update handoff's gate: `inspect` feeds the
 * banner count, `lock` must actually refuse new work. The host stub has no
 * sessions, so this asserts the admission path itself — a lock that only
 * reported `locked: true` without gating `session.send` would look correct in
 * the reply and still start a turn the install is about to kill.
 */
function makeHarness() {
	// DaemonServer's constructor wires a growing set of host callbacks; the
	// stub answers every unknown callback with a no-op and keeps only the two
	// session reads this contract needs.
	const base = { allSessions: () => [], get: () => undefined };
	const host = new Proxy(base as Record<string, unknown>, {
		get(target, prop: string | symbol) {
			if (prop in target) return target[prop as string];
			return () => {};
		},
	}) as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test", send: () => {} } as DaemonConnection;
	const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		server.handle(method, params, conn);
	return { rpc };
}

/** Resolve to the rejection message instead of throwing, for before/after comparisons. */
async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("system.updateTasks", () => {
	test("inspect reports an idle daemon with admission open", async () => {
		const { rpc } = makeHarness();
		expect(await rpc("system.updateTasks", { mode: "inspect" })).toEqual({
			locked: false,
			activeSessions: 0,
			queuedMessages: 0,
			runningJobs: 0,
			pendingApprovals: 0,
			armedSchedules: 0,
			activeTasks: false,
			scheduledTasks: false,
		});
	});

	test("defaults to inspect for an unknown mode", async () => {
		const { rpc } = makeHarness();
		expect(await rpc("system.updateTasks", { mode: "nope" })).toMatchObject({ locked: false });
	});

	test("lock refuses new sends until unlock opens admission again", async () => {
		const { rpc } = makeHarness();
		expect(await rpc("system.updateTasks", { mode: "lock" })).toMatchObject({ locked: true });
		expect(await rejection(rpc("session.send", { sessionId: "missing", text: "hi" }))).toContain(
			"UPDATE_RESTART_PENDING",
		);

		expect(await rpc("system.updateTasks", { mode: "unlock" })).toMatchObject({ locked: false });
		const after = await rejection(rpc("session.send", { sessionId: "missing", text: "hi" }));
		expect(after).not.toContain("UPDATE_RESTART_PENDING");
	});

	test("a second lock keeps the first engagement", async () => {
		const { rpc } = makeHarness();
		await rpc("system.updateTasks", { mode: "lock" });
		expect(await rpc("system.updateTasks", { mode: "lock" })).toMatchObject({ locked: true });
		await rpc("system.updateTasks", { mode: "unlock" });
		expect(await rpc("system.updateTasks", { mode: "inspect" })).toMatchObject({ locked: false });
	});
});
