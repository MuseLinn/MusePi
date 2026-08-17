import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as cleanseAgent from "@musepi/pi-coding-agent/cleanse/agent";
import { balanceDiagnostics } from "@musepi/pi-coding-agent/cleanse/balance";
import * as cleanseCheckers from "@musepi/pi-coding-agent/cleanse/checkers";
import { runCleanseCommand } from "@musepi/pi-coding-agent/cleanse/index";
import { runCleanseLoop } from "@musepi/pi-coding-agent/cleanse/loop";
import { type CleanseParserKind, parseCleanseDiagnostics } from "@musepi/pi-coding-agent/cleanse/parsers";
import type {
	CleanseAgentOutcome,
	CleanseDiagnostic,
	CleanseDiagnosticReport,
} from "@musepi/pi-coding-agent/cleanse/types";
import { createProgressReporter } from "@musepi/pi-coding-agent/cli/progress-reporter";
import { resolveCliArgv } from "@musepi/pi-coding-agent/cli-commands";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("cleanse diagnostics", () => {
	test("parses cargo clippy JSON into a project-relative actionable diagnostic", () => {
		const stdout = JSON.stringify({
			reason: "compiler-message",
			message: {
				message: "useless use of vec!",
				code: { code: "clippy::useless_vec" },
				level: "warning",
				spans: [
					{
						file_name: "src/main.rs",
						is_primary: true,
						line_start: 2,
						column_start: 18,
						line_end: 2,
						column_end: 31,
						suggested_replacement: "[1, 2, 3]",
					},
				],
			},
		});

		const diagnostics = parseCleanseDiagnostics("rust", {
			checker: "cargo clippy (.)",
			projectCwd: "/repo",
			checkerCwd: "/repo",
			stdout,
			stderr: "",
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			checker: "cargo clippy (.)",
			file: "src/main.rs",
			line: 2,
			column: 18,
			endLine: 2,
			endColumn: 31,
			code: "clippy::useless_vec",
			severity: "warning",
			message: "useless use of vec!",
			suggestion: "[1, 2, 3]",
		});
	});

	test("keeps files intact while balancing weighted burden across N agents", () => {
		const diagnostics = [
			...fileDiagnostics("a.rs", 4),
			...fileDiagnostics("b.rs", 3),
			...fileDiagnostics("c.rs", 2),
			...fileDiagnostics("d.rs", 1),
		];

		const assignments = balanceDiagnostics(diagnostics, 2);

		expect(assignments).toHaveLength(2);
		expect(assignments.map(assignment => assignment.weight).sort((left, right) => left - right)).toEqual([25, 25]);
		const assignedFiles = assignments.flatMap(assignment => assignment.groups.map(group => group.file));
		expect(assignedFiles).toHaveLength(4);
		expect(new Set(assignedFiles).size).toBe(4);
		expect(balanceDiagnostics(diagnostics, 12)).toHaveLength(4);
	});

	test("discovers package test scripts only when test mode is enabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-tests-"));
		try {
			await Bun.write(
				path.join(root, "package.json"),
				JSON.stringify({
					packageManager: "bun@1.3.14",
					scripts: { test: `bun -e "process.exit(3)"` },
				}),
			);
			await Bun.write(path.join(root, "src", "index.ts"), "export const value = 1;\n");

			const withoutTests = await cleanseCheckers.discoverCleanseDiagnosticSuite(root);
			const withTests = await cleanseCheckers.discoverCleanseDiagnosticSuite(root, { includeTests: true });
			const report = await withTests.run();

			expect(withoutTests.checkers).toHaveLength(0);
			expect(withTests.checkers).toHaveLength(1);
			expect(report.checks[0]).toMatchObject({
				label: "bun test (.)",
				exitCode: 3,
			});
			expect(report.diagnostics[0]?.message).toContain("bun test (.) failed with exit code 3");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("excludes generated Bazel trees from checker discovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-ignore-"));
		try {
			await Bun.write(path.join(root, "src", "index.ts"), "export const value = 1;\n");
			await Bun.write(
				path.join(root, "bazel-output", "fixture", "package.json"),
				JSON.stringify({ scripts: { test: `bun -e "process.exit(3)"` } }),
			);

			const suite = await cleanseCheckers.discoverCleanseDiagnosticSuite(root, { includeTests: true });

			expect(suite.checkers).toHaveLength(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("cleanse progress", () => {
	test("updates an interactive completion bar as workers finish", () => {
		const writes: string[] = [];
		const progress = createProgressReporter("Repairing", {
			isTTY: true,
			write(text) {
				writes.push(text);
				return true;
			},
		});

		progress.start(2);
		progress.complete();
		progress.complete();
		progress.finish();

		expect(writes).toHaveLength(4);
		for (const update of writes.slice(0, 3)) {
			expect(update.startsWith("\rRepairing [")).toBe(true);
			expect(update.endsWith("\x1b[K")).toBe(true);
		}
		expect(writes[0]).toContain("0/2");
		expect(writes[1]).toContain("1/2");
		expect(writes[2]).toContain("2/2");
		expect(writes[3]).toBe("\n");
	});

	test("updates the command's TTY bar as repair workers finish", async () => {
		const output: string[] = [];
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		const initial = report([...fileDiagnostics("a.rs", 1), ...fileDiagnostics("b.rs", 1)]);
		const clean = report([]);
		let runCount = 0;
		const suite: cleanseCheckers.CleanseDiagnosticSuite = {
			checkers: [{ id: "mock", label: "mock", language: "Test", command: "mock" }],
			skipped: [],
			select() {},
			async run() {
				runCount += 1;
				return runCount === 1 ? initial : clean;
			},
		};
		let hooks: cleanseAgent.CleanseAgentHooks | undefined;
		const runtime: cleanseAgent.CleanseAgentRuntime = {
			model: "test/model",
			sessionFile: "/tmp/cleanse.jsonl",
			async discoverCheckers() {
				return [];
			},
			async dispatch(assignments) {
				return assignments.map((assignment, index) => {
					const name = `CleanseW1A${index + 1}`;
					hooks?.onStart?.(name, assignment);
					const outcome: CleanseAgentOutcome = { name, success: true, output: "" };
					hooks?.onFinish?.(outcome, assignment);
					return outcome;
				});
			},
			async close() {},
		};
		vi.spyOn(cleanseCheckers, "discoverCleanseDiagnosticSuite").mockResolvedValue(suite);
		vi.spyOn(cleanseAgent, "createCleanseAgentRuntime").mockImplementation(async options => {
			hooks = options.hooks;
			return runtime;
		});

		try {
			const result = await runCleanseCommand({ maxAgents: 2, all: true });

			expect(result.status).toBe("clean");
			const updates = output.filter(chunk => chunk.startsWith("\rRepairing ["));
			expect(updates).toHaveLength(3);
			expect(updates[0]).toContain("0/2");
			expect(updates[1]).toContain("1/2");
			expect(updates[2]).toContain("2/2");
		} finally {
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	test("stays silent for non-TTY output", () => {
		const writes: string[] = [];
		const progress = createProgressReporter("Repairing", {
			isTTY: false,
			write(text) {
				writes.push(text);
				return true;
			},
		});

		progress.start(1);
		progress.complete();
		progress.finish();

		expect(writes).toEqual([]);
	});
});

describe("cleanse orchestration", () => {
	test("dispatches no more than N agents once and verifies their combined edits", async () => {
		const initial = report([
			...fileDiagnostics("a.rs", 2),
			...fileDiagnostics("b.rs", 1),
			...fileDiagnostics("c.rs", 1),
		]);
		const clean = report([]);
		let dispatches = 0;
		let assignmentCount = 0;

		const result = await runCleanseLoop(
			{ maxAgents: 2, initialReport: initial },
			{
				collect: async () => clean,
				dispatch: async assignments => {
					dispatches += 1;
					assignmentCount = assignments.length;
					return assignments.map(
						(assignment, index): CleanseAgentOutcome => ({
							name: `CleanseW1A${index + 1}`,
							success: true,
							output: assignment.groups.map(group => group.file).join(", "),
						}),
					);
				},
			},
		);

		expect(dispatches).toBe(1);
		expect(assignmentCount).toBe(2);
		expect(result.status).toBe("clean");
		expect(result.report.diagnostics).toEqual([]);
	});

	test("reports unresolved diagnostics without spawning a second batch", async () => {
		const initial = report(fileDiagnostics("a.rs", 1));
		let dispatches = 0;

		const result = await runCleanseLoop(
			{ maxAgents: 8, initialReport: initial },
			{
				collect: async () => initial,
				dispatch: async () => {
					dispatches += 1;
					return [];
				},
			},
		);

		expect(dispatches).toBe(1);
		expect(result.status).toBe("stalled");
		expect(result.report.diagnostics).toHaveLength(1);
	});

	test("routes cleanse as a top-level command", () => {
		expect(resolveCliArgv(["cleanse", "-n", "4", "-m", "opus"])).toEqual({
			argv: ["cleanse", "-n", "4", "-m", "opus"],
		});
	});
});

describe("cleanse alternative-tooling parsers", () => {
	const parse = (kind: CleanseParserKind, stdout: string) =>
		parseCleanseDiagnostics(kind, {
			checker: "checker",
			projectCwd: "/repo",
			checkerCwd: "/repo",
			stdout,
			stderr: "",
		});

	test("normalizes staticcheck JSON lines into project-relative diagnostics", () => {
		const stdout = `{"code":"S1002","severity":"error","location":{"file":"/repo/main.go","line":5,"column":7},"end":{"line":5,"column":20},"message":"should omit comparison to bool constant"}`;
		expect(parse("staticcheck", stdout)).toEqual([
			{
				checker: "checker",
				file: "main.go",
				line: 5,
				column: 7,
				endLine: 5,
				endColumn: 20,
				code: "S1002",
				severity: "error",
				message: "should omit comparison to bool constant",
				suggestion: undefined,
			},
		]);
	});

	test("parses golangci-lint text output with the linter name as code", () => {
		const diagnostics = parse("golangci", "main.go:10:2: ineffectual assignment to err (ineffassign)\n");
		expect(diagnostics).toMatchObject([
			{ file: "main.go", line: 10, column: 2, code: "ineffassign", severity: "warning" },
		]);
	});

	test("converts pylint JSON zero-based columns to one-based", () => {
		const stdout = JSON.stringify([
			{
				type: "error",
				path: "src/app.py",
				line: 3,
				column: 0,
				endLine: 3,
				endColumn: 10,
				symbol: "undefined-variable",
				"message-id": "E0602",
				message: "Undefined variable 'x'",
			},
		]);
		expect(parse("pylint", stdout)).toMatchObject([
			{ file: "src/app.py", line: 3, column: 1, endColumn: 11, code: "undefined-variable", severity: "error" },
		]);
	});

	test("classifies flake8 pyflakes codes as errors and style codes as warnings", () => {
		const diagnostics = parse(
			"flake8",
			["src/app.py:1:1: F401 'os' imported but unused", "src/app.py:2:80: W291 trailing whitespace"].join("\n"),
		);
		expect(diagnostics).toMatchObject([
			{ file: "src/app.py", line: 1, code: "F401", severity: "error" },
			{ file: "src/app.py", line: 2, code: "W291", severity: "warning" },
		]);
	});

	test("parses ty concise output", () => {
		const diagnostics = parse(
			"ty",
			"src/main.py:1:8: error[unresolved-import] Cannot resolve imported module `foo`\nFound 1 diagnostic\n",
		);
		expect(diagnostics).toEqual([
			{
				checker: "checker",
				file: "src/main.py",
				line: 1,
				column: 8,
				endLine: undefined,
				endColumn: undefined,
				code: "unresolved-import",
				severity: "error",
				message: "Cannot resolve imported module `foo`",
				suggestion: undefined,
			},
		]);
	});

	test("parses oxlint unix-format lines with bracketed severity and rule", () => {
		const diagnostics = parse(
			"oxlint",
			"src/index.ts:4:10: Variable 'x' is declared but never used. [Warning/no-unused-vars]\n",
		);
		expect(diagnostics).toMatchObject([
			{ file: "src/index.ts", line: 4, column: 10, code: "no-unused-vars", severity: "warning" },
		]);
	});

	test("resolves deno lint file URLs and zero-based columns", () => {
		const stdout = JSON.stringify({
			diagnostics: [
				{
					filename: "file:///repo/mod.ts",
					range: { start: { line: 2, col: 4 }, end: { line: 2, col: 9 } },
					code: "no-var",
					message: "`var` keyword is not allowed.",
					hint: "Use `let` or `const` instead.",
				},
			],
			errors: [],
		});
		expect(parse("deno-lint", stdout)).toMatchObject([
			{
				file: "mod.ts",
				line: 2,
				column: 5,
				code: "no-var",
				severity: "warning",
				suggestion: "Use `let` or `const` instead.",
			},
		]);
	});

	test("flattens stylelint per-file warnings", () => {
		const stdout = JSON.stringify([
			{
				source: "/repo/styles/site.css",
				warnings: [
					{
						line: 7,
						column: 3,
						rule: "color-no-invalid-hex",
						severity: "error",
						text: "Unexpected invalid hex color",
					},
				],
			},
		]);
		expect(parse("stylelint", stdout)).toMatchObject([
			{ file: "styles/site.css", line: 7, column: 3, code: "color-no-invalid-hex", severity: "error" },
		]);
	});

	test("parses actionlint JSON output", () => {
		const stdout = JSON.stringify([
			{
				message: "shellcheck reported issue",
				filepath: ".github/workflows/ci.yml",
				line: 12,
				column: 9,
				kind: "shellcheck",
			},
		]);
		expect(parse("actionlint", stdout)).toMatchObject([
			{ file: ".github/workflows/ci.yml", line: 12, column: 9, code: "shellcheck", severity: "error" },
		]);
	});
});

describe("cleanse custom suite", () => {
	test("builds runnable plans from discovery specs and skips unrunnable ones", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-custom-"));
		try {
			await Bun.write(path.join(root, "src", "a.ts"), "export const value = 1;\n");
			const suite = await cleanseCheckers.buildCustomCleanseSuite(root, [
				{
					label: "fake tsc",
					language: "TypeScript",
					command: ["bun", "-e", "console.log('src/a.ts:1:1: error: boom'); process.exit(1)"],
				},
				{ label: "missing tool", command: ["definitely-not-a-real-binary-xyz"] },
				{ label: "escaping cwd", cwd: "../outside", command: ["bun", "-e", "1"] },
			]);

			expect(suite.checkers).toMatchObject([{ id: "custom-1", label: "fake tsc", language: "TypeScript" }]);
			expect(suite.skipped).toMatchObject([
				{ label: "missing tool", reason: "executable not found: definitely-not-a-real-binary-xyz" },
				{ label: "escaping cwd" },
			]);

			const report = await suite.run();
			expect(report.checks).toHaveLength(1);
			expect(report.diagnostics).toMatchObject([
				{ checker: "fake tsc", file: "src/a.ts", line: 1, severity: "error", message: "boom" },
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("select() narrows which checkers a run executes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-select-"));
		try {
			const suite = await cleanseCheckers.buildCustomCleanseSuite(root, [
				{ label: "first", command: ["bun", "-e", "console.log('ok')"] },
				{ label: "second", command: ["bun", "-e", "console.log('ok')"] },
			]);
			suite.select(["custom-2"]);

			const report = await suite.run();
			expect(report.checks.map(check => check.id)).toEqual(["custom-2"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

function fileDiagnostics(file: string, count: number): CleanseDiagnostic[] {
	return Array.from({ length: count }, (_, index) => ({
		checker: "checker",
		file,
		line: index + 1,
		code: `E${index + 1}`,
		severity: "error",
		message: `problem ${index + 1}`,
		suggestion: "known fix",
	}));
}

function report(diagnostics: CleanseDiagnostic[]): CleanseDiagnosticReport {
	return {
		checks: [],
		diagnostics,
		skipped: [],
	};
}
