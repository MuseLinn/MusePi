/**
 * Session-scoped git worktrees: create an isolated `git worktree` on a new (or
 * existing) branch and hand back its path, so a GUI/TUI session can then be
 * re-rooted there (`SessionManager.moveSession`, reachable from the GUI through
 * the existing `/move` slash command).
 *
 * This is deliberately separate from the other two worktree consumers:
 *   - task isolation (`task/worktree.ts`) makes throwaway trees for subagents;
 *   - `gh-pr-checkout.ts` makes a tree for a PR branch that the AGENT uses by
 *     explicit path.
 * Neither re-roots the session, which is the whole point of the GUI's
 * "move to new worktree" action.
 *
 * Layout follows the existing agent-managed convention (`~/.musepi/wt`, or the
 * `worktree.base` setting / `MUSEPI_WORKTREE_DIR`): one directory per
 * branch+repo, so two repos can use the same branch name without colliding.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getWorktreeDir, hashPath } from "@musepi/pi-utils";
import { getRepoRoot } from "../task/worktree";
import * as git from "./git";

export interface CreateSessionWorktreeOptions {
	/** Session cwd — the worktree is created for the repo that contains it. */
	cwd: string;
	/** Branch to check out. Created when `createBranch` (default) is set. */
	branch?: string;
	/** Start point for a NEW branch (default `HEAD`). Ignored when reusing. */
	startPoint?: string;
	/** Create the branch (`-b`) instead of checking out an existing one. */
	createBranch?: boolean;
}

export interface SessionWorktreeResult {
	/** Absolute path of the worktree — hand this to `moveSession`. */
	path: string;
	branch: string;
	/** Repo root the worktree belongs to. */
	repoRoot: string;
	/** True when an already-registered worktree was returned as-is. */
	reused: boolean;
}

/** Branch → single fs-safe directory segment (`feat/x` → `feat-x`). */
export function worktreeSegment(branch: string, repoRoot: string): string {
	const safe = branch
		.replace(/[\\/]+/g, "-")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	// Suffix pins the repo: two projects may legitimately use the same branch.
	return `${safe || "worktree"}-${hashPath(repoRoot)}`;
}

function defaultBranch(): string {
	return `musepi/session-${Date.now().toString(36)}`;
}

/**
 * Create (or reuse) a worktree for `cwd`'s repo and return its path.
 *
 * Errors are surfaced verbatim — "not a git repository", the git stderr for a
 * conflicting branch, or the explicit refusal below — because the GUI shows
 * them directly. Nothing is deleted here: a colliding *unregistered* directory
 * is reported, never removed.
 */
export async function createSessionWorktree(options: CreateSessionWorktreeOptions): Promise<SessionWorktreeResult> {
	const branch = (options.branch ?? "").trim() || defaultBranch();
	// `getRepoRoot` reports in task-isolation terms ("… for isolated task
	// execution"), which is the wrong vocabulary for a GUI toast — re-wrap.
	const repoRoot = await getRepoRoot(options.cwd).catch(() => {
		throw new Error(`Not a git repository: ${options.cwd}`);
	});
	const target = getWorktreeDir(worktreeSegment(branch, repoRoot));

	const registered = await git.worktree.list(repoRoot).catch(() => []);
	const existing = registered.find(entry => path.resolve(entry.path) === path.resolve(target));
	if (existing) {
		// `git worktree list` reports forward slashes even on Windows — resolve
		// so a reused path is byte-identical to a freshly created one (the client
		// hands it straight to `/move`).
		return { path: path.resolve(existing.path), branch: existing.branch ?? branch, repoRoot, reused: true };
	}
	// Branch already checked out in the main tree (or elsewhere): git would
	// refuse anyway, but a directory collision is worth its own message.
	const onDisk = await fs
		.stat(target)
		.then(() => true)
		.catch(() => false);
	if (onDisk) {
		throw new Error(
			`Worktree path already exists but is not a registered worktree: ${target}. Remove it, or pick another branch name.`,
		);
	}

	await fs.mkdir(getWorktreeDir(""), { recursive: true });
	await git.worktree.add(repoRoot, target, branch, {
		createBranch: options.createBranch ?? true,
		...(options.startPoint ? { startPoint: options.startPoint } : {}),
	});
	return { path: path.resolve(target), branch, repoRoot, reused: false };
}
