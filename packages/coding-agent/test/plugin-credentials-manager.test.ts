/**
 * Tests for the plugin credential manager (backend selection + fallback).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	accountToPluginCredentialId,
	EnvBackend,
	getPluginCredentialManager,
	InMemoryBackend,
	PluginCredentialManager,
	pluginCredentialIdToAccount,
	resetPluginCredentialManager,
	SecureStorageBackend,
} from "@musepi/pi-coding-agent/plugin-credentials";

let testHome: string;
let credDir: string;

afterEach(() => {
	resetPluginCredentialManager();
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("MUSPI_PLUGIN_CRED_")) delete process.env[key];
	}
	if (testHome && existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

function freshHome(): string {
	const home = join(tmpdir(), `plugin-credentials-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	testHome = home;
	credDir = join(home, ".musepi");
	return home;
}

const freshSecureBackend = (): SecureStorageBackend => new SecureStorageBackend({ directory: credDir });

describe("accountToPluginCredentialId / pluginCredentialIdToAccount", () => {
	it("round-trips pluginId alone", () => {
		const id = { pluginId: "github-mcp" };
		expect(accountToPluginCredentialId(pluginCredentialIdToAccount(id))).toEqual(id);
	});

	it("round-trips pluginId + scope + name", () => {
		const id = { pluginId: "notion-mcp", scope: "workspace:ws-123", name: "team-a" };
		expect(accountToPluginCredentialId(pluginCredentialIdToAccount(id))).toEqual(id);
	});

	it("returns null for malformed keys", () => {
		expect(accountToPluginCredentialId("")).toBeNull();
		expect(accountToPluginCredentialId("a::b::c::d")).toBeNull();
	});
});

describe("PluginCredentialManager", () => {
	it("reads from the highest-priority backend that has the credential", async () => {
		freshHome();
		const secure = freshSecureBackend();
		const env = new EnvBackend();
		const mem = new InMemoryBackend();
		const manager = new PluginCredentialManager({ backends: [secure, env, mem] });

		const id = { pluginId: "gh" };
		await manager.set(id, { value: "from-secure" });
		process.env.MUSPI_PLUGIN_CRED_GH = "from-env";

		// Secure (priority 100) wins on the first hit.
		expect((await manager.get(id))?.value).toBe("from-secure");

		// Delete from secure only — env var survives (env backend can't
		// mutate process.env; that's documented).
		expect(await manager.delete(id)).toBe(true);
		expect((await manager.get(id))?.value).toBe("from-env");

		// Clear the env var; nothing left.
		delete process.env.MUSPI_PLUGIN_CRED_GH;
		expect(await manager.get(id)).toBeNull();

		// Now seed the in-memory backend; manager surfaces it as the only
		// available copy.
		await mem.set(id, { value: "from-memory" });
		expect((await manager.get(id))?.value).toBe("from-memory");
	});

	it("falls back to a lower-priority backend when the chosen one refuses to write", async () => {
		freshHome();
		const secure = freshSecureBackend();
		const mem = new InMemoryBackend();
		// Mark secure as unavailable: simulates a read-only mount.
		const unavailable = new (class extends SecureStorageBackend {
			override isAvailable(): Promise<boolean> {
				return Promise.resolve(false);
			}
		})();
		const manager = new PluginCredentialManager({ backends: [unavailable, mem] });

		await manager.set({ pluginId: "gh" }, { value: "token" });
		expect((await mem.get({ pluginId: "gh" }))?.value).toBe("token");
	});

	it("list aggregates unique ids across all backends", async () => {
		freshHome();
		const secure = freshSecureBackend();
		const env = new EnvBackend();
		const mem = new InMemoryBackend();
		const manager = new PluginCredentialManager({ backends: [secure, env, mem] });

		await secure.set({ pluginId: "gh" }, { value: "a" });
		process.env.MUSPI_PLUGIN_CRED_SLACK = "b";
		await mem.set({ pluginId: "notion" }, { value: "c" });

		const ids = await manager.list();
		expect(ids.length).toBe(3);
	});

	it("delete removes from every backend that holds the id (env vars excepted)", async () => {
		freshHome();
		const secure = freshSecureBackend();
		const env = new EnvBackend();
		const mem = new InMemoryBackend();
		const manager = new PluginCredentialManager({ backends: [secure, env, mem] });

		const id = { pluginId: "gh" };
		await secure.set(id, { value: "s" });
		// Only the env-overlay path is mutable: a credential set via `manager.set`
		// on the env backend goes into the overlay, NOT into process.env.
		await env.set(id, { value: "overlay-e" });
		await mem.set(id, { value: "m" });

		expect(await manager.delete(id)).toBe(true);
		expect(await secure.get(id)).toBeNull();
		// Overlay entry is gone, so env backend reports null.
		expect(await env.get(id)).toBeNull();
		expect(await mem.get(id)).toBeNull();

		// Now seed via env var directly and verify manager.delete still leaves
		// it (env vars are externally-owned and out of the manager's reach).
		process.env.MUSPI_PLUGIN_CRED_GH = "process-e";
		expect((await manager.get(id))?.value).toBe("process-e");
		expect(await manager.delete(id)).toBe(false);
		expect((await manager.get(id))?.value).toBe("process-e");
	});

	it("health reports healthy for a clean setup", async () => {
		freshHome();
		const manager = new PluginCredentialManager();
		const status = await manager.health();
		expect(status.healthy).toBe(true);
	});

	it("getPluginCredentialManager returns the same instance on repeated calls", () => {
		freshHome();
		const a = getPluginCredentialManager();
		const b = getPluginCredentialManager();
		expect(a).toBe(b);
	});

	it("resetPluginCredentialManager lets the next call produce a fresh instance", () => {
		freshHome();
		const a = getPluginCredentialManager();
		resetPluginCredentialManager();
		const b = getPluginCredentialManager();
		expect(a).not.toBe(b);
	});
});
