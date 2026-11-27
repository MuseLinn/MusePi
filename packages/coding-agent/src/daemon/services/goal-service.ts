/**
 * GoalService — the goal-mode RPC seam as an L2 daemon service.
 *
 * Seam:
 * - Services name/inject (dsh parity): key `goals`, injects
 *   `sessionProjections`. Goal mode lives on the live AgentSession with no
 *   journal record of its own, so this service contributes its own projection
 *   unit — nobody else registers it on the service's behalf.
 * - Input: `session.setGoal` (open/close), `session.goal` (show/pause/resume/
 *   drop/budget/guided).
 * - Output: `modesOf` snapshots and goal lifecycle acks; the projection push is
 *   published through the host after every write, so a client never polls.
 * - Lifecycle: stateless between calls; `stop` withdraws its projection unit so
 *   a disabled service leaves no `sessionMode` key in the baseline.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { SessionModeProjection } from "@musepi/pi-wire";
import {
	type ProjectionDefinition,
	type ProjectionHandle,
	sessionModeProjectionDefinition,
} from "../../session/session-projections";
import type { DaemonService } from "./types";

/** The slice of a live session goal control touches. */
export interface GoalLiveSession {
	agentSession: {
		getGoalModeState(): GoalModeState | undefined;
		setGoalModeState(state: GoalModeState | undefined): void;
		getPlanModeState(): { enabled?: boolean } | undefined;
		getVibeModeState(): { enabled?: boolean } | undefined;
		getEnabledToolNames(): string[];
		setActiveToolsByName(names: string[]): Promise<void>;
		settings: { get(key: string): unknown };
		isStreaming: boolean;
		memoryMode?: "persistent" | "incognito" | "temporary";
		/** Journal writer: goal mode has to be recorded, or it is lost on the
		 *  next activate (the TUI already records it this way). */
		sessionManager: { appendModeChange(mode: string, data?: Record<string, unknown>): string };
		prompt(text: string, options?: Record<string, unknown>): Promise<unknown>;
		followUp(text: string, images?: unknown, options?: Record<string, unknown>): Promise<unknown>;
		goalRuntime: {
			pauseGoal(): Promise<unknown>;
			resumeGoal(): Promise<GoalModeState>;
			dropGoal(): Promise<unknown>;
			onBudgetMutated(next: number | undefined): Promise<unknown>;
		};
	};
}

export interface GoalModeState {
	enabled?: boolean;
	mode?: string;
	goal?: { id: string; objective: string; status?: string } & Record<string, unknown>;
}

export interface GoalServiceDeps {
	get(sessionId: string): GoalLiveSession | undefined;
	/** Host-side projection publish — the goal/plan switches have no journal
	 *  record, so the write path must tell the projection to sample. */
	publishSessionModeProjection(sessionId: string): void;
	modesOf(session: unknown): unknown;
	/** Guided-goal interview kickoff (the hidden prompt that starts the
	 *  conversation) and media resolution for its attachments. */
	renderGuidedKickoff(input: { objective?: string }): string;
	resolveMedia(input: {
		images?: { type: "image"; data: string; mimeType: string }[];
		videos?: { type: "video"; mimeType: string; url?: string; data?: string }[];
	}): Promise<{ images?: unknown; videos?: unknown }>;
}

export class GoalService implements DaemonService {
	readonly key = "goals";
	readonly routes = {
		"session.setGoal": "setGoal",
		"session.goal": "goal",
	} as const;
	readonly inject = ["sessionProjections"] as const;

	readonly #deps: GoalServiceDeps;
	#projection: ProjectionHandle<SessionModeProjection> | null = null;

	constructor(deps: GoalServiceDeps) {
		this.#deps = deps;
	}

