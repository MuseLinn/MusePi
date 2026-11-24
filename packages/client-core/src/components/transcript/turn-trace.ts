/**
 * One turn's timeline, derived from rows the transcript already holds.
 *
 * OpenMausBot's trace is a server endpoint because its transcript is windowed
 * and the server owns the run record. MusePi's transcript already carries the
 * whole turn — each model call's `usage`/`duration`, each tool result's
 * `startedAt`/`durationMs` — so this is a pure read, no RPC and no second store
 * to keep in sync.
 *
 * What it answers that the fold header cannot: WHERE the minutes went. The
 * header says "工具耗时 42.0s" and "1 个失败"; this puts every step on one axis
 * so a single slow call is visible as a long bar rather than a number to compare.
 *
 * Absence is meaningful: a row written before timing existed has no duration.
 * It is drawn as a sliver at its timestamp and counted in `untimedSteps`, never
 * silently treated as zero — a zero-width bar would read as "this took no time".
 */
import type { AssistantMessage, SessionEntry } from "@musepi/pi-wire";

export type TraceStepKind = "model" | "tool";
export type TraceStepStatus = "ok" | "error" | "unknown";

/** One delegated subagent, as the `task` result already reports it: its own
 *  duration, tokens and outcome. Its INTERNAL steps live in another session's
 *  journal and are not in this transcript — that is the remaining gap against a
 *  cross-thread tree. */
export interface TraceSubStep {
	id: string;
	label: string;
	detail?: string;
	durationMs: number;
	status: TraceStepStatus;
	/** Cumulative input + output + cache-write tokens for this member. */
	tokens?: number;
}

export interface TraceStep {
	/** Row id (or call id) — stable enough for React keys within one trace. */
	id: string;
	kind: TraceStepKind;
	/** Tool name for a tool step; the model id for a model step. */
	label: string;
	/** One short line of what it worked on, when the row carries it. */
	detail?: string;
	startedAt: number;
	/** Absent when the row never recorded one (older journals, never-started calls). */
	durationMs?: number;
	status: TraceStepStatus;
	/** Position and width on the 0–100 axis of the turn's own span. */
	offsetPct: number;
	widthPct: number;
	tokens?: { input: number; output: number; cached: number };
	cost?: number;
	/** Delegated members of a `task` call. */
	children?: TraceSubStep[];
}

export interface TurnTrace {
	startedAt: number;
	endedAt: number;
	steps: TraceStep[];
	totals: {
		modelMs: number;
		toolMs: number;
		/** Steps that recorded a duration, and those that did not. */
		timedSteps: number;
		untimedSteps: number;
		failed: number;
		input: number;
		output: number;
		cached: number;
		cost: number;
	};
}

/** A step with no recorded duration still gets a sliver, so it is visible. */
const MIN_WIDTH_PCT = 0.6;

/** One readable line from a tool call's arguments. */
function callDetail(args: unknown): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "file_path", "query", "url", "pattern", "target"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 120);
	}
	return undefined;
}

/** The members a `task` result reports. Their own internal steps live in the
 *  subagent's session, so this is everything one transcript can honestly say
 *  about them: who ran, how long, how many tokens, and whether it failed. */
