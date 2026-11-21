import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@musepi/pi-ai";
import { buildSessionSecretObfuscator, obfuscateMessages } from "../src/secrets";
import { AgentSecretStore } from "../src/secrets/agent-store";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

const VALUE = "sk-super-secret-123";
const CONFIGURED_VALUE = "configured-value-123";

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

describe("agent-secret provider boundary without secrets.enabled", () => {
	it("covers an env->file->read round trip when generic secret sources are off", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-agent-boundary-"));
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl the API");
		// A configured source that must stay behind `secrets.enabled`.
		writeFileSync(
			join(dir, "secrets.yml"),
			["- type: plain", `  content: ${CONFIGURED_VALUE}`, "  mode: obfuscate", ""].join("\n"),
		);

		// `genericSecretsEnabled: false` is the `secrets.enabled=false` session
		// build: only the explicitly saved agent secret is registered.
		const obfuscator = await buildSessionSecretObfuscator(dir, dir, dir, false);
		expect(obfuscator).toBeDefined();
		expect(obfuscator?.hasSecrets()).toBe(true);
		expect(obfuscator?.obfuscate(CONFIGURED_VALUE)).toBe(CONFIGURED_VALUE);

		const tool = new BashTool(makeSession(dir));
		const outFile = join(dir, "env-capture.txt");
		const bashResult = await tool.execute("call-capture", {
			command: `printf '%s' "$MUSEPI_SECRET_API_TOKEN" > "${outFile}"`,
		});
		expect(JSON.stringify(bashResult)).not.toContain(VALUE);

		// A later `read` of the file exposes the child value locally; the provider
		// boundary is what must replace it before any provider request.
		const fileText = readFileSync(outFile, "utf8");
		expect(fileText).toBe(VALUE);
		const providerMessages = obfuscateMessages(obfuscator!, [
			{ role: "user", content: [{ type: "text", text: `file contents: ${fileText}` }] } as Message,
		]);
		const serialized = JSON.stringify(providerMessages);
		expect(serialized).not.toContain(VALUE);
		expect(serialized).toContain("APITOKEN");
	});
});
