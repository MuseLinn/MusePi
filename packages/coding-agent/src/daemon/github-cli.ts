/**
 * gh CLI runner for the daemon `github.*` RPCs.
 *
 * The daemon owns the device-flow token instead of `gh auth login`, whose
 * validation requests api.github.com — unreachable on flaky networks, which
 * then fails an auth that already succeeded. RPCs hand the token to gh through
 * GH_TOKEN (higher precedence than the keyring); a self-hosted host
 * (GitHub Enterprise and compatible) uses GH_ENTERPRISE_TOKEN + GH_HOST, which
 * is how gh scopes a credential to a non-github.com host.
 *
 * Every call is spawned async with a hard timeout: a gh that blocks on the
 * keyring or the network must never pin the daemon event loop, because that
 * freezes every session's turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	activeTokenForHost,
	normalizeGitHost,
	removeGitAccount,
	updateGitAccountIdentity,
	upsertGitAccount,
} from "./git-accounts";
import { runGit } from "./git-runner";

/**
 * gh CLI path: PATH first, then common install locations. Daemons launched
 * from the GUI (Electron) or launchd often lack /opt/homebrew/bin in PATH,
 * so `Bun.which("gh")` alone reports "not installed" for brew users.
 */
let ghBin: string | null | undefined;
export function ghPath(): string | null {
	if (ghBin !== undefined) return ghBin;
	if (Bun.which("gh") !== null) {
		ghBin = "gh";
		return ghBin;
	}
	if (process.platform === "darwin") {
		for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
			if (fs.existsSync(candidate)) {
				ghBin = candidate;
				return ghBin;
			}
		}
	} else if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles;
		const candidate = programFiles ? path.join(programFiles, "GitHub CLI", "gh.exe") : "";
		if (candidate !== "" && fs.existsSync(candidate)) {
			ghBin = candidate;
			return ghBin;
		}
	}
	ghBin = null;
	return null;
}

/**
 * The active github.com credential: persisted by `daemon/git-accounts.ts`,
 * which also migrates the legacy github-token.json. This module only reads
 * the active account and writes re-login results back.
 */
export function readGhToken(): { token: string; login?: string; email?: string; updatedAt: string } | null {
	return activeTokenForHost("github.com");
}

/**
 * cwd → remote host (bare, lowercase), cached per process. The default is
 * github.com — a repo with no origin (or a non-URL remote) behaves exactly
 * as before the host-aware token existed.
 */
const REMOTE_HOST_CACHE = new Map<string, string>();
async function remoteHostFor(cwd: string): Promise<string> {
	const key = path.resolve(cwd);
	const cached = REMOTE_HOST_CACHE.get(key);
	if (cached) return cached;
	let host = "github.com";
	try {
		const res = await runGit(key, ["remote", "get-url", "origin"], 5000);
		if (res.exitCode === 0) {
			const url = res.stdout.trim();
			// https://host/owner/repo(.git) or git@host:owner/repo(.git)
			const m = /^https?:\/\/([^/]+)\//.exec(url) ?? /^git@([^:]+):/.exec(url);
			if (m) host = normalizeGitHost(m[1]) || "github.com";
		}
	} catch {
		// keep the github.com default — a detection failure must not break RPCs
	}
	REMOTE_HOST_CACHE.set(key, host);
	return host;
}

/** Spawn `gh` with the account token chosen for the repo's remote host.
 *  `exitCode` is null only when the CLI itself is missing. */
export async function runGh(
	cwd: string,
	args: string[],
	timeoutMs = 15_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const gh = ghPath();
	if (gh === null) return { exitCode: null, stdout: "", stderr: "gh CLI not installed" };
	const host = await remoteHostFor(cwd);
	const account = activeTokenForHost(host);
	const proc = Bun.spawn({
		cmd: [gh, ...args],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: account
			? {
					...process.env,
					...(host === "github.com"
						? { GH_TOKEN: account.token }
						: { GH_ENTERPRISE_TOKEN: account.token, GH_HOST: host }),
				}
			: undefined,
		windowsHide: true,
	});
	setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// already exited
		}
	}, timeoutMs);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited.catch(() => null),
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

export function writeGhToken(token: string, identity?: { login?: string; email?: string }): void {
	if (identity?.login?.trim() || identity?.email?.trim()) {
		updateGitAccountIdentity("github.com", identity);
		// Identity-only refresh assumes an account already exists (the device
		// flow wrote it first); a standalone identity write with no account
		// falls through to the upsert below, same as the legacy prev-merge.
		if (readGhToken()) return;
	}
	// Merge the previous identity when the caller only passes a token — a
	// re-login without an api.github.com round trip keeps the known login.
	const prev = readGhToken();
	upsertGitAccount({
		host: "github.com",
		kind: "github",
		token,
		login: identity?.login ?? prev?.login,
		email: identity?.email ?? prev?.email,
	});
}

export function clearGhToken(): void {
	const active = activeTokenForHost("github.com");
	if (active) removeGitAccount(active.id);
}

/**
 * Classify device-flow fetch failures: transient network errors (EOF,
 * refused, timeout, DNS) keep polling per GitHub's device-flow guidance;
 * TLS/certificate failures are environmental and reported as a clear
 * message instead of the raw Bun fetch text.
 */
export function classifyNetworkError(err: unknown): "transient" | "fatal" {
	const msg = err instanceof Error ? err.message : String(err);
	if (/certificate|SSL|TLS|handshake/i.test(msg)) return "fatal";
	return "transient";
}

export function friendlyNetworkError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (/certificate|SSL|TLS|handshake/i.test(msg)) {
		return "无法验证 GitHub 的 TLS 证书——请检查系统代理/VPN 或网络拦截";
	}
	if (/ENOTFOUND|getaddrinfo|DNS/i.test(msg)) return "无法解析 GitHub 域名——请检查网络连接";
	if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EOF|fetch failed|network|Unable to connect/i.test(msg)) {
		return "连接 GitHub 失败（网络中断或代理拦截）——请检查网络后重试";
	}
	return msg;
}
