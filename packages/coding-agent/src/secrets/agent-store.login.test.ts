import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentSecretStore } from "./agent-store";

async function tempStore(): Promise<AgentSecretStore> {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "musepi-login-"));
	return new AgentSecretStore(dir);
}

const LOGIN = {
	site: "example.com",
	username: "me@example.com",
};

describe("saved logins", () => {
	it("keeps a login's password inside the vault", async () => {
		const store = await tempStore();
		const entry = await store.set("ACME", "hunter2-long", "team portal", "all", undefined, {
			kind: "login",
			login: LOGIN,
		});

		expect(entry.kind).toBe("login");
		expect(entry.login).toMatchObject({ site: "example.com", username: "me@example.com" });
		// A login is never a value the agent may use: `getValue` must refuse it,
		// which is what keeps it out of bash and out of the redaction list.
		expect(await store.getValue("ACME")).toBeUndefined();
		expect(await store.values()).toEqual([]);
		// The fill path is the only reader.
		expect(await store.loginCredentials("ACME")).toEqual({ password: "hunter2-long" });
	});

	it("hands a plain secret out normally, so the refusal is specific to logins", async () => {
		const store = await tempStore();
		await store.set("PLAIN", "value-1234");
		expect(await store.getValue("PLAIN")).toBe("value-1234");
		// And it cannot be filled as a login.
		expect(await store.loginCredentials("PLAIN")).toBeUndefined();
	});

	it("computes a current code from the stored setup key", async () => {
		const store = await tempStore();
		await store.set("ACME", "hunter2-long", "portal", "all", undefined, {
			kind: "login",
			login: { ...LOGIN, totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
		});
		const filled = await store.loginFill("ACME", 59_000);
		expect(filled).toMatchObject({ username: "me@example.com", password: "hunter2-long", code: "287082" });
	});

	it("keeps the stored setup key when a replacement leaves it blank", async () => {
		const store = await tempStore();
		await store.set("ACME", "first-pass", "portal", "all", undefined, {
			kind: "login",
			login: { ...LOGIN, totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
		});
		const replaced = await store.set("ACME", "second-pass", undefined, undefined, undefined, {
			kind: "login",
			login: LOGIN,
		});
		expect(replaced.login?.hasTotp).toBe(true);
		expect((await store.loginCredentials("ACME"))?.totp).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
	});

	it("finds the login for a host, honouring an exact-host choice", async () => {
		const store = await tempStore();
		await store.set("SITE", "p1-xxxx", "site", "all", undefined, {
			kind: "login",
			login: { site: "example.com", username: "a" },
		});
		await store.set("EXACT", "p2-xxxx", "exact", "all", undefined, {
			kind: "login",
			login: { site: "example.com", hosts: ["accounts.example.com"], exactHost: true, username: "b" },
		});

		// A subdomain matches the site-wide login.
		expect((await store.loginsForHost("www.example.com")).map(entry => entry.name)).toEqual(["SITE"]);
		// The exact-host login answers only on its listed host.
		expect((await store.loginsForHost("accounts.example.com")).map(entry => entry.name).sort()).toEqual([
			"EXACT",
			"SITE",
		]);
		// An unrelated site matches nothing.
		expect(await store.loginsForHost("other.test")).toEqual([]);
	});
});
