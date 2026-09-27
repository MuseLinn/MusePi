/**
 * Managed-browser bridge publishing (`lib/managed-browser-bridge.ts`).
 *
 * Contract: the desktop GUI tells the daemon the port the CDP bridge ACTUALLY
 * bound (9230-9239 is a retry range — the setting's default is often wrong),
 * and says so again when the bridge goes away. De-duplicated: host state
 * changes several times a second and each push is an RPC round-trip.
 */
import { expect, spyOn, test } from "bun:test";
import { pushManagedBrowserBridge } from "../src/lib/managed-browser-bridge";
import type { RpcClient } from "../src/lib/rpc";

function fakeRpc(): RpcClient {
	return { request: () => Promise.resolve({}) } as unknown as RpcClient;
}

test("publishes the bound port as a loopback CDP url", () => {
	const rpc = fakeRpc();
	const request = spyOn(rpc, "request");
	pushManagedBrowserBridge(rpc, 9235);
	expect(request).toHaveBeenCalledWith("browser.managedBridge", { url: "http://127.0.0.1:9235" });
});

test("re-publishes when the port changes, but not when it does not", () => {
	const rpc = fakeRpc();
	const request = spyOn(rpc, "request");
	pushManagedBrowserBridge(rpc, 9235);
	pushManagedBrowserBridge(rpc, 9236);
	pushManagedBrowserBridge(rpc, 9236);
	expect(request.mock.calls.map(call => String(call[0]))).toEqual(["browser.managedBridge", "browser.managedBridge"]);
	expect(request.mock.calls[1]?.[1]).toEqual({ url: "http://127.0.0.1:9236" });
});

test("withdraws the bridge when it stops (port gone)", () => {
	const rpc = fakeRpc();
	const request = spyOn(rpc, "request");
	pushManagedBrowserBridge(rpc, 9235);
	pushManagedBrowserBridge(rpc, null);
	expect(request.mock.calls[1]?.[1]).toEqual({ url: null });
});

test("a reconnect pushes again even for the same port", () => {
	const first = fakeRpc();
	const firstRequest = spyOn(first, "request");
	pushManagedBrowserBridge(first, 9235);
	const second = fakeRpc();
	const secondRequest = spyOn(second, "request");
	pushManagedBrowserBridge(second, 9235);
	expect(firstRequest.mock.calls.length).toBe(1);
	expect(secondRequest.mock.calls.length).toBe(1);
});
