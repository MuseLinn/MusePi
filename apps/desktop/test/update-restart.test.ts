import { describe, expect, test } from "bun:test";
// update-restart.cjs lives outside tsconfig include (electron/) and has no
// types — same convention as the update-logic test imports.
// @ts-expect-error — untyped CJS module
import { createRestartHandoff } from "../electron/update-restart.cjs";

/**
 * Restart handoff ordering:
 *
 *   inspect → (idle) → lock → re-check → stop daemon → installer
 *
 * The re-check is what makes the handoff safe: work that appeared between the
 * idle check and the lock wins, and the failed handoff unlocks admission so
 * the daemon keeps serving. An explicit install stays possible when the daemon
 * is mute or absent — the user already decided.
 */
interface HarnessOptions {
	inspect?: unknown[];
	lock?: (() => unknown) | unknown;
	stopOk?: boolean;
	handoffError?: Error | null;
}

function harness(options: HarnessOptions = {}) {
	const calls: string[] = [];
	const summaries = [...(options.inspect ?? [{ activeSessions: 0 }])];
	const handoff = createRestartHandoff({
		inspectTasks: async () => {
			calls.push("inspect");
			return summaries.length > 0 ? summaries.shift() : { activeSessions: 0 };
		},
		lockTasks: async () => {
			calls.push("lock");
			if ("lock" in options) return typeof options.lock === "function" ? options.lock() : options.lock;
			return { activeSessions: 0 };
		},
		unlockTasks: async () => {
			calls.push("unlock");
		},
		stopDaemon: async () => {
			calls.push("stop");
			return options.stopOk ?? true;
		},
		handoff: async () => {
			calls.push("handoff");
			if (options.handoffError) throw options.handoffError;
		},
	});
	return { handoff, calls };
}

describe("createRestartHandoff", () => {
	test("hands off an idle app in the documented order", async () => {
		const { handoff, calls } = harness();
		await expect(handoff.install({ auto: true })).resolves.toEqual({ ok: true });
		expect(calls).toEqual(["inspect", "lock", "stop", "handoff"]);
	});

	test("refuses to restart over work without locking admission", async () => {
		const { handoff, calls } = harness({ inspect: [{ activeSessions: 1, pendingApprovals: 1 }] });
		await expect(handoff.install({ auto: true })).resolves.toMatchObject({
			ok: false,
			reason: "busy",
			inFlight: 2,
		});
		expect(calls).toEqual(["inspect"]);
	});

	test("treats an unanswering daemon as unavailable, not idle", async () => {
		const { handoff } = harness({ inspect: ["unknown"] });
		await expect(handoff.install({ auto: true })).resolves.toMatchObject({
			ok: false,
			reason: "tasks-unavailable",
		});
	});

	test("keeps work that appeared between the idle check and the lock", async () => {
		const { handoff, calls } = harness({ lock: { activeSessions: 1 } });
		await expect(handoff.install({ auto: true })).resolves.toMatchObject({
			ok: false,
			reason: "tasks-changed",
		});
		expect(calls).toEqual(["inspect", "lock", "unlock"]);
	});

	test("lets an explicit install proceed over running work", async () => {
		const { handoff, calls } = harness({ inspect: [{ activeSessions: 2 }], lock: { activeSessions: 2 } });
		await expect(handoff.install({ auto: false })).resolves.toEqual({ ok: true });
		expect(calls).toEqual(["inspect", "lock", "stop", "handoff"]);
	});

	test("skips admission when no daemon is running", async () => {
		const { handoff, calls } = harness({ inspect: [null] });
		await expect(handoff.install({ auto: true })).resolves.toEqual({ ok: true });
		expect(calls).toEqual(["inspect", "stop", "handoff"]);
	});

	test("releases admission when the daemon cannot be stopped", async () => {
		const { handoff, calls } = harness({ stopOk: false });
		await expect(handoff.install({ auto: true })).resolves.toMatchObject({ ok: false, reason: "stop-failed" });
		expect(calls).toEqual(["inspect", "lock", "stop", "unlock"]);
	});

	test("reports a failed installer handoff", async () => {
		const { handoff } = harness({ handoffError: new Error("signature rejected") });
		await expect(handoff.install({ auto: true })).resolves.toMatchObject({
			ok: false,
			reason: "handoff-failed",
		});
	});

	test("continues an explicit install when the lock goes unanswered", async () => {
		const { handoff } = harness({ inspect: ["unknown"], lock: null });
		await expect(handoff.install({ auto: false })).resolves.toEqual({ ok: true });
	});

	test("refuses an automatic install when the lock goes unanswered", async () => {
		const { handoff } = harness({ lock: null });
		await expect(handoff.install({ auto: true })).resolves.toMatchObject({
			ok: false,
			reason: "tasks-unavailable",
		});
	});

	test("is single-flight across a watchdog tick and a manual click", async () => {
		const { handoff, calls } = harness();
		const first = handoff.install({ auto: true });
		const second = handoff.install({ auto: false });
		expect(second).toBe(first);
		await first;
		expect(calls.filter(call => call === "stop")).toHaveLength(1);
	});
});
