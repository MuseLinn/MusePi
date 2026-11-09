import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { navigationActionCode, searchUrl } from "@musepi/pi-coding-agent/tools/browser/navigation";
import * as supervisor from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.searchEngine": "bing" }),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("browser navigation", () => {
	it("uses the configured search engine and validates required inputs", () => {
		expect(searchUrl("bing", "hello world")).toBe("https://www.bing.com/search?q=hello%20world");
		expect(searchUrl("unknown", "hello")).toBe("https://www.google.com/search?q=hello");
		expect(navigationActionCode({ action: "back", wait_until: "domcontentloaded" }, "google")).toContain(
			"Page.getNavigationHistory",
		);
		expect(navigationActionCode({ action: "back", wait_until: "domcontentloaded" }, "google")).toContain(
			"Page.navigateToHistoryEntry",
		);
		expect(navigationActionCode({ action: "forward" }, "google")).toContain("Page.navigateToHistoryEntry");
		expect(navigationActionCode({ action: "reload" }, "google")).toContain("page.reload");
		expect(navigationActionCode({ action: "stop" }, "google")).toContain("Page.stopLoading");
		expect(navigationActionCode({ action: "wait_load", state: "complete" }, "google")).toContain(
			'document.readyState === "complete"',
		);
		expect(() => navigationActionCode({ action: "search", query: " " }, "google")).toThrow(/query/);
		expect(() => navigationActionCode({ action: "navigate", url: "not-a-url" }, "google")).toThrow(/HTTP\(S\)/);
	});

	it("returns actual navigation state through the existing browser tool", async () => {
		const navigation = {
			action: "search" as const,
			url: "https://www.bing.com/search?q=hello",
			title: "hello - Search",
		};
		vi.spyOn(supervisor, "runInTab").mockResolvedValue({
			displays: [],
			returnValue: navigation,
			screenshots: [],
			operations: [],
		});
		const result = await new BrowserTool(makeSession()).execute("search", { action: "search", query: "hello" });
		expect(result.details?.navigation).toEqual(navigation);
		expect(result.content).toContainEqual({ type: "text", text: JSON.stringify(navigation, null, 2) });
	});

	it("stops a pending navigation through the supervisor instead of the blocked run", async () => {
		vi.spyOn(supervisor, "getTab").mockReturnValue({
			targetId: "PAGE1",
			info: { url: "https://example.test/slow", title: "Slow", targetId: "PAGE1" },
			browser: { kind: { kind: "connected", gui: true } },
		} as never);
		vi.spyOn(supervisor, "stopTabLoading").mockResolvedValue("PAGE1");
		const result = await new BrowserTool(makeSession()).execute("stop", { action: "stop", name: "docs" });
		expect(result.details?.navigation).toEqual({ action: "stop", url: "https://example.test/slow", title: "Slow" });
	});
});
