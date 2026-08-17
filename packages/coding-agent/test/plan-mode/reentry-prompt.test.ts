import { describe, expect, it } from "bun:test";
import { prompt } from "@musepi/pi-utils";
import planModeActivePrompt from "../../src/prompts/system/plan-mode-active.md" with { type: "text" };

const BASE = {
	planFilePath: "local://old-feature-plan.md",
	askToolName: "ask",
	writeToolName: "write",
	editToolName: "edit",
	isHashlineEditMode: false,
	iterative: false,
} as const;

function render(overrides: { reentry: boolean; planExists: boolean }): string {
	return prompt.render(planModeActivePrompt, { ...BASE, ...overrides });
}

describe("plan-mode re-entry prompt", () => {
	it("only emits the Re-entry section when re-entering", () => {
		expect(render({ reentry: false, planExists: true })).not.toContain("## Re-entry");
		expect(render({ reentry: true, planExists: true })).toContain("## Re-entry");
	});
});
