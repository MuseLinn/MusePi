const { afterAll, afterEach, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-browser-record-ipc-"));
const recordsFile = path.join(tempRoot, "profile", "records.json");
const electron = {
	app: { getPath: name => name === "downloads" ? path.join(tempRoot, "downloads") : path.join(tempRoot, "profile") },
	contextBridge: { exposeInMainWorld() {} },
	dialog: {},
	ipcMain: { handle() {} },
	ipcRenderer: { invoke: async () => ({ ok: true }), on() {}, removeListener() {}, send() {} },
	net: {},
	protocol: { registerSchemesAsPrivileged() {} },
	session: { fromPartition: () => ({ getStoragePath: () => "managed-test", on() {} }) },
	shell: {},
	webContents: { fromId: () => null },
	webUtils: { getPathForFile: () => "" },
};
const electronPath = require.resolve("electron");
const managedBrowserPath = require.resolve("../electron/managed-browser.cjs");
const cachedElectron = require.cache[electronPath];
const cachedBrowser = require.cache[managedBrowserPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };
delete require.cache[managedBrowserPath];
const { ManagedBrowserController } = require(managedBrowserPath);
const controllers = [];

afterEach(async () => {
	for (const controller of controllers.splice(0)) await controller.closeServer();
});

afterAll(() => {
	if (cachedElectron) require.cache[electronPath] = cachedElectron;
	else delete require.cache[electronPath];
	if (cachedBrowser) require.cache[managedBrowserPath] = cachedBrowser;
	else delete require.cache[managedBrowserPath];
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function controller() {
	const instance = new ManagedBrowserController({ recordsFile });
	controllers.push(instance);
	instance.owner = { isDestroyed: () => false, webContents: { send() {} } };
	instance.waitForHostReady = async () => true;
	return instance;
}

function guest() {
	const listeners = new Map();
	return {
		listeners,
		session: { getStoragePath: () => "managed-test" },
		debugger: {},
		setWindowOpenHandler() {},
		on(name, handler) { listeners.set(name, handler); },
		once(name, handler) { listeners.set(name, handler); },
		isDestroyed: () => false,
		isLoading: () => true,
		getURL: () => "https://example.test/",
		getTitle: () => "Fixture",
		getUserAgent: () => "FixtureAgent",
		setUserAgent() {},
		setZoomFactor() {},
	};
}

function downloadItem() {
	const listeners = new Map();
	let savePath = "";
	let received = 0;
	return {
		listeners,
		getFilename: () => "file.zip",
		getURL: () => "https://example.test/file.zip",
		getTotalBytes: () => 100,
		getReceivedBytes: () => received,
		getSavePath: () => savePath,
		setSavePath: value => { savePath = value; },
		on(name, handler) { listeners.set(name, handler); },
		once(name, handler) { listeners.set(name, handler); },
		cancel() {},
		progress(value) {
			received = value;
			listeners.get("updated")?.({}, "progressing");
		},
		complete() {
			received = 100;
			listeners.get("done")?.({}, "completed");
		},
	};
}

describe("managed browser history and downloads", () => {
	it("records committed navigation and download settlement and reloads through loopback", async () => {
		const first = controller();
		const creating = first.createTab("https://example.test/", false);
		await Bun.sleep(0);
		const tab = first.tabs.get("1");
		const wc = guest();
		tab.bindGuest(wc);
		await creating;
		wc.listeners.get("did-finish-load")?.({});
		wc.listeners.get("did-navigate")?.({}, "https://user:pass@example.test/older");
		wc.listeners.get("did-navigate-in-page")?.({}, "https://example.test/newer");
		const item = downloadItem();
		first.preferences.download.askWhereToSave = false;
		first.handleWillDownload(item, wc);
		item.progress(40);
		item.complete();
		expect(first.recordStore.history().map(record => record.url)).toEqual([
			"https://example.test/newer",
			"https://example.test/older",
			"https://example.test/",
		]);
		expect(first.recordStore.downloads()[0]).toMatchObject({
			status: "completed",
			receivedBytes: 100,
			totalBytes: 100,
		});
		expect(first.recordStore.downloads()[0].savePath).toContain("file.zip");

		const port = await first.startServer();
		expect(port).not.toBeNull();
		const history = await fetch(`http://127.0.0.1:${port}/musepi/history`).then(response => response.json());
		const downloads = await fetch(`http://127.0.0.1:${port}/musepi/downloads`).then(response => response.json());
		expect(history[0].url).toBe("https://example.test/newer");
		expect(history.every(record => !record.url.includes("user:pass"))).toBe(true);
		expect(downloads[0].status).toBe("completed");

		const reloaded = new ManagedBrowserController({ recordsFile });
		expect(reloaded.recordStore.history()).toEqual(first.recordStore.history());
		expect(reloaded.recordStore.downloads()).toEqual(first.recordStore.downloads());
	});
});
