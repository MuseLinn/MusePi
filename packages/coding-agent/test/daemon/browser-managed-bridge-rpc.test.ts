/**
 * RPC `browser.managedBridge` — the desktop GUI hands the daemon the ACTUAL
 * bound port of its managed-browser CDP bridge (9230-9239 is a retry range),
 * which is what lets the agent's browser tool take over the in-app browser.
 *
 * Contract under test: the registration is connection-scoped runtime state
 * (never persisted), a later GUI's `null` or disconnect withdraws it, and a
 * non-loopback endpoint is refused — this RPC decides where the agent's
 * browser points.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { BrowserService } from "../../src/daemon/services/browser-service";
import {
	dropManagedBrowserBridge,
	managedBrowserBridgeUrl,
	normalizeManagedBrowserUrl,
} from "../../src/tools/browser/managed-bridge";

const GUI_A = "gui-conn-a";
const GUI_B = "gui-conn-b";

function service(): BrowserService {
	return new BrowserService({
		settings: async () => {
			throw new Error("not used by managedBridge");
		},
		cwd: () => ".",
	});
}

describe("browser.managedBridge", () => {
	afterEach(() => {
		dropManagedBrowserBridge(GUI_A);
		dropManagedBrowserBridge(GUI_B);
	});

	it("registers the bridge the desktop GUI reports and echoes the effective url", () => {
		const res = service().managedBridge({ url: "http://127.0.0.1:9235" }, GUI_A);
		expect(res).toEqual({ url: "http://127.0.0.1:9235" });
		expect(managedBrowserBridgeUrl()).toBe("http://127.0.0.1:9235");
	});

	it("normalizes the endpoint (trailing slash / path dropped)", () => {
		service().managedBridge({ url: "http://127.0.0.1:9237/json/" }, GUI_A);
		expect(managedBrowserBridgeUrl()).toBe("http://127.0.0.1:9237");
	});

	it("refuses a non-loopback endpoint — the agent's browser would be pointed off-host", () => {
		expect(() => service().managedBridge({ url: "http://203.0.113.9:9235" }, GUI_A)).toThrow(/loopback/);
		expect(managedBrowserBridgeUrl()).toBeNull();
	});

	it("refuses a non-http endpoint", () => {
		expect(() => normalizeManagedBrowserUrl("file:///etc/passwd")).toThrow(/http\(s\)/);
	});

	it("a null url withdraws that connection's bridge (GUI stopped it)", () => {
		service().managedBridge({ url: "http://127.0.0.1:9235" }, GUI_A);
		const res = service().managedBridge({ url: null }, GUI_A);
		expect(res).toEqual({ url: null });
		expect(managedBrowserBridgeUrl()).toBeNull();
	});

	it("one GUI going away does not withdraw another GUI's bridge", () => {
		service().managedBridge({ url: "http://127.0.0.1:9235" }, GUI_A);
		dropManagedBrowserBridge(GUI_B);
		expect(managedBrowserBridgeUrl()).toBe("http://127.0.0.1:9235");
	});
});
