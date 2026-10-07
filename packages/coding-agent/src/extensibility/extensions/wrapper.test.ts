import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { ExtensionToolWrapper } from "./wrapper";

/**
 * The tool_result event type declares `isError` as required. One construction
 * site used to honor that with a conditional spread — absent when the effective
 * state was success — so the object it returned carried no `isError` while the
 * type promised one. Nothing in that call path is generic code: the value flows
 * straight onto the wire, and a consumer that trusted the type would read
 * `undefined` where the type said no such value exists.
 *
 * The cases below drive the handler-modified return through a stub runner and
 * check the flag on the object that comes back, in every direction a handler can
 * flip it.
 */
function stubRunner(resultResult: { isError: boolean } | undefined) {
	return {
		consumeToolCallEmitted: () => false,
		hasHandlers: (kind: string) => kind === "tool_result",
		emitToolResult: async () => resultResult,
	} as unknown as ConstructorParameters<typeof ExtensionToolWrapper>[1];
}

function stubTool(): AgentTool<never, unknown> {
	return {
		name: "stub",
		description: "stub",
		parameters: { type: "object", properties: {} } as never,
		execute: async (): Promise<AgentToolResult<unknown, never>> => ({
			content: [{ type: "text", text: "ok" }],
			details: undefined,
		}),
	} as unknown as AgentTool<never, unknown>;
}

function execute(wrapper: ExtensionToolWrapper<never, unknown>): Promise<AgentToolResult<unknown, never>> {
	return wrapper.execute("call-1", {} as never) as Promise<AgentToolResult<unknown, never>>;
}

describe("ExtensionToolWrapper tool_result error flag", () => {
	it("carries isError: false when a handler keeps a success a success", async () => {
		// The case the old spread dropped the field on: handler returned a result
		// object, nothing was an error, so `isError` was spread away.
		const wrapper = new ExtensionToolWrapper(stubTool(), stubRunner({ isError: false }));
		const out = await execute(wrapper);
		expect(out.isError).toBe(false);
	});

	it("carries isError: true when a handler flags a success as an error", async () => {
		const wrapper = new ExtensionToolWrapper(stubTool(), stubRunner({ isError: true }));
		const out = await execute(wrapper);
		expect(out.isError).toBe(true);
	});

	it("carries isError: false when a handler flips a failure back to success", async () => {
		// The tool throws, the handler rewrites the content and clears the flag:
		// the person asked for the failure content without the failure status.
		const tool = stubTool();
		tool.execute = async () => {
			throw new Error("execution failed");
		};
		const wrapper = new ExtensionToolWrapper(tool, stubRunner({ isError: false }));
		const out = await execute(wrapper);
		expect(out.isError).toBe(false);
		expect(out.content).toEqual([{ type: "text", text: "execution failed" }]);
	});

	it("carries isError: true when a handler re-affirms a failure", async () => {
		const tool = stubTool();
		tool.execute = async () => {
			throw new Error("execution failed");
		};
		const wrapper = new ExtensionToolWrapper(tool, stubRunner({ isError: true }));
		const out = await execute(wrapper);
		expect(out.isError).toBe(true);
	});

	it("passes the untouched result through when no handler modified it", async () => {
		// No handlers registered at all: the wrapper must not invent a result
		// object — the tool's own return, which already carries the flag from its
		// own construction, is what reaches the agent loop.
		const runner = {
			consumeToolCallEmitted: () => false,
			hasHandlers: () => false,
		} as unknown as ConstructorParameters<typeof ExtensionToolWrapper>[1];
		const wrapper = new ExtensionToolWrapper(stubTool(), runner);
		const out = await execute(wrapper);
		expect(out.isError).toBeUndefined();
		expect(out.content).toEqual([{ type: "text", text: "ok" }]);
	});
});
