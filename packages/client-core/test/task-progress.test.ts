import { describe, expect, it } from "bun:test";
import { agentProgressFraction } from "../src/tool-render/tools/task";

/**
 * One progress rule for every surface: the TUI task card, the guest swarm
 * card and the desktop status row must read the same bar. The daemon streams
 * no estimated total, so a running member grows on tool calls
 * (`n / (n + 2)`) instead of claiming a percentage it cannot know.
 *
 * Two boundaries keep the bar honest: a running member stops at the cap, and
 * only `completed` reads full. A failed or aborted member keeps the work it
 * actually did — reporting failure as 100% told the user the opposite.
 */
describe("agentProgressFraction", () => {
	it("grows with tool calls while the agent runs", () => {
		expect(agentProgressFraction({ status: "running", toolCount: 1 })).toBeCloseTo(1 / 3, 5);
		expect(agentProgressFraction({ status: "running", toolCount: 2 })).toBeCloseTo(0.5, 5);
		expect(agentProgressFraction({ status: "running", toolCount: 8 })).toBeCloseTo(0.8, 5);
	});

	it("caps a long-running member short of full", () => {
		expect(agentProgressFraction({ status: "running", toolCount: 60 })).toBeCloseTo(0.85, 5);
		expect(agentProgressFraction({ status: "running", toolCount: 600 })).toBeCloseTo(0.85, 5);
	});

	it("is empty before the agent has run a tool", () => {
		expect(agentProgressFraction({ status: "pending", toolCount: 0 })).toBe(0);
		expect(agentProgressFraction({ status: "running", toolCount: 0 })).toBe(0);
	});

	it("is full only once the member completed", () => {
		expect(agentProgressFraction({ status: "completed", toolCount: 3 })).toBe(1);
		expect(agentProgressFraction({ status: "completed", toolCount: 0 })).toBe(1);
	});

	it("keeps the work a failed or aborted member actually did", () => {
		expect(agentProgressFraction({ status: "failed", toolCount: 8 })).toBeCloseTo(0.8, 5);
		expect(agentProgressFraction({ status: "aborted", toolCount: 3 })).toBeCloseTo(0.6, 5);
		expect(agentProgressFraction({ status: "failed", toolCount: 0 })).toBe(0);
		expect(agentProgressFraction({ status: "aborted" })).toBe(0);
	});

	it("tolerates the wire payload's loosely-typed records", () => {
		expect(agentProgressFraction({})).toBe(0);
		expect(agentProgressFraction({ status: 42, toolCount: "3" })).toBe(0);
	});
});
