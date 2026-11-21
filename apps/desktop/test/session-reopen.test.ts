import { expect, test } from "bun:test";
import {
	isConnectionNotReadyError,
	reopenRetryDelay,
	runSessionReopen,
	SESSION_REOPEN_MAX_ATTEMPTS,
	SESSION_REOPEN_RETRY_DELAYS_MS,
	type SessionOpenOutcome,
	SessionOpenScheduler,
} from "../src/lib/session-reopen";

const noopWait = async (): Promise<void> => {};

/** A daemon that refuses the first `refusals` opens with "not connected" and
 *  serves the session after that — the rebuild-faster-than-reconnect case. */
function daemonRefusingThenServing(refusals: number) {
	const requests: string[] = [];
	const open = async (sessionId: string): Promise<SessionOpenOutcome> => {
		requests.push(sessionId);
		if (requests.length <= refusals) return { status: "transient", error: new Error("not connected") };
		return { status: "opened" };
	};
	return { open, requests };
}

test("treats a socket that is not accepting requests yet as retryable", () => {
	expect(isConnectionNotReadyError(new Error("not connected"))).toBe(true);
	expect(isConnectionNotReadyError(new Error("connection closed"))).toBe(true);
	expect(isConnectionNotReadyError(new Error("cannot connect to ws://127.0.0.1:4242"))).toBe(true);
});

test("does not treat a session verdict or a slow answer as a dead connection", () => {
	expect(isConnectionNotReadyError(new Error("session not found: abc"))).toBe(false);
	// A timeout may be a daemon already serving the session — retrying would
	// stack resume requests on a turn that is merely slow.
	expect(isConnectionNotReadyError(new Error("request timeout: session.resume"))).toBe(false);
	expect(isConnectionNotReadyError(null)).toBe(false);
});

test("opens the session once the daemon accepts requests again", async () => {
	const { open, requests } = daemonRefusingThenServing(2);
	const result = await runSessionReopen({ sessionId: "s1", open, stillWanted: () => true, wait: noopWait });
	expect(result).toEqual({ status: "opened", attempts: 3, error: null });
	expect(requests).toEqual(["s1", "s1", "s1"]);
});

test("waits out the daemon with a bounded backoff schedule", async () => {
	const { open } = daemonRefusingThenServing(2);
	const waits: number[] = [];
	await runSessionReopen({
		sessionId: "s1",
		open,
		stillWanted: () => true,
		wait: async ms => void waits.push(ms),
	});
	expect(waits).toEqual(SESSION_REOPEN_RETRY_DELAYS_MS.slice(0, 2));
	expect(reopenRetryDelay(1)).toBe(SESSION_REOPEN_RETRY_DELAYS_MS[0]);
	// Past the schedule the last delay repeats, never unbounded growth.
	expect(reopenRetryDelay(99)).toBe(SESSION_REOPEN_RETRY_DELAYS_MS.at(-1) ?? 0);
});

test("a daemon that never returns stops after the bounded attempts", async () => {
	const { open, requests } = daemonRefusingThenServing(Number.POSITIVE_INFINITY);
	const result = await runSessionReopen({ sessionId: "s1", open, stillWanted: () => true, wait: noopWait });
	expect(result.status).toBe("exhausted");
	expect(result.attempts).toBe(SESSION_REOPEN_MAX_ATTEMPTS);
	expect(requests).toHaveLength(SESSION_REOPEN_MAX_ATTEMPTS);
	expect((result.error as Error).message).toBe("not connected");
});

test("returning to the welcome page (no session selected) does not reopen", async () => {
	// App wiring: the restore target is the selected session id, and the
	// welcome page means nothing is selected.
	const selected: string | null = null;
	const { open, requests } = daemonRefusingThenServing(0);
	const result = await runSessionReopen({
		sessionId: "s1",
		open,
		stillWanted: () => selected === "s1",
		wait: noopWait,
	});
	expect(result).toEqual({ status: "cancelled", attempts: 0, error: null });
	expect(requests).toEqual([]);
});

test("leaving during the backoff stops the retries", async () => {
	const { open, requests } = daemonRefusingThenServing(Number.POSITIVE_INFINITY);
	let wanted = true;
	const result = await runSessionReopen({
		sessionId: "s1",
		open,
		stillWanted: () => wanted,
		wait: async () => {
			wanted = false;
		},
	});
	expect(result).toEqual({ status: "cancelled", attempts: 1, error: expect.any(Error) });
	expect(requests).toHaveLength(1);
});

