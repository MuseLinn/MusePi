const { describe, expect, it } = require("bun:test");
const {
	projectActivity,
	settleActivity,
	startActivity,
	takeoverActivity,
} = require("../electron/managed-browser-activity.cjs");

function entry(key, tabId, action = "click") {
	return { key, tabId, action, summary: action, domain: "example.com", at: 1 };
}

describe("managed browser activity lifecycle", () => {
	it("settles only the matching command even when completions arrive out of order", () => {
		const ledger = [];
		startActivity(ledger, entry("c:1", "tab-a", "navigate"), 40);
		startActivity(ledger, entry("c:2", "tab-a", "click"), 40);

		expect(settleActivity(ledger, "c:1", "completed")).toBe(true);
		expect(settleActivity(ledger, "c:1", "failed")).toBe(false);

		expect(ledger.map(item => [item.id, item.status])).toEqual([
			["c:1", "completed"],
			["c:2", "dispatched"],
		]);
	});

	it("keeps the active tab projection and every busy tab independent", () => {
		const ledger = [];
		startActivity(ledger, entry("c:1", "background"), 40);
		startActivity(ledger, entry("c:2", "active"), 40);
		startActivity(ledger, entry("c:3", "active", "screenshot"), 40);
		settleActivity(ledger, "c:3", "completed");

		expect(projectActivity(ledger, "active")).toEqual({
			activity: expect.objectContaining({ id: "c:2", status: "dispatched" }),
			busyTabIds: ["background", "active"],
		});
		settleActivity(ledger, "c:2", "completed");
		expect(projectActivity(ledger, "active").activity.id).toBe("c:1");
	});

	it("takeover cancels only the target tab without reviving terminal entries", () => {
		const ledger = [];
		startActivity(ledger, entry("c:1", "tab-a"), 40);
		startActivity(ledger, entry("c:2", "tab-b"), 40);
		settleActivity(ledger, "c:1", "completed");

		expect(takeoverActivity(ledger, "tab-a")).toBe(0);
		expect(takeoverActivity(ledger, "tab-b")).toBe(1);
		expect(ledger.map(item => item.status)).toEqual(["completed", "canceled"]);
		expect(projectActivity(ledger, "tab-b").busyTabIds).toEqual([]);
	});

	it("evicts terminal history before running commands and times the continuous run from its first command", () => {
		const ledger = [];
		for (let index = 1; index <= 13; index++) startActivity(ledger, entry(`c:${index}`, "tab-a"), 12);
		for (let index = 2; index <= 13; index++) settleActivity(ledger, `c:${index}`, "completed");

		expect(ledger.some(item => item.id === "c:1" && item.status === "dispatched")).toBe(true);
		expect(projectActivity(ledger, "tab-a").activity.id).toBe("c:1");
		expect(projectActivity(ledger, "tab-a").busyTabIds).toEqual(["tab-a"]);
	});
});
