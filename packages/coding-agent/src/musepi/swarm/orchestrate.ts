// ============================================================
// MusePi native swarm orchestration — agent_swarm + agent execute
// flows (foreground). Model resolution, progressive launch, widget
// through the host's extension-widget channel (native in the fork),
// resume bookkeeping, and the final report.
//
// Background variant runs through the native background task manager
// (task_list / task_output / task_stop), report optionally to output_path.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import { formatReport } from "@musepi/core/swarm/report.js";
import {
	cancelPending,
	cancelTimer,
	currentSwarm,
	FRAME_INTERVAL_MS,
	globalAbortController,
	type ModelTier,
	progressEstimator,
	type SubAgentTask,
	type SubAgentType,
	type SwarmState,
	setActiveSessions,
	setCancelPending,
	setCancelTimer,
	setCurrentSwarm,
	setGlobalAbortController,
	setSavedSwarmState,
	setSwarmCancelled,
} from "@musepi/core/swarm/types.js";
import { Type } from "typebox";
import { backgroundManager } from "../task/manager.ts";
import {
	getDefaultModel,
	getDefaultProvider,
	getTaskRoleModel,
	linkAbortSignal,
	runProgressive,
	runSubAgent,
} from "./subagent.ts";
import { SwarmWidgetComponent } from "./widget.ts";

// ── Shared helpers (ported from the harness entry) ───────────

function parseModelSpec(spec: string): { provider?: string; modelId: string } {
	const colonIdx = spec.indexOf(":");
	if (colonIdx > 0) return { provider: spec.substring(0, colonIdx), modelId: spec.substring(colonIdx + 1) };
	const slashIdx = spec.indexOf("/");
	if (slashIdx > 0) return { provider: spec.substring(0, slashIdx), modelId: spec.substring(slashIdx + 1) };
	return { modelId: spec };
}

function summarizeStateForUpdate(state: SwarmState): any {
	return {
		...state,
		tasks: state.tasks.map((t) => {
			const lines = t.outputLines || [];
			return {
				...t,
				outputLineCount: lines.length,
				outputLines:
					lines.length > 5 ? [`[… ${lines.length - 5} earlier line(s) omitted]`, ...lines.slice(-5)] : lines,
			};
		}),
	};
}

