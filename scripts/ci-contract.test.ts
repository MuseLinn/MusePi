import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

interface WorkflowStep {
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
}

interface WorkflowJob {
	needs?: string[];
	if?: string;
	outputs?: Record<string, string>;
	steps?: WorkflowStep[];
}

interface Workflow {
	on?: Record<string, { paths?: unknown }>;
	jobs?: Record<string, WorkflowJob>;
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

	it("pins checkout, cache, Java setup and Pages actions to releases with Node 24 support", () => {
		const expected = new Map([
			["actions/checkout", "df4cb1c069e1874edd31b4311f1884172cec0e10"],
			["actions/cache", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"],
			["actions/cache/save", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"],
			["actions/cache/restore", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"],
			["actions/setup-java", "b843ebf9b913146b38da2eaa7aeddf76074ae1ad"],
			["actions/configure-pages", "45bfe0192ca1faeb007ade9deae92b16b8254a0d"],
			["actions/upload-pages-artifact", "fc324d3547104276b827a68afc52ff2a11cc49c9"],
			["actions/deploy-pages", "368f82528645a54fb793d4d04e342629a3f51346"],
		]);
		const files = fs
			.readdirSync(path.join(repoRoot, ".github"), { recursive: true, withFileTypes: true })
			.filter(entry => entry.isFile() && entry.name.endsWith(".yml"))
			.map(entry => path.relative(repoRoot, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"));
		const steps = files.flatMap(file =>
			allSteps(readYaml(file))
				.filter(step => [...expected.keys()].some(action => step.uses?.startsWith(`${action}@`)))
				.map(step => ({ file, step })),
		);
		expect(steps.length).toBeGreaterThan(2);
		for (const { file, step } of steps) {
			const action = [...expected.keys()].find(name => step.uses?.startsWith(`${name}@`))!;
			expect(step.uses, file).toBe(`${action}@${expected.get(action)}`);
		}
	});

	it("keys Bun dependency caches by the resolved runtime and lockfile", () => {
		const files = fs
			.readdirSync(path.join(repoRoot, ".github"), { recursive: true, withFileTypes: true })
			.filter(entry => entry.isFile() && entry.name.endsWith(".yml"))
			.map(entry => path.relative(repoRoot, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"));
		const cacheSteps = files.flatMap(file =>
			allSteps(readYaml(file))
				.filter(step => typeof step.with?.key === "string" && step.with.key.startsWith("bun-"))
				.map(step => ({ file, key: step.with?.key as string })),
		);
		expect(cacheSteps.length).toBeGreaterThan(0);
		for (const { file, key } of cacheSteps) {
			expect(key, file).toContain("steps.bun.outputs.bun-version");
			expect(key, file).toContain("hashFiles('**/bun.lock')");
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
		expect(result.stdout.toString()).toContain("==> apps/desktop");
	});

	it("gates releases on the real Electron desktop smoke job", () => {
		const workflow = readYaml(".github/workflows/ci.yml");
		const smoke = workflow.jobs?.test_desktop_smoke;
		const steps = allSteps(smoke);
		expect(steps.some(step => step.run?.includes("bun run ci:test:desktop-smoke"))).toBe(true);
		const gate = workflow.jobs?.release_gate;
		expect(gate?.needs).toContain("test_desktop_smoke");
		expect(gate?.if).toContain("needs.test_desktop_smoke.result == 'success'");
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

	it("publishes beta CLI and GUI assets to the shared prerelease channel", () => {
		for (const file of [".github/workflows/ci.yml", ".github/workflows/gui-release.yml"]) {
			const steps = allSteps(readYaml(file));
			const release = steps.find(step => step.uses?.startsWith("softprops/action-gh-release@"));
			expect(release?.with?.tag_name, file).toContain("channel-beta");
			expect(release?.with?.prerelease, file).toContain("-beta.");
		}
	});

	it("keeps beta releases out of the stable Homebrew formula", () => {
		const publish = readYaml(".github/workflows/ci.yml").jobs?.release_brew;
		expect(publish?.if).toContain("!contains(needs.release_metadata.outputs.release-tag, '-beta.')");
	});

	it("verifies the published GUI manifest version after upload", () => {
		const steps = allSteps(readYaml(".github/workflows/gui-release.yml").jobs?.publish);
		const upload = steps.findIndex(step => step.uses?.startsWith("softprops/action-gh-release@"));
		const verify = steps.findIndex(step => step.run?.includes("gui-release-channel.ts verify-published"));
		expect(verify).toBeGreaterThan(upload);
	});
});

describe("CI merge gate", () => {
	const workflow = readYaml(".github/workflows/ci.yml");
	const jobs = workflow.jobs ?? {};

	it("starts the workflow for every pull request so the required check always exists", () => {
		expect(workflow.on?.pull_request).toBeDefined();
		expect(workflow.on?.pull_request?.paths).toBeUndefined();
	});

	it("aggregates every blocking job into one always-run check", () => {
		const gate = jobs.ci_required;
		expect(gate).toBeDefined();
		expect(gate?.if).toContain("always()");
		const needs = new Set(gate?.needs ?? []);
		const excluded = new Set([
			"changes",
			"ci_required",
			"release_metadata",
			"release_gate",
			"release_binary",
			"release_binary_darwin",
			"release_github",
			"release_github_verify",
			"release_brew",
			"native_addons_arm",
			"native_addons_musl",
			"native_addons_win",
		]);
		for (const job of Object.keys(jobs)) {
			if (excluded.has(job)) continue;
			expect(needs.has(job), `${job} must feed CI required`).toBe(true);
		}
		for (const job of needs) {
			expect(job.startsWith("release_"), `${job} must not gate merges`).toBe(false);
		}
	});

	it("gates every heavy job on the changes path detector", () => {
		const alwaysRuns = new Set(["changes", "ci_required", "check", "docs_spec"]);
		for (const [name, job] of Object.entries(jobs)) {
			if (alwaysRuns.has(name) || name.startsWith("release_")) continue;
			expect(job.if, `${name} must wait for changes`).toContain("needs.changes.outputs.code");
			expect(job.needs, `${name} must depend on changes`).toContain("changes");
		}
	});

	it("accepts skipped heavy jobs only when the change gate found no code", () => {
		const python = requiredChecksInterpreter();
		expect(python).toBeDefined();
		const result = (value: string, outputs: Record<string, string> = {}) => ({ result: value, outputs });
		const run = (needs: Record<string, unknown>) =>
			Bun.spawnSync([python!, ".github/scripts/required_checks.py"], {
				cwd: repoRoot,
				env: { ...process.env, NEEDS: JSON.stringify(needs) },
				stdout: "pipe",
				stderr: "pipe",
			}).exitCode;

		expect(
			run({
				changes: result("success", { code: "true" }),
				check: result("success"),
				rust_validate: result("success"),
			}),
		).toBe(0);
		expect(
			run({
				changes: result("success", { code: "false" }),
				check: result("success"),
				rust_validate: result("skipped"),
			}),
		).toBe(0);
		expect(
			run({
				changes: result("success", { code: "true" }),
				check: result("success"),
				rust_validate: result("skipped"),
			}),
		).toBe(1);
		expect(
			run({
				changes: result("success", { code: "false" }),
				check: result("skipped"),
				rust_validate: result("skipped"),
			}),
		).toBe(1);
		expect(run({ changes: result("failure"), check: result("success") })).toBe(1);
	});
});

function requiredChecksInterpreter(): string | undefined {
	for (const candidate of [process.env.PYTHON, "python3", "python"]) {
		if (!candidate) continue;
		const probe = Bun.spawnSync([candidate, "--version"], { stdout: "pipe", stderr: "pipe" });
		if (probe.exitCode === 0) return candidate;
	}
	return undefined;
}

describe("CI contract coverage", () => {
	it("runs the CI contract test inside the required check", () => {
		const steps = allSteps(readYaml(".github/workflows/ci.yml").jobs?.check);
		expect(steps.some(step => step.run?.includes("scripts/ci-contract.test.ts"))).toBe(true);
	});
});
