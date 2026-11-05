const { afterAll, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlers = new Map();
const invokes = [];
const exposed = {};
const openedPaths = [];
const storageCalls = [];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-managed-downloads-"));
let storageError = null;
let captureError = null;
let saveDialogResult = { canceled: true };
const electron = {
	app: { getPath: () => "system-downloads" },
	contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
	dialog: { showSaveDialog: async () => saveDialogResult },
	ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
	ipcRenderer: {
		invoke: async (channel, ...args) => {
			invokes.push({ channel, args });
			return { ok: true };
		},
		on() {},
		removeListener() {},
		send() {},
	},
	net: {},
	protocol: { registerSchemesAsPrivileged() {} },
	session: {
		fromPartition: () => ({
			clearCache: async () => storageCalls.push({ kind: "cache" }),
			clearStorageData: async options => {
				if (storageError) throw storageError;
				storageCalls.push({ kind: "storage", options });
			},
		}),
	},
	shell: { openPath: async target => { openedPaths.push(target); return ""; } },
	webContents: { fromId: () => null },
	webUtils: { getPathForFile: () => "" },
};

const previousSchemesRegistered = process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED;
process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = "1";
const electronPath = require.resolve("electron");
const managedBrowserPath = require.resolve("../electron/managed-browser.cjs");
const preloadPath = require.resolve("../electron/preload.cjs");
const cachedModules = new Map(
	[electronPath, managedBrowserPath, preloadPath].map(modulePath => [modulePath, require.cache[modulePath]]),
);
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };
delete require.cache[managedBrowserPath];
delete require.cache[preloadPath];
const { ManagedBrowserController } = require(managedBrowserPath);
require(preloadPath);

afterAll(() => {
	for (const [modulePath, cached] of cachedModules) {
		if (cached) require.cache[modulePath] = cached;
		else delete require.cache[modulePath];
	}
	if (previousSchemesRegistered === undefined) delete process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED;
	else process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = previousSchemesRegistered;
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function handler(channel) {
	const registered = handlers.get(channel);
	expect(typeof registered).toBe("function");
	return registered;
}

describe("managed browser menu IPC", () => {
	it("routes clear-data through the shared partition cleanup", async () => {
		const controller = new ManagedBrowserController();
		controller.registerIpc();

		expect(await handler("managed-browser:clear-data")({}, { mode: "cookies" })).toEqual({ ok: true });
		expect(storageCalls).toEqual([
			{
				kind: "storage",
				options: { storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"] },
			},
		]);
	});

	it("returns native clear-data error details through IPC", async () => {
		const controller = new ManagedBrowserController();
		controller.registerIpc();
		storageError = new Error("storage denied");
		try {
			expect(await handler("managed-browser:clear-data")({}, { mode: "cookies" })).toEqual({
				ok: false,
				error: "storage denied",
			});
		} finally {
			storageError = null;
		}
	});

	it("prints the requested guest and maps the native callback result", async () => {
		const printCalls = [];
		const controller = new ManagedBrowserController();
		controller.tabs.set("print-page", {
			wc: {
				isDestroyed: () => false,
				print: (options, callback) => {
					printCalls.push(options);
					callback(true);
				},
			},
		});
		controller.registerIpc();

		expect(await handler("managed-browser:print")({}, { tabId: "print-page" })).toEqual({ ok: true });
		expect(printCalls).toEqual([{}]);
	});

	it("opens the configured download directory and reports shell failures", async () => {
		const controller = new ManagedBrowserController();
		controller.preferences.download.dir = "custom-downloads";
		controller.registerIpc();

		expect(await handler("managed-browser:show-downloads")({})).toEqual({ ok: true });
		expect(openedPaths).toEqual(["custom-downloads"]);
	});

	it("creates a missing configured download directory before opening it", async () => {
		const controller = new ManagedBrowserController();
		const target = path.join(tempRoot, "nested", "downloads");
		controller.preferences.download.dir = target;
		controller.registerIpc();

		expect(fs.existsSync(target)).toBe(false);
		expect(await handler("managed-browser:show-downloads")({})).toEqual({ ok: true });
		expect(fs.statSync(target).isDirectory()).toBe(true);
		expect(openedPaths.at(-1)).toBe(target);
	});

	function controllerWithScreenshot() {
		const controller = new ManagedBrowserController();
		controller.preferences.download.dir = path.join(tempRoot, "screenshots");
		controller.preferences.download.askWhereToSave = false;
		controller.tabs.set("shot-page", {
			title: "Example",
			wc: {
				isDestroyed: () => false,
				capturePage: async () => {
					if (captureError) throw captureError;
					return { toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
				},
			},
		});
		controller.registerIpc();
		return controller;
	}

	it("writes a real PNG through save-screenshot using the configured download policy", async () => {
		const controller = controllerWithScreenshot();
		const target = path.join(tempRoot, "screenshots", "Example.png");

		expect(await handler("managed-browser:save-screenshot")({}, { tabId: "shot-page" })).toEqual({
			ok: true,
			path: target,
		});
		expect([...fs.readFileSync(target)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it("reports screenshot cancellation without changing the real PNG", async () => {
		const controller = controllerWithScreenshot();
		const target = path.join(tempRoot, "screenshots", "Example.png");
		expect((await handler("managed-browser:save-screenshot")({}, { tabId: "shot-page" })).ok).toBe(true);
		const before = fs.readFileSync(target);

		controller.preferences.download.askWhereToSave = true;
		saveDialogResult = { canceled: true };
		expect(await handler("managed-browser:save-screenshot")({}, { tabId: "shot-page" })).toEqual({
			ok: false,
			canceled: true,
		});
		expect(fs.readFileSync(target)).toEqual(before);
	});

	it("returns native screenshot capture failures", async () => {
		const controller = controllerWithScreenshot();
		captureError = new Error("capture denied");
		try {
			expect(await handler("managed-browser:save-screenshot")({}, { tabId: "shot-page" })).toEqual({
				ok: false,
				error: "capture denied",
			});
		} finally {
			captureError = null;
		}
	});
});

describe("managed browser menu preload", () => {
	it("forwards print and download requests to their dedicated channels", async () => {
		const api = exposed.electronAPI;
		await api.managedBrowserPrint({ tabId: "print-page" });
		await api.managedBrowserShowDownloads();
		await api.managedBrowserSaveScreenshot({ tabId: "shot-page" });

		expect(invokes).toEqual([
			{ channel: "managed-browser:print", args: [{ tabId: "print-page" }] },
			{ channel: "managed-browser:show-downloads", args: [] },
			{ channel: "managed-browser:save-screenshot", args: [{ tabId: "shot-page" }] },
		]);
	});
});
