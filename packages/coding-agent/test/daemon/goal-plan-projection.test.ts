// The goal/plan services own their state, so they register their own
// projection unit — registered on start, withdrawn on stop, never listed
// centrally.
import { describe, expect, test } from "bun:test";
import { GoalService } from "../../src/daemon/services/goal-service";
import { PlanModeService } from "../../src/daemon/services/plan-mode-service";
import { SessionProjectionService } from "../../src/daemon/services/session-projection-service";
import { SessionProjectionRegistry } from "../../src/session/session-projections";

function stats() {
	return {
		sessionFile: undefined,
		sessionId: "s1",
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		premiumRequests: 0,
		cost: 0,
	};
}

/** A host context carrying the projection service under its cordis key, the
 *  same property `ctx.provide(key, service)` installs at mount. */
function ctxWith(projections: SessionProjectionService | undefined) {
	return { sessionProjections: projections } as never;
}

function seedMode(projections: SessionProjectionService): void {
	projections.seed("s1", {
		entries: [],
		source: {
			model: () => null,
			sessionStats: stats as never,
			sessionMode: () => ({ goal: null, plan: false }),
		},
	});
}

function goalService(published: string[]): GoalService {
	return new GoalService({
		get: () => undefined,
		publishSessionModeProjection: sessionId => published.push(sessionId),
		modesOf: () => ({}),
		renderGuidedKickoff: () => "",
		resolveMedia: async () => ({}),
	});
}

function planService(published: string[]): PlanModeService {
	return new PlanModeService({
		get: () => undefined,
		publishSessionModeProjection: sessionId => published.push(sessionId),
		modesOf: () => ({}),
		files: {
			read: async () => null,
			list: async () => [],
			write: async () => {},
			resolveTitle: () => ({ title: "" }),
			resolveApproved: async () => ({ planFilePath: "", title: "" }),
		},
		local: { root: () => "", copy: async () => {}, urlToPath: () => "" },
		renderApprovedPrompt: () => "",
		renderCompactNote: () => "",
		resolveExecutionModel: () => undefined,
		writeFile: async () => {},
		readFile: async () => "",
		mkdir: async () => {},
		writePlanViaLocal: async () => {},
	});
}

/** A live session that records the journal writes the mode switches make. */
function liveWith(modeLog: [string, unknown][], memoryMode?: "persistent" | "incognito" | "temporary") {
	let goal: Record<string, unknown> | undefined;
	let plan: { enabled?: boolean; planFilePath?: string } | undefined;
	return {
		agentSession: {
			memoryMode,
			getGoalModeState: () => goal as never,
			setGoalModeState: (state: unknown) => {
				goal = state as never;
			},
			getPlanModeState: () => plan,
			setPlanModeState: (state: unknown) => {
				plan = state as never;
			},
			setPlanProposalHandler: () => {},
			markPlanReferenceSent: () => {},
			getVibeModeState: () => undefined,
			getEnabledToolNames: () => [],
			setActiveToolsByName: async () => {},
			getAvailableModels: () => [],
			setModelTemporary: async () => {},
			resetSessionContext: async () => ({}),
			compact: async () => ({}),
			setPlanReferencePath: () => {},
			settings: { get: () => true },
			isStreaming: false,
			prompt: async () => ({}),
			followUp: async () => ({}),
			goalRuntime: {
				pauseGoal: async () => ({}),
				resumeGoal: async () => ({}) as never,
				dropGoal: async () => ({}),
				onBudgetMutated: async () => ({}),
			},
			sessionManager: {
				appendModeChange: (mode: string, data?: Record<string, unknown>) => {
					modeLog.push([mode, data]);
					return "id";
				},
				getCwd: () => "/tmp",
				getArtifactsDir: () => "/tmp",
				getSessionId: () => "s1",
			},
		},
	};
}

describe("goal and plan own their projection unit", () => {
	test("each service registers the unit it owns on start", () => {
		const projections = new SessionProjectionService(new SessionProjectionRegistry());
		const goals = goalService([]);
		goals.start(ctxWith(projections));
		seedMode(projections);
		// `sessionMode` is the unit both services contribute; once goal mounted it
		// must be present in the baseline.
		expect(projections.snapshot("s1")?.values.sessionMode).toBeDefined();
		goals.stop();
	});

	test("stop withdraws the unit it registered", () => {
		const projections = new SessionProjectionService(new SessionProjectionRegistry());
		const plans = planService([]);
		plans.start(ctxWith(projections));
		seedMode(projections);
		expect(projections.snapshot("s1")?.values.sessionMode).toBeDefined();

		plans.stop();
		expect(projections.snapshot("s1")?.values.sessionMode).toBeUndefined();
	});

	test("a missing projection service fails the mount instead of running blind", () => {
		// dsh's `static inject` contract: an unresolvable dependency is fatal, so
		// the service never runs without contributing its read model.
		expect(() => goalService([]).start(ctxWith(undefined))).toThrow(/sessionProjections/);
		expect(() => planService([]).start(ctxWith(undefined))).toThrow(/sessionProjections/);
	});

	test("a goal write records a journal entry, so a reload keeps it", () => {
		const modeLog: [string, unknown][] = [];
		const live = liveWith(modeLog);
		const service = new GoalService({
			get: () => live as never,
			publishSessionModeProjection: () => {},
			modesOf: () => ({}),
			renderGuidedKickoff: () => "",
			resolveMedia: async () => ({}),
		});

		service.setGoal({ sessionId: "s1", objective: "ship it" });
		// The TUI has always written this; without it a GUI-driven goal vanished
		// on the next activate.
		expect(modeLog).toHaveLength(1);
		expect(modeLog[0]![0]).toBe("goal");

		service.setGoal({ sessionId: "s1" });
		expect(modeLog[1]![0]).toBe("none");
	});

	test("goal entry is rejected for incognito and temporary sessions", async () => {
		for (const memoryMode of ["incognito", "temporary"] as const) {
			const modeLog: [string, unknown][] = [];
			const live = liveWith(modeLog, memoryMode);
			const service = new GoalService({
				get: () => live as never,
				publishSessionModeProjection: () => {},
				modesOf: () => ({}),
				renderGuidedKickoff: () => "",
				resolveMedia: async () => ({}),
			});

			expect(() => service.setGoal({ sessionId: "s1", objective: "ship it" })).toThrow(/Goal mode is unavailable/);
			await expect(service.goal({ sessionId: "s1", op: "guided" })).rejects.toThrow(/Goal mode is unavailable/);
			expect(modeLog).toHaveLength(0);
		}
	});

	test("a plan write records a journal entry", () => {
		const modeLog: [string, unknown][] = [];
		const live = liveWith(modeLog);
		const recording = new PlanModeService({
			get: () => live as never,
			publishSessionModeProjection: () => {},
			modesOf: () => ({}),
			files: {
				read: async () => null,
				list: async () => [],
				write: async () => {},
				resolveTitle: () => ({ title: "" }),
				resolveApproved: async () => ({ planFilePath: "", title: "" }),
			},
			local: { root: () => "", copy: async () => {}, urlToPath: () => "" },
			renderApprovedPrompt: () => "",
			renderCompactNote: () => "",
			resolveExecutionModel: () => undefined,
			writeFile: async () => {},
			readFile: async () => "",
			mkdir: async () => {},
			writePlanViaLocal: async () => {},
		});
		recording.setPlan({ sessionId: "s1", enabled: true });
		expect(modeLog[0]![0]).toBe("plan");
		recording.setPlan({ sessionId: "s1", enabled: false });
		expect(modeLog[1]![0]).toBe("none");
	});
});
