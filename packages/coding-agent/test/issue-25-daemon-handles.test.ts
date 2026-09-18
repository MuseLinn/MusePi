import { describe, expect, test } from "bun:test";
import { customToolToDefinition } from "../src/sdk";
import { scheduleTaskTool } from "../src/tools/schedule-task";

/**
 * Regression for issue #25: `schedule_task` (and `collab`) kept reporting
 * "(no daemon)" on desktop even with the daemon connected, because
 * createCustomToolContext — the CustomTool → ToolDefinition adapter — built a
 * whitelist context that DROPPED the daemon-injected `scheduledTasks` /
 * `collab` handles. The parameter binding was never wrong; the context
 * whitelist was. Driven here through the exported adapter, the same path a
 * session takes.
 */

function fakeAgentContext(handles: { scheduledTasks?: unknown; collab?: unknown }) {
	return {
		sessionManager: { getSessionId: () => "test-session", getCwd: () => "/tmp" },
		modelRegistry: {},
		model: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		ui: undefined,
		hasUI: false,
		mode: "rpc",
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => null,
		compact: async () => {},
		...handles,
	};
}

const definition = customToolToDefinition(scheduleTaskTool as never) as unknown as {
	execute: (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
};

describe("issue #25 — daemon handles survive the custom-tool adapter", () => {
	test("schedule_task list reaches the injected handle (no false no-daemon error)", async () => {
		let listed = 0;
		const ctx = fakeAgentContext({
			scheduledTasks: {
				list: async () => {
					listed++;
					return [
						{
							id: "t1",
							name: "Daily digest",
							schedule: { kind: "daily", hour: 9, minute: 0 },
							state: { nextRunAt: "2026-09-19T09:00:00Z" },
						},
					];
				},
			},
		});
		const result = await definition.execute("t1", { action: "list" }, undefined, undefined, ctx);
		expect(listed).toBe(1);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("Daily digest");
	});

	test("without a handle the tool still reports unavailability (standalone parity)", async () => {
		const result = await definition.execute("t2", { action: "list" }, undefined, undefined, fakeAgentContext({}));
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("no daemon");
	});
});
