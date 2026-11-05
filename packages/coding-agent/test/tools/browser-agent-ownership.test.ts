/**
 * Agent-scoped browser tab ownership.
 *
 * A subagent shares its parent's session id but disposes independently, so the
 * old session-scoped reap (`releaseTabsForOwner(sessionId, { kill: true })`)
 * could close a tab the parent — or the user — was still driving. Tab
 * ownership now records the creating agent, and a subagent's teardown hands its
 * tabs back to the spawning agent instead of closing them.
 *
 * The cmux backend is used because it needs no Chromium: `CmuxSocketClient` is
 * spied, so acquisition, run, close and release all exercise the real
 * supervisor code paths.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { CmuxSocketClient } from "@musepi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@musepi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
	type TabSession,
} from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@musepi/pi-coding-agent/tools/index";
import { ToolError } from "@musepi/pi-coding-agent/tools/tool-errors";

interface FakeAgent {
	displayName: string;
	parentId?: string;
}

function makeSession(agentId: string, agents: Record<string, FakeAgent>): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: { get: (key: string) => (key === "browser.cmux" ? true : undefined) },
		// Parent and child share one session id — the exact condition that made
		// session-scoped reaping dangerous.
		getSessionId: () => "session-agent-ownership",
		getAgentId: () => agentId,
		agentRegistry: {
			get: (id: string) => {
				const ref = agents[id];
				return ref ? { id, displayName: ref.displayName, parentId: ref.parentId } : undefined;
			},
		},
	} as unknown as ToolSession;
}

function makeAgents(): Record<string, FakeAgent> {
	return {
		Main: { displayName: "Main" },
		Helper: { displayName: "Helper", parentId: "Main" },
	};
}

async function drainAllTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

let prevSocketPath: string | undefined;

beforeEach(() => {
	prevSocketPath = process.env.CMUX_SOCKET_PATH;
	process.env.CMUX_SOCKET_PATH = `/tmp/omp-agent-own-${process.pid}-${Math.random().toString(36).slice(2)}.sock`;
	spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
});

afterEach(async () => {
	await drainAllTabs().catch(() => undefined);
	vi.restoreAllMocks();
	if (prevSocketPath === undefined) delete process.env.CMUX_SOCKET_PATH;
	else process.env.CMUX_SOCKET_PATH = prevSocketPath;
});

describe("browser tab agent ownership", () => {
	it("refuses to reuse a tab name owned by another agent", async () => {
		let splits = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: `surface-${++splits}`, url: "about:blank" };
				if (method === "browser.url.get") return { url: "about:blank" };
				if (method === "browser.eval") return { value: "" };
				return {};
			},
		);

		const agents = makeAgents();
		const parent = new BrowserTool(makeSession("Main", agents));
		await parent.execute("open-parent", { action: "open", name: "shared", timeout: 5 });

		const child = new BrowserTool(makeSession("Helper", agents));
		const reopened = child.execute("open-child", { action: "open", name: "shared", timeout: 5 });

		await expect(reopened).rejects.toBeInstanceOf(ToolError);
		await expect(reopened).rejects.toThrow(/belongs to agent "Main"/);
		await expect(reopened).rejects.toThrow(/different tab name/);

		// The refused open neither stole ownership nor opened a second surface.
		expect(splits).toBe(1);
		expect(getTabsMapForTest().get("shared")?.ownerAgentId).toBe("Main");
	});

	it("hands a finishing subagent's tabs to the parent instead of closing them", async () => {
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					return { surface_id: `surface-${getTabsMapForTest().size + 1}`, url: "about:blank" };
				}
				if (method === "browser.url.get") return { url: "about:blank" };
				if (method === "browser.eval") return { value: "" };
				return {};
			},
		);

		const agents = makeAgents();
		const parent = new BrowserTool(makeSession("Main", agents));
		const child = new BrowserTool(makeSession("Helper", agents));
		await parent.execute("open-parent", { action: "open", name: "parent-tab", timeout: 5 });
		await child.execute("open-child", { action: "open", name: "child-tab", timeout: 5 });

		// The child disposes while the parent session is still live.
		const released = await releaseTabsForOwner("session-agent-ownership", { kill: true, agentId: "Helper" });
		expect(released).toBe(0);
		expect([...getTabsMapForTest().keys()].sort()).toEqual(["child-tab", "parent-tab"]);
		const handed = getTabsMapForTest().get("child-tab");
		expect(handed?.ownerAgentId).toBe("Main");
		expect(handed?.ownerAgentName).toBe("Main");
		expect(getTabsMapForTest().get("parent-tab")?.ownerAgentId).toBe("Main");

		// The parent's own teardown reclaims both.
		const parentReleased = await releaseTabsForOwner("session-agent-ownership", { kill: true, agentId: "Main" });
		expect(parentReleased).toBe(2);
		expect(getTabsMapForTest().size).toBe(0);
	});

	it("moves the reap key to the parent session when the subagent minted its own id", async () => {
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-split", url: "about:blank" };
				if (method === "browser.url.get") return { url: "about:blank" };
				if (method === "browser.eval") return { value: "" };
				return {};
			},
		);

		const browser = await acquireBrowser(
			{ kind: "cmux", socketPath: process.env.CMUX_SOCKET_PATH!, surface: "surface-split" },
			{ cwd: "/tmp" },
		);
		await acquireTab("child-tab", browser, {
			timeoutMs: 5_000,
			ownerSessionId: "session-child",
			agentId: "Helper",
			agentName: "Helper",
			parentAgentId: "Main",
			parentAgentName: "Main",
			parentSessionId: "session-parent",
		});

		expect(await releaseTabsForOwner("session-child", { kill: true, agentId: "Helper" })).toBe(0);
		expect(getTabsMapForTest().get("child-tab")?.ownerSessionId).toBe("session-parent");

		// The parent's reap — its own session id, its own agent id — finds it.
		expect(await releaseTabsForOwner("session-parent", { kill: true, agentId: "Main" })).toBe(1);
		expect(getTabsMapForTest().has("child-tab")).toBe(false);
	});

	it("keeps a user-driven tab alive even when the owning agent disposes", async () => {
		const fakeTab = {
			name: "user-tab",
			browser: { kind: { kind: "connected" } },
			targetId: "target-user",
			backend: "cmux",
			cmuxTab: {},
			cmuxOwnsSurface: false,
			state: "alive",
			info: { url: "https://user.example", title: "User", viewport: { width: 800, height: 600 } },
			pending: new Map(),
			kindTag: "connected",
			ownerSessionId: "session-agent-ownership",
			ownerAgentId: "Helper",
			ownerAgentName: "Helper",
			parentAgentId: "Main",
			parentAgentName: "Main",
		} as unknown as TabSession;
		(getTabsMapForTest() as Map<string, TabSession>).set("user-tab", fakeTab);

		const released = await releaseTabsForOwner("session-agent-ownership", { kill: true, agentId: "Helper" });

		expect(released).toBe(0);
		expect(getTabsMapForTest().get("user-tab")).toBe(fakeTab);
		expect(fakeTab.ownerAgentId).toBe("Main");
		(getTabsMapForTest() as Map<string, TabSession>).delete("user-tab");
	});

	it("names the operating agent when a second run hits a busy tab", async () => {
		const navStarted = Promise.withResolvers<void>();
		const navGate = Promise.withResolvers<Record<string, unknown>>();
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-busy", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.eval":
						return { value: "" };
					case "browser.navigate":
						navStarted.resolve();
						return await navGate.promise;
					default:
						return {};
				}
			},
		);

		const agents = makeAgents();
		const browser = await acquireBrowser(
			{ kind: "cmux", socketPath: process.env.CMUX_SOCKET_PATH!, surface: "surface-busy" },
			{ cwd: "/tmp" },
		);
		await acquireTab("shared", browser, {
			timeoutMs: 5_000,
			ownerSessionId: "session-agent-ownership",
			agentId: "Main",
			agentName: "Main",
		});

		const first = runInTab("shared", {
			code: 'await tab.goto("https://example.test");',
			timeoutMs: 30_000,
			session: makeSession("Main", agents),
			agentId: "Main",
			agentName: "Main",
		});
		await navStarted.promise;

		const second = runInTab("shared", {
			code: "1",
			timeoutMs: 5_000,
			session: makeSession("Helper", agents),
			agentId: "Helper",
			agentName: "Helper",
		});
		await expect(second).rejects.toThrow(/Tab "shared" is busy by agent "Main"/);

		navGate.resolve({ url: "https://example.test" });
		await first;
		// The operator marker clears with the run, so the next caller is not
		// blamed on a finished agent.
		expect(getTabsMapForTest().get("shared")?.activeAgentId).toBeUndefined();
	});
});
