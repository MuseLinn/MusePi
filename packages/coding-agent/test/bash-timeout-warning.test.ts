import { beforeAll, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

function renderResultLines(result: unknown, isError: boolean): string[] {
	const definition = createBashToolDefinition(process.cwd());
	const component = definition.renderResult!(
		result as never,
		{ expanded: true, isPartial: false } as never,
		{} as never,
		{
			state: {},
			lastComponent: undefined,
			args: { command: "sleep 99", timeout: 1 },
			showImages: false,
			isError,
			cwd: process.cwd(),
			invalidate: () => {},
		} as never,
	) as { render(width: number): string[] };
	return component.render(120);
}

describe("bash timeout warning box", () => {
	it("renders a yellow boxed warning instead of a plain error line", () => {
		const result = {
			content: [{ type: "text", text: "partial output line\n\nCommand timed out after 30 seconds" }],
			details: undefined,
		};
		const lines = renderResultLines(result, true);
		const joined = lines.join("\n");
		expect(joined).toContain("╭");
		expect(joined).toContain("╰");
		expect(joined).toContain("⏱ timed out after 30s");
		// status line lifted into the box
		expect(joined).not.toContain("Command timed out after 30 seconds");
		expect(joined).toContain("partial output line");
	});

	it("does not alter non-timeout error output", () => {
		const result = {
			content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
			details: undefined,
		};
		const lines = renderResultLines(result, true);
		const joined = lines.join("\n");
		expect(joined).not.toContain("⏱");
		expect(joined).toContain("Command exited with code 1");
	});
});
