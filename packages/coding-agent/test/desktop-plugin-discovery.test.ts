/**
 * The desktop's UI shell lives in Cordis plugins under `apps/desktop/src/plugins`
 * (chat view, capability center, panel shell, right rail). The daemon discovers
 * them as bundled packages and serves their slot components; when the root is
 * stale every slot host renders nothing and the window looks empty, so the
 * discovery root is worth pinning at the entry level.
 */
import { describe, expect, it } from "bun:test";
import { discoverBundledPluginPaths } from "../src/discovery/builtin";

describe("desktop plugin discovery", () => {
	it("finds the desktop plugin entries by their workspace path", async () => {
		const entries = await discoverBundledPluginPaths({ scope: "all" });
		const desktop = entries.filter(entry => /[\\/]apps[\\/]desktop[\\/]src[\\/]plugins[\\/]/.test(entry));
		const byPackage = new Set(desktop.map(entry => entry.split(/[\\/]/).at(-2)));
		for (const name of ["chat-view", "capability-center", "panel", "ui-theme"]) {
			expect(byPackage).toContain(name);
		}
	});

	it("keeps the chat view's manifest entry resolvable", async () => {
		const entries = await discoverBundledPluginPaths({ scope: "all" });
		const chatView = entries.find(entry =>
			/[\\/]apps[\\/]desktop[\\/]src[\\/]plugins[\\/]chat-view[\\/]/.test(entry),
		);
		expect(chatView).toBeDefined();
		expect(await Bun.file(chatView!).exists()).toBe(true);
	});
});
