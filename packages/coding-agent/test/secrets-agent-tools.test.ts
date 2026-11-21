import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "../src/extensibility/extensions/types";
import { buildSecretObfuscator } from "../src/secrets";
import {
	forgetAgentSecretSession,
	notifyAgentSecretSaved,
	registerAgentSecretObfuscator,
} from "../src/secrets/agent-runtime";
import {
	type AgentSecretAnswer,
	type AgentSecretRequest,
	AgentSecretStore,
	type AgentSecretUIContext,
} from "../src/secrets/agent-store";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { ToolSession } from "../src/tools";
import { ListSecretsTool } from "../src/tools/list-secrets";
import { RequestSecretTool } from "../src/tools/request-secret";
import { ToolError } from "../src/tools/tool-errors";

const VALUE = "sk-super-secret-123";

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "musepi-agent-tools-"));
}

function makeSession(agentDir: string, uiContext?: ExtensionUIContext & AgentSecretUIContext): ToolSession {
	return {
		cwd: agentDir,
		hasUI: uiContext !== undefined,
		uiContext,
		getSessionId: () => "session-1",
		getSessionFile: () => null,
		settings: {
			getAgentDir: () => agentDir,
			get: () => undefined,
			getBashInterceptorRules: () => [],
		},
	} as unknown as ToolSession;
}

function secretUi(handler: (request: AgentSecretRequest) => Promise<AgentSecretAnswer | undefined>) {
	return { requestSecret: handler } as unknown as ExtensionUIContext & AgentSecretUIContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

describe("request_secret tool", () => {
	it("returns only the environment variable name after a save", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		const tool = new RequestSecretTool(
			makeSession(
				dir,
				secretUi(async request => {
					// The host persists the value; the tool only learns the action.
					expect(request.kind).toBe("fill");
					await store.set(request.name, VALUE, request.purpose);
					return { action: "save" };
				}),
			),
		);

		const result = await tool.execute("call-save", { name: "API_TOKEN", purpose: "curl the API" });
		const text = textOf(result);
		expect(text).toContain("$MUSEPI_SECRET_API_TOKEN");
		expect(text).not.toContain(VALUE);
		expect(JSON.stringify(result)).not.toContain(VALUE);
		expect(result.details?.status).toBe("saved");
		expect(await store.getValue("API_TOKEN")).toBe(VALUE);
		expect(await store.list()).toHaveLength(1);
	});

	it("returns a cancellation explanation and saves nothing", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		const tool = new RequestSecretTool(
			makeSession(
				dir,
				secretUi(async () => ({ action: "cancel" })),
			),
		);

		const result = await tool.execute("call-cancel", { name: "API_TOKEN", purpose: "curl" });
		const text = textOf(result);
		expect(text).toContain("cancelled");
		expect(text).not.toContain(VALUE);
		expect(result.details?.status).toBe("cancelled");
		expect(await store.list()).toEqual([]);
	});

	it("asks once for a stored value and then returns immediately in the same session", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl");

		let calls = 0;
		const ui = secretUi(async request => {
			calls++;
			expect(request.kind).toBe("allow");
			return { action: "allow" };
		});
		const tool = new RequestSecretTool(makeSession(dir, ui));
		const first = await tool.execute("call-allow", { name: "API_TOKEN", purpose: "curl" });
		expect(first.details?.status).toBe("available");
		expect(textOf(first)).not.toContain(VALUE);

		// A second call with a UI that refuses to answer must not re-open a card.
		const silent = new RequestSecretTool(
			makeSession(dir, {
				requestSecret: () => {
					throw new Error("card must not reopen");
				},
			} as unknown as ExtensionUIContext & AgentSecretUIContext),
		);
		const second = await silent.execute("call-again", { name: "API_TOKEN", purpose: "curl" });
		expect(second.details?.status).toBe("available");
		expect(calls).toBe(1);
		forgetAgentSecretSession(dir, "session-1");
	});

	it("refuses a host with no interactive secret channel", async () => {
		const dir = makeDir();
		const tool = new RequestSecretTool(makeSession(dir));
		await expect(tool.execute("call-no-ui", { name: "API_TOKEN", purpose: "curl" })).rejects.toBeInstanceOf(
			ToolError,
		);
	});
});

describe("list_secrets tool", () => {
	it("lists metadata and availability without values", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl the API");
		const tool = new ListSecretsTool(makeSession(dir));
		const result = await tool.execute();
		const text = textOf(result);

		expect(text).toContain("API_TOKEN");
		expect(text).toContain("curl the API");
		expect(text).toContain("scope: all");
		expect(text).toContain("$MUSEPI_SECRET_API_TOKEN");
		expect(text).not.toContain(VALUE);
		expect(JSON.stringify(result)).not.toContain(VALUE);
		expect(result.details?.entries).toEqual([
			{ name: "API_TOKEN", purpose: "curl the API", scope: "all", available: true },
		]);
	});

	it("reports an empty store without inventing entries", async () => {
		const dir = makeDir();
		const tool = new ListSecretsTool(makeSession(dir));
		const result = await tool.execute();
		expect(textOf(result)).toContain("No agent secrets are stored");
		expect(result.details?.entries).toEqual([]);
	});
});

describe("dynamic obfuscator registration", () => {
	it("session startup loads stored agent secrets into the obfuscator", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl the API");

		const obfuscator = await buildSecretObfuscator(dir, dir, dir);
		expect(obfuscator).toBeDefined();
		expect(obfuscator?.hasSecrets()).toBe(true);
		const obfuscated = obfuscator?.obfuscate(`Authorization: Bearer ${VALUE}`) ?? "";
		expect(obfuscated).not.toContain(VALUE);
		expect(obfuscated).toContain("APITOKEN");
	});

	it("mid-session saves are obfuscated immediately", () => {
		const dir = makeDir();
		const obfuscator = new SecretObfuscator([], "a".repeat(43));
		registerAgentSecretObfuscator(dir, obfuscator);
		expect(obfuscator.hasSecrets()).toBe(false);

		notifyAgentSecretSaved(dir, "API_TOKEN", VALUE);
		expect(obfuscator.hasSecrets()).toBe(true);
		const obfuscated = obfuscator.obfuscate(`token=${VALUE}`);
		expect(obfuscated).not.toContain(VALUE);
		expect(obfuscated).toContain("APITOKEN");
	});
});
