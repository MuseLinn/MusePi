import { describe, expect, it } from "bun:test";
import { foregroundRefusal } from "../../src/tools/computer/worker";

const context = (backgroundFallback: "takeover" | "refuse") => ({ snapshot: { backgroundFallback } }) as never;

describe("computer.backgroundFallback", () => {
	it("allows focus-taking calls under the default takeover policy", () => {
		expect(foregroundRefusal(context("takeover"), "click", "drive the user's pointer", "route")).toBeNull();
	});

	it("refuses them with a message that names the policy, the effect and the route", () => {
		const refusal = foregroundRefusal(
			context("refuse"),
			"type",
			"take the user's keyboard",
			"Use AX setValue instead.",
			"win-1",
		);
		expect(refusal).toContain("BackgroundUnavailable: ");
		expect(refusal).toContain('computer.backgroundFallback setting is "refuse"');
		expect(refusal).toContain("take the user's keyboard");
		expect(refusal).toContain("nothing was sent to win-1");
		expect(refusal).toContain("Use AX setValue instead.");
	});

	it("omits the target clause when the call has no target", () => {
		const refusal = foregroundRefusal(context("refuse"), "raise", "bring the window forward", "route");
		expect(refusal).toContain("nothing was sent.");
		expect(refusal).not.toContain(" to ");
	});
});
