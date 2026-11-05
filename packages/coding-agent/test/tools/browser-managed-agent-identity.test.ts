/**
 * Managed-browser agent identity across the tab lifecycle.
 *
 * A managed panel tab is badged with the agent that CREATED it ("操作者：X"),
 * so the supervisor must publish the operator when it creates the page and
 * must not strand that page when the tab goes away:
 * - a page the supervisor created through CDP (`createdTargetId`, version-skew
 *   fallback for shells without `ManagedBrowser.ensureAgentTab`) is closed on
 *   release, while a page the shell owns (dedicated agent tab) is left alone;
 * - a subagent's tab handed to its parent keeps the page and falls back to the
 *   parent's ownership instead of being closed under it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { PuppeteerBrowserHandle } from "@musepi/pi-coding-agent/tools/browser/registry";
import {
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
	type TabSession,
} from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@musepi/pi-coding-agent/tools/index";

function testSession(): ToolSession {
	return {
		cwd: "/tmp",
		settings: { get: () => undefined },
	} as unknown as ToolSession;
}

function fakeManagedBrowser(respond: (method: string) => Record<string, unknown> = () => ({})) {
	const calls: { method: string; params?: Record<string, unknown> }[] = [];
	const session = {
		send: async (method: string, params?: Record<string, unknown>) => {
			calls.push({ method, params });
			return respond(method);
		},
		detach: async () => undefined,
	};
	const handle = {
		key: "test-managed",
		kind: { kind: "connected", cdpUrl: "http://127.0.0.1:9230", gui: true },
		refCount: 1,
		browser: {
			connected: false,
			target: () => ({ createCDPSession: async () => session }),
			disconnect: () => undefined,
		},
		stealth: { browserSession: null, override: null },
	} as unknown as PuppeteerBrowserHandle;
	return { handle, calls };
}

/** A worker that acknowledges `close` so `releaseTab` does not fall back to the grace timeout. */
function fakeWorker() {
	let onMessage: ((msg: { type: string }) => void) | undefined;
	return {
		mode: "inline" as const,
		send: (msg: { type: string }) => {
			if (msg.type === "close") queueMicrotask(() => onMessage?.({ type: "closed" }));
		},
		onMessage: (handler: (msg: { type: string }) => void) => {
			onMessage = handler;
			return () => {
				onMessage = undefined;
			};
		},
		onError: () => () => undefined,
		terminate: async () => undefined,
	};
}

function managedTab(name: string, browser: PuppeteerBrowserHandle, extra: Record<string, unknown> = {}): TabSession {
	return {
		name,
		browser,
		targetId: "PAGE1",
		backend: "worker",
		worker: fakeWorker(),
		state: "alive",
		info: { url: "about:blank", viewport: { width: 800, height: 600 }, targetId: "PAGE1" },
		pending: new Map(),
		kindTag: "connected",
		activateForScreenshot: false,
		...extra,
	} as unknown as TabSession;
}

afterEach(async () => {
	for (const name of [...getTabsMapForTest().keys()]) {
		(getTabsMapForTest() as Map<string, TabSession>).delete(name);
	}
});

