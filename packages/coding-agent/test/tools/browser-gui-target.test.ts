/**
 * Managed-browser target resolution: an explicit `app.target` asks the bridge
 * for an ALREADY-OPEN tab and a miss is an error, while a call without a
 * target keeps the dedicated agent tab. Regression would be either silently
 * opening a fresh agent tab for a requested page, or creating/selecting a tab
 * when the caller only wanted to reuse one.
 *
 * The same call publishes the operating agent: the panel overlay names it as
 * "操作者：X", so the identity has to ride the create request, and an
 * unidentified caller must send no agent fields at all (user-tab payloads keep
 * their old shape).
 */
import { describe, expect, it } from "bun:test";
import type { PuppeteerBrowserHandle } from "@musepi/pi-coding-agent/tools/browser/registry";
import { requestManagedBrowserTarget } from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolError } from "@musepi/pi-coding-agent/tools/tool-errors";

type Reply = { targetId?: string | null };

function fakeBrowser(respond: (method: string) => Reply) {
	const calls: { method: string; params?: Record<string, unknown> }[] = [];
	let detached = false;
	const session = {
		send: async (method: string, params?: Record<string, unknown>) => {
			calls.push({ method, params });
			return respond(method);
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

const always = (reply: Reply) => () => reply;

describe("requestManagedBrowserTarget", () => {
	it("resolves an explicit target through findTabTarget", async () => {
		const { browser, calls, wasDetached } = fakeBrowser(always({ targetId: "PAGElocal-7" }));
		await expect(requestManagedBrowserTarget(browser, "docs")).resolves.toEqual({
			targetId: "PAGElocal-7",
			created: false,
		});
		expect(calls).toEqual([{ method: "ManagedBrowser.findTabTarget", params: { target: "docs" } }]);
		expect(wasDetached()).toBe(true);
	});

	it("keeps the dedicated agent tab when no target is given", async () => {
		const { browser, calls, wasDetached } = fakeBrowser(always({ targetId: "PAGE3" }));
		await expect(requestManagedBrowserTarget(browser)).resolves.toEqual({ targetId: "PAGE3", created: false });
		expect(calls).toEqual([{ method: "ManagedBrowser.ensureAgentTab", params: {} }]);
		expect(wasDetached()).toBe(true);
	});

	it("names the operating agent on the dedicated agent tab", async () => {
		const { browser, calls } = fakeBrowser(always({ targetId: "PAGE3" }));

		await requestManagedBrowserTarget(browser, undefined, { agentId: "Helper", agentName: "Helper Bot" });

		expect(calls).toEqual([
			{ method: "ManagedBrowser.ensureAgentTab", params: { agentId: "Helper", agentName: "Helper Bot" } },
		]);
	});

	it("falls back to the registry id when the agent has no display name", async () => {
		const { browser, calls } = fakeBrowser(always({ targetId: "PAGE3" }));

		await requestManagedBrowserTarget(browser, undefined, { agentId: " Helper " });

		expect(calls[0]?.params).toEqual({ agentId: "Helper", agentName: "Helper" });
	});

	it("creates the agent tab through CDP when the shell has no private method", async () => {
		const { browser, calls } = fakeBrowser(method => {
			if (method === "ManagedBrowser.ensureAgentTab")
				throw new Error("'ManagedBrowser.ensureAgentTab' wasn't found");
			return { targetId: "PAGE9" };
		});

		await expect(
			requestManagedBrowserTarget(browser, undefined, { agentId: "Writer", agentName: "Writer Bot" }),
		).resolves.toEqual({ targetId: "PAGE9", created: true });
		expect(calls).toEqual([
			{ method: "ManagedBrowser.ensureAgentTab", params: { agentId: "Writer", agentName: "Writer Bot" } },
			{
				method: "Target.createTarget",
				params: { url: "about:blank", agentId: "Writer", agentName: "Writer Bot" },
			},
		]);
	});

	it("propagates a real bridge failure instead of creating a tab", async () => {
		const { browser, calls } = fakeBrowser(() => {
			throw new Error("The managed browser did not provide an agent tab");
		});

		const pending = requestManagedBrowserTarget(browser, undefined, { agentId: "Writer" });
		await expect(pending).rejects.toThrow(/did not provide an agent tab/);
		expect(calls.map(call => call.method)).toEqual(["ManagedBrowser.ensureAgentTab"]);
	});

	it("reports an unmatched target instead of falling back to a new tab", async () => {
		const { browser, calls } = fakeBrowser(always({ targetId: null }));
		const pending = requestManagedBrowserTarget(browser, "release notes", { agentId: "Helper" });
		await expect(pending).rejects.toBeInstanceOf(ToolError);
		await expect(pending).rejects.toThrow(/release notes/);
		expect(calls.map(call => call.method)).toEqual(["ManagedBrowser.findTabTarget"]);
	});
});
