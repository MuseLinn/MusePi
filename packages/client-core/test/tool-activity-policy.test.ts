import { describe, expect, it } from "bun:test";
import { toolActivityPolicy, toolResultFailed, toolRowHidden } from "../src/components/transcript/tool-activity-policy";

/** Workbench shows everything; the bot lane's own switch is left unset, which is
 *  the real default (a bot hidden its tools). */
const shown = { hideToolActivity: false, toolCallSummary: true };

describe("toolActivityPolicy", () => {
	it("shows cards and summaries when nothing is hidden", () => {
		const policy = toolActivityPolicy(shown, "workbench");
		expect(policy.hidden).toBe(false);
		expect(policy.summarize).toBe(true);
	});

	it("hides cards and the summary together", () => {
		const policy = toolActivityPolicy({ ...shown, hideToolActivity: true }, "workbench");
		expect(policy.hidden).toBe(true);
		// A summary with no cards would be the only trace left, reading as a
		// missing card rather than a choice.
		expect(policy.summarize).toBe(false);
	});

	it("keeps the summary off when the user turned it off", () => {
		expect(toolActivityPolicy({ ...shown, toolCallSummary: false }, "workbench").summarize).toBe(false);
	});

	it("hides bot activity by default, even when the workbench shows it", () => {
		expect(toolActivityPolicy(shown, "bot").hidden).toBe(true);
		expect(toolActivityPolicy(shown, "workbench").hidden).toBe(false);
	});

	it("lets the bot lane show activity when its own switch is on", () => {
		expect(toolActivityPolicy({ ...shown, hideBotToolActivity: false }, "bot").hidden).toBe(false);
	});

	it("does not let the bot switch change the workbench lane", () => {
		const policy = toolActivityPolicy({ ...shown, hideBotToolActivity: true }, "workbench");
		expect(policy.hidden).toBe(false);
	});

	it("records the lane it resolved for", () => {
		expect(toolActivityPolicy(shown, "bot").lane).toBe("bot");
	});
});

describe("toolRowHidden", () => {
	it("never hides a failed call", () => {
		const policy = toolActivityPolicy({ ...shown, hideToolActivity: true }, "workbench");
		expect(toolRowHidden(policy, { content: [], isError: true })).toBe(false);
	});

	it("hides a successful call when activity is hidden", () => {
		const policy = toolActivityPolicy({ ...shown, hideToolActivity: true }, "workbench");
		expect(toolRowHidden(policy, { content: [] })).toBe(true);
	});

	it("hides a call that has not finished when activity is hidden", () => {
		const policy = toolActivityPolicy({ ...shown, hideToolActivity: true }, "workbench");
		expect(toolRowHidden(policy, undefined)).toBe(true);
	});

	it("keeps everything when activity is shown", () => {
		const policy = toolActivityPolicy(shown, "workbench");
		expect(toolRowHidden(policy, undefined)).toBe(false);
		expect(toolRowHidden(policy, { content: [], isError: true })).toBe(false);
	});
});

describe("toolResultFailed", () => {
	it("reads only an explicit error", () => {
		expect(toolResultFailed(undefined)).toBe(false);
		expect(toolResultFailed({ content: [] })).toBe(false);
		expect(toolResultFailed({ content: [], isError: false })).toBe(false);
		expect(toolResultFailed({ content: [], isError: true })).toBe(true);
	});
});
