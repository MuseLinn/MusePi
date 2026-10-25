/**
 * Git host accounts — the daemon's one store for source-control credentials.
 *
 * One JSON document per agent dir (`git-accounts.json`, mode 0600) holds
 * every connected account keyed by host, with one ACTIVE account per host.
 * The GUI lists accounts with masked tokens; RPC handlers receive the raw
 * token only through `activeTokenForHost`.
 *
 * Why a store instead of the old single `github-token.json`: the previous
 * shape held exactly one token for exactly github.com — no second account,
 * no enterprise host, no notion of which login a token belongs to. The
 * host-keyed shape is the persistence half of the provider-descriptor git
 * model (GitHub / GitHub Enterprise / GitLab / Gitea / Forgejo all reduce
 * to host + apiBase + token); hosts this build cannot drive yet simply
 * never get an account.
 *
 * Legacy migration: `github-token.json` (token/login/email/updatedAt)
 * imports as the active `github.com` account on first read, then the old
 * file is removed — one source of truth from then on.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";

/** Source-control hosts this build can authenticate. More hosts extend
 *  this union as their RPC surface lands — the store is host-agnostic. */
export type GitAccountKind = "github";

export interface GitAccountRecord {
	/** Stable id: `${host}/${login ?? "pat"}`. Ids never carry the token. */
	id: string;
	/** Lowercase bare host (github.com, gitlab.example.com). */
	host: string;
	kind: GitAccountKind;
	/** REST API origin for the host; null = the host's default. */
	apiBase: string | null;
	/** Raw credential. Never leaves this module except via activeTokenForHost. */
	token: string;
	login?: string;
	email?: string;
	updatedAt: string;
}

/** What list endpoints return: everything except the raw token. */
export interface GitAccountPublic {
	id: string;
	host: string;
	kind: GitAccountKind;
	apiBase: string | null;
	login?: string;
	email?: string;
	updatedAt: string;
	/** true when this account is the host's active credential. */
	active: boolean;
	/** Token suffix for display (`…abcd`), 4 chars max. */
	tokenTail: string;
}

interface GitAccountsFile {
	version: 1;
	/** Account id carrying RPCs for each host. */
	activeByHost: Record<string, string>;
	accounts: GitAccountRecord[];
}

const DEFAULT_API_BASE: Record<GitAccountKind, string | null> = {
	github: "https://api.github.com",
};

function accountsPath(): string {
	return path.join(getAgentDir(), "git-accounts.json");
}

function legacyTokenPath(): string {
	return path.join(getAgentDir(), "github-token.json");
}

/** Strip scheme/port/trailing slash; lowercase. A PAT form may hand us a
 *  full origin — the store only ever wants the bare host. */
export function normalizeGitHost(host: string): string {
	let h = host.trim().toLowerCase();
	h = h.replace(/^https?:\/\//, "").replace(/\/+$/, "");
	const slash = h.indexOf("/");
	if (slash >= 0) h = h.slice(0, slash);
	return h;
}

function maskTail(token: string): string {
	return `…${token.slice(-4)}`;
}

function emptyFile(): GitAccountsFile {
	return { version: 1, activeByHost: {}, accounts: [] };
}

/** Read the store, migrating the legacy single-token file on first use. */
function readStore(): GitAccountsFile {
	const file = accountsPath();
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as Partial<GitAccountsFile>;
		if (Array.isArray(parsed.accounts)) {
			return {
				version: 1,
				activeByHost: parsed.activeByHost && typeof parsed.activeByHost === "object" ? parsed.activeByHost : {},
				accounts: parsed.accounts.filter(
					(a): a is GitAccountRecord =>
						typeof a?.id === "string" && typeof a?.host === "string" && typeof a?.token === "string",
				),
			};
		}
	} catch {
		// missing or corrupt → fall through to legacy/migration
	}
	// First run on an upgraded install: adopt the old github-token.json.
	try {
		const raw = fs.readFileSync(legacyTokenPath(), "utf8");
		const parsed = JSON.parse(raw) as { token?: string; login?: string; email?: string; updatedAt?: string };
		if (typeof parsed.token === "string" && parsed.token.length > 0) {
			const account = buildAccount({
				host: "github.com",
				kind: "github",
				apiBase: null,
				token: parsed.token,
				login: typeof parsed.login === "string" ? parsed.login : undefined,
				email: typeof parsed.email === "string" ? parsed.email : undefined,
				updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
			});
			const migrated: GitAccountsFile = {
				version: 1,
				activeByHost: { "github.com": account.id },
				accounts: [account],
			};
			writeStore(migrated);
			try {
				fs.unlinkSync(legacyTokenPath());
			} catch {
				// leave the orphan — the new file is authoritative from here
			}
			return migrated;
		}
	} catch {
		// no legacy file — fresh install
	}
	try {
		fs.unlinkSync(legacyTokenPath());
	} catch {
		// already gone / not ours to delete
	}
	return emptyFile();
}

