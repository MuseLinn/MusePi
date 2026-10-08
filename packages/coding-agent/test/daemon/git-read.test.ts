/**
 * Daemon git read RPCs the panel needs and the daemon did not expose.
 *
 * These run against a real repository rather than a stubbed `git`, because the
 * parts worth checking here are exactly the ones a stub would agree with
 * wrongly: how `git show -s` separates a message that contains newlines from the
 * fields before it, what a root commit's diff looks like when there is no first
 * parent, and what a porcelain status line looks like when you slice the wrong
 * columns off it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";

async function tmpRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-git-read-"));
	const run = (args: string[]): void => {
		const res = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
	};
	run(["init", "-q", "-b", "main"]);
	// Repo-local identity: a CI runner has no global user, and a commit that
	// cannot be attributed makes every later assertion about authorship vacuous.
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "Ada"]);
	return dir;
}

function commit(repo: string, message: string, files: Record<string, string | Buffer>): void {
	for (const [name, body] of Object.entries(files)) {
		fs.writeFileSync(path.join(repo, name), body);
		Bun.spawnSync({ cmd: ["git", "add", name], cwd: repo, stdout: "pipe", stderr: "pipe" });
	}
	const res = Bun.spawnSync({
		cmd: ["git", "-c", "user.email=t@t", "-c", "user.name=Ada", "commit", "-q", "-m", message],
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

/** One JSON-RPC call against a freshly started daemon, then shut it down. */
async function call<T>(repo: string, method: string, params: Record<string, unknown>): Promise<T> {
	// The daemon's own files (socket, port) go outside the repository: left
	// inside it, `git status` honestly reports them and a test about which
	// files changed starts failing on the harness rather than on the code.
	const daemon = await startDaemon({
		socketPath: path.join(os.tmpdir(), `daemon-git-read-${crypto.randomUUID()}.sock`),
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
		return res.result as T;
	} finally {
		await daemon.close();
	}
}

describe("daemon git read RPCs", () => {
	test("git.show returns one commit's metadata and patch", async () => {
		const repo = await tmpRepo();
		commit(repo, "add greeting", { "a.txt": "hi\n" });

		const result = await call<{ shortHash: string; author: { name: string }; message: string; diff: string }>(
			repo,
			"git.show",
			{ revision: "HEAD" },
		);
		expect(result.author.name).toBe("Ada");
		expect(result.message).toBe("add greeting");
		// The patch is the reason this RPC exists — a commit row that cannot
		// expand into a diff is a row a person has to leave the app to read.
		expect(result.diff).toContain("a.txt");
		expect(result.diff).toContain("+hi");
	});

	test("git.show keeps a multi-line message intact", async () => {
		// The reason the metadata format is NUL-separated: with spaces, a subject
		// containing a blank line shifts every field after it, and the author date
		// ends up holding part of the message.
		const repo = await tmpRepo();
		commit(repo, "subject line\n\nbody paragraph\nover another", { "a.txt": "x\n" });

		const result = await call<{ author: { date: string }; message: string }>(repo, "git.show", { revision: "HEAD" });
		expect(result.message).toBe("subject line\n\nbody paragraph\nover another");
		expect(result.author.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("git.show diffs a root commit against nothing", async () => {
		// A root commit has no first parent, so a parent-relative diff renders as
		// an empty change and the first commit of a repository reads as if it
		// had done nothing.
		const repo = await tmpRepo();
		commit(repo, "initial", { "only.txt": "one\n" });

		const result = await call<{ parents: string[]; diff: string }>(repo, "git.show", { revision: "HEAD" });
		expect(result.parents).toEqual([]);
		expect(result.diff).toContain("+one");
	});

	test("git.show reports a missing revision rather than throwing", async () => {
		const repo = await tmpRepo();
		commit(repo, "only", { "a.txt": "x\n" });
		const result = await call<{ error?: string }>(repo, "git.show", { revision: "no-such-rev" });
		expect(result.error).toBeTruthy();
	});

	test("git.changedFiles lists working-tree changes with the status columns removed", async () => {
		const repo = await tmpRepo();
		commit(repo, "base", { "a.txt": "one\n" });
		fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
		fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
		Bun.spawnSync({ cmd: ["git", "add", "b.txt"], cwd: repo, stdout: "pipe", stderr: "pipe" });

		const result = await call<{ files: string[] }>(repo, "git.changedFiles", {});
		// A porcelain line is `<XY> <path>`; slicing three columns is what turns
		// it back into the path a panel can open.
		expect(result.files.sort()).toEqual(["a.txt", "b.txt"]);
	});

	test("git.changedFiles compares two revisions when given them", async () => {
		const repo = await tmpRepo();
		commit(repo, "base", { "a.txt": "one\n" });
		commit(repo, "second", { "a.txt": "one\ntwo\n" });

		const result = await call<{ files: string[] }>(repo, "git.changedFiles", { base: "HEAD~1", head: "HEAD" });
		expect(result.files).toEqual(["a.txt"]);
	});

	test("git.numstat reports per-file counts and marks a binary as countable-zero", async () => {
		const repo = await tmpRepo();
		commit(repo, "base", { "a.txt": "one\n" });
		fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");

		const result = await call<{ files: { path: string; added: number; removed: number; binary: boolean }[] }>(
			repo,
			"git.numstat",
			{},
		);
		const entry = result.files.find(f => f.path === "a.txt");
		expect(entry?.added).toBe(2);
		expect(entry?.binary).toBe(false);
		// A binary file reports `-` for both counts. Passing the minus through
		// would render as arithmetic on a symbol.
		//
		// Left unstaged on purpose: `git diff --numstat` reads the working tree,
		// so a staged binary would not appear in this answer at all.
		fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
		commit(repo, "add binary", { "bin.dat": String.fromCharCode(0, 1, 2, 0, 255) });
		fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([9, 9, 0, 255, 1]));
		const withBinary = await call<{ files: { path: string; added: number; binary: boolean }[] }>(
			repo,
			"git.numstat",
			{},
		);
		const binary = withBinary.files.find(f => f.path === "bin.dat");
		expect(binary?.binary).toBe(true);
		expect(binary?.added).toBe(0);
	});

	test("git.numstat reports a missing repository instead of throwing", async () => {
		const repo = await tmpRepo();
		const result = await call<{ error?: string }>(repo, "git.numstat", { cwd: os.tmpdir() });
		expect(result.error).toBeTruthy();
	});
});
