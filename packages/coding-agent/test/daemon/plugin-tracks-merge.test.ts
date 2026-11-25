/**
 * `plugin_manager` sees both plugin tracks.
 *
 * The model-facing list used to be built from the profile composition alone, so
 * a package installed the Track B way (a `musepi.extensions` manifest plus a
 * `musepi-plugins.lock.json` entry) installed, ran, and never appeared in
 * `list_plugins`. Worse, toggling one by name reached the cordis writer, which
 * answered "a conditional row cannot be toggled" — an explanation for a row
 * that was never a composition row at all.
 *
 * The whole config root is redirected with `PI_CONFIG_DIR`, not just `HOME`:
 * `PluginManager` resolves the plugins tree through `getPluginsDir()`, which
 * reads the config root and ignores a `home` argument. Redirecting only `HOME`
 * left the toggle writing the developer's real lockfile.
 *
 * A regression means: an installed extension package is missing from the list,
 * `set_plugin` writes the profile patch for it instead of the lockfile, or an
 * unknown id reports a specific wrong diagnosis instead of "unknown row".
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests } from "@musepi/pi-utils";
import { DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

const EXTENSION_PACKAGE = "@demo/track-b";

let configRoot: string;
let cwd: string;
let previousConfigDir: string | undefined;
let settings: Settings;

function noop(): void {}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function lockfile(): string {
	return path.join(configRoot, "plugins", "musepi-plugins.lock.json");
}

function readLock(): { plugins: Record<string, { enabled?: boolean }> } {
	return JSON.parse(fs.readFileSync(lockfile(), "utf8")) as {
		plugins: Record<string, { enabled?: boolean }>;
	};
}

function makeServer(): DaemonServer {
	const host = {
		cwd: () => cwd,
		get: () => undefined,
		allSessions: () => [],
		ensureRegistry: async () => null,
		settings: () => settings,
		snapshot: async () => ({ entries: [], state: {} }),
		setCollabToolProvider: noop,
		setScheduledTaskProvider: noop,
		setPluginManagementProvider: noop,
		setOnExtensionNotification: noop,
		setMcpAuthFlow: noop,
		setConnectorConnectPort: noop,
		setSessionConnectors: noop,
		setEditorDraft: noop,
	} as unknown as DaemonSessionHost;
	return new DaemonServer(host);
}

beforeEach(() => {
	configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-tracks-root-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-tracks-cwd-"));
	previousConfigDir = process.env.PI_CONFIG_DIR;
	process.env.PI_CONFIG_DIR = configRoot;
	// The resolver caches its roots on first read; rebuild them so this suite's
	// config root is the one every `getPluginsDir()` call resolves.
	__resetDirsFromEnvForTests();
	settings = Settings.isolated();

	const pluginsRoot = path.join(configRoot, "plugins");
	writeJson(path.join(pluginsRoot, "node_modules", EXTENSION_PACKAGE, "package.json"), {
		name: EXTENSION_PACKAGE,
		version: "1.0.0",
		musepi: { extensions: ["./index.ts"] },
	});
	fs.writeFileSync(
		path.join(pluginsRoot, "node_modules", EXTENSION_PACKAGE, "index.ts"),
		"export default function (): void {}\n",
		"utf8",
	);
	writeJson(lockfile(), {
		plugins: { [EXTENSION_PACKAGE]: { version: "1.0.0", enabled: true, enabledFeatures: null } },
	});
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = previousConfigDir;
	__resetDirsFromEnvForTests();
	fs.rmSync(configRoot, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("plugin_manager across both tracks", () => {
	it("lists an installed extension package the composition never mentions", async () => {
		const handle = makeServer().pluginManagementHandle();
		expect(handle).not.toBeNull();
		const rows = await handle!.listPlugins();
		const row = rows.find(entry => entry.name === EXTENSION_PACKAGE);
		expect(row).toBeDefined();
		expect(row?.track).toBe("extension");
		expect(row?.state).toBe("enabled");
		expect(row?.id).toBe(EXTENSION_PACKAGE);
	});

	it("toggles an extension row through the lockfile that owns it", async () => {
		const handle = makeServer().pluginManagementHandle();
		const result = await handle!.setPlugin(EXTENSION_PACKAGE, false);
		expect(result.ok).toBe(true);
		expect(readLock().plugins[EXTENSION_PACKAGE]?.enabled).toBe(false);
		const row = (await handle!.listPlugins()).find(entry => entry.name === EXTENSION_PACKAGE);
		expect(row?.state).toBe("disabled");
	});

	it("reports an unknown id as unknown instead of diagnosing a conditional row", async () => {
		const handle = makeServer().pluginManagementHandle();
		const result = await handle!.setPlugin("@demo/never-installed", false);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("unknown plugin row");
		expect(result.nextStep ?? "").not.toContain("conditional");
	});
});
