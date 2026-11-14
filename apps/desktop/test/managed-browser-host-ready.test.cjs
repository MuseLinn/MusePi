const { describe, expect, it } = require("bun:test");

// The barrier test never reaches Electron; skip the one-time scheme hook.
process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = "1";
const { ManagedBrowserController } = require("../electron/managed-browser.cjs");

describe("managed browser host-ready barrier", () => {
	it("holds create readiness until the renderer registers its listeners", async () => {
		const controller = new ManagedBrowserController();
		const pending = controller.waitForHostReady();
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Bun.sleep(10);
		expect(settled).toBe(false);
		expect(controller.handleHostReady()).toEqual({ ok: true });
		expect(await pending).toBe(true);
		expect(await controller.waitForHostReady()).toBe(true);
	});

	it("detaches numeric tab sessions when a guest is destroyed", () => {
		const controller = new ManagedBrowserController();
		const events = [];
		controller.tabs.set("2", { id: 2 });
		controller.conns.set(1, {
			id: 1,
			discover: true,
			sessions: new Map([
				["s-tab", { kind: "tab", tabId: 2 }],
				["s-page", { kind: "page", tabId: 2 }],
			]),
			ws: { write: frame => events.push(JSON.parse(frame.subarray(2).toString())) },
		});
		controller.handleTabDestroyed(controller.tabs.get("2"));
		const detached = events.filter(event => event.method === "Target.detachedFromTarget");
		expect(detached.map(event => event.params)).toEqual([
			{ sessionId: "s-tab", targetId: "TAB2" },
			{ sessionId: "s-page", targetId: "PAGE2" },
		]);
		expect(events.filter(event => event.method === "Target.targetDestroyed").map(event => event.params.targetId)).toEqual([
			"TAB2",
			"PAGE2",
		]);
	});
});
