/**
 * Shared execution lifecycle for extension-contributed external subagents.
 * Product adapters own process protocols; this module owns task presentation,
 * cancellation, output limits, and artifacts.
 */
import path from "node:path";
import { truncateTail } from "../session/streaming-output";
import type { ExecutorOptions } from "./executor";
import {
	type AgentProgress,
	type ExternalSubagentResult,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type SingleResult,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";

const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;

function abortMessage(signal: AbortSignal): string {
	return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "Cancelled");
}

function cancelledResult(options: ExecutorOptions, message: string): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 1,
		output: "",
		stderr: message,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		error: message,
		aborted: true,
		abortReason: message,
	};
}

/** Execute an extension's external product adapter under the standard task lifecycle. */
export async function runExternalSubagent(options: ExecutorOptions): Promise<SingleResult> {
	const external = options.agent.external;
	if (!external) throw new Error(`Agent "${options.agent.name}" has no external executor`);
	if (options.signal?.aborted) return cancelledResult(options, abortMessage(options.signal));

	const startedAt = Date.now();
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const maxRuntimeMs = Math.max(
		0,
		Math.trunc(Number(options.maxRuntimeMs ?? options.settings?.get("task.maxRuntimeMs") ?? 0) || 0),
	);
	const timeout =
		maxRuntimeMs > 0
			? setTimeout(() => controller.abort(new Error(`Timed out after ${maxRuntimeMs}ms`)), maxRuntimeMs)
			: undefined;
	const progress: AgentProgress = {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		status: "running",
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		modelOverride: options.modelOverride,
		modelRole: options.modelRole,
	};
	const emitProgress = (): void => {
		progress.durationMs = Date.now() - startedAt;
		options.onProgress?.({ ...progress });
		options.eventBus?.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: options.task,
			assignment: options.assignment,
			parentToolCallId: options.parentToolCallId,
			detached: options.detached,
			sessionFile: options.sessionFile ?? undefined,
			progress: { ...progress },
		});
	};
	const emitLifecycle = (status: "started" | "completed" | "failed" | "aborted"): void => {
		options.eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			description: options.description,
			status,
			sessionFile: options.sessionFile ?? undefined,
			parentToolCallId: options.parentToolCallId,
			index: options.index,
			detached: options.detached,
		});
	};

	emitLifecycle("started");
	emitProgress();
	let outcome: ExternalSubagentResult;
	try {
		outcome = await external({
			options,
			signal,
			report: update => {
				if (update.output !== undefined) {
					const tail = update.output.slice(-RECENT_OUTPUT_TAIL_BYTES);
					progress.recentOutput = tail
						.split("\n")
						.filter(line => line.trim())
						.slice(-8)
						.reverse();
				}
				if (update.currentTool !== undefined) progress.currentTool = update.currentTool || undefined;
				if (update.currentToolArgs !== undefined) progress.currentToolArgs = update.currentToolArgs || undefined;
				if (update.resolvedModel !== undefined) progress.resolvedModel = update.resolvedModel || undefined;
				emitProgress();
			},
		});
	} catch (error) {
		outcome = {
			output: "",
			error: error instanceof Error ? error.message : String(error),
			aborted: signal.aborted,
			abortReason: signal.aborted ? abortMessage(signal) : undefined,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
	}

	const aborted = outcome.aborted === true || signal.aborted;
	let exitCode = outcome.exitCode ?? (outcome.error ? 1 : 0);
	let stderr = outcome.stderr ?? outcome.error ?? "";
	if (aborted) exitCode = 1;
	if (!aborted && exitCode === 0 && !outcome.output.trim()) {
		exitCode = 1;
		stderr = `${options.agent.name} returned an empty response`;
	}
	const abortReason = aborted ? (outcome.abortReason ?? abortMessage(signal)) : undefined;
	if (abortReason && !stderr) stderr = abortReason;
	const { content: output, truncated } = truncateTail(outcome.output, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});
	let outputPath: string | undefined;
	let outputMeta: SingleResult["outputMeta"];
	if (options.artifactsDir) {
		outputPath = path.join(options.artifactsDir, `${options.id}.md`);
		try {
			await Bun.write(outputPath, outcome.output);
			outputMeta = { lineCount: outcome.output.split("\n").length, charCount: outcome.output.length };
		} catch {
			outputPath = undefined;
		}
	}
	progress.status = aborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	progress.resolvedModel = outcome.resolvedModel ?? progress.resolvedModel;
	emitProgress();
	emitLifecycle(progress.status);
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode,
		output,
		stderr,
		truncated: Boolean(truncated),
		durationMs: Date.now() - startedAt,
		tokens: 0,
		requests: 1,
		modelOverride: options.modelOverride,
		modelRole: options.modelRole,
		resolvedModel: progress.resolvedModel,
		error: exitCode === 0 ? undefined : outcome.error || stderr || abortReason || "External subagent failed",
		aborted,
		abortReason,
		outputPath,
		outputMeta,
	};
}
