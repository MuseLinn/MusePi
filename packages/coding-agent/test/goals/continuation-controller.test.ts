import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@musepi/pi-agent-core";
import {
	GoalContinuationController,
	type GoalContinuationSession,
} from "@musepi/pi-coding-agent/goals/continuation-controller";
import type { Goal, GoalModeState } from "@musepi/pi-coding-agent/goals/state";
import type { AgentSessionEvent } from "@musepi/pi-coding-agent/session/agent-session";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "finish the task",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeState(goal: Goal = makeGoal()): GoalModeState {
	return { enabled: true, mode: "active", goal };
}

function agentEnd(messages: AgentMessage[] = []): AgentSessionEvent {
	return { type: "agent_end", messages } as AgentSessionEvent;
}

function toolTurn(result = "same"): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
		},
		{
			role: "toolResult",
			toolName: "read",
			content: [{ type: "text", text: result }],
			isError: false,
		},
	] as unknown as AgentMessage[];
}

async function flush(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
	await new Promise<void>(resolve => setImmediate(resolve));
	await new Promise<void>(resolve => setTimeout(resolve, 0));
}

function harness(options: { modes?: string[]; state?: GoalModeState; contextGoal?: Goal } = {}) {
	let state = options.state;
	let tools = ["read"];
	const prompts: string[] = [];
	const journal: Array<{ kind: string; data?: unknown }> = [];
	const contextGoal = options.contextGoal ?? makeGoal();
	const session = {
		settings: {
			get: (key: string) => {
				if (key === "goal.continuationModes") return options.modes ?? ["daemon"];
				if (key === "goal.enabled") return true;
				return undefined;
			},
		},
		sessionManager: {
			getSessionId: () => "session-1",
			buildSessionContext: () => ({ mode: "goal", modeData: { goal: contextGoal } }),
			appendModeChange: (mode: string) => {
				journal.push({ kind: "mode", data: mode });
				return "entry";
			},
			appendCustomEntry: (customType: string, data?: unknown) => {
				journal.push({ kind: customType, data });
				return "entry";
			},
		},
		goalRuntime: {
			buildContinuationPrompt: () => "continue",
			onThreadResumed: async () => state ?? makeState(contextGoal),
			clearAccounting: () => {},
		},
		getGoalModeState: () => state,
		setGoalModeState: (next: GoalModeState | undefined) => {
			state = next;
		},
		getPlanModeState: () => undefined,
		getEnabledToolNames: () => [...tools],
		setActiveToolsByName: async (names: string[]) => {
			tools = [...names];
		},
		getTodoPhases: () => [],
		promptCustomMessage: async (message: { content: unknown }) => {
			prompts.push(String(message.content));
		},
		waitForIdle: async () => {},
		isStreaming: false,
		isDisposed: false,
		isSessionTransitioning: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
	} as unknown as GoalContinuationSession;
	return {
		controller: new GoalContinuationController(session),
		prompts,
		journal,
		tools: () => tools,
		state: () => state,
	};
}

describe("GoalContinuationController", () => {
	test("schedules a daemon continuation at agent_end and reports pending until admitted", async () => {
		const h = harness({ state: makeState() });
		h.controller.observe(agentEnd());
		expect(h.controller.continuationPending).toBe(true);
		await flush();
		expect(h.prompts).toEqual(["continue"]);
		expect(h.controller.continuationPending).toBe(false);
	});

	test("does not continue when the daemon mode is not enabled", async () => {
		const h = harness({ state: makeState(), modes: ["interactive"] });
		h.controller.observe(agentEnd());
		await flush();
		expect(h.prompts).toEqual([]);
		expect(h.controller.continuationPending).toBe(false);
	});

	test("stops after a continuation turn returns identical evidence", async () => {
		const h = harness({ state: makeState() });
		h.controller.observe(agentEnd());
		await flush();
		expect(h.prompts).toHaveLength(1);

		h.controller.observe(agentEnd(toolTurn("same")));
		await flush();
		expect(h.prompts).toHaveLength(2);

		h.controller.observe(agentEnd(toolTurn("same")));
		await flush();
		expect(h.prompts).toHaveLength(2);
		expect(h.controller.continuationPending).toBe(false);
	});

	test("a host abort suppresses the pending continuation", async () => {
		const h = harness({ state: makeState() });
		h.controller.observe(agentEnd());
		h.controller.stopForHostAbort();
		await flush();
		expect(h.prompts).toEqual([]);
		expect(h.controller.continuationPending).toBe(false);
	});

	test("holds a continuation during a session change and resumes after it", async () => {
		const h = harness({ state: makeState() });
		await h.controller.beginSessionChange();
		h.controller.observe(agentEnd());
		expect(h.controller.continuationPending).toBe(true);
		await h.controller.endSessionChange();
		await flush();
		expect(h.prompts).toEqual(["continue"]);
	});

	test("reconcile restores a persisted goal and the goal tool", async () => {
		const persisted = makeGoal({ objective: "persisted goal" });
		const h = harness({ state: undefined, contextGoal: persisted });
		await h.controller.reconcile();
		expect(h.state()?.goal.objective).toBe("persisted goal");
		expect(h.tools()).toContain("goal");
	});
});