function writeStore(store: GitAccountsFile): void {
	fs.writeFileSync(accountsPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function buildAccount(input: {
	host: string;
	kind: GitAccountKind;
	apiBase: string | null;
	token: string;
	login?: string;
	email?: string;
	updatedAt?: string;
}): GitAccountRecord {
	const host = normalizeGitHost(input.host);
	const login = input.login?.trim() ? input.login.trim() : undefined;
	return {
		id: `${host}/${login ?? "pat"}`,
		host,
		kind: input.kind,
		apiBase: input.apiBase ?? DEFAULT_API_BASE[input.kind] ?? null,
		token: input.token,
		login,
		email: input.email?.trim() ? input.email.trim() : undefined,
		updatedAt: input.updatedAt ?? new Date().toISOString(),
	};
}

/** All accounts, newest first per host, with the raw token masked out. */
export function listGitAccounts(): GitAccountPublic[] {
	const store = readStore();
	const active = store.activeByHost;
	return [...store.accounts]
		.sort((a, b) => (a.host === b.host ? b.updatedAt.localeCompare(a.updatedAt) : a.host.localeCompare(b.host)))
		.map(a => ({
			id: a.id,
			host: a.host,
			kind: a.kind,
			apiBase: a.apiBase,
			login: a.login,
			email: a.email,
			updatedAt: a.updatedAt,
			active: active[a.host] === a.id,
			tokenTail: maskTail(a.token),
		}));
}

/**
 * The credential RPC handlers spawn with (GH_TOKEN). One account per host
 * is active; adding an account makes it active (it was just validated, the
 * stale one was not).
 */
export function activeTokenForHost(host: string): GitAccountRecord | null {
	const store = readStore();
	const id = store.activeByHost[normalizeGitHost(host)];
	if (!id) return null;
	return store.accounts.find(a => a.id === id) ?? null;
}

/** Insert or replace an account for (host, login) — same login re-login
 *  replaces the token, a different login adds a second account. Makes the
 *  account active for its host. Returns the stored record. */
export function upsertGitAccount(input: {
	host: string;
	kind: GitAccountKind;
	apiBase?: string | null;
	token: string;
	login?: string;
	email?: string;
}): GitAccountRecord {
	const store = readStore();
	const account = buildAccount({ ...input, apiBase: input.apiBase ?? null });
	// Same account (same id) is replaced in place; everything else keeps
	// its slot so list ordering stays stable across a re-login.
	const idx = store.accounts.findIndex(a => a.id === account.id);
	if (idx >= 0) store.accounts[idx] = account;
	else store.accounts.push(account);
	store.activeByHost[account.host] = account.id;
	try {
		writeStore(store);
	} catch {
		// agent dir unavailable — account lost on restart, same tolerance
		// the legacy file had
	}
	return account;
}

/** Merge a fresh identity lookup into the active account of a host —
 *  the background `gh api user` refresh must not clobber a concurrent
 *  re-login's newer token, so only identity fields move. */
export function updateGitAccountIdentity(host: string, identity: { login?: string; email?: string }): void {
	const store = readStore();
	const id = store.activeByHost[normalizeGitHost(host)];
	if (!id) return;
	const account = store.accounts.find(a => a.id === id);
	if (!account) return;
	if (identity.login?.trim()) account.login = identity.login.trim();
	if (identity.email?.trim()) account.email = identity.email.trim();
	account.updatedAt = new Date().toISOString();
	try {
		writeStore(store);
	} catch {
		// same tolerance as the legacy write
	}
}

/** Remove one account; clears the host's active pointer when it pointed
 *  there (the host's RPCs fall back to the gh CLI keyring). */
export function removeGitAccount(id: string): boolean {
	const store = readStore();
	const before = store.accounts.length;
	store.accounts = store.accounts.filter(a => a.id !== id);
	if (store.accounts.length === before) return false;
	for (const [host, activeId] of Object.entries(store.activeByHost)) {
		if (activeId === id) delete store.activeByHost[host];
	}
	try {
		writeStore(store);
	} catch {
		// removal stays in-memory for this process — same tolerance as above
	}
	return true;
}

/**
 * The REST origin a host answers on. github.com is api.github.com; a
 * self-hosted GitHub Enterprise / compatible host answers under /api/v3.
 */
export function gitApiBaseForHost(host: string): string {
	const h = normalizeGitHost(host);
	return h === "github.com" ? "https://api.github.com" : `https://${h}/api/v3`;
}

/**
 * Validate a personal access token against the host's REST API and return
 * the identity it belongs to. `fetchImpl` is injectable so tests stay
 * offline. The token is sent as a Bearer credential and never persisted
 * here — callers upsert only after validation succeeds.
 */
export async function validateGitHubToken(
	host: string,
	token: string,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<{ login?: string; email?: string } | { error: string }> {
	const apiBase = gitApiBaseForHost(host);
	let resp: Response;
	try {
		resp = await fetchImpl(`${apiBase}/user`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		return {
			error:
				err instanceof Error && err.name === "TimeoutError"
					? `timed out reaching ${apiBase}`
					: `cannot reach ${apiBase} (${err instanceof Error ? err.message : String(err)})`,
		};
	}
	if (resp.status === 401 || resp.status === 403) return { error: "token rejected by the host (401)" };
	if (!resp.ok) return { error: `host answered ${resp.status}` };
	const body = (await resp.json().catch(() => ({}))) as { login?: unknown; email?: unknown };
	return {
		login: typeof body.login === "string" ? body.login : undefined,
		email: typeof body.email === "string" ? body.email : undefined,
	};
}
