/**
 * Managed-browser target resolution: an explicit `app.target` asks the bridge
 * for an ALREADY-OPEN tab and a miss is an error, while a call without a
 * target keeps the dedicated agent tab. Regression would be either silently
 * opening a fresh agent tab for a requested page, or creating/selecting a tab
 * when the caller only wanted to reuse one.
 */
import { describe, expect, it } from "bun:test";
import type { PuppeteerBrowserHandle } from "@musepi/pi-coding-agent/tools/browser/registry";
import { requestManagedBrowserTarget } from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolError } from "@musepi/pi-coding-agent/tools/tool-errors";

function fakeBrowser(result: { targetId?: string | null }) {
	const calls: { method: string; params?: Record<string, unknown> }[] = [];
	let detached = false;
	const session = {
		send: async (method: string, params?: Record<string, unknown>) => {
			calls.push({ method, params });
			return result;
		},
		detach: async () => {
			detached = true;
		},
	};
	const browser = {
		browser: {
			target: () => ({ createCDPSession: async () => session }),
		},
	} as unknown as PuppeteerBrowserHandle;
	return { browser, calls, wasDetached: () => detached };
}

describe("requestManagedBrowserTarget", () => {
	it("resolves an explicit target through findTabTarget", async () => {
		const { browser, calls, wasDetached } = fakeBrowser({ targetId: "PAGElocal-7" });
		await expect(requestManagedBrowserTarget(browser, "docs")).resolves.toBe("PAGElocal-7");
		expect(calls).toEqual([{ method: "ManagedBrowser.findTabTarget", params: { target: "docs" } }]);
		expect(wasDetached()).toBe(true);
	});

	it("keeps the dedicated agent tab when no target is given", async () => {
		const { browser, calls, wasDetached } = fakeBrowser({ targetId: "PAGE3" });
		await expect(requestManagedBrowserTarget(browser)).resolves.toBe("PAGE3");
		expect(calls).toEqual([{ method: "ManagedBrowser.ensureAgentTab", params: {} }]);
		expect(wasDetached()).toBe(true);
	});

	it("reports an unmatched target instead of falling back to a new tab", async () => {
		const { browser, calls } = fakeBrowser({ targetId: null });
		const pending = requestManagedBrowserTarget(browser, "release notes");
		await expect(pending).rejects.toBeInstanceOf(ToolError);
		await expect(pending).rejects.toThrow(/release notes/);
		expect(calls.map(call => call.method)).toEqual(["ManagedBrowser.findTabTarget"]);
	});
});
