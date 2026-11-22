/**
 * End-to-end proof of the runner's hardest distinction: a guard that HANGS on
 * its defect must report `unproven`, never `caught`.
 *
 * The unit tests pin `classifyRun`'s reading of a timeout, but the path that
 * matters runs a real process: `Bun.spawnSync` has to actually kill a hung
 * suite, and the runner has to keep the baseline run and the reverted run
 * apart. That is what this file exercises, against a throwaway git repository
 * whose guard is deliberately built to hang once its defect is restored.
 *
 * The timeout is short on purpose — the point is the classification, not
 * patience.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runMarker } from "./check-guards-mutation";

let repo: string;

const GUARD = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// @guard: revert guard-me.ts:1 | export const mode = "hang";
// @guard: test the subject answers
test("the subject answers", async () => {
	const { mode } = await import("./guard-me.ts");
	if (mode === "hang") {
		// The shape that made five guards pass review: the failure presents as a
		// stall, not as a diff.
		await new Promise(resolve => setTimeout(resolve, 60_000));
	}
	expect(mode).toBe("answer");
});
`;

function git(args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

beforeAll(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-mutation-probe-"));
	fs.writeFileSync(path.join(repo, "guard-me.ts"), 'export const mode = "answer";\n');
	fs.writeFileSync(path.join(repo, "probe.test.ts"), GUARD);
	git(["init", "--quiet"]);
	git(["add", "-A"]);
	git(["-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "--quiet", "-m", "probe"]);
});

afterAll(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("runMarker against a real hanging guard", () => {
	test("reports unproven, not caught, when the defect makes the guard hang", () => {
		const marker = {
			file: "probe.test.ts",
			markerLine: 4,
			target: "guard-me.ts",
			line: 1,
			defect: 'export const mode = "hang";',
			testName: "the subject answers",
		};
		const result = runMarker(marker, repo, { timeoutMs: 3000 });
		expect(result.outcome).toBe("unproven");
		expect(result.detail).toContain("timed out");
		// The suite really hung rather than failing fast: the run had to be
		// killed at the timeout, which is why this is not a catch.
		expect(result.durationMs).toBeGreaterThanOrEqual(2000);
	}, 30_000);

	test("leaves the scratch tree byte-identical after a reverted run", () => {
		// A runner that restored the file only on success would corrupt the very
		// tree it is testing the moment a run timed out.
		const target = path.join(repo, "guard-me.ts");
		expect(fs.readFileSync(target, "utf8")).toBe('export const mode = "answer";\n');
	});

	test("a guard whose defect fails fast is caught, in the same tree", () => {
		fs.writeFileSync(path.join(repo, "guard-me.ts"), 'export const mode = "answer";\n');
		const marker = {
			file: "probe.test.ts",
			markerLine: 4,
			target: "guard-me.ts",
			line: 1,
			defect: 'export const mode = "answer";',
			testName: "the subject answers",
		};
		// Nothing to revert — the line already reads the defect — so the runner
		// must say so instead of "catching" a passing suite.
		const result = runMarker(marker, repo, { timeoutMs: 3000 });
		expect(result.outcome).toBe("error");
		expect(result.detail).toContain("already reads the defect");
	}, 30_000);
});
