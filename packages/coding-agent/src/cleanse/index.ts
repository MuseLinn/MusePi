import { getProjectDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { shortenPath } from "../tools/render-utils";
import { type CleanseAgentRuntime, createCleanseAgentRuntime } from "./agent";
import { groupDiagnosticsByFile } from "./balance";
import { discoverCleanseDiagnosticSuite } from "./checkers";
import { runCleanseLoop } from "./loop";
import { createCleanseProgressReporter } from "./progress";
import type { CleanseAgentOutcome, CleanseAssignment, CleanseDiagnosticReport, CleanseLoopResult } from "./types";

const DEFAULT_MODEL = "@smol";
const DISPLAY_FILE_LIMIT = 50;

/** User-facing options for `omp cleanse`. */
export interface CleanseCommandOptions {
	maxAgents?: number;
	model?: string;
	includeTests?: boolean;
}

/** Observable completion state returned to the CLI adapter. */
export interface CleanseCommandResult {
	exitCode: number;
	status: "clean" | "unresolved" | "unsupported" | "cancelled";
	report: CleanseDiagnosticReport;
	sessionFile?: string;
}

/** Detect project diagnostics, dispatch one bounded repair batch, and verify it. */
export async function runCleanseCommand(options: CleanseCommandOptions = {}): Promise<CleanseCommandResult> {
	const maxAgents = options.maxAgents ?? 8;
	if (!Number.isInteger(maxAgents) || maxAgents <= 0) throw new Error("--agents must be a positive integer");
	const model = options.model?.trim() || DEFAULT_MODEL;
	const cwd = getProjectDir();
	const abortController = new AbortController();
	const abort = (): void => abortController.abort(new Error("Cleanse interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let runtime: CleanseAgentRuntime | undefined;
	let loopResult: CleanseLoopResult | undefined;
	const progress = createCleanseProgressReporter();
	const interactiveFailures: CleanseAgentOutcome[] = [];
	let interactiveFailuresPrinted = false;
	const printInteractiveFailures = (): void => {
		if (!progress.interactive || interactiveFailuresPrinted) return;
		interactiveFailuresPrinted = true;
		for (const outcome of interactiveFailures) printAgentOutcome(outcome);
	};

	try {
		process.stdout.write("Detecting configured project checkers...\n");
		const suite = await discoverCleanseDiagnosticSuite(cwd, { includeTests: options.includeTests });
		if (suite.checkCount === 0) {
			const report: CleanseDiagnosticReport = { checks: [], diagnostics: [], skipped: [...suite.skipped] };
			printSkippedChecks(report);
			process.stderr.write("No supported checker with an available executable was found.\n");
			return { exitCode: 1, status: "unsupported", report };
		}
		const initialReport = await suite.run(abortController.signal);
		printCheckReport(initialReport);
		if (initialReport.diagnostics.length === 0) {
			process.stdout.write(
				`Clean: ${initialReport.checks.length} checker${initialReport.checks.length === 1 ? "" : "s"} passed.\n`,
			);
			return { exitCode: 0, status: "clean", report: initialReport };
		}

		const assignments = groupDiagnosticsByFile(initialReport.diagnostics);
		const agentCount = Math.min(maxAgents, assignments.length);
		const fileCount = assignments.filter(group => group.file !== undefined).length;
		process.stdout.write(
			`Found ${initialReport.diagnostics.length} diagnostic${initialReport.diagnostics.length === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}; launching ${agentCount} subagent${agentCount === 1 ? "" : "s"}.\n`,
		);
		process.stdout.write(`Resolving model ${model}...\n`);
		const activeRuntime = await createCleanseAgentRuntime({
			cwd,
			model,
			hooks: {
				onStart(name, assignment) {
					if (progress.interactive) return;
					process.stdout.write(
						`[start] ${name}: ${formatAssignmentFiles(assignment)} (weight ${assignment.weight})\n`,
					);
				},
				onFinish(outcome) {
					progress.complete();
					if (progress.interactive) {
						if (!outcome.success) interactiveFailures.push(outcome);
						return;
					}
					printAgentOutcome(outcome);
				},
			},
		});
		runtime = activeRuntime;
		process.stdout.write(`Model: ${activeRuntime.model}\nSession: ${shortenPath(activeRuntime.sessionFile)}\n`);
		loopResult = await runCleanseLoop(
			{ maxAgents, initialReport, signal: abortController.signal },
			{
				collect: signal => suite.run(signal),
				dispatch: (batch, wave, report, signal) => activeRuntime.dispatch(batch, wave, report, signal),
				onWave(_wave, batch) {
					process.stdout.write(
						`Dispatching ${batch.length} weighted assignment${batch.length === 1 ? "" : "s"}...\n`,
					);
					progress.start(batch.length);
				},
				onReport(_wave, report) {
					progress.finish();
					printInteractiveFailures();
					process.stdout.write(
						`Verification: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"} remaining.\n`,
					);
				},
			},
		);
		progress.finish();
		printInteractiveFailures();
		await activeRuntime.close(loopResult);
		if (loopResult.status === "cancelled") {
			process.stderr.write("Cleanse cancelled.\n");
			return {
				exitCode: 130,
				status: "cancelled",
				report: loopResult.report,
				sessionFile: activeRuntime.sessionFile,
			};
		}
		if (loopResult.status === "clean") {
			process.stdout.write("Clean: all detected diagnostics are resolved.\n");
			return { exitCode: 0, status: "clean", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
		}
		printRemaining(loopResult.report);
		return { exitCode: 1, status: "unresolved", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
	} catch (error) {
		if (!abortController.signal.aborted) throw error;
		const report: CleanseDiagnosticReport = loopResult?.report ?? { checks: [], diagnostics: [], skipped: [] };
		progress.finish();
		printInteractiveFailures();
		process.stderr.write("Cleanse cancelled.\n");
		return { exitCode: 130, status: "cancelled", report, sessionFile: runtime?.sessionFile };
	} finally {
		progress.finish();
		printInteractiveFailures();
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
		await runtime?.close(loopResult);
	}
}

function printAgentOutcome(outcome: CleanseAgentOutcome): void {
	if (outcome.success) {
		process.stdout.write(`[done] ${outcome.name}${outcome.resolvedModel ? ` (${outcome.resolvedModel})` : ""}\n`);
		return;
	}
	const error = sanitizeText(outcome.error ?? "subagent failed")
		.replace(/\s+/g, " ")
		.slice(0, 300);
	process.stderr.write(`[fail] ${outcome.name}: ${error}\n`);
}

function printCheckReport(report: CleanseDiagnosticReport): void {
	for (const check of report.checks) {
		const count = check.diagnostics.length;
		process.stdout.write(`- ${check.label}: ${count === 0 ? "clean" : `${count} issue${count === 1 ? "" : "s"}`}\n`);
	}
	printSkippedChecks(report);
}

function printSkippedChecks(report: CleanseDiagnosticReport): void {
	for (const skipped of report.skipped) {
		process.stdout.write(`- ${skipped.label}: skipped (${skipped.reason})\n`);
	}
}

function formatAssignmentFiles(assignment: CleanseAssignment): string {
	return assignment.groups.map(group => group.file ?? "<project>").join(", ");
}

function printRemaining(report: CleanseDiagnosticReport): void {
	const groups = groupDiagnosticsByFile(report.diagnostics);
	process.stderr.write(
		`Unresolved: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"}.\n`,
	);
	for (const group of groups.slice(0, DISPLAY_FILE_LIMIT)) {
		process.stderr.write(`- ${group.file ?? "<project>"}: ${group.diagnostics.length}\n`);
	}
	if (groups.length > DISPLAY_FILE_LIMIT) {
		process.stderr.write(`- ... ${groups.length - DISPLAY_FILE_LIMIT} more files\n`);
	}
}
