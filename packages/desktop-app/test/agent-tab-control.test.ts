import { describe, expect, it } from "bun:test";
import { nextAgentTabControl } from "../src/lib/agent-tab-control";

const activity = (overrides: Partial<ManagedBrowserActivity> = {}): ManagedBrowserActivity => ({
	id: "op-1",
	action: "click",
	summary: "点击元素",
	domain: "example.com",
	status: "dispatched",
	tabId: "tab-a",
	at: 1_000,
	...overrides,
});

describe("nextAgentTabControl", () => {
	it("starts the hold at the first operation on a tab", () => {
		const control = nextAgentTabControl(null, activity(), ["tab-a"], 1_200);
		expect(control).toEqual({
			tabId: "tab-a",
			since: 1_000,
			activity: activity(),
			lastAt: 1_200,
		});
	});

	it("keeps the original start across steps on the same tab", () => {
		const first = nextAgentTabControl(null, activity(), ["tab-a"], 1_200);
		const second = nextAgentTabControl(first, activity({ id: "op-2", action: "fill", at: 4_000 }), ["tab-a"], 4_100);
		expect(second?.since).toBe(1_000);
		expect(second?.activity.id).toBe("op-2");
		expect(second?.lastAt).toBe(4_100);
	});

	it("remembers a settled activity so the pill can say the tab is held", () => {
		const first = nextAgentTabControl(null, activity(), ["tab-a"], 1_200);
		const settled = nextAgentTabControl(first, activity({ status: "completed" }), ["tab-a"], 3_000);
		expect(settled?.activity.status).toBe("completed");
		expect(settled?.since).toBe(1_000);
	});

	it("switches the hold to a different tab", () => {
		const first = nextAgentTabControl(null, activity(), ["tab-a", "tab-b"], 1_200);
		const moved = nextAgentTabControl(first, activity({ tabId: "tab-b", at: 2_000 }), ["tab-a", "tab-b"], 2_100);
		expect(moved?.tabId).toBe("tab-b");
		expect(moved?.since).toBe(2_000);
	});

	it("does not claim a tab from an activity that already settled", () => {
		expect(nextAgentTabControl(null, activity({ status: "cancelled" }), ["tab-a"], 1_200)).toBeNull();
		expect(nextAgentTabControl(null, activity({ status: "completed" }), ["tab-a"], 1_200)).toBeNull();
	});

	it("ignores activity for a tab the session does not own", () => {
		const first = nextAgentTabControl(null, activity(), ["tab-a"], 1_200);
		expect(nextAgentTabControl(first, activity({ tabId: "other", at: 2_000 }), ["tab-a"], 2_100)).toBe(first);
		expect(nextAgentTabControl(first, null, ["tab-a"], 2_100)).toBe(first);
	});
});
