import { describe, expect, test } from "bun:test";
import { runCleanseLoop } from "@musepi/pi-coding-agent/cleanse/loop";
import type { CleanseAgentOutcome, CleanseDiagnostic, CleanseDiagnosticReport } from "@musepi/pi-coding-agent/cleanse/types";

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

describe("cleanse continuous loop", () => {
	test("converges to clean over two waves when later diagnostics remain", async () => {
		const initial = report(fileDiagnostics("a.rs", 1));
		const wave1Collect = report(fileDiagnostics("b.rs", 1));
		const clean = report([]);
		let collectCalls = 0;
		let dispatches = 0;

		const result = await runCleanseLoop(
			{ maxAgents: 2, initialReport: initial, maxWaves: 3 },
			{
				collect: async () => {
					collectCalls += 1;
					return collectCalls === 1 ? wave1Collect : clean;
				},
				dispatch: async assignments => {
					dispatches += 1;
					return assignments.map(
						(assignment, index): CleanseAgentOutcome => ({
							name: `CleanseW${dispatches}A${index + 1}`,
							success: true,
							output: assignment.groups.map(group => group.file).join(", "),
						}),
					);
				},
			},
		);

		expect(dispatches).toBe(2);
		expect(collectCalls).toBe(2);
		expect(result.status).toBe("clean");
		expect(result.waves).toBe(2);
		expect(result.outcomes).toHaveLength(2);
	});

	test("caps remediation at maxWaves when diagnostics persist", async () => {
		const initial = report(fileDiagnostics("a.rs", 1));
		const dirty = report(fileDiagnostics("b.rs", 1));
		const maxWaves = 4;
		let dispatches = 0;

		const result = await runCleanseLoop(
			{ maxAgents: 2, initialReport: initial, maxWaves },
			{
				collect: async () => dirty,
				dispatch: async () => {
					dispatches += 1;
					return [];
				},
			},
		);

		expect(dispatches).toBe(maxWaves);
		expect(result.status).toBe("stalled");
		expect(result.waves).toBe(maxWaves);
	});

	test("returns cancelled when aborted mid-wave", async () => {
		const initial = report(fileDiagnostics("a.rs", 1));
		const controller = new AbortController();

		const result = await runCleanseLoop(
			{ maxAgents: 2, initialReport: initial, maxWaves: 3, signal: controller.signal },
			{
				collect: async () => report([]),
				dispatch: async () => {
					controller.abort();
					return [];
				},
			},
		);

		expect(result.status).toBe("cancelled");
		expect(result.waves).toBe(1);
	});

	test("default (no maxWaves) matches the single-pass behavior", async () => {
		const initial = report(fileDiagnostics("a.rs", 1));
		const dirty = report(fileDiagnostics("b.rs", 1));
		let dispatches = 0;

		const result = await runCleanseLoop(
			{ maxAgents: 2, initialReport: initial },
			{
				collect: async () => dirty,
				dispatch: async () => {
					dispatches += 1;
					return [];
				},
			},
		);

		expect(dispatches).toBe(1);
		expect(result.status).toBe("stalled");
		expect(result.waves).toBe(1);
	});
});
