/**
 * Daemon `worktree.create` RPC: build (or reuse) an isolated git worktree for
 * the caller's repo and return its path. The GUI pairs it with `/move` to
 * re-root the session ("move to new worktree").
 *
 * Worktrees land under `getWorktreesDir()`, so the suite points
 * MUSEPI_WORKTREE_DIR at a temp dir — the real `~/.musepi/wt` is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { worktreeSegment } from "../../src/utils/session-worktree";

let worktreeBase: string;

beforeAll(async () => {
	worktreeBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), "musepi-wt-base-"));
	process.env.MUSEPI_WORKTREE_DIR = worktreeBase;
});

afterAll(async () => {
	delete process.env.MUSEPI_WORKTREE_DIR;
	await fs.promises.rm(worktreeBase, { recursive: true, force: true });
});

async function tmpRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-wt-"));
	const run = (args: string[], cwd = dir): string => {
		const res = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
		if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
		return res.stdout.toString();
	};
	run(["init", "-q", "-b", "main"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	await fs.promises.writeFile(path.join(dir, "a.txt"), "hi");
	run(["add", "a.txt"]);
	run(["commit", "-q", "-m", "init"]);
	return dir;
}

async function call(ws: WebSocket, id: number, method: string, params: unknown): Promise<any> {
	return await new Promise(resolve => {
		ws.addEventListener("message", ev => resolve(JSON.parse((ev as MessageEvent).data as string)), { once: true });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
	});
}

describe("daemon worktree.create", () => {
	test("creates a worktree on a new branch under the configured base", async () => {
		const repo = await tmpRepo();
		const daemon = await startDaemon({ socketPath: path.join(repo, "d.sock"), wsPort: 0 });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));

			const res = await call(ws, 1, "worktree.create", { cwd: repo, branch: "feat/wt" });
			expect(res.result?.error).toBeUndefined();
			expect(res.result.reused).toBe(false);
			expect(res.result.branch).toBe("feat/wt");
			expect(typeof res.result.path).toBe("string");
			// Confined to the temp base — never ~/.musepi/wt.
			expect(res.result.path.startsWith(worktreeBase)).toBe(true);
			expect(res.result.path).toContain(worktreeSegment("feat/wt", repo));

			// The worktree is real: the file is there and HEAD is the new branch.
			const file = await fs.promises.readFile(path.join(res.result.path, "a.txt"), "utf8");
			expect(file).toBe("hi");
			const head = Bun.spawnSync({
				cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
				cwd: res.result.path,
				stdout: "pipe",
			});
			expect(head.stdout.toString().trim()).toBe("feat/wt");

			// …and registered on the parent repo.
			const list = Bun.spawnSync({ cmd: ["git", "worktree", "list"], cwd: repo, stdout: "pipe" });
			const normalized = list.stdout.toString().replace(/\\/g, "/");
			expect(normalized.includes(res.result.path.replace(/\\/g, "/"))).toBe(true);
			ws.close();
		} finally {
			await daemon.close();
			await fs.promises.rm(repo, { recursive: true, force: true });
		}
		// `git worktree add` is a multi-second operation on Windows; the bun
		// default 5s budget is not enough for the round trip.
	}, 30_000);

	test("reuses an already-registered worktree instead of failing", async () => {
		const repo = await tmpRepo();
		const daemon = await startDaemon({ socketPath: path.join(repo, "d.sock"), wsPort: 0 });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));

			const first = await call(ws, 1, "worktree.create", { cwd: repo, branch: "same" });
			const second = await call(ws, 2, "worktree.create", { cwd: repo, branch: "same" });
			expect(second.result.reused).toBe(true);
			expect(second.result.path).toBe(first.result.path);
			ws.close();
		} finally {
			await daemon.close();
			await fs.promises.rm(repo, { recursive: true, force: true });
		}
		// `git worktree add` is a multi-second operation on Windows; the bun
		// default 5s budget is not enough for the round trip.
	}, 30_000);

	test("checks out an existing branch when createBranch is false", async () => {
		const repo = await tmpRepo();
		const run = (args: string[]): void => {
			const res = Bun.spawnSync({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" });
			if (res.exitCode !== 0) throw new Error(res.stderr.toString());
		};
		run(["branch", "existing"]);
		const daemon = await startDaemon({ socketPath: path.join(repo, "d.sock"), wsPort: 0 });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));
			const res = await call(ws, 1, "worktree.create", {
				cwd: repo,
				branch: "existing",
				createBranch: false,
			});
			expect(res.result?.error).toBeUndefined();
			const head = Bun.spawnSync({
				cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
				cwd: res.result.path,
				stdout: "pipe",
			});
			expect(head.stdout.toString().trim()).toBe("existing");
			ws.close();
		} finally {
			await daemon.close();
			await fs.promises.rm(repo, { recursive: true, force: true });
		}
		// `git worktree add` is a multi-second operation on Windows; the bun
		// default 5s budget is not enough for the round trip.
	}, 30_000);

	test("reports a readable error outside a git repository", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-nogit-"));
		const daemon = await startDaemon({ socketPath: path.join(dir, "d.sock"), wsPort: 0 });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));
			const res = await call(ws, 1, "worktree.create", { cwd: dir, branch: "x" });
			expect(res.result.error).toContain("Not a git repository");
			ws.close();
		} finally {
			await daemon.close();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
