import { describe, expect, test } from "bun:test";
import type { SessionClient } from "./client";
import { probeConnection } from "./connection-health";

/**
 * Liveness probe. The collab wire has no heartbeat, so "did the host answer at
 * all" is the only signal that distinguishes a live socket from one the OS
 * silently tore down. An error reply still proves the link in both directions.
 */

/** Minimal client surface `probeConnection` touches. */
function fakeClient(behaviour: "resolve" | "reject" | "hang"): SessionClient {
	const rpc = (_method: string, _params?: unknown, opts?: { timeoutMs?: number }) => {
		if (behaviour === "resolve") return Promise.resolve({ ok: true });
		if (behaviour === "reject") return Promise.reject(new Error("unknown method: ping"));
		return new Promise<never>(() => {
			// Never settles: only the caller's deadline can end this.
			void opts;
		});
	};
	return { rpc } as unknown as SessionClient;
}

describe("probeConnection", () => {
	test("a reply means the link is alive", async () => {
		expect(await probeConnection(fakeClient("resolve"), 50)).toBe(true);
	});

	test("a host-side error still proves the link is alive", async () => {
		// An older host has no `ping`; the error travelled back over the wire.
		expect(await probeConnection(fakeClient("reject"), 50)).toBe(true);
	});

	test("silence past the deadline is a miss", async () => {
		expect(await probeConnection(fakeClient("hang"), 30)).toBe(false);
	});
});
