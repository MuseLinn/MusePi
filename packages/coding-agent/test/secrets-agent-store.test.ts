import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSecretSnapshot } from "../src/secrets/agent-runtime";
import {
	AGENT_SECRET_NAME_RE,
	AgentSecretStore,
	agentSecretEnvName,
	normalizeSecretScope,
	validateSecretName,
	validateSecretValue,
} from "../src/secrets/agent-store";

const VALUE = "sk-super-secret-123";

function makeStore(): { dir: string; store: AgentSecretStore } {
	const dir = mkdtempSync(join(tmpdir(), "musepi-agent-secrets-"));
	return { dir, store: new AgentSecretStore(dir) };
}

describe("agent secret store", () => {
	it("stores values only inside the encrypted envelope", async () => {
		const { dir, store } = makeStore();
		const entry = await store.set("GITHUB_TOKEN", VALUE, "GitHub API", "all");

		expect(entry).toMatchObject({
			name: "GITHUB_TOKEN",
			purpose: "GitHub API",
			scope: "all",
		});
		expect(typeof entry.createdAt).toBe("number");
		expect(typeof entry.updatedAt).toBe("number");
		expect(await store.getValue("GITHUB_TOKEN")).toBe(VALUE);

		const encrypted = readFileSync(join(dir, "agent-secrets", "secrets.json"), "utf8");
		const metadata = readFileSync(join(dir, "agent-secrets", "metadata.json"), "utf8");
		expect(encrypted).not.toContain(VALUE);
		expect(metadata).not.toContain(VALUE);
		expect(metadata).toContain("GITHUB_TOKEN");
	});

	it("writes the metadata sidecar owner-only", async () => {
		const { dir, store } = makeStore();
		await store.set("API_TOKEN", VALUE, "test");
		if (process.platform === "win32") return;
		const mode = fs.statSync(join(dir, "agent-secrets", "metadata.json")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("lists metadata, status and availability without values", async () => {
		const { store } = makeStore();
		await store.set("B_TOKEN", "value-b-12345", "second");
		await store.set("A_TOKEN", "value-a-12345", "first");

		const list = await store.list();
		expect(list.map(entry => entry.name)).toEqual(["A_TOKEN", "B_TOKEN"]);
		expect(JSON.stringify(list)).not.toContain("value-a-12345");
		expect(JSON.stringify(list)).not.toContain("value-b-12345");
		expect(await store.status()).toEqual({
			mode: "encrypted",
			count: 2,
			protectedBy: "key-file",
			locked: false,
		});
		expect(await store.available("A_TOKEN")).toBe(true);
		expect(await store.available("MISSING")).toBe(false);
	});

	it("replaces an existing value and keeps createdAt", async () => {
		const { store } = makeStore();
		const first = await store.set("TOKEN", "first-value-123", "first");
		await Bun.sleep(2);
		const second = await store.set("TOKEN", "second-value-123");
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
		expect(second.purpose).toBe("first");
		expect(await store.getValue("TOKEN")).toBe("second-value-123");
	});

	it("deletes idempotently and removes the value", async () => {
		const { store } = makeStore();
		await store.set("TOKEN", VALUE, "test");
		await store.delete("TOKEN");
		await store.delete("TOKEN");
		expect(await store.list()).toEqual([]);
		expect(await store.getValue("TOKEN")).toBeUndefined();
	});

	it("exposes the child environment and redacts stored values through the runtime snapshot", async () => {
		const { dir, store } = makeStore();
		await store.set("API_TOKEN", VALUE, "test");
		expect(agentSecretEnvName("API_TOKEN")).toBe("MUSEPI_SECRET_API_TOKEN");
		const snapshot = await agentSecretSnapshot(dir, dir);
		expect(snapshot.env.MUSEPI_SECRET_API_TOKEN).toBe(VALUE);
		expect(snapshot.redact(`token=${VALUE}; again ${VALUE}`)).toBe(
			"token=[secret:API_TOKEN]; again [secret:API_TOKEN]",
		);
	});

	it("validates names, values and scopes", async () => {
		expect(AGENT_SECRET_NAME_RE.test("GITHUB_TOKEN")).toBe(true);
		expect(AGENT_SECRET_NAME_RE.test("1TOKEN")).toBe(false);
		expect(AGENT_SECRET_NAME_RE.test("TOKEN-LOWER")).toBe(false);
		expect(() => validateSecretName("lower_case")).toThrow(/Invalid secret name/u);
		expect(() => validateSecretValue("")).toThrow(/must not be empty/u);
		expect(() => validateSecretValue("abc")).toThrow(/at least 4/u);
		expect(normalizeSecretScope(undefined)).toBe("all");
		expect(normalizeSecretScope("all")).toBe("all");

		const { store } = makeStore();
		await expect(store.set("bad-name", VALUE)).rejects.toThrow(/Invalid secret name/u);
		await expect(store.set("TOKEN", "abc")).rejects.toThrow(/at least 4/u);
	});
});
