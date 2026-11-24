import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConfigValue } from "@musepi/pi-coding-agent/config/resolve-config-value";
import { AgentSecretStore } from "@musepi/pi-coding-agent/secrets/agent-store";
import { getAgentDir, setAgentDir } from "@musepi/pi-utils/dirs";

const original = getAgentDir();

afterAll(() => {
	setAgentDir(original);
});

describe("vault references in MCP config values", () => {
	it("resolves the whole value from the agent secret store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-mcp-vault-"));
		setAgentDir(dir);
		const store = new AgentSecretStore(dir);
		await store.set("MCP_TOKEN", "abc/def", "an MCP server");

		expect(await resolveConfigValue("${vault:MCP_TOKEN}", { cwd: dir })).toBe("abc/def");
		expect(await resolveConfigValue("${vault:MCP_MISSING}", { cwd: dir })).toBeUndefined();
	});

	it("refuses a workspace-scoped value outside its workspace", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-mcp-vault-"));
		setAgentDir(dir);
		const store = new AgentSecretStore(dir);
		const workspace = resolve(dir, "project");
		await store.set("MCP_TOKEN", "abc/def", "an MCP server", [workspace]);

		expect(await resolveConfigValue("${vault:MCP_TOKEN}", { cwd: dir })).toBeUndefined();
		expect(await resolveConfigValue("${vault:MCP_TOKEN}", { cwd: workspace })).toBe("abc/def");
		// No workspace at all reads only `all`.
		expect(await resolveConfigValue("${vault:MCP_TOKEN}")).toBeUndefined();
	});

	it("does not treat a partial reference as a vault lookup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-mcp-vault-"));
		setAgentDir(dir);
		await new AgentSecretStore(dir).set("MCP_TOKEN", "abc/def", "an MCP server");

		expect(await resolveConfigValue("Bearer ${vault:MCP_TOKEN}", { cwd: dir })).toBe("Bearer ${vault:MCP_TOKEN}");
	});
});