	/** dsh's `static inject`: resolve the projection service from the host
	 *  context and register this domain's unit. A missing dependency throws so
	 *  the mount fails loudly instead of the service running without its
	 *  read-model contribution. */
	start(ctx: Context): void {
		const projections = ctx.sessionProjections;
		if (!projections) {
			throw new Error("goals: sessionProjections service is not mounted");
		}
		this.#projection = projections.register(
			sessionModeProjectionDefinition as ProjectionDefinition<SessionModeProjection>,
		);
	}

	stop(): void {
		this.#projection?.dispose();
		this.#projection = null;
	}

	/** RPC session.setGoal: set/replace the goal with an objective, or close an
	 *  active goal when none is given. Opening goal mode without an objective is
	 *  unsupported — the GUI's one-tap "armed" path sends the next message's text
	 *  as the objective instead of toggling an empty goal. */
	setGoal(params: unknown): unknown {
		const p = (params ?? {}) as { sessionId?: unknown; objective?: unknown };
		if (typeof p.sessionId !== "string") throw new Error("sessionId required");
		const live = this.#require(p.sessionId);
		const agent = live.agentSession;
		const current = agent.getGoalModeState();
		const objective = typeof p.objective === "string" ? p.objective.trim() : "";
		if (objective) {
			if ((agent.memoryMode ?? "persistent") !== "persistent")
				throw new Error("Goal mode is unavailable in incognito and temporary sessions.");
			const now = Date.now();
			agent.setGoalModeState({
				enabled: true,
				mode: "active",
				goal: {
					id: `goal-${now}`,
					objective,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: now,
					updatedAt: now,
				},
			});
			// Record the switch: without the journal entry a reload drops goal
			// mode silently. The TUI has always written this.
			agent.sessionManager.appendModeChange("goal", { goal: agent.getGoalModeState()?.goal });
		} else if (current?.enabled) {
			agent.setGoalModeState(undefined);
			agent.sessionManager.appendModeChange("none");
		}
		// Goal state has no journal record of its own shape: tell the projection
		// to sample it, or the badge would wait for a poll that no longer exists.
		this.#deps.publishSessionModeProjection(p.sessionId);
		return this.#deps.modesOf(agent);
	}

	/** RPC session.goal: full lifecycle (show/pause/resume/drop/budget/guided). */
	async goal(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as {
			sessionId?: unknown;
			op?: unknown;
			objective?: unknown;
			budget?: unknown;
			images?: { type: "image"; data: string; mimeType: string }[];
			videos?: { type: "video"; mimeType: string; url?: string; data?: string }[];
		};
		if (typeof p.sessionId !== "string") throw new Error("sessionId required");
		const sessionId = p.sessionId;
		const live = this.#require(sessionId);
		const g = live.agentSession;
		// The goal tool is only active while goal mode is: entering (incl. the
		// guided interview) adds it to the toolset, leaving restores the pre-goal
		// set.
		const setGoalTools = async (enabled: boolean): Promise<void> => {
			const previous = g.getEnabledToolNames().filter(name => name !== "goal");
			await g.setActiveToolsByName(enabled ? [...new Set([...previous, "goal"])] : previous);
		};
		const publish = (): void => this.#deps.publishSessionModeProjection(sessionId);
		switch (typeof p.op === "string" ? p.op : "") {
			case "show": {
				const state = g.getGoalModeState();
				return state?.goal ? { enabled: state.enabled === true, ...state.goal } : null;
			}
			case "pause": {
				if (!g.getGoalModeState()?.enabled) throw new Error("No active goal to pause.");
				await g.goalRuntime.pauseGoal();
				await setGoalTools(false);
				g.sessionManager.appendModeChange("goal_paused", { goal: g.getGoalModeState()?.goal });
				publish();
				return this.#deps.modesOf(g);
			}
			case "resume": {
				const state = await g.goalRuntime.resumeGoal();
				await setGoalTools(true);
				g.setGoalModeState(state);
				g.sessionManager.appendModeChange("goal", { goal: state.goal });
				publish();
				return this.#deps.modesOf(g);
			}
			case "drop": {
				await g.goalRuntime.dropGoal();
				await setGoalTools(false);
				g.setGoalModeState(undefined);
				g.sessionManager.appendModeChange("none");
				publish();
				return this.#deps.modesOf(g);
			}
			case "budget": {
				if (!g.getGoalModeState()?.enabled) throw new Error("No active goal.");
				const trimmed = (typeof p.budget === "string" ? p.budget : "").trim().toLowerCase();
				let next: number | undefined;
				if (trimmed !== "off") {
					const parsed = Number.parseInt(trimmed, 10);
					if (!Number.isInteger(parsed) || parsed <= 0) {
						throw new Error("Goal budget must be a positive integer or `off`.");
					}
					next = parsed;
				}
				await g.goalRuntime.onBudgetMutated(next);
				return this.#deps.modesOf(g);
			}
			case "guided": {
				if ((g.memoryMode ?? "persistent") !== "persistent")
					throw new Error("Goal mode is unavailable in incognito and temporary sessions.");
				// Hidden kickoff that starts a normal conversation in which the
				// agent interviews the user, then calls the `goal create` tool.
				// Pre-checks mirror the TUI handler order so both entry points
				// reject the same states with the same wording.
				if (g.getPlanModeState()?.enabled === true) throw new Error("Exit plan mode first.");
				if (g.getVibeModeState()?.enabled === true) throw new Error("Exit vibe mode first.");
				if (g.settings.get("goal.enabled") !== true) {
					throw new Error("Goal mode is disabled. Enable it in settings (goal.enabled).");
				}
				if (g.getGoalModeState()?.enabled) throw new Error("Goal mode is already active.");
				if (g.getGoalModeState()?.goal?.status === "paused") {
					throw new Error("Resume the current goal first, or drop it before starting a new one.");
				}
				await setGoalTools(true);
				const kickoff = this.#deps.renderGuidedKickoff({
					objective: typeof p.objective === "string" ? p.objective.trim() || undefined : undefined,
				});
				const { images, videos } = await this.#deps.resolveMedia({
					...(Array.isArray(p.images) && p.images.length > 0 ? { images: p.images } : {}),
					...(Array.isArray(p.videos) && p.videos.length > 0 ? { videos: p.videos } : {}),
				});
				try {
					if (g.isStreaming) await g.followUp(kickoff, images, { synthetic: true, videos });
					else
						await g.prompt(kickoff, {
							synthetic: true,
							...(images ? { images } : {}),
							...(videos ? { videos } : {}),
						});
				} catch (error) {
					// The streaming check and prompt() race: an AgentBusyError here
					// means the turn started in between, so queue instead of failing.
					if (!(error instanceof Error) || error.name !== "AgentBusyError") throw error;
					await g.followUp(kickoff, images, { synthetic: true, videos });
				}
				return this.#deps.modesOf(g);
			}
			default:
				throw new Error(`session.goal: unknown op ${String(p.op)}`);
		}
	}

	#require(sessionId: string): GoalLiveSession {
		const live = this.#deps.get(sessionId);
		if (!live) throw new Error(`Unknown session: ${sessionId}`);
		return live;
	}
}
