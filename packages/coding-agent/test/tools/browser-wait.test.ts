import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import * as supervisor from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import { pageWaitCode } from "@musepi/pi-coding-agent/tools/browser/wait";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("browser condition waiting", () => {
	it("compiles all condition kinds and validates bounds", () => {
		expect(
			pageWaitCode({ kind: "element", locator: { role: "button", name: "Submit", exact: true }, state: "visible" }),
		).toContain("button");
		expect(pageWaitCode({ kind: "text", text: "Done", match: "contains", state: "present" })).toContain("Done");
		expect(pageWaitCode({ kind: "url", value: "https://example.test", match: "prefix" })).toContain(
			"https://example.test",
		);
		expect(pageWaitCode({ kind: "url", value: "https://example.test", match: "exact" }, 100, 200)).toContain(
			"stableSince",
		);
		expect(() => pageWaitCode({ kind: "text", text: "x", state: "present" }, 30_001)).toThrow(/30000/);
		expect(() => pageWaitCode({ kind: "text", text: "x", state: "present" }, 100, 5001)).toThrow(/stableForMs/);
	});

	it("returns match and timeout evidence through the browser tool", async () => {
		const condition = { kind: "text" as const, text: "Done", match: "contains" as const, state: "present" as const };
		vi.spyOn(supervisor, "runInTab")
			.mockResolvedValueOnce({
				displays: [],
				returnValue: { outcome: "matched", condition, lastObserved: { text: "Done" }, timeoutMs: 10000 },
				screenshots: [],
				operations: [],
			})
			.mockResolvedValueOnce({
				displays: [],
				returnValue: { outcome: "timeout", condition, lastObserved: { text: "Loading" }, timeoutMs: 10000 },
				screenshots: [],
				operations: [],
			});
		const tool = new BrowserTool(makeSession());
		const matched = await tool.execute("matched", { action: "wait_for", condition });
		expect(matched.details?.waitResult?.outcome).toBe("matched");
		const timedOut = await tool.execute("timeout", { action: "wait_for", condition });
		expect(timedOut.isError).toBe(true);
		expect(timedOut.details?.waitResult?.lastObserved).toEqual({ text: "Loading" });
	});
});