async function resolveModelForTask(
	prompt: string,
	items: string[],
	available: any[],
	defaultModelId: string,
	defaultProvider: string,
	ctx: any,
): Promise<string> {
	const hasImages = items.some((i: string) => /\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff)$/i.test(i));
	const needsVision =
		hasImages ||
		/\b(vi(?:sual|deo|sion)|image|screen(?:shot|cap)|photo|multimod|[多视]模态|视觉|图像|截图|图片|照[片面]|视频|GIF|pixel|render|asset|sprite|texture|特效|光影|色彩|动画|UI.*check|界面.*检|[检审]查.*(?:视觉|画面|效果))\b/i.test(
			prompt,
		);
	const isSimple = /\b(find|list|scan|grep|read|cat|ls|count|check|show|display)\b/.test(prompt);
	const isComplex =
		/\b(implement|refactor|design|optimize|create|build|write|debug|test|fix|architect|migrate|integrate)\b/.test(
			prompt,
		);

	const currentModelId = ctx.model?.id ?? "";
	const currentProvider = ctx.model?.provider ?? defaultProvider;

	const scored = available
		.map((m: any) => {
			let score = 0;
			const id = m.id.toLowerCase();
			const isMultimodal = m.input?.includes("image");
			const isFree = id.endsWith("-free");
			const isLargeContext = (m.contextWindow || 0) >= 100000;
			const costPerMee = (m.cost?.input || 0) + (m.cost?.output || 0);

			if (m.provider === defaultProvider) score += 100;
			if (currentProvider && m.provider === currentProvider) score += 80;
			if (currentModelId && m.id === currentModelId) score += 200;
			if (isFree) score += 50;
			else if (costPerMee > 10) score -= 60;
			else if (costPerMee > 5) score -= 30;
			else if (costPerMee > 2) score -= 10;

			if (needsVision) {
				if (isMultimodal) score += 200;
				else score -= 150;
			} else if (hasImages) {
				if (isMultimodal) score += 200;
				else score -= 100;
			} else if (isSimple) {
				if (isFree) score += 150;
				score += 50;
			} else if (isComplex) {
				if (isLargeContext) score += 100;
				if (!isFree) score += 50;
			} else {
				if (isFree) score += 50;
			}

			if (isFree) score += 30;
			score -= id.length;
			return { model: m, score };
		})
		.sort((a: any, b: any) => b.score - a.score);

	if (scored.length >= 2 && Math.abs(scored[0].score - scored[1].score) < 20) {
		const modelOptions = scored.slice(0, 5).map((s: any) => {
			const m = s.model;
			const free = m.id.endsWith("-free") ? " (free)" : "";
			const vision = m.input?.includes("image") ? " [multimodal]" : "";
			const context = m.contextWindow ? ` ${Math.round(m.contextWindow / 1000)}k ctx` : "";
			return `${m.id}${free}${vision}${context} [${m.provider}]`;
		});
		modelOptions.push("Other (type a model name)");

		const choice = await ctx.ui.select(`Which model? (default: ${scored[0].model.id})`, modelOptions, {
			timeout: 30000,
		});

		if (choice === "Other (type a model name)") {
			const custom = await ctx.ui.input("Enter model name:", scored[0].model.id, { timeout: 30000 });
			if (custom?.trim()) {
				const exact = scored.find((s: any) => s.model.id === custom.trim());
				if (exact) return `${exact.model.provider}:${exact.model.id}`;
				const partial = available.find((m: any) => m.id.includes(custom.trim()));
				if (partial) return `${partial.provider}:${partial.id}`;
				return custom.trim();
			}
		} else if (choice) {
			const idx = modelOptions.indexOf(choice);
			if (idx >= 0 && idx < scored.length) return `${scored[idx].model.provider}:${scored[idx].model.id}`;
		}
		return `${scored[0].model.provider}:${scored[0].model.id}`;
	} else if (scored.length > 0) {
		return `${scored[0].model.provider}:${scored[0].model.id}`;
	} else {
		const fromDefaultProvider = available.find((m: any) => m.id === defaultModelId && m.provider === defaultProvider);
		const fromAny = available.find((m: any) => m.id === defaultModelId);
		return (fromDefaultProvider || fromAny || available[0])?.id || "";
	}
}

function resolveExplicitModel(modelId: string, available: any[], defaultProvider: string): string | null {
	const parsed = parseModelSpec(modelId);
	let candidates: any[];
	if (parsed.provider) {
		candidates = available.filter(
			(m: any) =>
				m.id.toLowerCase() === parsed.modelId.toLowerCase() &&
				m.provider?.toLowerCase() === parsed.provider?.toLowerCase(),
		);
		if (candidates.length === 0) {
			candidates = available.filter((m: any) => m.id.toLowerCase() === parsed.modelId.toLowerCase());
		}
	} else {
		const query = modelId.toLowerCase();
		candidates = available.filter((m: any) => {
			const id = m.id.toLowerCase();
			const name = (m.name || "").toLowerCase();
			const provider = (m.provider || "").toLowerCase();
			return id.includes(query) || name.includes(query) || provider.includes(query);
		});
	}
	if (candidates.length === 0) return null;
	const scored = candidates
		.map((m: any) => {
			let score = 0;
			if (m.provider === defaultProvider) score += 100;
			if (m.id.endsWith("-free")) score += 50;
			score -= m.id.length;
			return { model: m, score };
		})
		.sort((a: any, b: any) => b.score - a.score);
	return scored[0].model.id;
}

// ── Widget host (extension-widget channel; native in the fork) ──

interface WidgetHost {
	tui: any;
	repaint(): void;
}

function mountSwarmWidget(ctx: any, widget: SwarmWidgetComponent): WidgetHost {
	const host: WidgetHost = {
		tui: null,
		repaint() {
			host.tui?.invalidate?.();
			host.tui?.requestRender?.();
		},
	};
	try {
		ctx.ui.setWidget("swarm-mode-progress", (t: any, _th: any) => {
			host.tui = t;
			return widget;
		});
	} catch {
		/* no UI (print/RPC) — the widget simply never mounts */
	}
	return host;
}

function unmountSwarmWidget(ctx: any): void {
	try {
		ctx.ui.setWidget("swarm-mode-progress", undefined);
	} catch {
		/* stale ctx */
	}
}

