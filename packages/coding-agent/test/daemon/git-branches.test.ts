/**
 * Daemon git branch RPCs (welcome/new-session branch selector): list local
 * branches + current, and checkout. Runs git in the caller's cwd.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";

async function tmpRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-git-"));
	const run = (args: string[]): void => {
		const res = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
	};
	run(["init", "-q", "-b", "main"]);
	await fs.promises.writeFile(path.join(dir, "a.txt"), "hi");
	run(["add", "a.txt"]);
	run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
	run(["branch", "feature/x"]);
	return dir;
}

describe("daemon git branch RPCs", () => {
	test("git.branches lists current + local branches", async () => {
		const repo = await tmpRepo();
		const daemon = await startDaemon({ socketPath: path.join(repo, "d.sock"), wsPort: 0 });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));
			const res = await new Promise<any>(resolve => {
				ws.addEventListener("message", ev => resolve(JSON.parse((ev as MessageEvent).data as string)), { once: true });
				ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "git.branches", params: { cwd: repo } }));
			});
			expect(res.result).toEqual({ current: "main", branches: ["feature/x", "main"] });
			ws.close();
		} finally {
			await daemon.close();
		}
	});

	test("git.log graph mode returns commit-graph ASCII", async () => {
		const repo = await tmpRepo();
		// Give it a fork: feature commit on a side branch.
		const run = (args: string[]): void => {
			const res = Bun.spawnSync({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" });
			if (res.exitCode !== 0) throw new Error(res.stderr.toString());
		};
		run(["checkout", "-qb", "side"]);
		run(["commit", "-q", "--allow-empty", "-m", "side"]);
		run(["checkout", "-q", "main"]);
		const daemon = await startDaemon({ socketPath: path.join(repo, "d.sock"), wsPort: 0 });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));
			const res = await new Promise<any>(resolve => {
				ws.addEventListener("message", ev => resolve(JSON.parse((ev as MessageEvent).data as string)), { once: true });
				ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "git.log", params: { cwd: repo, graph: true } }));
			});
			expect(typeof res.result.graph).toBe("string");
			expect(res.result.graph).toContain("*");
			expect(res.result.graph).toContain("side");
			ws.close();
		} finally {
			await daemon.close();
		}
	});

	test("git.checkout switches branch; non-repo cwd errors", async () => {
		const repo = await tmpRepo();
		const daemon = await startDaemon({ socketPath: path.join(repo, "d.sock"), wsPort: 0 });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));
			const call = (id: number, method: string, params: unknown): Promise<any> =>
				new Promise(resolve => {
					const onMsg = (ev: MessageEvent): void => {
						const m = JSON.parse(ev.data as string);
						if (m.id === id) {
							ws.removeEventListener("message", onMsg);
							resolve(m);
						}
					};
					ws.addEventListener("message", onMsg);
					ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
				});
			const checkout = await call(1, "git.checkout", { cwd: repo, branch: "feature/x" });
			expect(checkout.result).toEqual({ ok: true });
			const after = await call(2, "git.branches", { cwd: repo });
			expect(after.result.current).toBe("feature/x");
			const bare = await call(3, "git.branches", { cwd: path.dirname(repo) });
			expect(bare.result.error).toBe("not a git repository");
			ws.close();
		} finally {
			await daemon.close();
		}
	});
});
