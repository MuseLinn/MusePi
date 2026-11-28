import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@musepi/pi-agent-core";
import type { Settings } from "../../config/settings";
import { ExtensionToolWrapper } from "../../extensibility/extensions/wrapper";
import type { ToolSession } from "../../tools";
import { callSessionTool } from "./tool-bridge";

/**
 * `eval` scripts reach session tools through this bridge, and the bridge used
 * to call `tool.execute()` with three arguments. The approval wrapper therefore
 * saw no context, resolved `tools.approvalMode` from the `"yolo"` fallback and
 * ran the nested call with an empty user policy: a script could write where a
 * direct call would have prompted, and could bypass a configured deny.
 *
 * These cases drive the real approval wrapper through the bridge, so they fail
 * if the context is dropped again.
 */

type ApprovalAnswer = "Approve" | "Deny";

function stubRunner(select: (prompt: string) => Promise<ApprovalAnswer | undefined>) {
	const prompts: string[] = [];
	const runner = {
		consumeToolCallEmitted: () => false,
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ({
			select: async (prompt: string) => {
				prompts.push(prompt);
				return await select(prompt);
			},
		}),
		emit: async () => {},
		emitToolResult: async () => undefined,
		sessionId: "",
	} as unknown as ConstructorParameters<typeof ExtensionToolWrapper>[1];
	return { runner, prompts };
}

function writeTool(onExecute: () => void): AgentTool<never, unknown> {
	return {
		name: "write",
		description: "write",
		parameters: { type: "object", properties: {} } as never,
		execute: async (): Promise<AgentToolResult<unknown, never>> => {
			onExecute();
			return { content: [{ type: "text", text: "written" }] };
		},
	} as unknown as AgentTool<never, unknown>;
}

function settings(values: Record<string, unknown>): Settings {
	return { get: (key: string) => values[key] } as unknown as Settings;
}

function sessionWith(tool: unknown): ToolSession {
	return { getToolByName: () => tool as AgentTool } as unknown as ToolSession;
}

describe("eval tool bridge approval", () => {
	it("prompts a nested call under always-ask instead of running it", async () => {
		let executions = 0;
		const { runner, prompts } = stubRunner(async () => "Deny");
		const wrapped = new ExtensionToolWrapper(
			writeTool(() => {
				executions += 1;
			}),
			runner,
		);

		const call = callSessionTool(
			"write",
			{ path: "a.txt", content: "x" },
			{
				session: sessionWith(wrapped),
				context: { settings: settings({ "tools.approvalMode": "always-ask" }) } as AgentToolContext,
			},
		);

		await expect(call).rejects.toThrow("denied by user");
		expect(prompts.length).toBe(1);
		expect(executions).toBe(0);
	});

	it("honors a configured deny for a nested call", async () => {
		let executions = 0;
		const { runner, prompts } = stubRunner(async () => "Approve");
		const wrapped = new ExtensionToolWrapper(
			writeTool(() => {
				executions += 1;
			}),
			runner,
		);

		const call = callSessionTool(
			"write",
			{ path: "a.txt", content: "x" },
			{
				session: sessionWith(wrapped),
				context: {
					settings: settings({ "tools.approvalMode": "yolo", "tools.approval": { write: "deny" } }),
				} as AgentToolContext,
			},
		);

		await expect(call).rejects.toThrow("blocked by user policy");
		expect(prompts.length).toBe(0);
		expect(executions).toBe(0);
	});

	it("does not inherit the enclosing call's approval markers", async () => {
		let executions = 0;
		const { runner, prompts } = stubRunner(async () => "Deny");
		const wrapped = new ExtensionToolWrapper(
			writeTool(() => {
				executions += 1;
			}),
			runner,
		);

		const call = callSessionTool(
			"write",
			{ path: "a.txt", content: "x" },
			{
				session: sessionWith(wrapped),
				context: {
					settings: settings({ "tools.approvalMode": "always-ask" }),
					xdevApproved: true,
					providerSafetyApproved: true,
				} as AgentToolContext,
			},
		);

		await expect(call).rejects.toThrow("denied by user");
		expect(prompts.length).toBe(1);
		expect(executions).toBe(0);
	});
});
