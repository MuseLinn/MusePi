import { describe, expect, it } from "bun:test";
import { applyToolResultPatch } from "../src/extensibility/extensions/tool-result-patch";
import type { ToolResultEvent } from "../src/extensibility/extensions/types";

function event(): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "raw output" }],
		isError: false,
		details: { exitCode: 0 },
	} as ToolResultEvent;
}

describe("applyToolResultPatch block", () => {
	it("turns the observed result into an error carrying the hook reason", () => {
		const target = event();
		expect(applyToolResultPatch(target, { block: true, reason: "policy: no writes" })).toBe(true);
		expect(target.isError).toBe(true);
		expect(target.content).toEqual([{ type: "text", text: "policy: no writes" }]);
	});

	it("uses a stable fallback reason when the hook gives none", () => {
		const target = event();
		applyToolResultPatch(target, { block: true });
		expect(target.isError).toBe(true);
		expect(target.content).toEqual([{ type: "text", text: "The tool result was rejected by a hook." }]);
	});

	it("keeps the existing content/details rewrite path unchanged", () => {
		const target = event();
		applyToolResultPatch(target, { content: [{ type: "text", text: "rewritten" }], isError: true });
		expect(target.content).toEqual([{ type: "text", text: "rewritten" }]);
		expect(target.isError).toBe(true);
		expect(target.details).toEqual({ exitCode: 0 });
	});
});
