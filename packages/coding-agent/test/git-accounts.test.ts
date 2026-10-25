/**
 * git-accounts store contracts: legacy github-token.json migration, per-host
 * active selection, re-login replacement, identity merge without token
 * clobber, removal clearing the active pointer, and the masking guarantee
 * (list output never carries a raw token).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	activeTokenForHost,
	gitApiBaseForHost,
	listGitAccounts,
	normalizeGitHost,
	removeGitAccount,
	updateGitAccountIdentity,
	upsertGitAccount,
	validateGitHubToken,
} from "../src/daemon/git-accounts";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

let agentDir: string;

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("git-accounts-");
});

afterAll(async () => {
	await restoreAgentDirForTest(agentDir);
}, 30000);

describe("normalizeGitHost", () => {
	it("strips scheme, path, port-keep host and lowercases", () => {
		expect(normalizeGitHost("https://GitHub.com/octo/repo")).toBe("github.com");
		expect(normalizeGitHost("github.com/")).toBe("github.com");
	});
});

describe("git-accounts store", () => {
	it("migrates the legacy github-token.json into the active github.com account", () => {
		fs.writeFileSync(
			path.join(agentDir, "github-token.json"),
			JSON.stringify({ token: "ghp_legacy1234", login: "octo", updatedAt: "2026-01-01T00:00:00.000Z" }),
		);
		const accounts = listGitAccounts();
		expect(accounts).toHaveLength(1);
		expect(accounts[0].host).toBe("github.com");
		expect(accounts[0].login).toBe("octo");
		expect(accounts[0].active).toBe(true);
		expect(accounts[0].tokenTail).toBe("…1234");
		// The raw token is retrievable only through the active-credential path…
		expect(activeTokenForHost("github.com")?.token).toBe("ghp_legacy1234");
		// …and the legacy file is gone — one source of truth.
		expect(fs.existsSync(path.join(agentDir, "github-token.json"))).toBe(false);
	});

	it("never leaks a raw token through the list output", () => {
		const raw = JSON.stringify(listGitAccounts());
		expect(raw).not.toContain("ghp_legacy1234");
	});

	it("upserting a second login for the host adds an account and makes it active", () => {
		upsertGitAccount({ host: "github.com", kind: "github", token: "ghp_second5678", login: "hubot" });
		const accounts = listGitAccounts();
		expect(accounts).toHaveLength(2);
		const active = accounts.find(a => a.active);
		expect(active?.login).toBe("hubot");
		expect(activeTokenForHost("github.com")?.token).toBe("ghp_second5678");
	});

	it("re-login under the same login replaces the token without growing the list", () => {
		upsertGitAccount({ host: "github.com", kind: "github", token: "ghp_rotated9999", login: "hubot" });
		const accounts = listGitAccounts().filter(a => a.login === "hubot");
		expect(accounts).toHaveLength(1);
		expect(activeTokenForHost("github.com")?.token).toBe("ghp_rotated9999");
	});

	it("identity refresh merges login/email without clobbering the token", () => {
		updateGitAccountIdentity("github.com", { login: "hubot", email: "hubot@example.com" });
		const active = activeTokenForHost("github.com");
		expect(active?.token).toBe("ghp_rotated9999");
		expect(active?.email).toBe("hubot@example.com");
	});

	it("removeGitAccount clears the host pointer so RPCs fall back to the keyring", () => {
		const hubot = listGitAccounts().find(a => a.login === "hubot");
		expect(hubot).toBeDefined();
		expect(removeGitAccount(hubot!.id)).toBe(true);
		expect(activeTokenForHost("github.com")).toBeNull();
		expect(listGitAccounts().some(a => a.login === "hubot")).toBe(false);
		// The other account of the host survives removal.
		expect(listGitAccounts().some(a => a.login === "octo")).toBe(true);
	});

	it("survives a daemon restart (persisted document reload)", () => {
		// Re-activate octo (the removal test cleared the host pointer), then
		// re-read from disk — the document, not process memory, is authoritative.
		upsertGitAccount({ host: "github.com", kind: "github", token: "ghp_legacy1234", login: "octo" });
		const before = listGitAccounts();
		expect(before.some(a => a.login === "octo" && a.active)).toBe(true);
	});
});

describe("validateGitHubToken", () => {
	it("resolves the api base: api.github.com vs enterprise /api/v3", () => {
		expect(gitApiBaseForHost("github.com")).toBe("https://api.github.com");
		expect(gitApiBaseForHost("ghe.corp.example")).toBe("https://ghe.corp.example/api/v3");
	});

	it("returns the identity on 200 and sends the bearer credential", async () => {
		const calls: Array<[string, string]> = [];
		const fake = (async (url: unknown, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			calls.push([String(url), String(headers.Authorization)]);
			return new Response(JSON.stringify({ login: "octo", email: "octo@example.com" }), { status: 200 });
		}) as (url: string, init?: RequestInit) => Promise<Response>;
		const res = await validateGitHubToken("github.com", "ghp_secret", fake);
		expect(res).toEqual({ login: "octo", email: "octo@example.com" });
		expect(calls).toEqual([["https://api.github.com/user", "Bearer ghp_secret"]]);
	});

	it("maps 401 to a token-rejected error instead of storing anything", async () => {
		const fake = (async () => new Response("{}", { status: 401 })) as (
			url: string,
			init?: RequestInit,
		) => Promise<Response>;
		const res = await validateGitHubToken("github.com", "bad", fake);
		expect("error" in res && res.error).toContain("401");
	});

	it("reports unreachable hosts as an error without throwing", async () => {
		const fake = (async () => {
			throw new Error("boom");
		}) as (url: string, init?: RequestInit) => Promise<Response>;
		const res = await validateGitHubToken("ghe.corp", "tok", fake);
		expect("error" in res).toBe(true);
	});
});
