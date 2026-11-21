import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSecretStore } from "../src/secrets/agent-store";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

const VALUE = "sk-super-secret-123";

function makeSession(agentDir: string): ToolSession {
	return {
		cwd: agentDir,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "session-1",
		settings: {
			getAgentDir: () => agentDir,
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

describe("bash agent-secret injection", () => {
	it("injects stored values into the child env and scrubs them from the result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-agent-bash-"));
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl the API");

		const tool = new BashTool(makeSession(dir));
		const result = await tool.execute("call-secret-env", {
			command: `printf '%s' "$MUSEPI_SECRET_API_TOKEN"`,
		});
		const text = textOf(result);

		expect(text).toContain("[secret:API_TOKEN]");
		expect(text).not.toContain(VALUE);
		expect(JSON.stringify(result)).not.toContain(VALUE);
		// The value never enters the daemon process environment.
		expect(process.env.MUSEPI_SECRET_API_TOKEN).toBeUndefined();
	});

	it("stored values win over a model-supplied env entry of the same name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-agent-bash-"));
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl the API");

		const tool = new BashTool(makeSession(dir));
		const result = await tool.execute("call-secret-override", {
			command: `printf '%s' "$MUSEPI_SECRET_API_TOKEN"`,
			env: { MUSEPI_SECRET_API_TOKEN: "caller-supplied-value" },
		});
		const text = textOf(result);

		expect(text).toContain("[secret:API_TOKEN]");
		expect(text).not.toContain("caller-supplied-value");
		expect(text).not.toContain(VALUE);
	});
});
