import { logger, prompt } from "@musepi/pi-utils";
import type { ExtensionAPI, ExtensionContext } from "../../extensibility/extensions/types";
import idleRecapPrompt from "../../prompts/system/recap-user.md" with { type: "text" };
import { nextActionableTask } from "../../tools/todo";

export const name = "musepi-idle-maintenance";
export const inject = [] as const;
export const provide = [] as const;

interface IdleState {
	generation: number;
	compaction?: ReturnType<ExtensionContext["setTimeout"]>;
	recap?: ReturnType<ExtensionContext["setTimeout"]>;
	recapAbort?: AbortController;
}

const COMPACTION_MIN_SECONDS = 60;
const COMPACTION_MAX_SECONDS = 3600;
const RECAP_MIN_SECONDS = 1;
const RECAP_MAX_SECONDS = 3600;

/**
 * Idle session maintenance, modelled on the upstream `IdleMaintenance` unit:
 * one `agent_end` settlement arms both the compaction and the recap timers,
 * and any activity disarms them together. The plugin owns the timers for every
 * host (TUI/desktop/ACP/daemon); hosts only supply the session capabilities
 * behind `ctx.runIdleCompaction`, `ctx.runEphemeralTurn`, `ctx.recordRecap`,
 * and `ctx.showRecap`.
 *
 * A plugin instance can serve several sessions, so state is bucketed by the
 * session's manager; one session's activity never cancels another's timer.
 */
export function apply(pi: ExtensionAPI): void {
	const states = new WeakMap<object, IdleState>();

	const stateFor = (ctx: ExtensionContext): IdleState => {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = { generation: 0 };
			states.set(ctx.sessionManager, state);
		}
		return state;
	};

	const isQuiet = (ctx: ExtensionContext): boolean => {
		if (!ctx.isIdle()) return false;
		if (ctx.isSettled && !ctx.isSettled()) return false;
		return !ctx.hasDraftInput?.();
	};

	const cancel = (ctx: ExtensionContext): void => {
		const state = stateFor(ctx);
		state.generation++;
		if (state.compaction) {
			ctx.clearTimer(state.compaction);
			state.compaction = undefined;
		}
		if (state.recap) {
			ctx.clearTimer(state.recap);
			state.recap = undefined;
		}
		state.recapAbort?.abort();
		state.recapAbort = undefined;
	};

	const armCompaction = (ctx: ExtensionContext, state: IdleState, scheduledFor: number): void => {
		if (!ctx.runIdleCompaction) return;
		if (ctx.settings.get("compaction.idleEnabled") !== true) return;
		if (ctx.settings.get("compaction.enabled") === false) return;
		const threshold = Number(ctx.settings.get("compaction.idleThresholdTokens") ?? 0);
		if (!(threshold > 0)) return;
		if (!isQuiet(ctx)) return;
		if ((ctx.getContextUsage()?.tokens ?? 0) < threshold) return;

		const seconds = Math.max(
			COMPACTION_MIN_SECONDS,
			Math.min(COMPACTION_MAX_SECONDS, Number(ctx.settings.get("compaction.idleTimeoutSeconds") ?? 300)),
		);
		state.compaction = ctx.setTimeout(() => {
			state.compaction = undefined;
			if (scheduledFor !== state.generation || !isQuiet(ctx)) return;
			if ((ctx.getContextUsage()?.tokens ?? 0) < threshold) return;
			void ctx.runIdleCompaction?.();
		}, seconds * 1000);
	};

	const runRecap = async (ctx: ExtensionContext, state: IdleState, scheduledFor: number): Promise<void> => {
		state.recap = undefined;
		if (scheduledFor !== state.generation || !isQuiet(ctx)) return;
		const runEphemeralTurn = ctx.runEphemeralTurn;
		const showRecap = ctx.showRecap;
		if (!runEphemeralTurn || !showRecap) return;

		const goal = ctx.getGoalModeState?.()?.goal.objective.trim();
		const title = ctx.sessionManager.getSessionName()?.trim();
		const task = nextActionableTask(ctx.getTodoPhases?.() ?? [])?.content ?? "";
		const promptText = prompt.render(idleRecapPrompt, {
			goal: goal || title || "",
			task,
		});

		const abort = new AbortController();
		state.recapAbort = abort;
		try {
			const { replyText } = await runEphemeralTurn({ promptText, signal: abort.signal });
			if (state.recapAbort !== abort || abort.signal.aborted) return;
			if (scheduledFor !== state.generation || !isQuiet(ctx)) return;
			const text = replyText.trim();
			if (!text) return;
			ctx.recordRecap?.(text);
			showRecap(text);
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (state.recapAbort === abort) state.recapAbort = undefined;
		}
	};

	const armRecap = (ctx: ExtensionContext, state: IdleState, scheduledFor: number): void => {
		if (!ctx.runEphemeralTurn || !ctx.showRecap) return;
		if (ctx.settings.get("recap.enabled") !== true) return;
		if (!isQuiet(ctx)) return;
		if ((ctx.getContextUsage()?.tokens ?? 0) === 0) return;

		const seconds = Math.max(
			RECAP_MIN_SECONDS,
			Math.min(RECAP_MAX_SECONDS, Number(ctx.settings.get("recap.idleSeconds") ?? 240)),
		);
		state.recap = ctx.setTimeout(() => {
			void runRecap(ctx, state, scheduledFor);
		}, seconds * 1000);
	};

	const arm = (ctx: ExtensionContext): void => {
		cancel(ctx);
		const state = stateFor(ctx);
		const scheduledFor = state.generation;
		armCompaction(ctx, state, scheduledFor);
		armRecap(ctx, state, scheduledFor);
	};

	pi.on("agent_end", (_event, ctx) => {
		arm(ctx);
	});
	pi.on("turn_start", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("input", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("auto_compaction_start", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("session_branch", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cancel(ctx);
	});
}