// ── Background swarm runner (fire-and-forget) ─────────────────

async function runSwarmInBackground(
	bgId: string,
	state: SwarmState,
	tasks: SubAgentTask[],
	ctx: any,
	maxC: number,
	outputPath?: string,
): Promise<void> {
	const controller = new AbortController();
	// task_stop flips the entry status to "aborted"; poll and translate that
	// into an abort so in-flight subagents and the worker pool wind down.
	const stopPoll = setInterval(() => {
		const t = backgroundManager.get(bgId);
		if (!t || t.status !== "running") {
			try {
				controller.abort();
			} catch {
				/* ignore */
			}
		}
	}, 500);
	stopPoll.unref?.();
	try {
		await runProgressive(tasks, maxC, async (task) => {
			if (controller.signal.aborted) {
				task.status = "aborted";
				return;
			}
			await runSubAgent(task, ctx, controller.signal, () => {
				const d = tasks.filter((t) => t.status === "done").length;
				backgroundManager.appendOutput(bgId, [`progress: ${d}/${tasks.length} done`]);
			});
		});

		// stop() already flipped the entry to "aborted" — leave it as-is.
		if (controller.signal.aborted) return;

		state.endTime = Date.now();
		state.status = tasks.every((t) => t.status === "done")
			? "completed"
			: tasks.some((t) => t.status === "done")
				? "partial"
				: "failed";

		const report = formatReport(state);
		if (outputPath) {
			// Kimi Code-style: full report lands in output_path; the task entry
			// keeps only a pointer + tail so in-memory outputLines stay small.
			try {
				fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
				fs.writeFileSync(outputPath, report, "utf-8");
				backgroundManager.complete(bgId, [
					`[report written to ${outputPath} — use Read with offset/limit to page]`,
					...report.split("\n").slice(-5),
				]);
			} catch (e: any) {
				backgroundManager.complete(bgId, [
					`[failed to write output_path ${outputPath}: ${e?.message || e}]`,
					report,
				]);
			}
		} else {
			backgroundManager.complete(bgId, report.split("\n"));
		}
	} catch (e: any) {
		backgroundManager.fail(bgId, e?.message || String(e));
	} finally {
		clearInterval(stopPoll);
		if (currentSwarm === state) setCurrentSwarm(null);
	}
}

// ── agent_swarm ───────────────────────────────────────────────

