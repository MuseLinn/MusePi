// ============================================================
// MusePi swarm — worktree isolation engine (pure TS, no Rust).
//
// OMP-style "user-invisible" isolation, v1 scope:
//   - baseline capture: HEAD commit + `git status --porcelain` snapshot of
//     the main working tree (uncommitted changes are NOT carried into the
//     worktree — isolation semantics: the subagent works from a clean HEAD);
//   - `git worktree add --detach <tmpdir> HEAD` per subagent (unique digest);
//   - merge-back: `git -C <wt> add -A && git diff --cached <baselineHead>`
//     (covers new/modified/deleted files AND commits the agent made inside
//     the worktree, all relative to the baseline commit) → `git apply` on
//     the main tree, but only while the main porcelain snapshot is
//     unchanged; a changed baseline (user/main agent edited concurrently)
//     or a failing apply drops the patch to `<patchesDir>/<agentId>.patch`
//     instead of force-merging;
//   - cleanup: `git worktree remove --force` after a successful merge; the
//     worktree is preserved (and reported) otherwise.
//
// Degrades loudly (never silently) to kind "none" when: not a git repo,
// git unavailable, unborn HEAD, or nested git repos (v1 does not isolate
// those). Zero pi imports — node:child_process + node:fs only.
// ============================================================

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	} catch (err) {
		const e = err as { stderr?: string | Buffer; message?: string };
		const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
		throw new Error(stderr || e?.message || String(err));
	}
}

/** Baseline of the main working tree, captured before the worktree is created. */
export interface WorktreeBaseline {
	repoRoot: string;
	headCommit: string;
	/** `git status --porcelain` snapshot — merge-back only auto-applies while this is unchanged. */
	porcelain: string;
}

export interface WorktreeIsolation {
	kind: "worktree";
	repoRoot: string;
	worktreeDir: string;
	baseline: WorktreeBaseline;
}

export interface NoIsolation {
	kind: "none";
	/** Human-readable degradation reason (surfaced to the model/user — never silent). */
	reason: string;
}

export type PreparedIsolation = WorktreeIsolation | NoIsolation;

/** True when the path lies inside a git work tree; false for non-git dirs and missing git. */
async function repoRootOf(cwd: string): Promise<string | null> {
	try {
		const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
		return top.trim() || null;
	} catch {
		return null;
	}
}

