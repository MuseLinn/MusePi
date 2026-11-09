import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import * as supervisor from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function tab() {
	return {
		targetId: "PAGE1",
		info: { url: "https://example.test", title: "Example", targetId: "PAGE1" },
		browser: { kind: { kind: "connected", gui: true } },
	};
}

afterEach(() => vi.restoreAllMocks());

describe("browser tab control", () => {
	it("activates control without revealing the page", async () => {
		vi.spyOn(supervisor, "getTab").mockReturnValue(tab() as never);
		const reveal = vi.spyOn(supervisor, "activateTabTarget");
		const result = await new BrowserTool(makeSession()).execute("activate", { action: "activate", name: "docs" });
		expect(result.details?.control).toEqual({ action: "activate", activeTabId: "PAGE1" });
		expect(reveal).not.toHaveBeenCalled();
	});

	it("switches the real target into view", async () => {
		vi.spyOn(supervisor, "getTab").mockReturnValue(tab() as never);
		const reveal = vi.spyOn(supervisor, "activateTabTarget").mockResolvedValue("PAGE1");
		const result = await new BrowserTool(makeSession()).execute("switch", { action: "switch", name: "docs" });
		expect(reveal).toHaveBeenCalledWith("docs");
		expect(result.details?.control).toEqual({ action: "switch", activeTabId: "PAGE1", visibleTabId: "PAGE1" });
	});

	it("releases control without closing the page", async () => {
		vi.spyOn(supervisor, "getTab").mockReturnValue(tab() as never);
		const release = vi.spyOn(supervisor, "releaseManagedAgent").mockResolvedValue(true);
		const result = await new BrowserTool(makeSession()).execute("release", { action: "release", name: "docs" });
		expect(release).toHaveBeenCalledWith("docs");
		expect(result.details?.control).toEqual({ action: "release", activeTabId: "PAGE1", released: true });
	});
});