export const musepiAgentSwarmToolDef = {
	name: "agent_swarm",
	label: "Agent Swarm",
	description: "Batch parallel: same template applied to multiple items. Each item gets an isolated sub-agent.",
	promptSnippet: "agent_swarm — auto-routes models based on task type unless specified",
	promptGuidelines: [
		"Model routing is automatic: if you don't specify 'model', the system picks the best model based on task type, current session model, and available capabilities.",
		"If the user mentions specific models (e.g., 'use deepseek' or '用mimo'), pass them through the 'model' or 'model_map' parameter.",
		"For multi-model swarms, use model_map to assign different models per item.",
		"When uncertain which model is best, call ask_user_question to let the user choose — then pass their response as model/model_map.",
		"For image/multimodal tasks, the system automatically prefers multimodal-capable models.",
	],
	parameters: Type.Object({
		description: Type.String({ description: "Swarm name for display" }),
		subagent_type: StringEnum(["explore", "plan", "coder"] as const, { default: "coder" }),
		prompt_template: Type.Optional(
			Type.String({ description: "Template with {{item}} placeholder. Required when items is provided." }),
		),
		items: Type.Optional(
			Type.Array(Type.String(), { description: "Items to process. Each item launches one new sub-agent. Max 128." }),
		),
		model_tier: Type.Optional(StringEnum(["cheap", "balanced", "premium", "auto"] as const, { default: "auto" })),
		model: Type.Optional(Type.String({ description: "Override model for all agents" })),
		model_map: Type.Optional(
			Type.Record(
				Type.String({ description: "Item index (0-based)" }),
				Type.String({
					description: "Model name or alias for this item (per-item overrides; keys are item indices)",
				}),
			),
		),
		max_concurrency: Type.Optional(Type.Number({ default: 5 })),
		run_in_background: Type.Optional(
			Type.Boolean({
				default: false,
				description: "Run the swarm as a background task and return a task ID immediately.",
			}),
		),
		output_path: Type.Optional(
			Type.String({ description: "Only with run_in_background: write the final swarm report to this file." }),
		),
	}),

	async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
		const tier: ModelTier = params.model_tier || "auto";
		const maxC = Math.min(params.max_concurrency || 5, 128);

		const defaultModelId = getDefaultModel();
		const defaultProvider = getDefaultProvider();
		const available: Array<{ id: string; provider?: string; cost: { input: number } }> =
			ctx.modelRegistry?.getAvailable() || [];

		// ── Model selection ──
		let modelId = params.model || "";
		if (modelId) {
			const resolved = resolveExplicitModel(modelId, available, defaultProvider);
			if (!resolved) {
				return {
					content: [
						{
							type: "text",
							text: `No model matching "${modelId}" found. Available: ${available
								.map((m: any) => m.id)
								.slice(0, 10)
								.join(", ")}...`,
						},
					],
				};
			}
			modelId = resolved;
		} else {
			// MusePi model roles: an explicit `task` role config wins over
			// auto-routing; unconfigured → existing auto-routing behavior.
			const taskRole = getTaskRoleModel(available);
			if (taskRole) {
				modelId = taskRole;
			} else {
				modelId = await resolveModelForTask(
					(params.prompt_template || "").toLowerCase(),
					params.items || [],
					available,
					defaultModelId,
					defaultProvider,
					ctx,
				);
			}
		}
		if (!modelId) {
			return { content: [{ type: "text", text: "No models available in registry." }] };
		}

		// ── model_map resolution ──
		const rawMap = params.model_map || {};
		const resolvedMap: Record<string, string> = {};
		function autoResolveModel(query: string): string {
			const q = query.toLowerCase();
			const candidates = available.filter((m: any) => {
				const id = m.id.toLowerCase();
				const name = (m.name || "").toLowerCase();
				const provider = (m.provider || "").toLowerCase();
				return id.includes(q) || name.includes(q) || provider.includes(q);
			});
			if (candidates.length === 0) return modelId;
			const scored = candidates
				.map((m: any) => {
					let score = 0;
					if (m.provider === defaultProvider) score += 100;
					if (m.id.endsWith("-free")) score += 50;
					score -= m.id.length;
					return { model: m, score };
				})
				.sort((a: any, b: any) => b.score - a.score);
			return scored[0].model.id;
		}
		for (const [k, v] of Object.entries(rawMap)) {
			if (typeof v === "string" && v.trim()) resolvedMap[k] = autoResolveModel(v.trim());
		}

		// ── Build task list ──
		const items: string[] = params.items || [];
		const promptTemplate: string = params.prompt_template || "";
		if (items.length === 0) {
			return { content: [{ type: "text", text: "agent_swarm: provide items (batch items) to run." }] };
		}
		const tasks: SubAgentTask[] = items.slice(0, 128).map((item, idx) => {
			const taskId = idx + 1;
			const resolvedModel = resolvedMap[String(idx)] || modelId;
			return {
				id: String(taskId).padStart(3, "0"),
				agent: params.subagent_type || "coder",
				type: params.subagent_type as SubAgentType,
				task: promptTemplate.replace(/\{\{item\}\}/g, item),
				promptTemplate,
				item,
				model: resolvedModel,
				status: "pending" as const,
				turns: 0,
				usage: { input: 0, output: 0, cost: 0 },
				outputLines: [],
				progressPercent: 0,
				toolCalls: 0,
				estimatedTotalCalls: 10,
				ticks: 0,
			};
		});

		// ── Init swarm state ──
		const state: SwarmState = {
			name: params.description,
			mode: "swarm",
			modelTier: tier,
			tasks,
			status: "pending",
			startTime: Date.now(),
		};
		setCurrentSwarm(state);
		progressEstimator.reset();
		for (const t of tasks) progressEstimator.ensureMember(t.id);
		setActiveSessions(new Map());
		setCancelPending(false);
		setSwarmCancelled(false);
		if (cancelTimer) {
			clearTimeout(cancelTimer);
			setCancelTimer(null);
		}

		// ── Background mode: hand off to the native background task manager ──
		if (params.run_in_background === true) {
			const bgId = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			backgroundManager.register({
				id: bgId,
				prompt: `[swarm] ${params.description} (${tasks.length} agents)`,
				model: modelId,
				subagentType: params.subagent_type || "coder",
				status: "running",
				outputLines: [],
				startTime: Date.now(),
				createdAt: Date.now(),
				turns: 0,
				usage: { input: 0, output: 0, cost: 0 },
			});
			const outputPath = params.output_path as string | undefined;
			state.status = "running";
			// Fire-and-forget: progress lands in the task entry, the final
			// report in the entry (and optionally in output_path).
			void runSwarmInBackground(bgId, state, tasks, ctx, maxC, outputPath);
			return {
				content: [
					{
						type: "text",
						text:
							`Swarm started in background. Task ID: ${bgId}\n` +
							`${tasks.length} agents queued (max_concurrency=${maxC}, 30min/agent timeout).\n` +
							`Use task_list to check status, task_output(task_id="${bgId}", block=true) to wait for completion.` +
							(outputPath ? `\nFinal report will be written to: ${outputPath}` : ""),
					},
				],
				details: null,
			};
		}

		setGlobalAbortController(new AbortController());
		const unlinkGlobal = linkAbortSignal(signal, globalAbortController!);

		const theme = ctx.ui.theme;
		state.status = "running";

		const widget = new SwarmWidgetComponent(
			() => currentSwarm,
			theme,
			() => cancelPending,
		);
		const host = mountSwarmWidget(ctx, widget);
		const updateWidget = () => {
			if (widget.update() === "changed") host.repaint();
		};
		updateWidget();

		let refreshTimer: ReturnType<typeof setInterval> | null = null;
		const startRefresh = () => {
			if (refreshTimer) return;
			refreshTimer = setInterval(() => {
				const status = widget.update();
				if (status === "changed") host.repaint();
				if ((status === "empty" || widget.refreshIntervalMs <= 0) && refreshTimer) {
					clearInterval(refreshTimer);
					refreshTimer = null;
				}
			}, FRAME_INTERVAL_MS);
		};
		startRefresh();

		const updateProgress = () => {
			updateWidget();
			const d = tasks.filter((t) => t.status === "done").length;
			onUpdate?.({
				content: [{ type: "text", text: `${state.name}: ${d}/${tasks.length} done` }],
				details: summarizeStateForUpdate(state),
			});
		};

		try {
			await runProgressive(
				tasks,
				maxC,
				async (task) => {
					if (signal.aborted || currentSwarm === null) {
						task.status = "aborted";
						return;
					}
					const combinedSignal =
						AbortSignal.any?.([signal, globalAbortController?.signal].filter(Boolean) as AbortSignal[]) ?? signal;
					await runSubAgent(task, ctx, combinedSignal, updateProgress);
				},
				{ initialBatch: Math.min(5, maxC), spacingMs: 700 },
			);
		} finally {
			unlinkGlobal();
			setGlobalAbortController(null);
			state.endTime = Date.now();
			state.status = tasks.every((t) => t.status === "done")
				? "completed"
				: tasks.some((t) => t.status === "done")
					? "partial"
					: "failed";

			if (widget.update() === "changed") host.repaint();
			if (refreshTimer) {
				clearInterval(refreshTimer);
				refreshTimer = null;
			}
			setActiveSessions(null);

			if (state.status === "partial" || state.status === "failed") {
				const completedItems = tasks.filter((t) => t.status === "done").map((t) => t.item || t.task);
				setSavedSwarmState({
					name: state.name,
					items: params.items,
					modelTier: tier,
					subagentType: params.subagent_type as SubAgentType,
					promptTemplate: params.prompt_template,
					maxConcurrency: maxC,
					completedItems,
				});
			}

			setTimeout(() => {
				unmountSwarmWidget(ctx);
				if (currentSwarm === state) setCurrentSwarm(null);
			}, 30000);
		}

		return {
			content: [{ type: "text", text: formatReport(state) }],
			details: state,
		};
	},
};

