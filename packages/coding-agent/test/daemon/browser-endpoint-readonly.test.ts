import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Settings } from "../../src/config/settings";
import { browserEndpoint, browserTabs } from "../../src/daemon/browser-rpc";
import * as launchClient from "../../src/launch/client";

/**
 * `browser.endpoint` / `browser.tabs` are STATUS reads.
 *
 * The settings pane polls `browser.endpoint` every 4 seconds and the agent-tab
 * strip polls `browser.tabs` every 3. Answering those with `ensureSharedBrowser`
 * meant a passive read started a browser: opening Settings → Browser spawned a
 * headless Chromium beside the desktop app's own managed browser, which is how
 * the app ended up running two browsers at once. The contract under test is
 * that these two RPCs only describe what the broker already has — they must
 * never send `start` (and never `stop`, which would kill a browser the user is
 * actually using).
 */

const OPS: string[] = [];

function fakeClient(daemon: Record<string, unknown> | undefined) {
	return {
		projectDir: "/tmp/musepi-browser-status",
		onCompletion: () => () => {},
		request: async (operation: { op: string; name?: string }) => {
			OPS.push(operation.op);
			if (operation.op === "describe") {
				return { op: "describe", daemon };
			}
			return { op: operation.op };
		},
		close: async () => {},
	} as unknown as launchClient.DaemonBrokerClient;
}

function settings(headless = true): Settings {
	return {
		get: (key: string) => (key === "browser.headless" ? headless : undefined),
		isConfigured: () => false,
	} as unknown as Settings;
}

afterEach(() => {
	OPS.length = 0;
	vi.restoreAllMocks();
});

describe("browser status RPCs are read-only", () => {
	test("no running shared browser: reports nothing and never starts one", async () => {
		vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue(fakeClient(undefined));

		expect(await browserEndpoint(settings(), "/tmp/musepi-browser-status")).toBeNull();
		expect(OPS).toEqual(["describe"]);
		expect(OPS).not.toContain("start");
	});

	test("an exited record is not resurrected by a status read", async () => {
		vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue(
			fakeClient({ state: "exited", readyMatch: "DevTools listening on ws://127.0.0.1:1/x" }),
		);

		expect(await browserEndpoint(settings(), "/tmp/musepi-browser-status")).toBeNull();
		expect(OPS).not.toContain("start");
	});

	test("a running browser is reported without any lifecycle op", async () => {
		// A ready record whose endpoint does not answer the liveness probe reads
		// as "not running" — a status read must not replace a wedged browser.
		vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue(
			fakeClient({ state: "ready", readyMatch: "DevTools listening on ws://127.0.0.1:1/x" }),
		);

		expect(await browserEndpoint(settings(), "/tmp/musepi-browser-status")).toBeNull();
		expect(OPS).toEqual(["describe"]);
		expect(OPS).not.toContain("start");
		expect(OPS).not.toContain("stop");
	});

	test("browser.tabs shares the same read-only path", async () => {
		vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue(fakeClient(undefined));

		expect(await browserTabs(settings(), "/tmp/musepi-browser-status")).toEqual({ tabs: [], wsEndpoint: null });
		expect(OPS).not.toContain("start");
	});
});
