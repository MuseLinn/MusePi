import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import { initTheme } from "@musepi/pi-coding-agent/modes/theme/theme";
import { buildAsyncJobResultBlock } from "@musepi/pi-coding-agent/modes/utils/transcript-render-helpers";
import type { CustomMessage } from "@musepi/pi-coding-agent/session/messages";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function jobMessage(content: string, details: Record<string, unknown>): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "async-job-result",
		content,
		display: true,
		details,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function envelope(output: string, attrs = 'id="Alice" agent="task" status="completed" duration="2m57s"'): string {
	return `Background task job "Alice" completed:\n\n<task-result ${attrs}>\n<meta lines="4" size="974B"/>\n<output>\n${output}\n</output>\n</task-result>\n\nAlice is now idle — message it via \`hub\` to follow up; transcript at history://Alice`;
}

describe("async-job-result TUI block", () => {
	it("renders the settlement line and output, never the task-result envelope", () => {
		const block = buildAsyncJobResultBlock(
			jobMessage(envelope('{\n  "reportSentToMain": true\n}'), {
				jobId: "Alice",
				status: "completed",
				label: "Alice",
			}),
			() => false,
		);
		const text = Bun.stripANSI(block.render(100).join("\n"));
		expect(text).toContain("Alice");
		expect(text).toContain("[task]");
		expect(text).toContain("2m57s");
		expect(text).toContain("completed");
		expect(text).toContain("4 lines");
		expect(text).toContain("974B");
		expect(text).toContain("reportSentToMain");
		expect(text).toContain("history://Alice");
		expect(text).not.toContain("<task-result");
		expect(text).not.toContain("<output>");
		expect(text).not.toContain("<meta");
		expect(text).not.toContain("Background task job");
	});

	it("collapses a long output and reveals all lines when expanded", () => {
		const output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		let expanded = false;
		const block = buildAsyncJobResultBlock(
			jobMessage(envelope(output), { jobId: "Alice", status: "completed", label: "Alice" }),
			() => expanded,
		);
		const collapsed = Bun.stripANSI(block.render(100).join("\n"));
		expect(collapsed).toContain("more lines");
		expect(collapsed).not.toContain("line 30");
		expanded = true;
		const full = Bun.stripANSI(block.render(100).join("\n"));
		expect(full).not.toContain("more lines");
		expect(full).toContain("line 30");
	});

	it("labels a failed job from details and keeps the replay sentence out", () => {
		const block = buildAsyncJobResultBlock(
			jobMessage('Background task job "Bob" failed.', { jobId: "Bob", status: "failed", label: "Bob" }),
			() => false,
		);
		const text = Bun.stripANSI(block.render(100).join("\n"));
		expect(text).toContain("Bob");
		expect(text).toContain("failed");
		expect(text).not.toContain("Background task job");
	});
});