describe("managed-browser agent identity lifecycle", () => {
	it("closes the panel page the supervisor created when the tab is released", async () => {
		const { handle, calls } = fakeManagedBrowser();
		(getTabsMapForTest() as Map<string, TabSession>).set(
			"owned",
			managedTab("owned", handle, { targetId: "PAGE9", createdTargetId: "PAGE9" }),
		);

		await expect(releaseTab("owned", { kill: false })).resolves.toBe(true);
		expect(calls).toEqual([{ method: "Target.closeTarget", params: { targetId: "PAGE9" } }]);
		expect(getTabsMapForTest().has("owned")).toBe(false);
	});

	it("leaves the shell-owned dedicated agent tab alone on release", async () => {
		const { handle, calls } = fakeManagedBrowser();
		(getTabsMapForTest() as Map<string, TabSession>).set("dedicated", managedTab("dedicated", handle));

		await expect(releaseTab("dedicated", { kill: false })).resolves.toBe(true);
		expect(calls).toEqual([]);
		expect(getTabsMapForTest().has("dedicated")).toBe(false);
	});

	it("hands a subagent's tab to the parent without closing its page", async () => {
		const { handle, calls } = fakeManagedBrowser();
		const tab = managedTab("child", handle, {
			createdTargetId: "PAGE1",
			ownerSessionId: "session-shared",
			ownerAgentId: "Helper",
			ownerAgentName: "Helper",
			parentAgentId: "Main",
			parentAgentName: "Main",
		});
		(getTabsMapForTest() as Map<string, TabSession>).set("child", tab);

		await expect(releaseTabsForOwner("session-shared", { kill: true, agentId: "Helper" })).resolves.toBe(0);
		expect(calls).toEqual([]);
		expect(getTabsMapForTest().get("child")).toBe(tab);
		expect(tab.ownerAgentId).toBe("Main");
		expect(tab.ownerAgentName).toBe("Main");

		// The parent's own teardown now owns the page it inherits and closes it
		// instead of leaving a panel tab nobody tracks.
		await expect(releaseTabsForOwner("session-shared", { kill: true, agentId: "Main" })).resolves.toBe(1);
		expect(calls).toEqual([{ method: "Target.closeTarget", params: { targetId: "PAGE1" } }]);
		expect(getTabsMapForTest().has("child")).toBe(false);
	});

	it("keeps a user-driven page alive when its agent is reaped", async () => {
		const { handle, calls } = fakeManagedBrowser();
		const tab = managedTab("user-page", handle, {
			ownerSessionId: "session-shared",
			ownerAgentId: "Helper",
			ownerAgentName: "Helper",
		});
		(getTabsMapForTest() as Map<string, TabSession>).set("user-page", tab);

		await expect(releaseTabsForOwner("session-shared", { kill: true, agentId: "Helper" })).resolves.toBe(0);
		expect(calls).toEqual([]);
		expect(getTabsMapForTest().get("user-page")).toBe(tab);
		expect(tab.ownerAgentId).toBeUndefined();
	});

	it("rebadges the dedicated agent tab with the parent after a hand-off", async () => {
		const { handle, calls } = fakeManagedBrowser(method =>
			method === "ManagedBrowser.ensureAgentTab" ? { targetId: "PAGE1" } : {},
		);
		const tab = managedTab("child", handle, {
			managedAgentTab: true,
			ownerSessionId: "session-shared",
			ownerAgentId: "Helper",
			ownerAgentName: "Helper Bot",
			parentAgentId: "Main",
			parentAgentName: "Main",
		});
		(getTabsMapForTest() as Map<string, TabSession>).set("child", tab);

		await releaseTabsForOwner("session-shared", { kill: true, agentId: "Helper" });
		// The publication is fire-and-forget: let its CDP round-trip settle.
		await Bun.sleep(0);

		expect(calls).toEqual([
			{ method: "ManagedBrowser.ensureAgentTab", params: { agentId: "Main", agentName: "Main" } },
		]);
		expect(tab.ownerAgentId).toBe("Main");
	});

	it("republishes the operator when another agent runs the dedicated tab", async () => {
		const { handle, calls } = fakeManagedBrowser(method =>
			method === "ManagedBrowser.ensureAgentTab" ? { targetId: "PAGE1" } : {},
		);
		const tab = managedTab("shared", handle, {
			managedAgentTab: true,
			publishedAgentId: "Main",
			ownerSessionId: "session-shared",
			ownerAgentId: "Main",
			ownerAgentName: "Main",
		});
		(getTabsMapForTest() as Map<string, TabSession>).set("shared", tab);

		const run = runInTab("shared", {
			code: "1",
			timeoutMs: 2_000,
			session: testSession(),
			agentId: "Helper",
			agentName: "Helper Bot",
		}).catch(error => error);
		await Bun.sleep(1);

		expect(calls).toEqual([
			{ method: "ManagedBrowser.ensureAgentTab", params: { agentId: "Helper", agentName: "Helper Bot" } },
		]);

		await releaseTab("shared", { kill: false });
		expect(await run).toBeInstanceOf(Error);
		// The run marker still clears so the next caller is not blamed on a
		// finished agent.
		expect(tab.activeAgentId).toBeUndefined();
	});

	it("does not touch the bridge for a run by the already-published agent", async () => {
		const { handle, calls } = fakeManagedBrowser();
		const tab = managedTab("shared", handle, {
			managedAgentTab: true,
			publishedAgentId: "Main",
			ownerSessionId: "session-shared",
			ownerAgentId: "Main",
		});
		(getTabsMapForTest() as Map<string, TabSession>).set("shared", tab);

		const run = runInTab("shared", {
			code: "1",
			timeoutMs: 2_000,
			session: testSession(),
			agentId: "Main",
		}).catch(error => error);
		await Bun.sleep(1);

		expect(calls).toEqual([]);

		await releaseTab("shared", { kill: false });
		expect(await run).toBeInstanceOf(Error);
	});

	it("does not publish an operator for tabs that are not the dedicated agent tab", async () => {
		const { handle, calls } = fakeManagedBrowser();
		const tab = managedTab("adopted", handle, { ownerSessionId: "session-shared", ownerAgentId: "Main" });
		(getTabsMapForTest() as Map<string, TabSession>).set("adopted", tab);

		const run = runInTab("adopted", {
			code: "1",
			timeoutMs: 2_000,
			session: testSession(),
			agentId: "Helper",
			agentName: "Helper",
		}).catch(error => error);
		await Bun.sleep(1);

		expect(calls).toEqual([]);

		await releaseTab("adopted", { kill: false });
		expect(await run).toBeInstanceOf(Error);
	});
});