test("a refusal about the session itself is not retried", async () => {
	let attempts = 0;
	const result = await runSessionReopen({
		sessionId: "gone",
		open: async () => {
			attempts++;
			return { status: "failed", error: new Error("session not found: gone") };
		},
		stillWanted: () => true,
		wait: noopWait,
	});
	expect(result.status).toBe("failed");
	expect(attempts).toBe(1);
	expect((result.error as Error).message).toBe("session not found: gone");
});

test("a newer open that owns the session ends this restore", async () => {
	let attempts = 0;
	const result = await runSessionReopen({
		sessionId: "s1",
		open: async () => {
			attempts++;
			return { status: "superseded" };
		},
		stillWanted: () => true,
		wait: noopWait,
	});
	expect(result).toEqual({ status: "superseded", attempts: 1, error: null });
});

// ── Scheduler: every open intent shares one bounded chain ────────────────
// The app wires `select` to the same ref `wanted` reads (`selectedIdRef`) and
// `open` to one RPC attempt. The scheduler must record a user's pick BEFORE
// its first `wanted` check: an intent recorded only inside the attempt makes
// the run cancel itself (zero requests) and, together with the replaced
// restore, leaves both sessions unopened. These cover that order and the
// restore/pick interleaving.

/** Let a started run reach its first wait without touching real timers. */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
};

/** A wait that parks until the test releases it, so two runs can interleave. */
function gatedWait() {
	const gates: Array<() => void> = [];
	const wait = (): Promise<void> =>
		new Promise<void>(resolve => {
			gates.push(resolve);
		});
	return { wait, release: (): void => void gates.shift()?.(), pending: (): number => gates.length };
}

/** App-shaped scheduler: one mutable selection drives both `select` and
 *  `wanted`, exactly like `selectedIdRef` in app.tsx. */
function harness(
	open: (sessionId: string) => Promise<SessionOpenOutcome>,
	options?: { selected?: string | null; wait?: (ms: number) => Promise<void> },
) {
	let selected: string | null = options?.selected ?? null;
	const abandons: Array<{ id: string; error: unknown }> = [];
	const scheduler = new SessionOpenScheduler({
		select: sessionId => {
			selected = sessionId;
		},
		open,
		wanted: () => selected,
		abandon: (id, error) => void abandons.push({ id, error }),
		wait: options?.wait,
	});
	return {
		scheduler,
		selected: (): string | null => selected,
		setSelected: (sessionId: string | null): void => {
			selected = sessionId;
		},
		abandons,
	};
}

test("a user pick is recorded before the first check, so the pick itself issues a resume", async () => {
	const requests: string[] = [];
	const app = harness(
		async sessionId => {
			requests.push(sessionId);
			return { status: "opened" };
		},
		{ selected: "A" },
	);
	const result = await app.scheduler.open("B");
	expect(result.status).toBe("opened");
	// Before the fix the first `wanted` check saw the stale selection A and the
	// run cancelled with no request at all.
	expect(requests).toEqual(["B"]);
	expect(app.selected()).toBe("B");
});

test("a pick recorded only by the attempt cancels the run (the wiring this replaces)", async () => {
	// Characterizes the old app order: `select` does nothing up front and the
	// selection only flips when the attempt itself runs. The scheduler must not
	// hide that failure, because the app must commit the pick first.
	let selected: string | null = "A";
	let attempts = 0;
	const scheduler = new SessionOpenScheduler({
		select: () => {},
		open: async sessionId => {
			attempts++;
			selected = sessionId;
			return { status: "opened" };
		},
		wanted: () => selected,
		abandon: () => {},
		wait: noopWait,
	});
	expect((await scheduler.open("B")).status).toBe("cancelled");
	expect(attempts).toBe(0);
});