// ── agent (single dispatch) ───────────────────────────────────

export const musepiAgentToolDef = {
	name: "agent",
	label: "Agent",
	description: "Single agent dispatch: isolated sub-agent for a specific task.",
	promptSnippet: "agent — single sub-agent with auto model routing",
	promptGuidelines: [
		"Model routing is automatic: if you don't specify 'model', the system picks the best model based on task type, current session model, and available capabilities.",
		"If the user mentions a specific model name, pass it via the 'model' parameter.",
		"When uncertain which model to use, call ask_user_question to let the user choose.",
	],
	parameters: Type.Object({
		prompt: Type.String({ description: "Task prompt" }),
		description: Type.String({ description: "Short description" }),
		subagent_type: StringEnum(["explore", "plan", "coder"] as const, { default: "coder" }),
		model_tier: Type.Optional(StringEnum(["cheap", "balanced", "premium", "auto"] as const, { default: "auto" })),
		model: Type.Optional(Type.String()),
	}),

	async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
		const tier: ModelTier = params.model_tier || "auto";
		const defaultModelId = getDefaultModel();
		const defaultProvider = getDefaultProvider();
		const available: Array<{ id: string; provider?: string; cost: { input: number } }> =
			ctx.modelRegistry?.getAvailable() || [];

		let modelId = params.model || "";
		if (modelId) {
			const resolved = resolveExplicitModel(modelId, available, defaultProvider);
			if (!resolved) {
				return { content: [{ type: "text", text: `No model matching "${modelId}" found.` }] };
			}
			modelId = resolved;
		} else {
			// MusePi model roles: an explicit `task` role config wins over
			// auto-routing; unconfigured → existing auto-routing behavior.
			const taskRole = getTaskRoleModel(available);
			if (taskRole) {
				modelId = taskRole;
			} else {
				modelId = await resolveModelForTask(
					(params.prompt || "").toLowerCase(),
					[],
					available,
					defaultModelId,
					defaultProvider,
					ctx,
				);
			}
		}
		if (!modelId) {
			return { content: [{ type: "text", text: "No models available." }] };
		}

		const task: SubAgentTask = {
			id: "001",
			agent: params.subagent_type,
			type: params.subagent_type as SubAgentType,
			task: params.prompt,
			prompt: params.prompt,
			model: modelId,
			status: "pending" as const,
			turns: 0,
			usage: { input: 0, output: 0, cost: 0 },
			outputLines: [],
			progressPercent: 0,
			toolCalls: 0,
			estimatedTotalCalls: 1,
			ticks: 0,
		};

		const state: SwarmState = {
			name: params.description,
			mode: "agent",
			modelTier: tier,
			tasks: [task],
			status: "pending",
			startTime: Date.now(),
		};
		setCurrentSwarm(state);
		progressEstimator.reset();
		progressEstimator.ensureMember("001");
		setActiveSessions(new Map());
		setSwarmCancelled(false);

		const theme = ctx.ui.theme;
		state.status = "running";

		const widget = new SwarmWidgetComponent(
			() => state,
			theme,
			() => false,
		);
		const host = mountSwarmWidget(ctx, widget);
		const updateWidget = () => {
			if (widget.update() === "changed") host.repaint();
		};
		updateWidget();

		let refreshTimer: ReturnType<typeof setInterval> | null = null;
		const startRefresh = () => {
			if (refreshTimer) return;
			refreshTimer = setInterval(() => {
				const status = widget.update();
				if (status === "changed") host.repaint();
				if ((status === "empty" || widget.refreshIntervalMs <= 0) && refreshTimer) {
					clearInterval(refreshTimer);
					refreshTimer = null;
				}
			}, FRAME_INTERVAL_MS);
		};
		startRefresh();

		const updateProgress = () => {
			updateWidget();
			onUpdate?.({
				content: [{ type: "text", text: `${state.name}: ${task.status}` }],
				details: summarizeStateForUpdate(state),
			});
		};

		try {
			await runSubAgent(task, ctx, signal, updateProgress);
		} finally {
			state.endTime = Date.now();
			state.status = task.status === "done" ? "completed" : "failed";
			if (widget.update() === "changed") host.repaint();
			if (refreshTimer) {
				clearInterval(refreshTimer);
				refreshTimer = null;
			}
			setActiveSessions(null);
			setTimeout(() => {
				unmountSwarmWidget(ctx);
				if (currentSwarm === state) setCurrentSwarm(null);
			}, 30000);
		}

		const out = task.outputLines.join("\n");
		return {
			content: [
				{
					type: "text",
					text: out || `Agent finished with status: ${task.status}${task.error ? ` (${task.error})` : ""}`,
				},
			],
			details: state,
		};
	},
};
