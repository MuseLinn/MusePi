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

	it("pins checkout, cache and Java setup actions to releases that run on Node 24", () => {
		const expected = new Map([
			["actions/checkout", "df4cb1c069e1874edd31b4311f1884172cec0e10"],
			["actions/cache", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"],
			["actions/cache/save", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"],
			["actions/cache/restore", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"],
			["actions/setup-java", "b843ebf9b913146b38da2eaa7aeddf76074ae1ad"],
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
		expect(result.stdout.toString()).toContain("==> packages/desktop-app");
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
