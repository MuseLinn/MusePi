// Restoring goal/plan mode from the journal: the switches live only on the live
// AgentSession, so a resume that skipped this dropped a mode the journal still
// recorded.
import { describe, expect, test } from "bun:test";
import { restoreModeFromJournal } from "../../src/daemon/session-host";

/** A session whose journal folds to the given mode, recording what was restored. */
function sessionWith(context: { mode?: unknown; modeData?: Record<string, unknown> }) {
	const restored: { plan?: unknown; goal?: unknown } = {};
	return {
		restored,
		session: {
			sessionManager: { buildSessionContext: () => context },
			setPlanModeState: (state: unknown) => {
				restored.plan = state;
			},
			setGoalModeState: (state: unknown) => {
				restored.goal = state;
			},
		},
	};
}

const GOAL = {
	id: "goal-1",
	objective: "ship it",
	status: "active",
	tokensUsed: 10,
	timeUsedSeconds: 5,
	createdAt: 1,
	updatedAt: 2,
};

describe("restoreModeFromJournal", () => {
	test("restores plan mode with its file path", () => {
		const { session, restored } = sessionWith({ mode: "plan", modeData: { planFilePath: "local://PLAN.md" } });
		restoreModeFromJournal(session as never);
		expect(restored.plan).toEqual({ enabled: true, planFilePath: "local://PLAN.md" });
	});

	test("a paused plan stays off but keeps its path", () => {
		// `plan_paused` means the session is not in plan mode; restoring it as on
		// would silently re-enter a mode the user exited.
		const { session, restored } = sessionWith({ mode: "plan_paused", modeData: { planFilePath: "local://PLAN.md" } });
		restoreModeFromJournal(session as never);
		expect(restored.plan).toEqual({ enabled: false, planFilePath: "local://PLAN.md" });
	});

	test("plan mode without a path is left off", () => {
		// The proposal/approve flow needs a path; entering without one strands
		// the session in a mode it can never complete.
		const { session, restored } = sessionWith({ mode: "plan", modeData: {} });
		restoreModeFromJournal(session as never);
		expect(restored.plan).toBeUndefined();
	});

	test("restores an active goal from its recorded data", () => {
		const { session, restored } = sessionWith({ mode: "goal", modeData: { goal: GOAL } });
		restoreModeFromJournal(session as never);
		expect(restored.goal).toMatchObject({ enabled: true, mode: "active", goal: { objective: "ship it" } });
	});

	test("a paused goal restores disabled", () => {
		const { session, restored } = sessionWith({ mode: "goal_paused", modeData: { goal: GOAL } });
		restoreModeFromJournal(session as never);
		expect(restored.goal).toMatchObject({ enabled: false });
	});

	test("a malformed goal record restores nothing", () => {
		// Session files are user-editable and survive across versions: a
		// half-written goal must not be restored as a real one.
		const { session, restored } = sessionWith({ mode: "goal", modeData: { goal: { id: "x" } } });
		restoreModeFromJournal(session as never);
		expect(restored.goal).toBeUndefined();
	});

	test("mode none restores nothing", () => {
		const { session, restored } = sessionWith({ mode: "none" });
		restoreModeFromJournal(session as never);
		expect(restored.plan).toBeUndefined();
		expect(restored.goal).toBeUndefined();
	});

	test("an unreadable journal is not fatal", () => {
		const session = {
			sessionManager: {
				buildSessionContext: () => {
					throw new Error("corrupt");
				},
			},
			setPlanModeState: () => {},
			setGoalModeState: () => {},
		};
		expect(() => restoreModeFromJournal(session as never)).not.toThrow();
	});
});
