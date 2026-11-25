import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

interface WorkflowStep {
	id?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
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

	it("does not start a second CI run from the tag push that release.ts also emits", () => {
		const push = readYaml(".github/workflows/ci.yml").on?.push as { branches?: string[]; tags?: unknown };
		expect(push?.branches).toContain("main");
		expect(push?.tags).toBeUndefined();
	});

	it("dispatches CI for a tag pushed onto an already published commit", () => {
		const workflow = readYaml(".github/workflows/tui-release-recover.yml");
		const push = workflow.on?.push as { tags?: string[] };
		expect(push?.tags).toEqual(["v*"]);
		const steps = allSteps(workflow);
		const checkout = steps.find(step => step.uses?.startsWith("actions/checkout@"));
		expect(checkout?.with?.ref).toBe("${{ github.event.repository.default_branch }}");
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
		const dispatch = steps.find(step => step.run?.includes("scripts/ci-tui-release-recover.ts"));
		expect(dispatch?.run).toBe("bun scripts/ci-tui-release-recover.ts");
		expect(dispatch?.run).not.toContain("${{");
		expect(dispatch?.env?.GITHUB_SHA).toBe("${{ github.sha }}");
		expect(dispatch?.env?.GITHUB_REF_NAME).toBe("${{ github.ref_name }}");
		expect(steps.some(step => step.uses?.startsWith("softprops/action-gh-release@"))).toBe(false);
		const metadata = allSteps(readYaml(".github/workflows/ci.yml").jobs?.release_metadata);
		expect(metadata.some(step => step.run?.includes("HEAD carries release tag"))).toBe(true);
	});