function subStepsOf(details: unknown): TraceSubStep[] | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const results = (details as { results?: unknown }).results;
	if (!Array.isArray(results)) return undefined;
	const out: TraceSubStep[] = [];
	for (const raw of results) {
		if (raw === null || typeof raw !== "object") continue;
		const item = raw as {
			id?: unknown;
			agent?: unknown;
			description?: unknown;
			task?: unknown;
			lastIntent?: unknown;
			exitCode?: unknown;
			durationMs?: unknown;
			tokens?: unknown;
		};
		const durationMs =
			typeof item.durationMs === "number" && Number.isFinite(item.durationMs) ? item.durationMs : undefined;
		if (durationMs === undefined) continue;
		const intent = typeof item.lastIntent === "string" ? item.lastIntent : undefined;
		const description = typeof item.description === "string" ? item.description : undefined;
		const task = typeof item.task === "string" ? item.task : undefined;
		out.push({
			id: typeof item.id === "string" ? item.id : `sub:${out.length}`,
			label: typeof item.agent === "string" && item.agent ? item.agent : "subagent",
			...((description ?? intent ?? task) ? { detail: (description ?? intent ?? task)!.slice(0, 120) } : {}),
			durationMs,
			status: typeof item.exitCode === "number" && item.exitCode !== 0 ? "error" : "ok",
			...(typeof item.tokens === "number" && Number.isFinite(item.tokens) ? { tokens: item.tokens } : {}),
		});
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Build the trace for the turn starting at `startIdx` (its user message) through
 * `endIdx` inclusive. Returns null when the span holds no step at all.
 */
export function buildTurnTrace(entries: readonly SessionEntry[], startIdx: number, endIdx: number): TurnTrace | null {
	const span = entries.slice(Math.max(0, startIdx), Math.min(entries.length, endIdx + 1));
	if (span.length === 0) return null;

	// Call id → the call's own detail, so the result row can show what it ran.
	const callDetails = new Map<string, { name: string; detail?: string }>();
	const raw: Array<Omit<TraceStep, "offsetPct" | "widthPct">> = [];

	for (const entry of span) {
		if (entry.type !== "message") continue;
		const message = entry.message;

		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") {
					callDetails.set(block.id, { name: block.name, detail: callDetail(block.arguments) });
				}
			}
			// A model call is a step of its own: the provider request that
			// produced this message. `duration` is the request time when the
			// engine reported it.
			const assistant = message as AssistantMessage;
			// Each assistant message is one provider round, whether it carried
			// text or only tool calls. Usage is normally present; a hand-written
			// or partial row must not throw the whole trace away.
			const usage = assistant.usage;
			raw.push({
				id: entry.id ?? `model:${assistant.timestamp}`,
				kind: "model",
				label: assistant.model ?? "model",
				startedAt: assistant.timestamp,
				...(typeof assistant.duration === "number" ? { durationMs: assistant.duration } : {}),
				status: assistant.stopReason === "error" ? "error" : "ok",
				...(usage
					? {
							tokens: {
								input: usage.input,
								output: usage.output,
								cached: usage.cacheRead + usage.cacheWrite,
							},
							cost: usage.cost.total,
						}
					: {}),
			});
			continue;
		}

		if (message.role === "toolResult") {
			const call = callDetails.get(message.toolCallId);
			const subs = message.toolName === "task" ? subStepsOf(message.details) : undefined;
			raw.push({
				id: message.toolCallId,
				kind: "tool",
				label: message.toolName,
				...(call?.detail === undefined ? {} : { detail: call.detail }),
				startedAt: message.startedAt ?? message.timestamp,
				...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
				status: message.isError ? "error" : "ok",
				...(subs === undefined ? {} : { children: subs }),
			});
			continue;
		}

		if (message.role === "bashExecution") {
			raw.push({
				id: entry.id ?? `bash:${message.timestamp}`,
				kind: "tool",
				label: "bash",
				detail: message.command.slice(0, 120),
				startedAt: message.timestamp,
				status: message.exitCode === 0 ? "ok" : "error",
			});
		}
	}

	if (raw.length === 0) return null;

	const turnedAt = span.map(entry => entryStart(entry)).filter(n => Number.isFinite(n));
	const startedAt = Math.min(...turnedAt);
	const endedAt = Math.max(...raw.map(step => step.startedAt + (step.durationMs ?? 0)), ...turnedAt);
	const spanMs = Math.max(1, endedAt - startedAt);

	const steps: TraceStep[] = raw.map(step => {
		const offsetPct = clampPct(((step.startedAt - startedAt) / spanMs) * 100);
		const widthPct =
			step.durationMs === undefined
				? MIN_WIDTH_PCT
				: clampPct(Math.max(MIN_WIDTH_PCT, (step.durationMs / spanMs) * 100), 100 - offsetPct);
		return { ...step, offsetPct, widthPct };
	});

	const totals = {
		modelMs: 0,
		toolMs: 0,
		timedSteps: 0,
		untimedSteps: 0,
		failed: 0,
		input: 0,
		output: 0,
		cached: 0,
		cost: 0,
	};
	for (const step of steps) {
		if (step.durationMs === undefined) totals.untimedSteps++;
		else {
			totals.timedSteps++;
			if (step.kind === "model") totals.modelMs += step.durationMs;
			else totals.toolMs += step.durationMs;
		}
		if (step.status === "error") totals.failed++;
		if (step.tokens) {
			totals.input += step.tokens.input;
			totals.output += step.tokens.output;
			totals.cached += step.tokens.cached;
		}
		totals.cost += step.cost ?? 0;
	}

	return { startedAt, endedAt, steps, totals };
}

function entryStart(entry: SessionEntry): number {
	return entry.type === "message" ? entry.message.timestamp : Date.parse(entry.timestamp);
}

function clampPct(value: number, ceiling = 100): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(0, value), Math.max(0, ceiling));
}
