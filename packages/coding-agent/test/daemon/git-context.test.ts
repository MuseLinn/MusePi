/**
 * `git.context` — the session git scene the review surface will read.
 *
 * These run against real repositories because every part worth checking is a
 * git output shape: porcelain `-z` rename records, numstat rename/binary rows,
 * merge-base against a base branch, and upstream divergence. A stubbed `git`
 * would agree with the wrong answer in exactly those places.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { GitContextService } from "../../src/daemon/services/git-context-service";
import { readGitContext } from "../../src/git/context";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function writeFile(root: string, name: string, body: string | Uint8Array): void {
	const file = path.join(root, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
}

/** Initialise a repository whose default branch is `main`, with one commit. */
function initRepo(): { dir: string; initialCommit: string } {
	const dir = tempDir("musepi-git-context-");
	runGit(dir, ["init", "-q", "-b", "main"]);
	runGit(dir, ["config", "user.email", "t@t"]);
	runGit(dir, ["config", "user.name", "Ada"]);
	writeFile(dir, "README.md", "hello\n");
	runGit(dir, ["add", "."]);
	runGit(dir, ["commit", "-q", "-m", "init"]);
	return { dir, initialCommit: runGit(dir, ["rev-parse", "HEAD"]) };
}

describe("git.context", () => {
	test("reports branch, base fork point, file kinds, and numstat", async () => {
		const { dir, initialCommit } = initRepo();
		runGit(dir, ["checkout", "-q", "-b", "feature"]);
		writeFile(dir, "src/app.ts", "export const a = 1;\n");
		runGit(dir, ["add", "."]);
		runGit(dir, ["commit", "-q", "-m", "feature work"]);
		const featureCommit = runGit(dir, ["rev-parse", "HEAD"]);

		// Unstaged edit after the commit, plus untracked text and binary files:
		// the panel sees all three in one snapshot.
		writeFile(dir, "src/app.ts", "export const a = 1;\nexport const b = 2;\n");
		writeFile(dir, "test/new.test.ts", "one\ntwo\nthree\n");
		writeFile(dir, "assets/logo.bin", Buffer.from([0, 1, 2, 0, 255]));

		const result = await readGitContext(dir);
		if (!result.available) throw new Error(`expected available snapshot, got ${result.reason}`);

		expect(result.root).toBe(path.resolve(dir));
		expect(result.worktree.linked).toBe(false);
		expect(result.head).toEqual({
			branch: "feature",
			detached: false,
			commit: featureCommit,
			shortCommit: featureCommit.slice(0, 7),
		});
		// No remote was configured, so there is no upstream: the divergence must
		// be absent rather than a misleading 0/0.
		expect(result.upstream).toBeNull();
		expect(result.base).toEqual({
			ref: "refs/heads/main",
			source: "local",
			forkPoint: initialCommit,
		});
		expect(result.timedOut).toBe(false);
		expect(result.truncated).toBe(false);

		const byPath = new Map(result.files.map(file => [file.path, file]));
		expect(byPath.get("src/app.ts")).toEqual({
			path: "src/app.ts",
			status: " M",
			additions: 1,
			deletions: 0,
			kind: "code",
		});
		expect(byPath.get("test/new.test.ts")).toEqual({
			path: "test/new.test.ts",
			status: "??",
			additions: 3,
			deletions: 0,
			kind: "test",
		});
		// A binary untracked file has no line count; 0 would read as an empty file.
		expect(byPath.get("assets/logo.bin")).toEqual({
			path: "assets/logo.bin",
			status: "??",
			additions: null,
			deletions: 0,
			kind: "other",
		});

		const capped = await readGitContext(dir, { maxFiles: 1 });
		if (!capped.available) throw new Error("expected available snapshot");
		expect(capped.truncated).toBe(true);
		expect(capped.files).toHaveLength(1);
	});

	test("reports a detached HEAD without inventing a branch", async () => {
		const { dir, initialCommit } = initRepo();
		runGit(dir, ["checkout", "-q", "--detach", "HEAD"]);

		const result = await readGitContext(dir);
		if (!result.available) throw new Error("expected available snapshot");
		expect(result.head.branch).toBeNull();
		expect(result.head.detached).toBe(true);
		expect(result.head.shortCommit).toBe(initialCommit.slice(0, 7));
		// The repository still has `main`, so the base is real and its fork point
		// is the detached commit itself.
		expect(result.base?.ref).toBe("refs/heads/main");
		expect(result.base?.forkPoint).toBe(initialCommit);
	});

	test("counts divergence against a configured upstream", async () => {
		const { dir } = initRepo();
		const remote = path.join(tempDir("musepi-git-context-remote-"), "origin.git");
		runGit(path.dirname(remote), ["init", "-q", "--bare", remote]);
		runGit(dir, ["remote", "add", "origin", remote]);
		runGit(dir, ["push", "-q", "-u", "origin", "main"]);

		runGit(dir, ["checkout", "-q", "-b", "feature"]);
		writeFile(dir, "src/feature.ts", "export const f = 1;\n");
		runGit(dir, ["add", "."]);
		runGit(dir, ["commit", "-q", "-m", "feature base"]);
		runGit(dir, ["push", "-q", "-u", "origin", "feature"]);
		writeFile(dir, "src/feature.ts", "export const f = 2;\n");
		runGit(dir, ["commit", "-q", "-am", "local only"]);

		const result = await readGitContext(dir);
		if (!result.available) throw new Error("expected available snapshot");
		expect(result.upstream).toEqual({ ahead: 1, behind: 0 });
	});

	test("returns a structured empty state outside a repository", async () => {
		const dir = tempDir("musepi-git-context-plain-");
		const result = await readGitContext(dir);
		expect(result).toEqual({ available: false, cwd: path.resolve(dir), reason: "not-a-repository" });
	});

	test("the service validates params and falls back to its cwd", async () => {
		const { dir } = initRepo();
		const service = new GitContextService({ cwd: () => dir });

		const fallback = await service.context({});
		expect(fallback.available).toBe(true);

		// A ref that would reach git as an option is rejected before any spawn.
		const rejected = await service.context({ base: "--upload-pack=evil" });
		expect(rejected).toEqual({
			available: false,
			cwd: path.resolve(dir),
			reason: "invalid-base",
			detail: "base must be a ref name",
		});
	});

	test("git.context is dispatched over the daemon RPC", async () => {
		// The direct-service tests above prove the computation; this one proves the
		// switch case and the registry key actually line up at runtime, which the
		// route-coverage test only checks as source text.
		const { dir } = initRepo();
		writeFile(dir, "src/app.ts", "export const a = 1;\n");
		const daemon = await startDaemon({
			socketPath: path.join(os.tmpdir(), `daemon-git-context-${crypto.randomUUID()}.sock`),
			wsPort: 0,
		});
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
			const response = await new Promise<{ result?: { available?: boolean; files?: { path: string }[] } }>(
				resolve => {
					ws.addEventListener("message", event => resolve(JSON.parse((event as MessageEvent).data as string)), {
						once: true,
					});
					ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "git.context", params: { cwd: dir } }));
				},
			);
			ws.close();
			expect(response.result?.available).toBe(true);
			expect(response.result?.files?.map(file => file.path)).toContain("src/app.ts");
		} finally {
			await daemon.close();
		}
	});
});
