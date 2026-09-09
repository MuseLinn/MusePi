/**
 * Tests for the env-var backend (read-only fallback).
 */

import { afterEach, describe, expect, it } from "bun:test";

import { EnvBackend } from "@musepi/pi-coding-agent/plugin-credentials/backends/env-backend";

const PREFIX = "MUSPI_PLUGIN_CRED_";

afterEach(() => {
	// Strip every key the tests may have set so other suites stay clean.
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(PREFIX)) delete process.env[key];
	}
});

describe("EnvBackend", () => {
	it("returns null when no env var is set", async () => {
		const backend = new EnvBackend();
		expect(await backend.get({ pluginId: "github-mcp" })).toBeNull();
	});

	it("reads a plain plugin credential", async () => {
		process.env[`${PREFIX}GITHUB_MCP`] = "gho_abc";
		const backend = new EnvBackend();
		const cred = await backend.get({ pluginId: "github-mcp" });
		expect(cred).toEqual({ value: "gho_abc", tokenType: "Bearer" });
	});

	it("encodes scope and name into the env var key", async () => {
		process.env[`${PREFIX}NOTION__TEAM_A`] = "secret_a";
		process.env[`${PREFIX}NOTION__TEAM_B`] = "secret_b";
		const backend = new EnvBackend();

		expect(await backend.get({ pluginId: "notion", name: "team-a" })).toEqual({
			value: "secret_a",
			tokenType: "Bearer",
		});
		expect(await backend.get({ pluginId: "notion", name: "team-b" })).toEqual({
			value: "secret_b",
			tokenType: "Bearer",
		});
	});

	it("set writes to the in-memory overlay, not process.env", async () => {
		const backend = new EnvBackend();
		await backend.set({ pluginId: "gh" }, { value: "gho_xyz" });
		expect(process.env[`${PREFIX}GH`]).toBeUndefined();

		const got = await backend.get({ pluginId: "gh" });
		expect(got).toEqual({ value: "gho_xyz" });
	});

	it("overlay entries win over process.env (and delete clears them)", async () => {
		process.env[`${PREFIX}GH`] = "from-env";
		const backend = new EnvBackend();

		await backend.set({ pluginId: "gh" }, { value: "from-overlay" });
		expect((await backend.get({ pluginId: "gh" }))?.value).toBe("from-overlay");

		await backend.delete({ pluginId: "gh" });
		expect((await backend.get({ pluginId: "gh" }))?.value).toBe("from-env");
	});

	it("list enumerates both env and overlay credentials without duplicates", async () => {
		process.env[`${PREFIX}GH`] = "a";
		process.env[`${PREFIX}NOTION`] = "b";
		const backend = new EnvBackend();
		await backend.set({ pluginId: "slack" }, { value: "c" });

		const ids = await backend.list();
		expect(ids.length).toBe(3);
	});

	it("filter narrows by pluginId, scope, and name", async () => {
		process.env[`${PREFIX}GH`] = "a";
		process.env[`${PREFIX}GH__WS_1`] = "b";
		process.env[`${PREFIX}NOTION__WS_1__TEAM_A`] = "c";
		const backend = new EnvBackend();

		// Env-var keys map non-alphanumerics (including `:`) to `_`, so the
		// round-tripped scope for `workspace:ws-1` is `ws_1`. The plugin layer
		// that minted the env var is responsible for picking a scope that
		// round-trips, or the lookup fails on the colon-bearing canonical form.
		const ws1 = await backend.list({ scope: "ws_1" });
		expect(ws1.length).toBe(2);
		const teamA = await backend.list({ pluginId: "notion", name: "team_a" });
		expect(teamA.length).toBe(1);
		expect(teamA[0]?.pluginId).toBe("notion");
	});
});
