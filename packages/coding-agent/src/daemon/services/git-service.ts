/**
 * GitService — the right-panel git surface as an L2 daemon service.
 *
 * Seam:
 * - Input: `git.*` read/write routes (log, status, diff, branches, identity,
 *   stage, commit, push, pull, stash, checkout, worktrees) plus the session
 *   working directory. Watch pairs belong to GitWatchService.
 * - Output: panel-shaped read models and write acks; git's own stderr for
 *   failures, so a missing repository renders as a state, not a dialog.
 * - Lifecycle: stateless; the runner module owns the process guards.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	diff as gitDiff,
	readBlob as gitReadBlob,
	restore as gitRestore,
	worktree as gitWorktrees,
} from "../../utils/git";
import { runGit, runGitRead, runGitWrite } from "../git-runner";
import type { DaemonService } from "./types";

export class GitService implements DaemonService {
	readonly key = "git";
	readonly routes = {
		"git.log": "log",
		"git.diff": "diff",
		"git.show": "show",
		"git.changedFiles": "changedFiles",
		"git.numstat": "numstat",
		"git.discard": "discard",
		"git.revert": "revert",
		"git.status": "status",
		"git.stage": "stage",
		"git.unstage": "unstage",
		"git.commit": "commit",
		"git.branches": "branches",
		"git.identity": "identity",
		"git.push": "push",
		"git.fetch": "fetch",
		"git.pull": "pull",
		"git.stashList": "stashList",
		"git.stashPush": "stashPush",
		"git.stashPop": "stashPop",
		"git.stashDrop": "stashDrop",
		"git.checkout": "checkout",
		"git.worktrees": "worktrees",
	} as const;

	constructor(private readonly deps: { cwd: () => string }) {}

	private cwd(): string {
		return this.deps.cwd();
	}

	async log(params: unknown): Promise<unknown> {
		// Recent commit history for the right-pane git view.
		// Runs git in the caller's session cwd (params.cwd), not the
		// daemon cwd — the GUI passes snap.state.cwd.
		//
		// Structured mode (default): `git log --all --topo-order`
		// with \x1f-separated fields / \x1e-separated records — full
		// hash, short hash, author, author timestamp, decorations
		// (%D) and parents — parsed into typed commits for the GUI's
		// lane-solving graph renderer. `limit`/`skip` page the log
		// (load-more fetches the next slice); one extra record beyond
		// `limit` yields `hasMore`. `graph: true` keeps the legacy
		// `--graph --oneline` ASCII string. Async spawn with a 10s
		// kill guard — NOT spawnSync, which froze the whole daemon
		// event loop once (see git.status).
		const p = (params ?? {}) as { cwd?: unknown; graph?: unknown; limit?: unknown; skip?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const run = (args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
			const proc = Bun.spawn({
				cmd: ["git", ...args],
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			// Belt-and-braces: a hung git (network FS, hooks) must
			// never pin the RPC open forever.
			setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// already exited
				}
			}, 10_000);
			return Promise.all([
				proc.exited.catch(() => null),
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
		};
		if (p.graph === true) {
			const res = await run(["log", "--graph", "--all", "--oneline", "--decorate", "-n", "60"]);
			if (res.exitCode !== 0) return { error: "not a git repository" };
			return { graph: res.stdout.trim() };
		}
		const limit = Math.min(
			500,
			Math.max(10, typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100),
		);
		const skip = typeof p.skip === "number" && p.skip > 0 ? Math.floor(p.skip) : 0;
		// Remote names distinguish `origin/main`-style remote refs
		// from same-shaped local branches (`feature/x`) in %D.
		const [logRes, remotesRes] = await Promise.all([
			run([
				"log",
				"--all",
				"--topo-order",
				// %H %h %an %at %D %P %s — records end with \x1e.
				"--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%P%x1f%s%x1e",
				`--max-count=${limit + 1}`,
				...(skip > 0 ? [`--skip=${skip}`] : []),
			]),
			run(["remote"]),
		]);
		if (logRes.exitCode !== 0) return { error: "not a git repository" };
		const remoteNames =
			remotesRes.exitCode === 0
				? remotesRes.stdout
						.split("\n")
						.map(r => r.trim())
						.filter(Boolean)
				: [];
		const commits: {
			hash: string;
			shortHash: string;
			author: string;
			timestamp: number;
			refs: { kind: "head" | "local" | "remote" | "tag"; name: string }[];
			parents: string[];
			subject: string;
		}[] = [];
		for (const record of logRes.stdout.split("\x1e")) {
			const trimmed = record.replace(/^\n/, "");
			if (!trimmed.trim()) continue;
			const [hash, shortHash, author, at, deco, parentsRaw, subject] = trimmed.split("\x1f");
			if (!hash || !shortHash) continue;
			const refs: { kind: "head" | "local" | "remote" | "tag"; name: string }[] = [];
			for (const d of (deco ?? "").split(/,\s*/)) {
				const ref = d.trim();
				if (!ref) continue;
				const arrow = /^HEAD -> (.+)$/.exec(ref);
				if (arrow) refs.push({ kind: "head", name: arrow[1]! });
				else if (ref === "HEAD") refs.push({ kind: "head", name: "HEAD" });
				else if (ref.startsWith("tag: ")) refs.push({ kind: "tag", name: ref.slice(5) });
				else if (remoteNames.some(r => ref.startsWith(`${r}/`))) refs.push({ kind: "remote", name: ref });
				else refs.push({ kind: "local", name: ref });
			}
			commits.push({
				hash,
				shortHash,
				author: author ?? "",
				timestamp: Number.parseInt(at ?? "0", 10) * 1000,
				refs,
				parents: (parentsRaw ?? "").split(" ").filter(Boolean),
				subject: subject ?? "",
			});
		}
		const hasMore = commits.length > limit;
		return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
	}

	async diff(params: unknown): Promise<unknown> {
		// Working-tree diff for the right-pane workspace-changes view. The
		// optional content pairs give Monaco the real HEAD/index/worktree
		// versions; unified patches remain available as a bounded fallback.
		const p = (params ?? {}) as { maxLines?: number; path?: string; cwd?: unknown; content?: unknown };
		const maxLines = Math.min(500, Math.max(20, p.maxLines ?? 200));
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const rootResult = await runGitRead(cwd, ["rev-parse", "--show-toplevel"]);
		if (rootResult.exitCode !== 0) return { error: "not a git repository" };
		const root = rootResult.stdout.trim();
		const files = p.path ? [p.path] : undefined;
		const [statusResult, stagedRaw, unstagedRaw] = await Promise.all([
			runGitRead(cwd, ["status", "--short"]),
			gitDiff(cwd, { cached: true, files, allowFailure: true }),
			gitDiff(cwd, { files, allowFailure: true }),
		]);
		const cap = (text: string): string =>
			text.length > maxLines * 400 ? `${text.slice(0, maxLines * 400)}\n… (truncated)` : text;
		const result = {
			root,
			status: statusResult.stdout.trim(),
			staged: cap(stagedRaw),
			unstaged: cap(unstagedRaw),
		};
		if (p.content !== true) return result;
		if (!p.path) return { ...result, contentError: "content requires a file path" };
		const absolute = path.resolve(root, p.path);
		const relative = path.relative(root, absolute);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			return { ...result, contentError: "path is outside the repository" };
		}
		const repoPath = relative.split(path.sep).join("/");
		const readObject = async (objectName: string): Promise<string | null> => {
			try {
				return await gitReadBlob(root, objectName);
			} catch {
				return null;
			}
		};
		const readWorking = async (): Promise<string | null> => {
			try {
				return await fs.promises.readFile(absolute, "utf8");
			} catch (error) {
				return (error as { code?: string }).code === "ENOENT" ? "" : null;
			}
		};
		const [head, index, working, untrackedStatus] = await Promise.all([
			stagedRaw ? readObject(`HEAD:${repoPath}`) : null,
			stagedRaw || unstagedRaw ? readObject(`:${repoPath}`) : null,
			unstagedRaw || !stagedRaw ? readWorking() : null,
			!stagedRaw && !unstagedRaw ? runGitRead(root, ["status", "--short", "--", repoPath]) : null,
		]);
		const contentPair = (
			original: string | null,
			modified: string | null,
		): { original: string; modified: string } | null => {
			if (original === null || modified === null) return null;
			if (original.includes("\0") || modified.includes("\0")) return null;
			if (Buffer.byteLength(original) > 2 * 1024 * 1024 || Buffer.byteLength(modified) > 2 * 1024 * 1024) {
				return null;
			}
			return { original, modified };
		};
		const stagedContent = stagedRaw
			? contentPair(
					head ?? (stagedRaw.includes("new file mode") ? "" : null),
					index ?? (stagedRaw.includes("deleted file mode") ? "" : null),
				)
			: null;
		const unstagedContent = unstagedRaw
			? contentPair(index, working)
			: untrackedStatus?.stdout.startsWith("?? ")
				? contentPair("", working)
				: null;
		return {
			...result,
			...(stagedContent ? { stagedContent } : {}),
			...(unstagedContent ? { unstagedContent } : {}),
		};
	}

	async show(params: unknown): Promise<unknown> {
		// One commit: metadata plus the patch that commit introduced.
		//
		// Two calls because git has no single command for both: `show -s`
		// with a NUL-separated format for the metadata (a message
		// containing newlines survives it, which a space-separated format
		// does not), and `diff-tree -p` against the first parent for the
		// patch. A root commit has no parent, so it diffs against the empty
		// tree — otherwise a repository's first commit renders as an empty
		// change, which reads as "this commit did nothing".
		const p = (params ?? {}) as { revision?: unknown; maxLines?: unknown; cwd?: unknown };
		const revision = typeof p.revision === "string" && p.revision.length > 0 ? p.revision : "HEAD";
		const maxLines = Math.min(2000, Math.max(20, Number(p.maxLines) || 400));
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());

		const [meta, parents, patch] = await Promise.all([
			runGitRead(cwd, ["show", "-s", "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%B", revision]),
			runGitRead(cwd, ["rev-list", "--parents", "-n", "1", revision]),
			runGitRead(cwd, ["diff-tree", "-r", "-p", "--root", revision]),
		]);
		if (meta.exitCode !== 0) return { error: "not found or not a git repository" };
		const [hash = "", shortHash = "", name = "", email = "", date = "", parentLine = "", ...messageParts] =
			meta.stdout.split("\0");
		const parentList = parents.exitCode === 0 ? parents.stdout.trim().split(/\s+/).slice(1) : [];
		const truncated =
			patch.exitCode === 0 && patch.stdout.length > maxLines * 400
				? `${patch.stdout.slice(0, maxLines * 400)}\n… (truncated)`
				: patch.stdout;
		return {
			revision: hash.trim(),
			shortHash: shortHash.trim(),
			author: { name, email, date: date.trim() },
			// `%B` is the raw body and git terminates it with the blank line
			// that separates it from the next record — two newlines, not one.
			// Stripping a single trailing newline leaves the message with a
			// phantom trailing blank line in every view that renders it.
			message: messageParts.join("\0").replace(/\n+$/, ""),
			parents: parentList.filter(Boolean),
			diff: truncated,
		};
	}

	async changedFiles(params: unknown): Promise<unknown> {
		// Changed paths between two tree-ish objects, or the working tree
		// when neither is given. The panel needs this to decide which files
		// to fetch a diff for, and asking for a diff of every tracked path
		// to find out which ones moved is the expensive way round.
		const p = (params ?? {}) as { base?: unknown; head?: unknown; cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const base = typeof p.base === "string" && p.base.length > 0 ? p.base : undefined;
		const head = typeof p.head === "string" && p.head.length > 0 ? p.head : undefined;
		const args = base && head ? ["diff", "--name-only", base, head] : ["status", "--porcelain"];
		const res = await runGitRead(cwd, args);
		if (res.exitCode !== 0) return { error: "not a git repository" };
		const files = res.stdout
			.split("\n")
			.filter(line => line.trim() !== "")
			// A porcelain line is `<XY> <path>` — exactly three leading columns
			// whose width is the whole point, so the line must NOT be trimmed
			// before the path is sliced off. Trimming first drops the
			// leading space of an unstaged change and the slice then eats
			// the first characters of the filename.
			.map(line => (base && head ? line.trim() : line.slice(3)));
		return { files };
	}

	async numstat(params: unknown): Promise<unknown> {
		// Per-file added/removed counts. A panel renders "＋n −m" per file
		// and computes its own bar widths, and asking it to count lines out
		// of a diff means shipping every diff to count them in the client.
		const p = (params ?? {}) as { path?: unknown; cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const fileArgs = typeof p.path === "string" && p.path.length > 0 ? ["--", p.path] : [];
		const res = await runGitRead(cwd, ["diff", "--numstat", ...fileArgs]);
		if (res.exitCode !== 0) return { error: "not a git repository" };
		const files = res.stdout
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => {
				const [added = "", removed = "", file = ""] = line.split("\t");
				return {
					path: file,
					// `-` counts appear for a binary file, which has no lines to
					// count; passing it through would render as arithmetic on
					// a minus sign.
					added: added === "-" ? 0 : Number(added) || 0,
					removed: removed === "-" ? 0 : Number(removed) || 0,
					binary: added === "-" || removed === "-",
				};
			});
		return { files };
	}

	async discard(params: unknown): Promise<unknown> {
		// Throw away one file's unstaged edits.
		//
		// `--worktree` alone is the whole point: a staged change stays
		// staged. Discarding both would silently undo something the person
		// had deliberately prepared for a commit, which is not what "throw
		// away this file's edits" means.
		const p = (params ?? {}) as { path?: unknown; cwd?: unknown };
		const file = typeof p.path === "string" ? p.path : "";
		if (!file) return { error: "path required" };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		// `--` after the flag list: a path beginning with a dash is a legal
		// filename, and without this git reads it as an option.
		await gitRestore(cwd, { files: [file], worktree: true });
		return { ok: true };
	}

	async revert(params: unknown): Promise<unknown> {
		// Add a commit that undoes an earlier one, leaving history intact.
		//
		// `git revert` rather than `reset --hard`: this is the operation a
		// person wants from a "revert this commit" button, and the other one
		// is data loss they did not ask for.
		const p = (params ?? {}) as { hash?: unknown; cwd?: unknown };
		const hash = typeof p.hash === "string" ? p.hash.trim() : "";
		if (!hash) return { error: "hash required" };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		await runGitWrite(cwd, ["revert", "--no-edit", hash]);
		return { ok: true };
	}

	async status(params: unknown): Promise<unknown> {
		// Structured working-tree state for the changes tree: branch,
		// ahead/behind vs upstream, and per-file staged/unstaged/
		// untracked lists (parsed from `status --porcelain=v1`).
		// `ignored: true` also lists gitignored files (--ignored flag,
		// parsed from the `!!` lines) — the settings Git tab toggle.
		// `numstat: true` additionally sums line insertions/deletions
		// (`diff HEAD --numstat`, staged+unstaged vs HEAD) for the
		// floating status card's +N/−M badge.
		//
		// Async spawns (NOT spawnSync — that froze the whole daemon
		// event loop, stalling every session's turn while git ran),
		// and the probes run concurrently instead of serially.
		const p = (params ?? {}) as { ignored?: boolean; numstat?: boolean; cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const run = (args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
			const proc = Bun.spawn({
				cmd: ["git", ...args],
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			// Belt-and-braces: a hung git (network FS, hooks) must
			// never pin the RPC open forever.
			setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// already exited
				}
			}, 10_000);
			return Promise.all([
				proc.exited.catch(() => null),
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
		};
		const [root, branchRaw, aheadRaw, statusRaw, stagedNumstatRaw, workingNumstatRaw] = await Promise.all([
			run(["rev-parse", "--show-toplevel"]),
			run(["branch", "--show-current"]),
			run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
			run(["status", "--porcelain=v1", ...(p.ignored ? ["--ignored"] : [])]),
			p.numstat === true ? run(["diff", "--cached", "--numstat"]) : Promise.resolve(null),
			p.numstat === true ? run(["diff", "--numstat"]) : Promise.resolve(null),
		]);
		if (root.exitCode !== 0) return { error: "not a git repository" };
		const staged: { path: string; status: string }[] = [];
		const unstaged: { path: string; status: string }[] = [];
		const untracked: { path: string; status: string }[] = [];
		const ignored: { path: string; status: string }[] = [];
		for (const line of statusRaw.stdout.toString().split("\n")) {
			if (!line) continue;
			const x = line[0] ?? " ";
			const y = line[1] ?? " ";
			const file = line.slice(3);
			if (x === "!" && y === "!") ignored.push({ path: file, status: "!!" });
			else if (x === "?" && y === "?") untracked.push({ path: file, status: "??" });
			else {
				if (x !== " " && x !== "?") staged.push({ path: file, status: x });
				if (y !== " ") unstaged.push({ path: file, status: y });
			}
		}
		let ahead = 0;
		let behind = 0;
		if (aheadRaw.exitCode === 0) {
			const [a, b] = aheadRaw.stdout
				.toString()
				.trim()
				.split(/\s+/)
				.map((n: string) => Number.parseInt(n, 10) || 0);
			ahead = a;
			behind = b;
		}
		// Per-file line stats split by Git scope, matching the changes
		// tree's staged/working groups. Binary files report "-" and carry
		// no line count. The aggregate mirrors HEAD -> working tree, so a
		// file edited in both scopes contributes to both maps.
		interface FileStats {
			added: number;
			removed: number;
			binary: boolean;
		}
		const parseNumstat = (raw: typeof stagedNumstatRaw): Record<string, FileStats> => {
			const map: Record<string, FileStats> = {};
			if (raw?.exitCode !== 0) return map;
			for (const line of raw.stdout.split("\n")) {
				const [addedRaw = "", removedRaw = "", rawFile = ""] = line.split("\t");
				if (!rawFile) continue;
				// Renames render as "old => new"; the status tree keys on
				// the destination path.
				const file = rawFile.includes(" => ") ? rawFile.slice(rawFile.lastIndexOf(" => ") + 4).trim() : rawFile;
				map[file] = {
					added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10) || 0,
					removed: removedRaw === "-" ? 0 : Number.parseInt(removedRaw, 10) || 0,
					binary: addedRaw === "-" || removedRaw === "-",
				};
			}
			return map;
		};
		let added: number | undefined;
		let deleted: number | undefined;
		let fileStats: { staged: Record<string, FileStats>; working: Record<string, FileStats> } | undefined;
		if (p.numstat === true) {
			const stagedStats = parseNumstat(stagedNumstatRaw);
			const workingStats = parseNumstat(workingNumstatRaw);
			fileStats = { staged: stagedStats, working: workingStats };
			let totalAdded = 0;
			let totalRemoved = 0;
			for (const stats of [...Object.values(stagedStats), ...Object.values(workingStats)]) {
				totalAdded += stats.added;
				totalRemoved += stats.removed;
			}
			added = totalAdded;
			deleted = totalRemoved;
		}
		return {
			root: root.stdout.toString().trim(),
			branch: branchRaw.exitCode === 0 ? branchRaw.stdout.toString().trim() : null,
			ahead,
			behind,
			staged,
			unstaged,
			untracked,
			ignored: p.ignored ? ignored : undefined,
			added,
			deleted,
			fileStats,
		};
	}

	async stage(params: unknown): Promise<unknown> {
		// Stage paths into the index (changes panel + button).
		const p = (params ?? {}) as Record<string, unknown>;
		const paths = Array.isArray(p.paths) ? (p.paths as string[]).filter(x => typeof x === "string") : [];
		const cwd = path.resolve(
			typeof p.cwd === "string" && (p.cwd as string).length > 0 ? (p.cwd as string) : this.cwd(),
		);
		const proc = Bun.spawn({
			cmd: ["git", "add", "--", ...paths],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
		}, 10_000);
		const [exit, err] = await Promise.all([proc.exited.catch(() => null), new Response(proc.stderr).text()]);
		if (exit !== 0) return { error: err.trim() || "git add failed" };
		return { ok: true };
	}

	async unstage(params: unknown): Promise<unknown> {
		// Unstage paths (git restore --staged, fallback reset HEAD).
		const p = (params ?? {}) as Record<string, unknown>;
		const paths = Array.isArray(p.paths) ? (p.paths as string[]).filter(x => typeof x === "string") : [];
		const cwd = path.resolve(
			typeof p.cwd === "string" && (p.cwd as string).length > 0 ? (p.cwd as string) : this.cwd(),
		);
		const proc = Bun.spawn({
			cmd: ["git", "restore", "--staged", "--", ...paths],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
		}, 10_000);
		const [exit] = await Promise.all([proc.exited.catch(() => null), new Response(proc.stderr).text()]);
		if (exit !== 0) {
			// Older git (pre-2.23) lacks restore — fall back to reset.
			const proc2 = Bun.spawn({
				cmd: ["git", "reset", "HEAD", "--", ...paths],
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			const [exit2, err2] = await Promise.all([proc2.exited.catch(() => null), new Response(proc2.stderr).text()]);
			if (exit2 !== 0) return { error: err2.trim() || "git unstage failed" };
		}
		return { ok: true };
	}

	async commit(params: unknown): Promise<unknown> {
		// Commit the staged index. Identity (settings Git tab 身份) is
		// injected per-commit with -c (never writes the repo's local
		// config — persist it here instead, but a desktop
		// setting must not silently mutate the user's repo).
		const p = (params ?? {}) as Record<string, unknown>;
		const message = typeof p.message === "string" ? p.message : "";
		if (!message.trim()) throw new Error("message required");
		const id = (p.identity ?? {}) as Record<string, unknown>;
		const identity = {
			name: typeof id.name === "string" ? id.name : undefined,
			email: typeof id.email === "string" ? id.email : undefined,
		};
		const cwd = path.resolve(
			typeof p.cwd === "string" && (p.cwd as string).length > 0 ? (p.cwd as string) : this.cwd(),
		);
		const args: string[] = [];
		if (identity.name) args.push("-c", `user.name=${identity.name}`);
		if (identity.email) args.push("-c", `user.email=${identity.email}`);
		const [subject, ...body] = message.trim().split("\n");
		const proc = Bun.spawn({
			cmd: ["git", ...args, "commit", "-m", subject, ...(body.length ? ["-m", body.join("\n").trim()] : [])],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
		}, 15_000);
		const [exit, out, err] = await Promise.all([
			proc.exited.catch(() => null),
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (exit !== 0) return { error: err.trim() || out.trim() || "git commit failed" };
		return { ok: true, summary: (out.toString() || err.toString()).trim() };
	}

	async branches(params: unknown): Promise<unknown> {
		// Local branch list + current branch for the welcome/new-session
		// branch selector. Runs in the caller's
		// cwd; not a git repo → { error }.
		const p = (params ?? {}) as { cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const current = Bun.spawnSync({
			cmd: ["git", "branch", "--show-current"],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const list = Bun.spawnSync({
			cmd: ["git", "for-each-ref", "refs/heads", "--format=%(refname:short)"],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		if (current.exitCode !== 0 || list.exitCode !== 0) return { error: "not a git repository" };
		const branches = list.stdout
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b));
		return {
			current: current.stdout.toString().trim() || null,
			branches,
		};
	}

	async identity(params: unknown): Promise<unknown> {
		// Commit identity the way git resolves it: `git config user.*`
		// walks local → global → system, so one read reports the
		// effective value. `source` says whether the repo pins its
		// own identity (local) or inherits the machine's (global).
		const p = (params ?? {}) as { cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const read = (args: string[]): { exitCode: number; stdout: string } => {
			const res = Bun.spawnSync({
				cmd: ["git", ...args],
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			return { exitCode: res.exitCode ?? 1, stdout: res.stdout.toString().trim() };
		};
		const root = read(["rev-parse", "--show-toplevel"]);
		// Outside a repo git still knows the machine-wide identity —
		// `git config user.*` resolves global/system without a
		// repository, so a non-repo cwd degrades to that instead of
		// reporting nothing.
		const name = read(["config", "user.name"]).stdout || null;
		const email = read(["config", "user.email"]).stdout || null;
		const localEmail = read(["config", "--local", "--get", "user.email"]);
		const source =
			root.exitCode !== 0
				? ("global" as const)
				: localEmail.exitCode === 0 && localEmail.stdout
					? ("local" as const)
					: ("global" as const);
		return { name, email, source };
	}

	async push(params: unknown): Promise<unknown> {
		// Push the repo's current branch. First try a plain `git
		// push`; a branch with no upstream asks for `-u`, so retry
		// with `-u origin HEAD` when git says so. Async spawn + 30s
		// cap: the first push of a branch can be slow.
		const p = (params ?? {}) as { cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const run = (args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
			const proc = Bun.spawn({
				cmd: ["git", ...args],
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// already exited
				}
			}, 30_000);
			return Promise.all([
				proc.exited.catch(() => null),
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
		};
		let res = await run(["push"]);
		if (
			res.exitCode !== 0 &&
			/(set the remote as upstream|upstream branch|no upstream)/i.test(`${res.stderr}\n${res.stdout}`)
		) {
			res = await run(["push", "-u", "origin", "HEAD"]);
		}
		if (res.exitCode !== 0) {
			return { ok: false, error: (res.stderr.trim() || res.stdout.trim() || "git push failed").slice(0, 500) };
		}
		return { ok: true };
	}

	async fetch(params: unknown): Promise<unknown> {
		// Fetch every remote in one shot — no per-remote bookkeeping
		// needed for a panel-sized sync control. 30s cap: network.
		const p = (params ?? {}) as { cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const res = await runGit(cwd, ["fetch", "--all"]);
		if (res.exitCode !== 0) {
			return {
				ok: false,
				error: (res.stderr.trim() || res.stdout.trim() || "git fetch failed").slice(0, 500),
			};
		}
		return { ok: true };
	}

	async pull(params: unknown): Promise<unknown> {
		// Pull = fetch + rebase, never a merge commit: local commits
		// replay on top of the fetched ones. `--no-autostash` keeps a
		// dirty tree a loud, recoverable error instead of a silent
		// autostash.
		const p = (params ?? {}) as { cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const res = await runGit(cwd, ["pull", "--rebase", "--no-autostash"]);
		if (res.exitCode !== 0) {
			return { ok: false, error: (res.stderr.trim() || res.stdout.trim() || "git pull failed").slice(0, 500) };
		}
		return { ok: true };
	}

	async stashList(params: unknown): Promise<unknown> {
		// Stash entries for the right-panel stash tab: ref, subject
		// (the -m message), relative age, commit hash — \x1f fields,
		// one entry per line.
		const p = (params ?? {}) as { cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const res = await runGit(cwd, ["stash", "list", "--format=%gd%x1f%gs%x1f%cr%x1f%H"]);
		if (res.exitCode !== 0) return { stashes: [] };
		const stashes = res.stdout
			.split("\n")
			.map(line => line.trim())
			.filter(line => line !== "")
			.map(line => {
				const [ref, message, age, hash] = line.split("\x1f");
				return { ref: ref ?? "", message: message ?? "", age: age ?? "", hash: hash ?? "" };
			});
		return { stashes };
	}

	async stashPush(params: unknown): Promise<unknown> {
		// Stash working-tree + staged changes, untracked included. A
		// clean tree is NOT an error — `{ok: true, empty: true}` lets
		// the panel skip the refresh.
		const p = (params ?? {}) as { cwd?: unknown; message?: unknown; includeUntracked?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const message = typeof p.message === "string" && p.message.trim() !== "" ? p.message.trim() : undefined;
		const args = ["stash", "push", "--include-untracked"];
		if (message) args.push("-m", message);
		const res = await runGit(cwd, args);
		const out = `${res.stderr}\n${res.stdout}`;
		if (res.exitCode !== 0) {
			if (/no local changes|no changes/i.test(out)) return { ok: true, empty: true };
			return { ok: false, error: out.trim().slice(0, 500) };
		}
		return { ok: true, empty: /no local changes/i.test(out) };
	}

	async stashPop(params: unknown): Promise<unknown> {
		// Apply a stash and drop it (ref defaults to the newest). A
		// conflicted pop keeps the stash: git reports it and exits 1,
		// which is the correct outcome to surface.
		const p = (params ?? {}) as { cwd?: unknown; ref?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const ref = typeof p.ref === "string" && p.ref.trim() !== "" ? p.ref.trim() : "stash@{0}";
		const res = await runGit(cwd, ["stash", "pop", ref]);
		if (res.exitCode !== 0) {
			return { ok: false, error: (res.stderr.trim() || "git stash pop failed").slice(0, 500) };
		}
		return { ok: true };
	}

	async stashDrop(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: unknown; ref?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const ref = typeof p.ref === "string" && p.ref.trim() !== "" ? p.ref.trim() : "stash@{0}";
		const res = await runGit(cwd, ["stash", "drop", ref]);
		if (res.exitCode !== 0) {
			return { ok: false, error: (res.stderr.trim() || "git stash drop failed").slice(0, 500) };
		}
		return { ok: true };
	}

	async checkout(params: unknown): Promise<unknown> {
		// Switch the repo's branch (welcome branch selector, status-card
		// branch menu). Caller's cwd; uncommitted changes are git's
		// problem (checkout fails with a clear stderr, surfaced to the
		// GUI toast). `create` → `checkout -b` (create + check out in
		// one step, status-card "create branch" parity).
		const p = (params ?? {}) as { cwd?: unknown; branch?: unknown; create?: unknown };
		const branch = typeof p.branch === "string" && p.branch.length > 0 ? p.branch : "";
		if (!branch) throw new Error("branch required");
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		const proc = Bun.spawnSync({
			cmd: p.create === true ? ["git", "checkout", "-b", branch] : ["git", "checkout", branch],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		if (proc.exitCode !== 0) return { error: proc.stderr.toString().trim() || "git checkout failed" };
		return { ok: true };
	}

	async worktrees(params: unknown): Promise<unknown> {
		// Linked-worktree list for the sidebar's worktree switcher:
		// path, HEAD, branch per entry, plus a `prunable` flag for
		// worktrees whose directory vanished outside git. Central
		// git.worktree.list is the async spawn — NOT spawnSync, which
		// froze the whole daemon on a hung git.
		const p = (params ?? {}) as { cwd?: unknown };
		const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.cwd());
		try {
			const entries = await gitWorktrees.list(cwd);
			return {
				worktrees: entries.map(e => ({
					// Main worktree has no `branch` line in porcelain
					// when checked out; detached ones have none at all.
					head: (e.head ?? "").trim(),
					name: path.basename(e.path),
					branch: (e.branch ?? "").replace(/^refs\/heads\//, ""),
					path: e.path,
					prunable: false,
				})),
			};
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
}
