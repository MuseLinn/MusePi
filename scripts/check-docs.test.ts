import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoots = new Set<string>();

async function fixture(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "musepi-docs-check-"));
	temporaryRoots.add(root);
	for (const [path, content] of Object.entries(files)) {
		const destination = join(root, path);
		await mkdir(join(destination, ".."), { recursive: true });
		await writeFile(destination, content);
	}
	return root;
}

async function check(root: string): Promise<{ exitCode: number; output: string }> {
	const child = Bun.spawn({
		cmd: [process.execPath, join(import.meta.dir, "check-docs.ts"), "--root", root],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

afterEach(async () => {
	await Promise.all([...temporaryRoots].map(root => rm(root, { recursive: true, force: true })));
	temporaryRoots.clear();
});

describe("documentation metadata gate", () => {
	it("accepts a living document whose title, summary, and owning scope are machine-readable", async () => {
		const root = await fixture({
			"docs/example.md": `---\ntitle: Example\nstatus: living\nsummary: Owns the example runtime contract.\nscope:\n  - packages/example\n---\n# Example\n`,
		});
		const result = await check(root);
		expect(result.output).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("rejects a new document without metadata so it cannot enter the corpus as an unclassified long-lived file", async () => {
		const root = await fixture({ "docs/new-contract.md": "# New contract\n" });
		const result = await check(root);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("docs/new-contract.md");
		expect(result.output).toContain("missing frontmatter");
	});

	it("does not require product metadata on disposable implementation plans", async () => {
		const root = await fixture({ "docs/superpowers/plans/example.md": "# Implementation plan\n" });
		const result = await check(root);
		expect(result.output).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("reports invalid status, empty summary, and missing scope instead of accepting decorative frontmatter", async () => {
		const root = await fixture({
			"docs/invalid.md": `---\ntitle: Invalid\nstatus: current\nsummary: ""\n---\n# Invalid\n`,
		});
		const result = await check(root);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("status must be living, reference, draft, or archived");
		expect(result.output).toContain("summary must be a non-empty string");
		expect(result.output).toContain("scope must list at least one owning path");
	});
});
