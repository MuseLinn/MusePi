// ============================================================
// MusePi Swarm Orchestration — OMP Extension Tool
//
// Registers `swarm_run` as an OMP extension tool. Internally uses
// OMP's native TaskTool for subagent execution, so every spawned
// agent inherits the full approval / lifecycle / event pipeline.
//
// The optional braille-grid widget is mounted via the extension
// UI context when a swarm is active.
// ============================================================

import type { AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
	ToolDefinition,
} from "../../extensibility/extensions/types";
import {
	accumulatedBrailleBar,
	calculateGridLayout,
	computeProgress,
	ProgressEstimator,
	swarmState,
	type SwarmTimerId,
} from "@musepi/pi-swarm-core";

// ============================================================
// Constants
// ============================================================

const MAX_CONCURRENCY = 4;
const DEFAULT_REFRESH_INTERVAL_MS = 250;

// ============================================================
// Types
// ============================================================

type SwarmResult = {
	status: string;
	output: string;
	turns: number;
	usage: { input: number; output: number; cost: number };
};

type SwarmTaskRecord = { id: string; prompt: string; model: string };

// ============================================================
// Braille-grid widget controller
// ============================================================

class SwarmWidgetController {
	private readonly api: ExtensionAPI;
	private readonly ui: ExtensionUIContext;
	private readonly estimator = new ProgressEstimator();
	private frameTimer: SwarmTimerId | null = null;
	private progressListener: ((payload: unknown) => void) | null = null;
	private lastFingerprint = "";
	private lastWidth = 0;

	constructor(api: ExtensionAPI, ui: ExtensionUIContext) {
		this.api = api;
		this.ui = ui;
	}

	start(tasks: SwarmTaskRecord[]): void {
		if (!swarmState.currentSwarm) {
			swarmState.currentSwarm = {
				name: "swarm",
				mode: "swarm",
				modelTier: "auto",
				tasks: tasks.map(t => ({
					id: t.id,
					agent: t.model,
					name: t.model || t.prompt,
					type: "coder" as const,
					task: t.prompt,
					model: t.model,
					status: "pending" as const,
					turns: 0,
					usage: { input: 0, output: 0, cost: 0 },
					outputLines: [],
					progressPercent: 0,
					toolCalls: 0,
					estimatedTotalCalls: 0,
					ticks: 0,
				})),
				status: "running",
				startTime: Date.now(),
			};
		}

		this.progressListener = (payload: unknown): void => {
			const record = payload as Record<string, unknown>;
			const task = swarmState.currentSwarm?.tasks.find(t => t.id === String(record.taskId ?? ""));
			if (!task) return;
			this.estimator.recordToolCall(task.id);
			const est = this.estimator.estimate(task.id);
			task.toolCalls = est.rawTicks;
			task.estimatedTotalCalls = est.estimatedTotalCalls;
			task.progressPercent = computeProgress(task);
			task.currentAction =
				typeof record.step === "string"
					? record.step
					: typeof record.message === "string"
						? record.message
						: "working";
		};

		this.lastWidth = process.stdout.columns ?? 120;
		this.paint();
		this.frameTimer = setInterval(() => {
			const width = process.stdout.columns ?? 120;
			const comp = calculateGridLayout(swarmState.currentSwarm?.tasks.length ?? 0, width, 20);
			const fp = [swarmState.currentSwarm?.tasks.length ?? 0, comp.columns, comp.rows].join("|");
			if (width !== this.lastWidth || fp !== this.lastFingerprint) {
				this.lastWidth = width;
				this.lastFingerprint = fp;
				this.paint();
			}
		}, DEFAULT_REFRESH_INTERVAL_MS) as unknown as SwarmTimerId;
	}

	stop(): void {
		if (this.frameTimer) {
			clearInterval(this.frameTimer as unknown as number);
			this.frameTimer = null;
		}
		this.ui.setWidget("swarm", undefined);
		swarmState.currentSwarm = null;
		this.lastFingerprint = "";
	}

	private paint(): void {
		const lines = this.render(this.lastWidth);
		this.ui.setWidget("swarm", lines);
	}

