/** Shared process and JSONL protocol support for external product subagents. */

import { prompt } from "@musepi/pi-utils";
import { AbortError, type ChildProcess, spawn } from "@musepi/pi-utils/ptree";
import externalTaskTemplate from "../prompts/system/external-subagent-user-prompt.md" with { type: "text" };
import type { ExecutorOptions } from "./executor";
import type { ExternalSubagentContext, ExternalSubagentResult } from "./types";

const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EXTERNAL_DISPOSE_GRACE_MS = 3_000;

/** Configuration fields shared by the bundled external product plugins. */
export interface ExternalProductConfig {
	executable?: string;
	model?: string;
	permissionMode?: string;
	/** JSON object containing string environment values. */
	env?: string;
	disposeGraceMs?: number;
}

export type ExternalChildProcess = ChildProcess<"pipe"> | ChildProcess<"ignore">;

export interface ExternalProcessOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	signal: AbortSignal;
	stdin: "pipe" | "ignore";
}

/** Process factory seam used by real adapters and protocol fixtures. */
export type ExternalProcessFactory = (command: string[], options: ExternalProcessOptions) => ExternalChildProcess;

/** One normalized product event. */
export interface ExternalJsonlEvent {
	/** Incremental answer text. */
	text?: string;
	/** A native terminal answer, which takes precedence over incremental text. */
	final?: string;
	error?: string;
	currentTool?: string;
	currentToolArgs?: string;
}

export interface ExternalJsonlSpec {
	product: string;
	command: string[];
	env?: Record<string, string>;
	disposeGraceMs?: number;
	requireFinal?: boolean;
	parse: (event: unknown) => ExternalJsonlEvent | undefined;
}

export function spawnExternalProcess(command: string[], options: ExternalProcessOptions): ExternalChildProcess {
	const spawnOptions = {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
	};
	return options.stdin === "pipe"
		? spawn(command, { ...spawnOptions, stdin: "pipe" })
		: spawn(command, { ...spawnOptions, stdin: "ignore" });
}

/** Render the task and shared batch context without dropping either input. */
export function externalTask(options: ExecutorOptions): string {
	return prompt.render(externalTaskTemplate, { task: options.task, context: options.context });
}

/** Read a plugin's JSON environment field at execution time. */
export function externalEnvironment(value: string | undefined): Record<string, string> {
	if (!value?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("External subagent env must be a JSON object", { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("External subagent env must be a JSON object");
	}
	const entries = Object.entries(parsed);
	if (entries.some(([, entry]) => typeof entry !== "string")) {
		throw new Error("External subagent env values must be strings");
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

/** Resolve a native model selector without inheriting MusePi's parent model. */
export function externalModel(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

/** Resolve an executable path or preserve the product's PATH lookup name. */
export function externalExecutable(value: string | undefined, fallback: string): string {
	return value?.trim() || fallback;
}

/** Resolve the process-range termination grace. */
export function externalDisposeGrace(value: number | undefined): number {
	return Math.max(0, Math.trunc(Number(value ?? DEFAULT_EXTERNAL_DISPOSE_GRACE_MS) || 0));
}

function abortMessage(signal: AbortSignal): string {
	return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "Cancelled");
}

async function readJsonl(
	child: ExternalChildProcess,
	spec: ExternalJsonlSpec,
	consume: (event: ExternalJsonlEvent) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	const consumeLine = (line: string): void => {
		if (!line.trim()) return;
		if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
			throw new Error(`${spec.product} emitted an oversized JSONL event`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`${spec.product} emitted invalid JSONL`, { cause: error });
		}
		const event = spec.parse(parsed);
		if (event?.error) throw new Error(event.error);
		if (event) consume(event);
	};
	for await (const chunk of child.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		if (Buffer.byteLength(buffer) > MAX_PROTOCOL_LINE_BYTES) {
			throw new Error(`${spec.product} emitted an oversized JSONL event`);
		}
		for (const line of lines) consumeLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	}
	buffer += decoder.decode();
	consumeLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
}

/** Run one JSONL product process and normalize its native terminal answer. */
export async function runExternalJsonl(
	context: ExternalSubagentContext,
	spec: ExternalJsonlSpec,
	factory: ExternalProcessFactory = spawnExternalProcess,
): Promise<ExternalSubagentResult> {
	const child = factory(spec.command, {
		cwd: context.options.cwd,
		env: { ...Bun.env, ...spec.env },
		signal: context.signal,
		stdin: "ignore",
	});
	let answer = "";
	let finalAnswer: string | undefined;
	let failure: Error | undefined;
	const consume = (event: ExternalJsonlEvent): void => {
		if (event.text) answer += event.text;
		if (event.final !== undefined) finalAnswer = event.final;
		context.report({
			output: finalAnswer ?? answer,
			...(event.currentTool !== undefined ? { currentTool: event.currentTool } : {}),
			...(event.currentToolArgs !== undefined ? { currentToolArgs: event.currentToolArgs } : {}),
		});
	};
	try {
		await readJsonl(child, spec, consume);
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
	}
	if (failure || context.signal.aborted) {
		await child.terminate(
			new AbortError(failure ?? abortMessage(context.signal), child.peekStderr()),
			externalDisposeGrace(spec.disposeGraceMs),
		);
	}
	let exitCode = child.exitCode;
	try {
		exitCode = await child.exited;
	} catch (error) {
		if (!failure) failure = error instanceof Error ? error : new Error(String(error));
	}
	if (context.signal.aborted) {
		return {
			output: finalAnswer ?? answer,
			stderr: child.peekStderr(),
			exitCode: 1,
			aborted: true,
			abortReason: abortMessage(context.signal),
		};
	}
	if (!failure && exitCode !== 0) failure = new Error(`${spec.product} exited with code ${exitCode ?? "unknown"}`);
	if (!failure && spec.requireFinal && !finalAnswer?.trim()) {
		failure = new Error(`${spec.product} ended without a successful result`);
	}
	return {
		output: finalAnswer ?? answer,
		stderr: child.peekStderr(),
		exitCode: failure ? 1 : (exitCode ?? 1),
		error: failure?.message,
	};
}

/** Parse the result protocol shared by Claude Code and CodeBuddy. */
export function parseClaudeStyleEvent(product: string, value: unknown): ExternalJsonlEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as { type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown; errors?: unknown };
	if (event.type !== "result") return undefined;
	const result = typeof event.result === "string" ? event.result : "";
	if (event.subtype === "success" && event.is_error === false && result.trim()) return { final: result };
	const details = Array.isArray(event.errors)
		? event.errors.filter(error => typeof error === "string").join("; ")
		: "";
	return { error: `${product} native result was not successful${details ? `: ${details}` : ""}` };
}
