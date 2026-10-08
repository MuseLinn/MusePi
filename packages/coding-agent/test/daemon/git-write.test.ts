/**
 * Daemon git write RPCs, and the polling view a side panel needs.
 *
 * The write cases are the ones worth running against a real repository: what
 * reaches the index afterwards is the whole contract. Discarding a file's edits
 * while leaving its staged change alone is a distinction a mock cannot check —
 * a stubbed `git restore` would happily agree with either behaviour.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";

async function tmpRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-git-write-"));
	const run = (args: string[]): void => {
		const res = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
	};
	run(["init", "-q", "-b", "main"]);
	// Repo-local identity: a CI runner has no global user, so a commit here would
	// otherwise fail and take the assertion with it.
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	fs.writeFileSync(path.join(dir, "b.txt"), "keep\n");
	run(["add", "a.txt", "b.txt"]);
	run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
	return dir;
}

/** One JSON-RPC call against a freshly started daemon, then shut it down. */
async function call<T>(repo: string, method: string, params: Record<string, unknown>): Promise<T> {
	// The daemon's files live outside the repository: inside it, `git status`
	// reports them and every assertion about what changed is really asserting
	// about the harness.
	const daemon = await startDaemon({
		socketPath: path.join(os.tmpdir(), `daemon-git-write-${crypto.randomUUID()}.sock`),
		wsPort: 0,
	});
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
		await new Promise(r => ws.addEventListener("open", r, { once: true }));
		const res = await new Promise<any>(resolve => {
			ws.addEventListener("message", ev => resolve(JSON.parse((ev as MessageEvent).data as string)), { once: true });
			ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { cwd: repo, ...params } }));
		});
		ws.close();
		// A handler that *throws* answers with a JSON-RPC error envelope, which is
		// a different thing from a handler that returns `{ error }` — the first
		// must reject here, or `rejects.toThrow` would never see it.
		if (res.error) throw new Error(String(res.error.message ?? JSON.stringify(res.error)));
		return res.result as T;
	} finally {
		await daemon.close();
	}
}

function git(cwd: string, ...args: string[]): string {
	return Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

/**
 * A file's content as git sees it, not as Node reads it.
 *
 * Checking out on Windows writes CRLF into the working tree, so reading the file
 * back through `fs` compares against a different byte sequence than the one the
 * commit holds — and a test asserting on it fails for a reason that has nothing
 * to do with the operation under test.
 */
function gitContent(cwd: string, file: string): string {
	return git(cwd, "show", `HEAD:${file}`);
}

describe("daemon git write RPCs", () => {
	test("git.discard drops a file's edits but leaves it staged", async () => {
		// The distinction the whole operation rests on: unstaged work is thrown
		// away, and what the person prepared for the next commit stays prepared.
		// Unstaging too would undo a decision they had not asked to revisit.
		//
		// Asserted through git's own view rather than by reading the file: on
		// Windows a checkout writes CRLF into the working tree, so the bytes on
		// disk are not the bytes the commit holds and comparing them says nothing
		// about whether the edit was discarded.
		const repo = await tmpRepo();
		fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");
		Bun.spawnSync({ cmd: ["git", "add", "a.txt"], cwd: repo, stdout: "pipe", stderr: "pipe" });
		fs.writeFileSync(path.join(repo, "a.txt"), "edited again\n");

		await call(repo, "git.discard", { path: "a.txt" });

		// Unstaged work gone…
		expect(git(repo, "diff", "--name-only").trim()).toBe("");
		// …and the staged version still there, still staged.
		expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("a.txt");
		expect(git(repo, "show", ":a.txt")).toBe("edited\n");
	});

	test("git.discard leaves other files alone", async () => {
		const repo = await tmpRepo();
		fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");
		fs.writeFileSync(path.join(repo, "b.txt"), "also edited\n");

		await call(repo, "git.discard", { path: "a.txt" });

		// The other file's edit survives: discarding is per-file, and a discard
		// that quietly reverted the whole tree would be the worst possible
		// reading of "throw away this one".
		const dirty = git(repo, "diff", "--name-only")
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean);
		expect(dirty).toEqual(["b.txt"]);
	});

	test("git.discard requires a path", async () => {
		// Reported, not guessed at: with no path there is nothing to discard, and
		// defaulting to the whole tree would throw away work nobody named.
		const repo = await tmpRepo();
		const result = await call<{ error?: string }>(repo, "git.discard", {});
		expect(result.error).toBe("path required");
		expect(gitContent(repo, "a.txt")).toBe("one\n");
	});

	test("git.revert undoes a commit and keeps history", async () => {
		// `revert`, not `reset`: the tree goes back to the earlier content while
		// both commits stay in the log, which is what undoing one commit means.
		const repo = await tmpRepo();
		fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
		Bun.spawnSync({ cmd: ["git", "add", "a.txt"], cwd: repo, stdout: "pipe", stderr: "pipe" });
		Bun.spawnSync({
			cmd: ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "second"],
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const hash = git(repo, "rev-parse", "--short", "HEAD").trim();

		await call(repo, "git.revert", { hash });

		// The committed content is back…
		expect(gitContent(repo, "a.txt")).toBe("one\n");
		// …and nothing is left as an uncommitted change, which is what makes this
		// a commit rather than a checkout.
		expect(git(repo, "diff", "--name-only").trim()).toBe("");
		// History grew rather than shrank: that is the difference from a reset.
		expect(git(repo, "log", "--oneline").trim().split("\n").length).toBe(3);
		expect(git(repo, "log", "-1", "--pretty=%s").trim()).not.toBe("second");
	});

	test("git.revert requires a hash", async () => {
		const repo = await tmpRepo();
		const result = await call<{ error?: string }>(repo, "git.revert", {});
		expect(result.error).toBe("hash required");
	});

	test("git.revert surfaces git's own reason when it cannot apply", async () => {
		// The failure people actually hit: a later commit rewrote the same line
		// the revert wants to undo, so there is no three-way merge to apply.
		// "git exited 1" sends them to the terminal; the reason is the answer to
		// the question they were asking.
		//
		// Both commits have to touch the *same* line — reverting a commit whose
		// edit is still present merges cleanly, which would test nothing.
		const repo = await tmpRepo();
		const commit = (message: string, content: string): void => {
			fs.writeFileSync(path.join(repo, "a.txt"), content);
			Bun.spawnSync({ cmd: ["git", "add", "a.txt"], cwd: repo, stdout: "pipe", stderr: "pipe" });
			Bun.spawnSync({
				cmd: ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message],
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
			});
		};
		commit("second", "changed once\n");
		const hash = git(repo, "rev-parse", "--short", "HEAD").trim();
		commit("third", "changed differently\n");

		await expect(call(repo, "git.revert", { hash })).rejects.toThrow(/could not revert|cannot revert|CONFLICT/i);
	});
});

describe("changes.ops", () => {
	test("asks for a session and reports an unknown one", async () => {
		const repo = await tmpRepo();
		const missing = await call<{ error?: string }>(repo, "changes.ops", { sessionId: "no-such-session" });
		expect(missing.error).toBe("session not found");
		const noId = await call<{ error?: string }>(repo, "changes.ops", {});
		expect(noId.error).toBe("sessionId required");
	});
});
