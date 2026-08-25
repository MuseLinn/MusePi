import { balanceDiagnostics } from "./balance";
import type { CleanseAgentOutcome, CleanseAssignment, CleanseDiagnosticReport, CleanseLoopResult } from "./types";

/** Runtime seams for one bounded diagnose, dispatch, and verify pass. */
export interface CleanseLoopDependencies {
	collect(signal?: AbortSignal): Promise<CleanseDiagnosticReport>;
	dispatch(
		assignments: CleanseAssignment[],
		wave: number,
		report: CleanseDiagnosticReport,
		signal?: AbortSignal,
	): Promise<CleanseAgentOutcome[]>;
	onWave?(wave: number, assignments: readonly CleanseAssignment[]): void;
	onReport?(wave: number, report: CleanseDiagnosticReport): void;
}

/** Inputs controlling one complete cleanse loop. */
export interface CleanseLoopOptions {
	maxAgents: number;
	initialReport: CleanseDiagnosticReport;
	signal?: AbortSignal;
	/** Maximum diagnose→dispatch→verify waves to run for continuous remediation. Default 1 = single-pass. */
	maxWaves?: number;
}

/** Dispatch a wave of `maxAgents` workers after each diagnose pass until clean or the wave budget is exhausted. */
export async function runCleanseLoop(
	options: CleanseLoopOptions,
	dependencies: CleanseLoopDependencies,
): Promise<CleanseLoopResult> {
	const initialReport = options.initialReport;
	if (initialReport.diagnostics.length === 0) {
		return { status: "clean", waves: 0, report: initialReport, outcomes: [] };
	}
	if (options.signal?.aborted) {
		return { status: "cancelled", waves: 0, report: initialReport, outcomes: [] };
	}
	const maxWaves = options.maxWaves ?? 1;
	if (!Number.isInteger(maxWaves) || maxWaves <= 0) {
		throw new Error("maxWaves must be a positive integer");
	}
	let report = initialReport;
	let outcomes: CleanseAgentOutcome[] = [];
	let waves = 0;
	for (let wave = 1; wave <= maxWaves; wave += 1) {
		const assignments = balanceDiagnostics(report.diagnostics, options.maxAgents);
		dependencies.onWave?.(wave, assignments);
		const waveOutcomes = await dependencies.dispatch(assignments, wave, report, options.signal);
		outcomes = outcomes.concat(waveOutcomes);
		waves = wave;
		if (options.signal?.aborted) {
			return { status: "cancelled", waves, report, outcomes };
		}
		report = await dependencies.collect(options.signal);
		dependencies.onReport?.(wave, report);
		if (report.diagnostics.length === 0) {
			return { status: "clean", waves, report, outcomes };
		}
	}
	return { status: "stalled", waves, report, outcomes };
}
