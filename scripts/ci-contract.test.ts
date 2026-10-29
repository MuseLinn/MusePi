import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

interface WorkflowStep {
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
}

interface Workflow {
	jobs?: Record<string, { needs?: string[]; if?: string }>;
}

function readYaml(file: string): Workflow {
	return Bun.YAML.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as Workflow;
}

function allSteps(document: unknown): WorkflowStep[] {
	if (!document || typeof document !== "object") return [];
	if (Array.isArray(document)) return document.flatMap(allSteps);
	const record = document as Record<string, unknown>;
	if (Array.isArray(record.steps)) return record.steps as WorkflowStep[];
	return Object.values(record).flatMap(allSteps);
}

describe("CI runtime and delivery contracts", () => {
	it("uses the root packageManager version for every setup-bun installation", () => {
		const files = fs
			.readdirSync(path.join(repoRoot, ".github"), { recursive: true, withFileTypes: true })
			.filter(entry => entry.isFile() && entry.name.endsWith(".yml"))
			.map(entry => path.relative(repoRoot, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"));
		const setupSteps = files.flatMap(file =>
			allSteps(readYaml(file))
				.filter(step => step.uses?.startsWith("oven-sh/setup-bun@"))
				.map(step => ({ file, step })),
		);
		expect(setupSteps.length).toBeGreaterThan(0);
		for (const { file, step } of setupSteps) {
			expect(step.with?.["bun-version-file"], file).toBe("package.json");
			expect(step.with?.["bun-version"], file).toBeUndefined();
		}
	});

	it("includes the desktop suite in the Linux CI workspace bucket", () => {
		const result = Bun.spawnSync(["bun", "scripts/ci-test-ts.ts", "workspace", "--dry-run"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("==> packages/desktop-app");
	});

	it("does not publish CLI binaries when the release validation gate failed", () => {
		const workflow = readYaml(".github/workflows/ci.yml");
		const publish = workflow.jobs?.release_github;
		expect(publish?.needs).toContain("release_gate");
		expect(publish?.if).toContain("needs.release_gate.result == 'success'");
	});

	it("does not publish GUI assets before main CI succeeds for the tagged commit", () => {
		const workflow = readYaml(".github/workflows/gui-release.yml");
		const steps = allSteps(workflow.jobs?.publish);
		expect(steps.some(step => step.run?.includes("scripts/ci-require-workflow-success.ts CI"))).toBe(true);
	});
});
