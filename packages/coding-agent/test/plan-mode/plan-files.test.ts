import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPlanFile, writePlanFile } from "../../src/plan-mode/plan-files";

const OPTIONS = {
	localProtocolOptions: { artifactsDir: "/nonexistent", getSessionId: () => "s1" },
	cwd: process.cwd(),
};

describe("plan-files writePlanFile (GUI in-place plan edits)", () => {
	test("writes back through the same cwd-relative path readPlanFile resolves", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-files-"));
		const rel = path.join(dir, "plan.md");
		fs.writeFileSync(rel, "# Plan\n\nold body\n");

		await writePlanFile(rel, "# Plan\n\nnew body\n", OPTIONS);

		expect(fs.readFileSync(rel, "utf8")).toBe("# Plan\n\nnew body\n");
		expect(await readPlanFile(rel, OPTIONS)).toBe("# Plan\n\nnew body\n");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("creates missing parent directories", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-files-"));
		const nested = path.join(dir, "sub", "deep", "plan.md");

		await writePlanFile(nested, "content\n", OPTIONS);

		expect(fs.readFileSync(nested, "utf8")).toBe("content\n");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("overwrites an existing file (the GUI edit replaces the whole body)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-files-"));
		const p = path.join(dir, "a.md");
		fs.writeFileSync(p, "before\n");

		await writePlanFile(p, "after\n", OPTIONS);
		await writePlanFile(p, "final\n", OPTIONS);

		expect(fs.readFileSync(p, "utf8")).toBe("final\n");
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