test("a session picked during a restore owns the retries and the restore stops", async () => {
	const gate = gatedWait();
	const calls = new Map<string, number>();
	const opened: string[] = [];
	const app = harness(
		async sessionId => {
			const seen = (calls.get(sessionId) ?? 0) + 1;
			calls.set(sessionId, seen);
			// The daemon is not accepting requests yet for the first try of each.
			if (seen === 1) return { status: "transient", error: new Error("not connected") };
			opened.push(sessionId);
			return { status: "opened" };
		},
		{ selected: "A", wait: gate.wait },
	);
	const restoringA = app.scheduler.restore("A");
	await flush();
	expect(calls.get("A")).toBe(1);

	// The user picks B while A is waiting out its backoff.
	const openingB = app.scheduler.open("B");
	await flush();
	expect(calls.get("B")).toBe(1);

	// A is superseded: releasing its backoff must not issue another request.
	gate.release();
	expect((await restoringA).status).toBe("cancelled");
	expect(calls.get("A")).toBe(1);

	// B keeps its own chain and opens on the retry.
	gate.release();
	const result = await openingB;
	expect(result).toMatchObject({ status: "opened", attempts: 2 });
	expect(opened).toEqual(["B"]);
	// Neither intent tore the session down while the daemon was refusing.
	expect(app.abandons).toEqual([]);
});

test("a user open that never succeeds fails visibly instead of vanishing", async () => {
	const app = harness(async () => ({ status: "transient", error: new Error("not connected") }), { wait: noopWait });
	const result = await app.scheduler.open("B");
	expect(result.status).toBe("exhausted");
	expect(result.attempts).toBe(SESSION_REOPEN_MAX_ATTEMPTS);
	expect(app.abandons).toHaveLength(1);
	expect(app.abandons[0]?.id).toBe("B");
});

test("retries only re-issue opens, never a session teardown on the way", async () => {
	let attempts = 0;
	const app = harness(
		async () => {
			attempts++;
			if (attempts < 3) return { status: "transient", error: new Error("not connected") };
			return { status: "opened" };
		},
		{ selected: "A", wait: noopWait },
	);
	expect((await app.scheduler.open("A")).status).toBe("opened");
	expect(attempts).toBe(3);
	// The transcript keeps the idle snapshot: only opens were issued, so no
	// retry could present a turn as running.
	expect(app.abandons).toEqual([]);
});

test("a session deleted during the restore is not restored on reconnect", async () => {
	const gate = gatedWait();
	const calls: string[] = [];
	const app = harness(
		async sessionId => {
			calls.push(sessionId);
			return { status: "transient", error: new Error("not connected") };
		},
		{ selected: "A", wait: gate.wait },
	);
	const restoring = app.scheduler.restore("A");
	await flush();
	expect(calls).toEqual(["A"]);

	// Deleting the selected session clears the ref the scheduler reads.
	app.setSelected(null);
	gate.release();
	expect((await restoring).status).toBe("cancelled");
	expect(calls).toEqual(["A"]);

	// A later reconnect restore must not target the deleted session. It also
	// must not re-select it: a restore never invents intent.
	expect((await app.scheduler.restore("A")).status).toBe("cancelled");
	expect(calls).toEqual(["A"]);
	expect(app.selected()).toBeNull();
	expect(app.abandons).toEqual([]);
});

test("a request timeout is a verdict, not a connection gap", async () => {
	let calls = 0;
	const app = harness(
		async () => {
			calls++;
			return { status: "failed", error: new Error("request timeout: session.resume") };
		},
		{ selected: "A", wait: noopWait },
	);
	const result = await app.scheduler.open("A");
	expect(result.status).toBe("failed");
	expect(calls).toBe(1);
	// The open path already showed the failure; the scheduler must not stack
	// a second, later one on top of it.
	expect(app.abandons).toEqual([]);
});

test("an open that throws a connection error is retried, not lost", async () => {
	let attempts = 0;
	const app = harness(
		async () => {
			attempts++;
			if (attempts === 1) throw new Error("not connected");
			return { status: "opened" };
		},
		{ selected: "A", wait: noopWait },
	);
	expect((await app.scheduler.open("A")).status).toBe("opened");
	expect(attempts).toBe(2);
});

test("an open that throws a session verdict fails once, visibly", async () => {
	let attempts = 0;
	const app = harness(
		async () => {
			attempts++;
			throw new Error("session not found: gone");
		},
		{ selected: "gone", wait: noopWait },
	);
	expect((await app.scheduler.open("gone")).status).toBe("failed");
	expect(attempts).toBe(1);
	// The open path showed this one; the scheduler only adds the give-up case.
	expect(app.abandons).toEqual([]);
});
