/**
 * Best-effort git identity for the user gutter avatar, read through the
 * daemon's `fs.read` RPC (no shell access in the renderer).
 *
 * Resolution order: the workspace's own `.git/config` `[user]` section,
 * then the user's global `~/.gitconfig` (home derived from the workspace
 * path — the macOS convention `/Users/<name>/…`). Missing repo configs
 * are cached as null so we don't re-query on every message.
 */

import type { RpcClient } from "./rpc";

export interface GitUser {
	name: string;
	email: string;
}

/** Parse a git config file's `[user]` section (name/email keys). */
export function parseGitConfig(content: string): GitUser | null {
	const lines = content.split(/\r?\n/);
	let inUser = false;
	let name = "";
	let email = "";
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inUser = /^\[user\]$/.test(line);
			continue;
		}
		if (!inUser || line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line.slice(eq + 1).trim();
		if (key === "name" && !name) name = value;
		else if (key === "email" && !email) email = value;
	}
	if (!name && !email) return null;
	return { name, email };
}

const cache = new Map<string, GitUser | null>();

/** Resolve the git identity for a workspace via the daemon's fs.read. */
export async function readGitUser(rpc: RpcClient, cwd: string): Promise<GitUser | null> {
	if (!cwd) return null;
	const hit = cache.get(cwd);
	if (hit !== undefined) return hit;

	const readConfig = async (path: string): Promise<GitUser | null> => {
		try {
			const res = await rpc.request<{ content: string | null }>("fs.read", { path });
			return res?.content ? parseGitConfig(res.content) : null;
		} catch {
			return null;
		}
	};

	// Walk up from the workspace to the filesystem root: the repo's .git
	// dir may sit at musepi-omp/.git while the session cwd is a package
	// subdirectory (openchamber gets the same identity from git config).
	let user: GitUser | null = null;
	const parts = cwd.split("/").filter(Boolean);
	for (let i = parts.length; i >= 1 && !user; i--) {
		user = await readConfig(`/${parts.slice(0, i).join("/")}/.git/config`);
	}
	if (!user) {
		// Global fallback: ~/.gitconfig, home derived from the macOS path
		// convention /Users/<name>/… (no env access in the renderer).
		const home = /^\/Users\/[^/]+/.exec(cwd)?.[0];
		if (home) user = await readConfig(`${home}/.gitconfig`);
	}
	cache.set(cwd, user);
	return user;
}