/** Discover nested git repos (`.git` dir or file) below root, excluding node_modules. Bounded walk. */
async function findNestedRepos(repoRoot: string): Promise<string[]> {
	const nested: string[] = [];
	const MAX_DIRS = 2000;
	let visited = 0;
	async function walk(dir: string): Promise<void> {
		if (visited > MAX_DIRS) return;
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			visited++;
			const full = path.join(dir, entry.name);
			try {
				await fs.access(path.join(full, ".git"));
				nested.push(path.relative(repoRoot, full));
				continue; // don't recurse into nested repos
			} catch {
				/* not a repo root */
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return nested;
}

function worktreeDirFor(repoRoot: string, agentId: string): string {
	const digest = createHash("sha256")
		.update(`${path.resolve(repoRoot)}"${agentId}"${randomBytes(6).toString("hex")}`)
		.digest("hex")
		.slice(0, 12);
	return path.join(os.tmpdir(), "musepi-wt", digest);
}

/**
 * Capture the baseline and create a detached worktree at HEAD for one
 * subagent. Degrades to { kind: "none", reason } on any precondition
 * failure — callers proceed without isolation and surface the reason.
 */
export async function prepareIsolation(cwd: string, agentId: string): Promise<PreparedIsolation> {
	const repoRoot = await repoRootOf(cwd);
	if (!repoRoot) {
		return { kind: "none", reason: `not a git repository (or git unavailable): ${cwd}` };
	}

	let headCommit: string;
	try {
		headCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
	} catch {
		return { kind: "none", reason: "repository has no commits yet (unborn HEAD)" };
	}

	const nested = await findNestedRepos(repoRoot);
	if (nested.length > 0) {
		return {
			kind: "none",
			reason: `nested git repositories are not isolated in v1: ${nested.slice(0, 3).join(", ")}`,
		};
	}

	const porcelain = await git(repoRoot, ["status", "--porcelain"]);
	const worktreeDir = worktreeDirFor(repoRoot, agentId);
	await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
	try {
		await git(repoRoot, ["worktree", "add", "--detach", worktreeDir, "HEAD"]);
	} catch (err) {
		return {
			kind: "none",
			reason: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	return {
		kind: "worktree",
		repoRoot,
		worktreeDir,
		baseline: { repoRoot, headCommit, porcelain },
	};
}

export interface MergeOutcome {
	status: "applied" | "no-changes" | "patch-saved" | "failed";
	/** Set when the patch was dropped to disk instead of applied. */
	patchPath?: string;
	/** Model/user-readable one-liner describing what happened. */
	note: string;
}

/** Apply a unified diff to a working tree via a temp patch file. */
async function applyPatch(repoRoot: string, patchText: string): Promise<void> {
	const tmp = path.join(os.tmpdir(), `musepi-wt-apply-${randomBytes(6).toString("hex")}.patch`);
	try {
		await fs.writeFile(tmp, patchText, "utf-8");
		await git(repoRoot, ["apply", "--whitespace=nowarn", tmp]);
	} finally {
		await fs.rm(tmp, { force: true });
	}
}

/** `git apply --check` against a working tree (read-only preflight). */
async function canApplyPatch(repoRoot: string, patchText: string): Promise<boolean> {
	const tmp = path.join(os.tmpdir(), `musepi-wt-check-${randomBytes(6).toString("hex")}.patch`);
	try {
		await fs.writeFile(tmp, patchText, "utf-8");
		await git(repoRoot, ["apply", "--check", "--whitespace=nowarn", tmp]);
		return true;
	} catch {
		return false;
	} finally {
		await fs.rm(tmp, { force: true });
	}
}

/**
 * Merge a subagent's worktree changes back into the main working tree.
 *
 * The patch applies cleanly → auto-apply. This deliberately lets
 * NON-CONFLICTING concurrent changes through (sibling subagents merging in
 * completion order, or a user editing files the patch doesn't touch) —
 * `git apply` itself is the conflict guard: it fails exactly when the
 * patch's context no longer matches (user/main agent/sibling touched the
 * same lines, or created the same new file), and only then do we refuse to
 * force-merge and drop the patch to `<patchesDir>/<agentId>.patch` for the
 * model/user to handle. The baseline porcelain snapshot is used for the
 * diagnostic note, not as a hard gate.
 */
export async function mergeIsolation(prep: WorktreeIsolation, patchesDir: string, agentId: string): Promise<MergeOutcome> {
	const { repoRoot, worktreeDir, baseline } = prep;

	// Stage everything the agent did (new/modified/deleted) and diff against
	// the BASELINE commit — this also folds in any commits the agent made
	// inside the worktree (its HEAD may have moved past baseline).
	let patchText: string;
	try {
		await git(worktreeDir, ["add", "-A"]);
		patchText = await git(worktreeDir, ["diff", "--cached", baseline.headCommit]);
	} catch (err) {
		return {
			status: "failed",
			note: `failed to capture worktree changes: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!patchText.trim()) {
		return { status: "no-changes", note: "isolated run produced no changes" };
	}

	const safeName = agentId.replace(/[^\w.-]+/g, "_");
	const patchPath = path.join(patchesDir, `${safeName}.patch`);
	const savePatch = async (): Promise<string> => {
		await fs.mkdir(patchesDir, { recursive: true });
		await fs.writeFile(patchPath, patchText, "utf-8");
		return patchPath;
	};

	if (await canApplyPatch(repoRoot, patchText)) {
		try {
			await applyPatch(repoRoot, patchText);
			return { status: "applied", note: "worktree changes applied to the main working tree" };
		} catch (err) {
			await savePatch();
			return {
				status: "patch-saved",
				patchPath,
				note: `git apply failed (${err instanceof Error ? err.message : String(err)}); patch saved to ${patchPath}`,
			};
		}
	}

	// Patch no longer applies — diagnose for the note, never force-merge.
	await savePatch();
	let reason: string;
	try {
		const currentPorcelain = await git(repoRoot, ["status", "--porcelain"]);
		reason =
			currentPorcelain !== baseline.porcelain
				? "main working tree changed since the subagent started and the patch conflicts with it"
				: "patch conflicts with the current main tree";
	} catch {
		reason = "main tree status unreadable and the patch does not apply";
	}
	return {
		status: "patch-saved",
		patchPath,
		note: `${reason} — not auto-merging; patch saved to ${patchPath} (apply manually with: git apply "${patchPath}")`,
	};
}

/**
 * Remove the worktree. Returns a warning string when removal failed (the
 * caller reports it and moves on — cleanup failure is never fatal).
 */
export async function cleanupIsolation(prep: WorktreeIsolation): Promise<string | undefined> {
	try {
		await git(prep.repoRoot, ["worktree", "remove", "--force", prep.worktreeDir]);
		return undefined;
	} catch (err) {
		// Best-effort fallbacks: drop the directory and prune the registration.
		try {
			await fs.rm(prep.worktreeDir, { recursive: true, force: true });
			await git(prep.repoRoot, ["worktree", "prune"]);
			return undefined;
		} catch {
			return `worktree cleanup failed for ${prep.worktreeDir}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
}
