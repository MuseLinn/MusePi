import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * Daemon RPC contract for the model catalog, provider login, preset and GitHub
 * account surfaces: every route must reach its service through the dispatcher.
 *
 * The host stub returns no model registry, so provider login reports its
 * documented "no registry yet" error and the catalog routes return their empty
 * shapes — exactly what the GUI renders before a session exists. Preset reads
 * and writes go to a temp modes directory, never the user's.
 */

const modesDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-modes-"));
const previousModesDir = process.env.MUSEPI_MODES_DIR;
process.env.MUSEPI_MODES_DIR = modesDir;

afterAll(() => {
	if (previousModesDir === undefined) delete process.env.MUSEPI_MODES_DIR;
	else process.env.MUSEPI_MODES_DIR = previousModesDir;
	fs.rmSync(modesDir, { recursive: true, force: true });
});

function makeHarness() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-presets-cwd-"));
	const host = {
		cwd: () => cwd,
		get: () => undefined,
		ensureRegistry: async () => null,
		// ExtensionService reads this synchronously when presets list plugins.
		settings: () => ({ get: () => undefined, getRaw: () => undefined }),
		snapshot: async () => ({ entries: [], state: {} }),
		// DaemonServer wires these on construction; the stub host ignores them.
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test", send: () => {} } as DaemonConnection;
	const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		server.handle(method, params, conn);
	return { cwd, rpc };
}

describe("models.* RPCs", () => {
	test("an empty catalog surfaces as empty rows, not an error", async () => {
		const { rpc } = makeHarness();
		expect(await rpc("models.listAvailable")).toEqual([]);
		expect(await rpc("models.catalog")).toEqual([]);
		expect(await rpc("models.detail", { id: "any/model" })).toBeNull();
		expect(await rpc("models.refreshRuntime")).toEqual({ refreshed: false });
	});

	test("models.detail still requires an id", async () => {
		const { rpc } = makeHarness();
		await expect(rpc("models.detail", {})).rejects.toThrow(/model id required/);
	});
});

describe("providers.* RPCs", () => {
	test("login and catalog reads report the missing registry", async () => {
		const { rpc } = makeHarness();
		await expect(rpc("providers.list")).rejects.toThrow(/No model registry yet/);
		await expect(rpc("providers.login", { providerId: "anthropic" })).rejects.toThrow(/No model registry yet/);
	});

	test("loginInput without a pending login is a clean error", async () => {
		const { rpc } = makeHarness();
		await expect(rpc("providers.loginInput", { providerId: "nope", value: "x" })).rejects.toThrow(/No pending login/);
	});

	test("testConnection validates its inputs before any network call", async () => {
		const { rpc } = makeHarness();
		await expect(rpc("providers.testConnection", { modelId: "m" })).rejects.toThrow(/baseUrl required/);
	});
});

describe("presets RPCs", () => {
	test("modes.list seeds the built-in presets in the configured directory", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("modes.list")) as { modesDir: string; modes: Array<{ id: string; builtin: boolean }> };
		expect(res.modesDir).toBe(modesDir);
		const ids = res.modes.map(mode => mode.id);
		expect(ids).toContain("work");
		expect(res.modes.filter(mode => mode.builtin).length).toBeGreaterThan(0);
	});

	test("save → get → delete round-trips a custom preset", async () => {
		const { rpc } = makeHarness();
		await rpc("modes.save", { id: "roundtrip-check", label: "Roundtrip", settings: {} });
		const read = (await rpc("modes.get", { id: "roundtrip-check" })) as { id: string; label: string };
		expect(read.id).toBe("roundtrip-check");
		expect(read.label).toBe("Roundtrip");
		expect(await rpc("modes.validate", { id: "roundtrip-check" })).toEqual({ valid: true });
		expect(await rpc("modes.delete", { id: "roundtrip-check" })).toEqual({ ok: true });
		await expect(rpc("modes.get", { id: "roundtrip-check" })).rejects.toThrow(/Unknown mode/);
	});

	test("a built-in preset rejects authoring writes", async () => {
		const { rpc } = makeHarness();
		await expect(rpc("modes.save", { id: "work" })).rejects.toThrow(/built-in preset/);
		await expect(rpc("modes.delete", { id: "work" })).rejects.toThrow(/built-in preset/);
	});

	test("agentPresets.list reads the same sources as modes.list", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("agentPresets.list")) as { presets: Array<{ id: string; source: string }> };
		expect(res.presets.some(preset => preset.id === "work" && preset.source === "file")).toBe(true);
	});
});

describe("github.accountList RPC", () => {
	test("returns the masked account rows the settings pane renders", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("github.accountList")) as { accounts: unknown[] };
		expect(Array.isArray(res.accounts)).toBe(true);
	});
});
