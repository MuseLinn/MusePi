// MusePi core — swarm worktree isolation 引擎集成测试。
// 用真实临时 git 仓库覆盖：baseline 捕获、干净合并、baseline 变化→patch
// 落盘、非 git 降级、嵌套 repo 降级、worktree 清理、配置默认值/直通。
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { mergeMusepiSettings } from "../src/config/schema.ts";
import {
	cleanupIsolation,
	mergeIsolation,
	prepareIsolation,
	type WorktreeIsolation,
} from "../src/swarm/isolation.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const tmpRoots: string[] = [];
function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-iso-test-"));
	tmpRoots.push(dir);
	git(dir, ["init", "-b", "main"]);
	// Repo-local LF policy: host-global autocrlf must not leak into assertions.
	git(dir, ["config", "core.autocrlf", "false"]);
	git(dir, ["-c", "user.email=test@musepi", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init"]);
	fs.writeFileSync(path.join(dir, "a.txt"), "alpha\n");
	fs.writeFileSync(path.join(dir, "b.txt"), "bravo\n");
	git(dir, ["add", "-A"]);
	git(dir, ["-c", "user.email=test@musepi", "-c", "user.name=test", "commit", "-m", "files"]);
	return dir;
}

after(() => {
	for (const dir of tmpRoots) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

describe("swarm isolation", { skip: !hasGit() }, () => {
	it("captures baseline: HEAD commit + porcelain snapshot (dirty state excluded from worktree)", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n");
		const prep = await prepareIsolation(repo, "agent-1");
		assert.equal(prep.kind, "worktree");
		if (prep.kind !== "worktree") return;
		assert.equal(prep.baseline.headCommit, git(repo, ["rev-parse", "HEAD"]).trim());
		assert.ok(prep.baseline.porcelain.includes("dirty.txt"));
		// Worktree starts from clean HEAD: the uncommitted file is NOT carried over.
		assert.equal(fs.existsSync(path.join(prep.worktreeDir, "dirty.txt")), false);
		assert.equal(fs.readFileSync(path.join(prep.worktreeDir, "a.txt"), "utf-8"), "alpha\n");
		await cleanupIsolation(prep);
	});

	it("clean merge path: worktree changes apply back to the main tree; worktree is removed", async () => {
		const repo = makeRepo();
		const prep = (await prepareIsolation(repo, "agent-2")) as WorktreeIsolation;
		assert.equal(prep.kind, "worktree");
		// Agent edits an existing file and creates a new one inside the worktree.
		fs.writeFileSync(path.join(prep.worktreeDir, "a.txt"), "alpha-edited\n");
		fs.writeFileSync(path.join(prep.worktreeDir, "new.txt"), "brand-new\n");

		const patchesDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-iso-patches-"));
		tmpRoots.push(patchesDir);
		const outcome = await mergeIsolation(prep, patchesDir, "agent-2");
		assert.equal(outcome.status, "applied", outcome.note);
		assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf-8"), "alpha-edited\n");
		assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf-8"), "brand-new\n");

		const warn = await cleanupIsolation(prep);
		assert.equal(warn, undefined);
		assert.equal(fs.existsSync(prep.worktreeDir), false);
		assert.ok(!git(repo, ["worktree", "list"]).includes(prep.worktreeDir));
	});

	it("merges commits the agent made inside the worktree (diff against baseline commit)", async () => {
		const repo = makeRepo();
		const prep = (await prepareIsolation(repo, "agent-3")) as WorktreeIsolation;
		fs.writeFileSync(path.join(prep.worktreeDir, "committed-inside.txt"), "committed\n");
		git(prep.worktreeDir, ["add", "-A"]);
		git(prep.worktreeDir, ["-c", "user.email=t@m", "-c", "user.name=t", "commit", "-m", "agent work"]);

		const outcome = await mergeIsolation(prep, os.tmpdir(), "agent-3");
		assert.equal(outcome.status, "applied", outcome.note);
		assert.equal(fs.readFileSync(path.join(repo, "committed-inside.txt"), "utf-8"), "committed\n");
		await cleanupIsolation(prep);
	});

	it("conflicting concurrent edit → no force-merge; patch lands in patchesDir", async () => {
		const repo = makeRepo();
		const prep = (await prepareIsolation(repo, "agent-4")) as WorktreeIsolation;
		fs.writeFileSync(path.join(prep.worktreeDir, "a.txt"), "agent-edit\n");
		// Concurrent CONFLICTING edit in the main tree after the baseline.
		fs.writeFileSync(path.join(repo, "a.txt"), "user-edit\n");

		const patchesDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-iso-patches-"));
		tmpRoots.push(patchesDir);
		const outcome = await mergeIsolation(prep, patchesDir, "agent-4");
		assert.equal(outcome.status, "patch-saved", outcome.note);
		assert.ok(outcome.patchPath?.endsWith("agent-4.patch"));
		assert.ok(fs.existsSync(outcome.patchPath!));
		assert.ok(fs.readFileSync(outcome.patchPath!, "utf-8").includes("agent-edit"));
		// Main tree keeps the user's version — no clobber.
		assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf-8"), "user-edit\n");
		// Worktree preserved for manual handling — clean it up explicitly.
		await cleanupIsolation(prep);
	});

	it("non-conflicting concurrent change still merges (sibling subagent semantics)", async () => {
		const repo = makeRepo();
		const prep = (await prepareIsolation(repo, "agent-4b")) as WorktreeIsolation;
		fs.writeFileSync(path.join(prep.worktreeDir, "a.txt"), "agent-edit\n");
		// A sibling subagent (or the user) landed an UNRELATED file meanwhile.
		fs.writeFileSync(path.join(repo, "sibling.txt"), "sibling\n");

		const outcome = await mergeIsolation(prep, os.tmpdir(), "agent-4b");
		assert.equal(outcome.status, "applied", outcome.note);
		assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf-8"), "agent-edit\n");
		assert.equal(fs.readFileSync(path.join(repo, "sibling.txt"), "utf-8"), "sibling\n");
		await cleanupIsolation(prep);
	});

	it("no changes → no-changes, nothing applied", async () => {
		const repo = makeRepo();
		const prep = (await prepareIsolation(repo, "agent-5")) as WorktreeIsolation;
		const outcome = await mergeIsolation(prep, os.tmpdir(), "agent-5");
		assert.equal(outcome.status, "no-changes");
		await cleanupIsolation(prep);
	});

	it("degrades (not silently) on a non-git directory", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-iso-nogit-"));
		tmpRoots.push(dir);
		const prep = await prepareIsolation(dir, "agent-6");
		assert.equal(prep.kind, "none");
		if (prep.kind !== "none") return;
		assert.ok(prep.reason.length > 0);
	});

	it("degrades on nested git repos (v1)", async () => {
		const repo = makeRepo();
		const nestedDir = path.join(repo, "vendor", "nested");
		fs.mkdirSync(nestedDir, { recursive: true });
		git(nestedDir, ["init", "-b", "main"]);
		const prep = await prepareIsolation(repo, "agent-7");
		assert.equal(prep.kind, "none");
		if (prep.kind !== "none") return;
		assert.ok(prep.reason.includes("nested"));
	});
});

describe("swarm isolation config", () => {
	it("defaults to worktree; honors none passthrough", () => {
		assert.equal(mergeMusepiSettings(undefined).swarm.isolation, "worktree");
		assert.equal(mergeMusepiSettings({ swarm: { isolation: "none" } }).swarm.isolation, "none");
	});
});
