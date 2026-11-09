import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitWatchService } from "../../src/daemon/services/git-watch-service";

const services: GitWatchService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.stop();
});

function tempRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-git-watch-"));
	const run = (args: string[]): void => {
		const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	run(["init", "-q", "-b", "main"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "Ada"]);
	fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
	run(["add", "a.txt"]);
	run(["commit", "-q", "-m", "base"]);
	return repo;
}

test("watches the git directory and pushes changed roots", async () => {
	const repo = tempRepo();
	const payloads: Array<Record<string, unknown>> = [];
	const service = new GitWatchService({ broadcast: payload => payloads.push(payload) });
	services.push(service);

	service.watch({ roots: [repo] }, { id: "conn-1" });
	// Chokidar starts asynchronously; let it attach before mutating HEAD.
	await Bun.sleep(400);
	fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feature\n");

	const deadline = Date.now() + 4_000;
	while (payloads.length === 0 && Date.now() < deadline) await Bun.sleep(50);
	expect(payloads).toContainEqual(
		expect.objectContaining({ type: "git.statusChanged", roots: [repo], reason: "git-dir" }),
	);
});

test("unwatch stops pushing for that connection", async () => {
	const repo = tempRepo();
	const payloads: Array<Record<string, unknown>> = [];
	const service = new GitWatchService({ broadcast: payload => payloads.push(payload) });
	services.push(service);

	service.watch({ roots: [repo] }, { id: "conn-1" });
	await Bun.sleep(300);
	service.unwatch({ roots: [repo] }, { id: "conn-1" });
	await Bun.sleep(300);
	payloads.length = 0;
	fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/other\n");
	await Bun.sleep(500);
	expect(payloads).toEqual([]);
});
