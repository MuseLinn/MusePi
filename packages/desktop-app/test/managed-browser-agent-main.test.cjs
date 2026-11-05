const { afterAll, afterEach, describe, expect, it } = require("bun:test");

const PARTITION_STORAGE = "/managed-browser-partition";
const GUEST_WEB_CONTENTS_ID = 42;
const sent = [];

function managedGuest() {
	return {
		isDestroyed: () => false,
		session: { getStoragePath: () => PARTITION_STORAGE },
		setWindowOpenHandler() {},
		on() {},
		once() {},
		isLoading: () => false,
		getURL: () => "about:blank",
		getTitle: () => "",
		getUserAgent: () => "MusePiTest/1.0",
		setUserAgent() {},
		setZoomFactor() {},
		debugger: {
			attach() {},
			isAttached: () => false,
			detach() {},
			on() {},
			sendCommand: async () => ({}),
		},
		destroy() {},
	};
}

const guest = managedGuest();
const electron = {
	app: { getPath: () => "system-downloads" },
	dialog: {},
	ipcMain: { handle() {} },
	net: {},
	protocol: { registerSchemesAsPrivileged() {} },
	session: {
		fromPartition: () => ({
			getStoragePath: () => PARTITION_STORAGE,
			setPermissionRequestHandler() {},
			protocol: { handle() {} },
			on() {},
		}),
	},
	shell: {},
	webContents: { fromId: id => (id === GUEST_WEB_CONTENTS_ID ? guest : null) },
};

const previousSchemesRegistered = process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED;
process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = "1";
const electronPath = require.resolve("electron");
const managedBrowserPath = require.resolve("../electron/managed-browser.cjs");
const cachedModules = new Map([[electronPath, require.cache[electronPath]]]);
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };
delete require.cache[managedBrowserPath];
const { ManagedBrowserController } = require(managedBrowserPath);

afterEach(() => {
	sent.length = 0;
});

afterAll(() => {
	for (const [modulePath, cached] of cachedModules) {
		if (cached) require.cache[modulePath] = cached;
		else delete require.cache[modulePath];
	}
	if (previousSchemesRegistered === undefined) delete process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED;
	else process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = previousSchemesRegistered;
});

function createController() {
	const controller = new ManagedBrowserController();
	controller.setOwner({
		isDestroyed: () => false,
		on() {},
		webContents: {
			on() {},
			send: (channel, payload) => {
				sent.push({ channel, payload });
				if (channel === "managed-browser:create-tab") {
					queueMicrotask(() =>
						controller.handleGuestReady({
							tabId: payload.tabId,
							webContentsId: GUEST_WEB_CONTENTS_ID,
						}),
					);
				}
			},
		},
	});
	controller.handleHostReady();
	return controller;
}

function createPush(tabId) {
	return sent.find(entry => entry.channel === "managed-browser:create-tab" && entry.payload.tabId === tabId);
}

function cdpConn(controller) {
	const replies = [];
	// Transport framing is covered elsewhere; this harness records the JSON-RPC
	// replies the bridge produces.
	controller.send = (_conn, payload) => replies.push(JSON.parse(payload));
	return { conn: { id: 1, sessions: new Map(), ws: {} }, replies };
}

describe("managed browser agent attribution in main", () => {
	it("publishes the creating agent on the create push and the activity ledger", async () => {
		const controller = createController();
		const tab = await controller.createTab("https://example.test/", true, {
			id: "Helper",
			name: "Helper Bot",
		});
		const id = String(tab.id);

		expect(tab.agentId).toBe("Helper");
		expect(tab.agentName).toBe("Helper Bot");
		expect(createPush(id).payload).toEqual({
			tabId: id,
			url: "https://example.test/",
			agentId: "Helper",
			agentName: "Helper Bot",
		});
		expect(controller.state().activity).toMatchObject({
			tabId: id,
			action: "open",
			agentId: "Helper",
			agentName: "Helper Bot",
		});
		controller.releaseTabs();
	});

	it("keeps user-tab payloads and ledger rows free of agent fields", async () => {
		const controller = createController();
		const tab = await controller.createTab("https://user.test/", false);
		const id = String(tab.id);

		expect(tab.agentId).toBeNull();
		expect(Object.hasOwn(createPush(id).payload, "agentId")).toBe(false);
		expect(Object.hasOwn(createPush(id).payload, "agentName")).toBe(false);
		const activity = controller.state().activity;
		expect(Object.hasOwn(activity, "agentId")).toBe(false);
		expect(Object.hasOwn(activity, "agentName")).toBe(false);
		controller.releaseTabs();
	});

	it("attributes the dedicated agent tab from ManagedBrowser.ensureAgentTab params", async () => {
		const controller = createController();
		const { conn, replies } = cdpConn(controller);

		await controller.handleBrowserCommand(conn, {
			id: 7,
			method: "ManagedBrowser.ensureAgentTab",
			params: { agentId: "Scout", agentName: "Scout" },
		});

		const id = String(controller.agentTabId);
		expect(replies.at(-1)).toMatchObject({ id: 7, result: { targetId: `PAGE${id}` } });
		expect(createPush(id).payload).toMatchObject({ agentId: "Scout", agentName: "Scout" });
		expect(controller.state().activity).toMatchObject({
			tabId: id,
			agentId: "Scout",
			agentName: "Scout",
		});

		// A later caller can be the first to publish the display name.
		await controller.handleBrowserCommand(conn, {
			id: 8,
			method: "ManagedBrowser.ensureAgentTab",
			params: { agentId: "Scout", agentName: "Scout Renamed" },
		});
		expect(controller.tabs.get(id).agentName).toBe("Scout Renamed");
		controller.releaseTabs();
	});

	it("attributes a CDP Target.createTarget tab from its params", async () => {
		const controller = createController();
		const { conn, replies } = cdpConn(controller);

		await controller.handleBrowserCommand(conn, {
			id: 9,
			method: "Target.createTarget",
			params: { url: "https://agent.test/", agentId: "Writer", agentName: "Writer Bot" },
		});

		const id = String(controller.agentTabId);
		expect(replies.at(-1)).toMatchObject({ id: 9, result: { targetId: `PAGE${id}` } });
		expect(createPush(id).payload).toMatchObject({
			url: "https://agent.test/",
			agentId: "Writer",
			agentName: "Writer Bot",
		});
		expect(controller.state().activity).toMatchObject({
			tabId: id,
			action: "navigate",
			agentId: "Writer",
			agentName: "Writer Bot",
		});
		controller.releaseTabs();
	});
});
