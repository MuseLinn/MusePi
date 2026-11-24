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
			raw.push({
				id: message.toolCallId,
				kind: "tool",
				label: message.toolName,
				...(call?.detail === undefined ? {} : { detail: call.detail }),
				startedAt: message.startedAt ?? message.timestamp,
				...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
				status: message.isError ? "error" : "ok",
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