	it("adds TUI assets to an existing GitHub release without replacing its notes", () => {
		const steps = allSteps(readYaml(".github/workflows/ci.yml").jobs?.release_github);
		const create = steps.find(step => step.with?.body_path === "release-notes.md");
		const update = steps.find(
			step => step.uses?.startsWith("softprops/action-gh-release@") && step.with?.generate_release_notes === false,
		);
		expect(create?.with?.generate_release_notes).toBe(true);
		expect(update?.with?.body_path).toBeUndefined();
		expect(update?.if).toContain("exists == 'true'");
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

	it("starts a push run for docs-only commits", () => {
		const paths = (workflow.on?.push?.paths ?? []) as string[];
		expect(paths).toContain("docs/**");
	});

	it("starts a push run for the root README pair the pairing gate reads", () => {
		// The classifier side is guarded by the README classify cases; this is the
		// half that decides whether a run starts at all, and losing one entry here
		// lets a stale pairing record ship with a green suite.
		const paths = (workflow.on?.push?.paths ?? []) as string[];
		expect(paths).toEqual(expect.arrayContaining(["README.md", "README.zh-CN.md", "README.i18n.yaml"]));
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

describe("changes classifier", () => {
	// The step's own script, run against throwaway repositories. The step must
	// not re-parse the workflow to learn what "code" means: it refuses the
	// matrix only when every changed path is documentation.
	const bash = Bun.which("bash");
	const git = Bun.which("git");
	const diffStep = readYaml(".github/workflows/ci.yml").jobs?.changes?.steps?.find(step => step.id === "diff");
	const script = diffStep?.run ?? "";

	function gitIn(cwd: string, ...args: string[]): string {
		const result = Bun.spawnSync([git!, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		// Windows git reports line-ending normalization as `warning:` lines on a
		// successful command; a real failure is never just a warning.
		const errors = result.stderr
			.toString()
			.split("\n")
			.filter(line => line.trim() !== "" && !line.startsWith("warning:"));
		expect(errors, `git ${args.join(" ")}`).toEqual([]);
		expect(result.exitCode).toBe(0);
		return result.stdout.toString().trim();
	}

	/** A clone with an `origin`, so the step's `git fetch origin <sha>` works. */
	function fixture(files: Record<string, string>): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-ci-contract-"));
		const origin = path.join(root, "origin.git");
		const work = path.join(root, "work");
		gitIn(root, "init", "--quiet", "--bare", origin);
		gitIn(root, "init", "--quiet", "--initial-branch=main", work);
		gitIn(work, "config", "user.email", "ci-contract@example.invalid");
		gitIn(work, "config", "user.name", "CI contract");
		fs.mkdirSync(path.join(work, ".github/workflows"), { recursive: true });
		fs.copyFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), path.join(work, ".github/workflows/ci.yml"));
		for (const [file, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
			fs.writeFileSync(path.join(work, file), content);
		}
		gitIn(work, "add", "-A");
		gitIn(work, "commit", "--quiet", "-m", "base");
		gitIn(work, "remote", "add", "origin", origin);
		gitIn(work, "push", "--quiet", "--set-upstream", "origin", "main");
		return work;
	}

	/** Run the step as the runner does, returning `code` and the raw output. */
	function runStep(work: string, baseSha: string, shell: string = bash!): { code: string; log: string } {
		const output = path.join(path.dirname(work), "github-output");
		fs.writeFileSync(output, "");
		const result = Bun.spawnSync([shell, "-c", script], {
			cwd: work,
			env: { ...process.env, GITHUB_OUTPUT: output, BASE_SHA: baseSha },
			stdout: "pipe",
			stderr: "pipe",
		});
		// git writes fetch progress and tolerated ref errors (the unreachable base
		// case) to stderr; only the step's own `::error::` annotations matter.
		expect(result.stderr.toString()).not.toContain("::error::");
		expect(result.exitCode).toBe(0);
		const written = fs.readFileSync(output, "utf8");
		const match = /^code=(true|false)$/m.exec(written);
		expect(match, written).toBeDefined();
		return { code: match![1]!, log: `${result.stdout.toString()}${result.stderr.toString()}` };
	}

	function commit(work: string, mutate: () => void): string {
		mutate();
		gitIn(work, "add", "-A");
		gitIn(work, "commit", "--quiet", "-m", "change");
		gitIn(work, "push", "--quiet", "origin", "main");
		return gitIn(work, "rev-parse", "HEAD~1");
	}

	function classify(work: string, changes: Record<string, string>, baseSha?: string): string {
		const before = commit(work, () => {
			for (const [file, content] of Object.entries(changes)) {
				fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
				fs.writeFileSync(path.join(work, file), content);
			}
		});
		return runStep(work, baseSha ?? before).code;
	}

	const BASE_FILES = {
		"packages/x/entry.ts": "export {};\n",
		"docs/guide.md": "# guide\n",
		"patches/a.patch": "patch\n",
		"bazel/defs.bzl": "# defs\n",
		"README.md": "# MusePi\n",
		"README.zh-CN.md": "# MusePi\n",
		"README.i18n.yaml": "stem: README\n",
	};

	it("exists as a script the contract test can run", () => {
		expect(script).toContain("git diff --name-only");
		expect(diffStep?.env?.BASE_SHA).toContain("github.event.before");
	});

	it("classifies a docs-only push as no code change", () => {
		if (!bash || !git) return;
		const work = fixture(BASE_FILES);
		expect(classify(work, { "docs/guide.md": "# guide\n\nmore\n" })).toBe("false");
	});

	it("classifies every non-docs family as a code change", () => {
		if (!bash || !git) return;
		// One worktree, one push per family: each push diffs its own range, which
		// is what the runner sees. Covers the families a re-parsed trigger list
		// could silently drop, including `patches/**` and an inline-commented entry.
		const work = fixture(BASE_FILES);
		for (const [file, content] of [
			["packages/x/entry.ts", "export const x = 1;\n"],
			["patches/a.patch", "patch 2\n"],
			["bazel/defs.bzl", "# defs 2\n"],
			["scripts/tool.ts", "export {};\n"],
			[".github/workflows/nix.yml", "# edited\n"],
			["package.json", "{}\n"],
			["Cargo.toml", "[workspace]\n"],
		] as const) {
			expect(classify(work, { [file]: content }), file).toBe("true");
		}
	}, 60000);

	it("classifies a mixed push as a code change", () => {
		if (!bash || !git) return;
		const work = fixture(BASE_FILES);
		expect(classify(work, { "docs/guide.md": "# guide\n\nmixed\n", "package.json": "{}\n" })).toBe("true");
	});

	it("runs the matrix when the range holds no paths at all", () => {
		if (!bash || !git) return;
		// An empty diff would vacuously satisfy "every path is docs"; the step
		// must treat a bogus base that resolves but matches nothing as code.
		const work = fixture(BASE_FILES);
		const base = commit(work, () => fs.writeFileSync(path.join(work, "docs/guide.md"), "# guide\n\nbase\n"));
		expect(runStep(work, base).code).toBe("false");
		expect(runStep(work, gitIn(work, "rev-parse", "HEAD")).code).toBe("true");
	});

	it("treats a file moved out of code and into docs as a code change", () => {
		if (!bash || !git) return;
		const work = fixture(BASE_FILES);
		const before = commit(work, () => {
			fs.mkdirSync(path.join(work, "docs"), { recursive: true });
			fs.renameSync(path.join(work, "packages/x/entry.ts"), path.join(work, "docs/entry.md"));
		});
		// With rename detection git reports only `docs/entry.md`, which would read
		// as documentation-only; the step must still see the removal.
		expect(runStep(work, before).code).toBe("true");
	});

	it("classifies a README-only push as no code change", () => {
		if (!bash || !git) return;
		// The root README pair is inside the strict pairing gate, so a commit that
		// only re-records the pair is the `477f6c9c` shape one path over.
		const work = fixture(BASE_FILES);
		expect(classify(work, { "README.md": "# MusePi\n\nnew line\n" })).toBe("false");
		expect(classify(work, { "README.i18n.yaml": "stem: README\nrecorded: 2\n" })).toBe("false");
	});

	it("classifies a mixed README and code push as a code change", () => {
		if (!bash || !git) return;
		const work = fixture(BASE_FILES);
		expect(
			classify(work, { "README.md": "# MusePi\n\nmixed\n", "packages/x/entry.ts": "export const y = 1;\n" }),
		).toBe("true");
	});

	it("keeps every other root file out of the documentation set", () => {
		if (!bash || !git) return;
		// `README.md` is allowlisted by name, not by a root-wide rule.
		const work = fixture(BASE_FILES);
		expect(classify(work, { "CONTRIBUTING.md": "# Contributing\n" })).toBe("true");
		expect(classify(work, { LICENSE: "license\n" })).toBe("true");
	});

	it("runs the matrix when the pre-push tip cannot be compared", () => {
		if (!bash || !git) return;
		const work = fixture(BASE_FILES);
		const zeros = "0".repeat(40);
		expect(classify(work, { "docs/guide.md": "# guide\n\nnew branch\n" }, zeros)).toBe("true");
		expect(classify(work, { "docs/guide.md": "# guide\n\nmissing base\n" }, "f".repeat(40))).toBe("true");
	});

	it("does not re-parse the workflow trigger to decide what code is", () => {
		if (!bash || !git) return;
		// A commented trigger entry is legal YAML that a line-regex parse mangles.
		const work = fixture(BASE_FILES);
		const ciPath = path.join(work, ".github/workflows/ci.yml");
		const original = fs.readFileSync(ciPath, "utf8");
		fs.writeFileSync(ciPath, original.replace('         - "patches/**"', '         - "patches/**" # root deps'));
		gitIn(work, "commit", "--quiet", "-am", "comment the trigger entry");
		gitIn(work, "push", "--quiet", "origin", "main");
		// `:33` is `- "README.md"`: a trigger re-parse that needs an exact-string
		// match would drop this family and classify the push as documentation,
		// while the real rule ignores the trigger list entirely.
		const markdown = original.replace('         - "README.md"', "         - 'README.md'  # quoting variant");
		fs.writeFileSync(ciPath, markdown);
		gitIn(work, "commit", "--quiet", "-am", "quote the trigger entry");
		gitIn(work, "push", "--quiet", "origin", "main");
		expect(classify(work, { "packages/x/entry.ts": "export const quoted = 1;\n" })).toBe("true");
		expect(classify(work, { "README.md": "# MusePi\n\nstill docs\n" })).toBe("false");
		expect(script).not.toContain("awk");
		expect(script).not.toContain("mapfile");
		expect(script).not.toContain("in_push");
	});

	it.skipIf(process.platform === "win32")("classifies a Chinese-named docs file as no code change", () => {
		if (!bash || !git) return;
		// git quotes non-ASCII paths unless asked not to; a quoted
		// `"docs/\345..."` does not start with `docs/` and would run the matrix.
		const work = fixture(BASE_FILES);
		expect(classify(work, { "docs/发布说明.md": "# 发布说明\n" })).toBe("false");
	});

	it.skipIf(process.platform === "win32")("classifies correctly under a bash older than 4", () => {
		if (!bash || !git) return;
		// The runner's bash is 5.x, but a contributor's macOS bash is 3.2, so the
		// step must not need mapfile/associative arrays/`${x,,}` to be runnable.
		expect(script).not.toMatch(/\b(mapfile|readarray|declare\s+-A)\b/);
		expect(script).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)\}/);
		const oldest = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]
			.filter(candidate => fs.existsSync(candidate))
			.map(candidate => {
				const version = Bun.spawnSync([candidate, "--version"], { stdout: "pipe" }).stdout.toString();
				return { candidate, major: Number(/version (\d+)\./.exec(version)?.[1]) };
			})
			.find(({ major }) => Number.isFinite(major) && major < 4);
		if (!oldest) {
			// Ubuntu runners have no bash 3.2, so this cannot execute there. Name
			// the reason instead of passing quietly: everything else above still
			// holds, but nothing here has run the step under an old bash.
			console.warn("SKIPPED bash<4 execution: no bash older than 4 on this host (ubuntu runners have none)");
			return;
		}
		const work = fixture(BASE_FILES);
		const before = commit(work, () => fs.writeFileSync(path.join(work, "docs/guide.md"), "# guide\n\nold bash\n"));
		expect(runStep(work, before, oldest.candidate).code).toBe("false");
		expect(runStep(work, gitIn(work, "rev-parse", "HEAD"), oldest.candidate).code).toBe("true");
	});
});

describe("CI contract coverage", () => {
	it("runs the CI contract test inside the required check", () => {
		const steps = allSteps(readYaml(".github/workflows/ci.yml").jobs?.check);
		expect(steps.some(step => step.run?.includes("scripts/ci-contract.test.ts"))).toBe(true);
	});
});
