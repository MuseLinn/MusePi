import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionUIContext } from "../src/extensibility/extensions/types";
import { buildSecretObfuscator } from "../src/secrets";
import {
	agentSecretSnapshot,
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

	it("returns immediately for a stored, decryptable value without a second card", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl");

		// Saving was the consent: no per-session grant card, including after a
		// restart (this session never granted anything).
		const tool = new RequestSecretTool(
			makeSession(dir, {
				requestSecret: () => {
					throw new Error("card must not reopen for a stored value");
				},
			} as unknown as ExtensionUIContext & AgentSecretUIContext),
		);
		const result = await tool.execute("call-available", { name: "API_TOKEN", purpose: "curl" });
		expect(result.details?.status).toBe("available");
		expect(textOf(result)).toContain("$MUSEPI_SECRET_API_TOKEN");
		expect(textOf(result)).not.toContain(VALUE);
	});

	it("asks to allow a stored secret scoped to another workspace", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		const foreign = resolve(dir, "other-workspace");
		const workspace = resolve(dir, "this-workspace");
		await store.set("API_TOKEN", VALUE, "curl", [foreign]);

		let askedKind = "";
		let askedWorkspace = "";
		const ui = secretUi(async request => {
			askedKind = request.kind;
			askedWorkspace = request.workspace ?? "";
			await store.setScope("API_TOKEN", [foreign, workspace]);
			return { action: "allow" };
		});
		const tool = new RequestSecretTool({ ...makeSession(dir, ui), cwd: workspace } as unknown as ToolSession);

		const result = await tool.execute("call-allow", { name: "API_TOKEN", purpose: "curl" });
		expect(askedKind).toBe("allow");
		expect(askedWorkspace).toBe(workspace);
		expect(result.details?.status).toBe("saved");
		expect(result.details?.scope).toEqual([foreign, workspace]);
	});

	it("does not reuse a stored secret outside this workspace", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		await store.set("API_TOKEN", VALUE, "curl", [resolve(dir, "other-workspace")]);
		const tool = new RequestSecretTool({
			...makeSession(
				dir,
				secretUi(async () => ({ action: "cancel" })),
			),
			cwd: resolve(dir, "this-workspace"),
		} as unknown as ToolSession);

		const result = await tool.execute("call-outside", { name: "API_TOKEN", purpose: "curl" });
		expect(result.details?.status).toBe("cancelled");
	});

	it("accepts a four-character value and reports it as saved", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		const tool = new RequestSecretTool(
			makeSession(
				dir,
				secretUi(async request => {
					await store.set(request.name, "1234", request.purpose);
					return { action: "save" };
				}),
			),
		);
		const result = await tool.execute("call-pin", { name: "PIN", purpose: "unlock the vault" });
		expect(result.details?.status).toBe("saved");
		expect(await store.getValue("PIN")).toBe("1234");
		expect(JSON.stringify(result)).not.toContain("1234");
	});

	it("a file delivery returns the private path, never the value", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		const tool = new RequestSecretTool(
			makeSession(
				dir,
				secretUi(async request => {
					expect(request.delivery).toBe("file");
					await store.set(request.name, VALUE, request.purpose, undefined, "file");
					return { action: "save" };
				}),
			),
		);
		const result = await tool.execute("call-file", { name: "CERT", purpose: "tls handshake", delivery: "file" });
		const text = textOf(result);
		expect(text).toContain(store.filePath("CERT"));
		expect(text).not.toContain(VALUE);
		expect(result.details?.delivery).toBe("file");

		// The working copy can vanish outside the store; asking again restores it.
		await store.removeDeliveryFile("CERT");
		await tool.execute("call-file-again", { name: "CERT", purpose: "tls handshake", delivery: "file" });
		expect(await Bun.file(store.filePath("CERT")).text()).toBe(VALUE);
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
		expect(text).toContain("scope: every session");
		expect(text).toContain("$MUSEPI_SECRET_API_TOKEN");
		expect(text).not.toContain(VALUE);
		expect(JSON.stringify(result)).not.toContain(VALUE);
		expect(result.details?.entries).toEqual([
			{
				name: "API_TOKEN",
				purpose: "curl the API",
				scope: "all",
				delivery: "env",
				kind: "secret",
				available: true,
				usable: true,
			},
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
	it("redacts the URL-encoded and JSON-escaped forms in bash output", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		const value = 'sk-abc/def+"ghi"';
		await store.set("API_TOKEN", value, "curl");
		const snapshot = await agentSecretSnapshot(dir, dir);
		const encoded = encodeURIComponent(value).replace(
			/[!'()*]/g,
			char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		const escaped = JSON.stringify(value).slice(1, -1);
		for (const form of [value, encoded, escaped]) {
			const output = snapshot.redact(`prefix ${form} suffix`);
			expect(output).not.toContain(form);
			expect(output).toContain("[secret:API_TOKEN]");
		}
	});

	it("obfuscates encoded forms at the provider boundary", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		const value = "tok/with+slash";
		await store.set("API_TOKEN", value, "curl");
		const obfuscator = await buildSecretObfuscator(dir, dir, dir);
		const encoded = encodeURIComponent(value).replace(
			/[!'()*]/g,
			char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		const output = obfuscator?.obfuscate(`url?t=${encoded}`) ?? "";
		expect(output).not.toContain(encoded);
		expect(obfuscator?.deobfuscate(output)).toContain(encoded);
	});

	it("narrows bash injection to the names the command mentions", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		await store.set("ALPHA", "alpha-value", "first");
		await store.set("BETA", "beta-value", "second");

		const narrowed = await agentSecretSnapshot(dir, dir, {
			command: "echo $MUSEPI_SECRET_ALPHA",
			referencedOnly: true,
		});
		expect(narrowed.env.MUSEPI_SECRET_ALPHA).toBe("alpha-value");
		expect(narrowed.env.MUSEPI_SECRET_BETA).toBeUndefined();
		// Redaction still covers a value that was not injected.
		expect(narrowed.redact("beta-value")).toContain("[secret:BETA]");

		const all = await agentSecretSnapshot(dir, dir, {
			command: "echo $MUSEPI_SECRET_ALPHA",
			referencedOnly: false,
		});
		expect(all.env.MUSEPI_SECRET_BETA).toBe("beta-value");
	});

	it("a file delivery stays out of the environment but is still redacted", async () => {
		const dir = makeDir();
		const store = new AgentSecretStore(dir);
		await store.set("CERT", VALUE, "tls", "all", "file");
		const file = store.filePath("CERT");
		expect(await Bun.file(file).text()).toBe(VALUE);
		const snapshot = await agentSecretSnapshot(dir, dir);
		expect(snapshot.env.MUSEPI_SECRET_CERT).toBeUndefined();
		expect(snapshot.redact(`value ${VALUE}`)).toContain("[secret:CERT]");
		await store.delete("CERT");
		expect(await Bun.file(file).exists()).toBe(false);
	});

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
