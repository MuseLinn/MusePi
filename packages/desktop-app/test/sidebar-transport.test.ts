/**
 * Sidebar transport bridge contract.
 *
 * Stubbed transport, real aborts — no daemon. The point is the chokepoint every
 * sidebar call now runs through, so what gets pinned is its behaviour at that
 * seam: what it forwards, how a rejection surfaces, and how abort is delivered.
 * None of that depends on a live socket, and all of it would be wrong in a way
 * the UI could not survive if the bridge were moved.
 */
import { describe, expect, test } from "bun:test";
import { callSidebar, type RpcTransport, SidebarApiError } from "../src/lib/sidebar-transport";

/** A transport whose one request resolves/rejects with a chosen outcome. */
function transport(behavior: { result?: unknown; reject?: Error }): {
	rpc: RpcTransport;
	calls: { method: string; params: unknown }[];
} {
	const calls: { method: string; params: unknown }[] = [];
	return {
		calls,
		rpc: {
			request<T>(method: string, params?: unknown): Promise<T> {
				calls.push({ method, params });
				if (behavior.reject) return Promise.reject(behavior.reject);
				return Promise.resolve(behavior.result as T);
			},
		},
	};
}

describe("callSidebar", () => {
	test("forwards an un-adapted method by identity, passing the payload through", async () => {
		// Most read routes already take {cwd, path} in the same shape, so they
		// reach the daemon untouched — a method with no adapter must NOT be
		// silently dropped or rewritten.
		const { rpc, calls } = transport({ result: { entries: [] } });
		const value = await callSidebar<{ entries: unknown[] }>(rpc, "git.status", { cwd: "/w", path: "src" });
		expect(value.entries).toEqual([]);
		expect(calls).toEqual([{ method: "git.status", params: { cwd: "/w", path: "src" } }]);
	});

	test("a JSON-RPC rejection surfaces as a host-coded SidebarApiError", async () => {
		// The daemon answers "Unknown method" / a route-level throw via the RPC
		// error envelope; the component's existing `catch (e)` must see the
		// sidebar's error type, not a raw Error, and read a code it can branch on.
		const { rpc } = transport({ reject: new Error("Unknown method") });
		const err = await callSidebar(rpc, "nope.missing", {}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SidebarApiError);
		expect((err as SidebarApiError).code).toBe("host");
		expect((err as SidebarApiError).message).toBe("Unknown method");
	});

	test("resolves a route's {error} field as ordinary data, not a failure", async () => {
		// archive.status legitimately returns {error: "..."} when a build failed;
		// turning every resolved {error} into a throw would make the poller unable
		// to read the failure it is meant to display. The transport must NOT judge
		// a successful RPC result's shape.
		const { rpc } = transport({ result: { state: "error", error: "disk full" } });
		const value = await callSidebar<{ state: string }>(rpc, "archive.status", { id: "x" });
		expect(value.state).toBe("error");
	});

	test("a pre-aborted signal rejects without ever hitting the transport", async () => {
		// The sidebar's own fetch aborted before send produced no request; matching
		// that avoids firing a daemon call the caller already abandoned.
		const { rpc, calls } = transport({ result: {} });
		const controller = new AbortController();
		controller.abort();
		const err = await callSidebar(rpc, "fs.read", {}, controller.signal).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SidebarApiError);
		expect((err as SidebarApiError).code).toBe("network");
		expect(calls.length).toBe(0);
	});

	test("an abort during the request releases the caller while the RPC is still open", async () => {
		// RpcClient cannot cancel an in-flight frame, so abort races a still-
		// pending request. The caller must be freed now, not when the request
		// eventually settles — and the late resolution must not throw an
		// unhandled rejection into the process.
		const controller = new AbortController();
		let resolve!: (v: unknown) => void;
		const pending = new Promise<unknown>(r => {
			resolve = r;
		});
		const rpc: RpcTransport = { request: () => pending as never };
		const call = callSidebar(rpc, "fs.read", {}, controller.signal);
		controller.abort();
		const err = await call.then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as SidebarApiError).code).toBe("network");
		// Resolve late; the caller already rejected, this must not resurface.
		resolve({ late: true });
		await pending;
	});

	test("an aborted signal after a real rejection keeps the host error, not a phantom abort", async () => {
		// If the request genuinely failed AND was aborted, the component cares
		// which happened first; Promise.race must not mask a real failure that
		// settled before the abort fired.
		const controller = new AbortController();
		const rpc: RpcTransport = { request: () => Promise.reject(new Error("boom")) };
		const err = await callSidebar(rpc, "fs.read", {}, controller.signal).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as SidebarApiError).code).toBe("host");
	});
});