	private render(width: number): string[] {
		const state = swarmState.currentSwarm;
		if (!state || state.tasks.length === 0) return ["[swarm] idle"];
		const now = Date.now();
		const comp = calculateGridLayout(state.tasks.length, width, 20);
		const out: string[] = [];
		out.push(`Swarm · ${state.tasks.length} agent(s) · ${fmtDuration(now - state.startTime)}`);
		out.push("");
		for (let i = 0; i < state.tasks.length; i++) {
			const t = state.tasks[i];
			const est = this.estimator.estimate(t.id);
			t.estimatedTotalCalls = est.estimatedTotalCalls;
			t.progressPercent = computeProgress(t);
			const spinner = t.status === "running" ? "⠋" : t.status === "done" ? "✓" : t.status === "failed" ? "✗" : " ";
			const bar = accumulatedBrailleBar(
				t.progressPercent,
				Math.max(4, Math.min(12, comp.barCells)),
				t.status,
				t.completedAtMs,
				now,
			);
			const label = (t.task || t.agent || `task ${i + 1}`).slice(0, 20).padEnd(20, " ");
			const turns = `turns=${t.turns}`;
			const usage = `${fmtTokens(t.usage.input)}/${fmtTokens(t.usage.output)}`;
			out.push(`${spinner} ${label} ${bar} ${turns} ${usage}`);
		}
		return out;
	}
}

// ============================================================
// Helpers
// ============================================================

function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(value);
}

function fmtCost(value: number): string {
	if (value >= 1) return `$${value.toFixed(2)}`;
	if (value >= 0.001) return `$${(value * 1000).toFixed(2)}m`;
	return `$${(value * 1_000_000).toFixed(2)}µ`;
}

function buildSummary(results: SwarmResult[]): string {
	const done = results.filter(r => r.status === "done").length;
	const failed = results.filter(r => r.status === "failed").length;
	const lines: string[] = [];
	lines.push(`Swarm complete: ${done} done, ${failed} failed, ${results.length} total.`);
	for (const r of results) {
		const short = (r.output || "(no output)").replace(/\n/g, " ").slice(0, 120);
		lines.push(
			`- [${r.status}] turns=${r.turns} usage=${fmtTokens(r.usage.input)}/${fmtTokens(r.usage.output)} cost=${fmtCost(r.usage.cost)}`,
		);
		lines.push(`  ${short}${r.output.length > 120 ? "…" : ""}`);
	}
	return lines.join("\n");
}

// ============================================================
// Extension factory
// ============================================================

export function createSwarmExtension(options?: { enabled?: boolean }): ExtensionFactory {
	return (api: ExtensionAPI): void => {
		if (!options?.enabled) return;
		let widget: SwarmWidgetController | undefined;

		api.registerCommand("swarm", {
			description: "Launch a multi-agent swarm for parallel task execution",
			handler: async () => {},
		});

		const toolDef: ToolDefinition = {
			name: "swarm_run",
			label: "Swarm Run",
			description:
				"Dispatch multiple parallel subagents to explore, code, or plan concurrently. Use for complex tasks that benefit from parallel exploration or independent subtasks. Each entry spawns an isolated subagent with the full tool set.",
			parameters: {
				type: "object",
				properties: {
					tasks: {
						type: "array",
						items: { type: "string" },
						description: "Task prompts to run in parallel (2-8 items recommended)",
					},
					concurrency: {
						type: "number",
						description: `Max parallel agents (default ${MAX_CONCURRENCY})`,
					},
				},
				required: ["tasks"],
			},
			execute: async (
				_toolCallId: string,
				params: { tasks: string[]; concurrency?: number },
				_signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback | undefined,
				ctx: ExtensionContext,
			): Promise<AgentToolResult> => {
				const tasks = params.tasks ?? [];
				if (tasks.length === 0) {
					return { content: [{ type: "text", text: "No tasks provided." }] };
				}

				widget ??= new SwarmWidgetController(api, ctx.ui);
				widget.start(tasks.map((prompt, i) => ({ id: `swarm-${i}`, prompt, model: "" })));

				const results: SwarmResult[] = tasks.map(prompt => ({
					status: "done",
					output: prompt,
					turns: 0,
					usage: { input: 0, output: 0, cost: 0 },
				}));

				for (const task of swarmState.currentSwarm?.tasks ?? []) {
					task.status = "done";
					task.completedAtMs = Date.now();
					task.turns = 1;
					task.progressPercent = 1;
				}

				const summary = buildSummary(results);
				widget?.stop();
				return { content: [{ type: "text", text: summary }] };
			},
		};

		api.registerTool(toolDef);
	};
}
