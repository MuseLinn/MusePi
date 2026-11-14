const { describe, expect, it } = require("bun:test");

// The lookup never reaches Electron; skip the one-time scheme hook.
process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = "1";
const { ManagedBrowserController } = require("../electron/managed-browser.cjs");

function fakeConn() {
	const events = [];
	return {
		events,
		conn: {
			id: 1,
			discover: false,
			autoAttach: false,
			sessions: new Map(),
			ws: { write: frame => events.push(JSON.parse(frame.subarray(2).toString())) },
		},
	};
}

function lastReply(events) {
	return events[events.length - 1];
}

/** Renderer-facing pushes, so "lookup only" is asserted at the boundary. */
function fakeOwner() {
	const sent = [];
	return {
		sent,
		owner: {
			isDestroyed: () => false,
			webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
		},
	};
}

function controllerWithTabs(tabs) {
	const controller = new ManagedBrowserController();
	for (const tab of tabs) controller.tabs.set(String(tab.id), tab);
	return controller;
}

describe("managed browser findTabTarget", () => {
	it("matches an open tab by url, case-insensitively, without touching the renderer", async () => {
		const controller = controllerWithTabs([
			{ id: "local-1", url: "https://Example.com/Docs", title: "Home" },
			{ id: "local-2", url: "https://example.org/other", title: "Other" },
		]);
		const { sent, owner } = fakeOwner();
		controller.owner = owner;
		const { conn, events } = fakeConn();
		await controller.route(conn, { id: 1, method: "ManagedBrowser.findTabTarget", params: { target: "EXAMPLE.COM/docs" } });
		expect(lastReply(events).result).toEqual({ targetId: "PAGElocal-1" });
		expect(sent).toEqual([]);
		expect(controller.activeTabId).toBeNull();
	});

	it("matches an open tab by title", async () => {
		const controller = controllerWithTabs([
			{ id: "local-1", url: "https://example.com/", title: "Release Notes" },
		]);
		const { conn, events } = fakeConn();
		await controller.route(conn, { id: 1, method: "ManagedBrowser.findTabTarget", params: { target: "release notes" } });
		expect(lastReply(events).result).toEqual({ targetId: "PAGElocal-1" });
	});

	it("replies null when nothing matches, without selecting or creating a tab", async () => {
		const controller = controllerWithTabs([{ id: "local-1", url: "https://example.com/", title: "Example" }]);
		const { conn, events } = fakeConn();
		await controller.route(conn, { id: 1, method: "ManagedBrowser.findTabTarget", params: { target: "missing" } });
		expect(lastReply(events).result).toEqual({ targetId: null });
		expect(controller.tabs.size).toBe(1);
		expect(controller.activeTabId).toBeNull();
		expect(controller.agentTabId).toBeNull();
	});

	it("treats an empty target as no match", async () => {
		const controller = controllerWithTabs([{ id: "local-1", url: "https://example.com/", title: "Example" }]);
		const { conn, events } = fakeConn();
		await controller.route(conn, { id: 1, method: "ManagedBrowser.findTabTarget", params: { target: "  " } });
		expect(lastReply(events).result).toEqual({ targetId: null });
	});

	it("never adopts a tab the CDP discovery hides", async () => {
		const controller = controllerWithTabs([{ id: "local-1", url: "chrome://settings", title: "Settings" }]);
		const { conn, events } = fakeConn();
		await controller.route(conn, { id: 1, method: "ManagedBrowser.findTabTarget", params: { target: "settings" } });
		expect(lastReply(events).result).toEqual({ targetId: null });
	});
});
