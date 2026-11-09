const { afterAll, beforeEach, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlers = new Map();
const loaded = [];
const removed = [];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-managed-extensions-"));
const extensionDir = path.join(tempRoot, "fixture-extension");
const recordsFile = path.join(tempRoot, "userData", "managed-browser-extensions.json");
const manifest = {
	manifest_version: 2,
	name: "Fixture extension",
	version: "1.0.0",
	permissions: ["tabs", "storage"],
};

const mockSession = {
	loadExtension: async dir => {
		loaded.push(dir);
		return { id: "fixture-id", name: manifest.name, version: manifest.version };
	},
	removeExtension: id => removed.push(id),
	getAllExtensions: () => loaded.map(dir => ({ id: "fixture-id", name: manifest.name, version: manifest.version })),
};
const electron = {
	app: { getPath: () => path.join(tempRoot, "userData") },
	dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [extensionDir] }) },
	ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
	protocol: { registerSchemesAsPrivileged() {} },
	session: { fromPartition: () => mockSession },
};

const electronPath = require.resolve("electron");
const managedBrowserPath = require.resolve("../electron/managed-browser.cjs");
const cachedElectron = require.cache[electronPath];
const cachedController = require.cache[managedBrowserPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };

function handler(channel) {
	const registered = handlers.get(channel);
	expect(typeof registered).toBe("function");
	return registered;
}

beforeEach(() => {
	loaded.length = 0;
	removed.length = 0;
	handlers.clear();
	fs.rmSync(extensionDir, { recursive: true, force: true });
	fs.mkdirSync(extensionDir, { recursive: true });
	fs.writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest));
	fs.rmSync(recordsFile, { force: true });
});

afterAll(() => {
	if (cachedElectron) require.cache[electronPath] = cachedElectron;
	else delete require.cache[electronPath];
	if (cachedController) require.cache[managedBrowserPath] = cachedController;
	else delete require.cache[managedBrowserPath];
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function controller() {
	delete require.cache[managedBrowserPath];
	const { ManagedBrowserController } = require(managedBrowserPath);
	const instance = new ManagedBrowserController();
	instance.registerIpc();
	return instance;
}

describe("managed browser extensions", () => {
	it("requires a valid unpacked manifest and permission confirmation before loading", async () => {
		const instance = controller();
		const chosen = await handler("managed-browser:extensions-choose")({});
		expect(chosen.candidate).toMatchObject({
			name: "Fixture extension",
			version: "1.0.0",
			permissions: ["tabs", "storage"],
		});
		expect(loaded).toEqual([]);
		await expect(handler("managed-browser:extensions-install")({}, { confirmed: false })).rejects.toThrow(
			/confirmation/i,
		);
		expect(loaded).toEqual([]);

		fs.writeFileSync(path.join(extensionDir, "manifest.json"), "{bad json");
		await expect(handler("managed-browser:extensions-choose")({})).rejects.toThrow();
	});

	it("installs the reviewed directory without opening a second picker", async () => {
		const instance = controller();
		const choose = instance.chooseExtension.bind(instance);
		let chooseCalls = 0;
		instance.chooseExtension = async () => {
			chooseCalls += 1;
			return choose();
		};
		await handler("managed-browser:extensions-choose")({});
		const installed = await handler("managed-browser:extensions-install")({}, { confirmed: true });
		expect(installed.ok).toBe(true);
		expect(loaded).toEqual([extensionDir]);
		expect(chooseCalls).toBe(1);
		const listed = await handler("managed-browser:extensions-list")({});
		expect(listed.extensions).toHaveLength(1);
		expect(listed.extensions[0]).toMatchObject({ id: "fixture-id", name: "Fixture extension", version: "1.0.0" });

		const duplicate = await handler("managed-browser:extensions-install")({}, { confirmed: true });
		expect(duplicate.alreadyInstalled).toBe(true);
		expect(loaded).toHaveLength(1);
		expect(chooseCalls).toBe(1);
	});

	it("removes the extension without deleting the source directory", async () => {
		const instance = controller();
		await handler("managed-browser:extensions-choose")({});
		await handler("managed-browser:extensions-install")({}, { confirmed: true });
		const result = await handler("managed-browser:extensions-remove")({}, { id: "fixture-id" });
		expect(result.ok).toBe(true);
		expect(removed).toEqual(["fixture-id"]);
		expect(fs.existsSync(path.join(extensionDir, "manifest.json"))).toBe(true);
		expect(JSON.parse(fs.readFileSync(recordsFile, "utf8"))).toEqual([]);
	});

	it("restores valid records and reports startup load failures without phantom rows", async () => {
		const instance = controller();
		await handler("managed-browser:extensions-choose")({});
		await handler("managed-browser:extensions-install")({}, { confirmed: true });
		loaded.length = 0;
		await instance.loadPersistedExtensions();
		expect(loaded).toEqual([extensionDir]);

		fs.rmSync(extensionDir, { recursive: true, force: true });
		loaded.length = 0;
		mockSession.loadExtension = async dir => {
			throw new Error(`missing ${dir}`);
		};
		await instance.loadPersistedExtensions();
		const listed = await handler("managed-browser:extensions-list")({});
		expect(listed.extensions).toEqual([]);
		expect(listed.errors).toHaveLength(1);
		expect(listed.errors[0]).toContain("missing");
	});
});
