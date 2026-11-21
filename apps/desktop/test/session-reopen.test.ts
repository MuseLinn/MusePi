import { expect, test } from "bun:test";
import {
	isConnectionNotReadyError,
	reopenRetryDelay,
	runSessionReopen,
	SESSION_REOPEN_MAX_ATTEMPTS,
	SESSION_REOPEN_RETRY_DELAYS_MS,
	type SessionOpenOutcome,
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
