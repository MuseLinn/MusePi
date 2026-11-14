import { describe, expect, it, vi } from "bun:test";
import { runInNewContext } from "node:vm";
import { toolWireSchema, validateJsonSchemaValue } from "@musepi/pi-ai/utils/schema";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { snapshotActionCode } from "@musepi/pi-coding-agent/tools/browser/snapshot-actions";
import { createElementSnapshot, createVisualSnapshot } from "@musepi/pi-coding-agent/tools/browser/snapshots";
import * as supervisor from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@musepi/pi-coding-agent/tools/tool-errors";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

const observation = {
	url: "https://example.test",
	title: "Example",
	viewport: { width: 1100, height: 750 },
	scroll: { x: 0, y: 0, width: 1100, height: 750, scrollWidth: 1100, scrollHeight: 750 },
	elements: [{ id: 7, role: "button", name: "Submit", states: [] }],
};

describe("snapshot action schema and prompt", () => {
	it("accepts element and visual action variants", () => {
		const schema = toolWireSchema(new BrowserTool(makeSession()));
		for (const args of [
			{ action: "elements", name: "docs", scope: "viewport", limit: 100 },
			{ action: "visual", name: "docs" },
			{ action: "click", name: "docs", snapshotId: "elements-1", ref: "e7" },
			{ action: "click", name: "docs", snapshotId: "visual-1", x: 100, y: 120 },
			{ action: "click_if_interactive", name: "docs", snapshotId: "visual-1", x: 100, y: 120, radius: 48 },
			{ action: "visual_type", name: "docs", snapshotId: "visual-1", x: 100, y: 120, text: "hello", replace: true },
			{ action: "fill", name: "docs", snapshotId: "elements-1", ref: "e7", text: "hello" },
			{ action: "drag", name: "docs", snapshotId: "visual-1", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
			{
				action: "drag_path",
				name: "docs",
				snapshotId: "visual-1",
				points: [
					{ x: 1, y: 2 },
					{ x: 3, y: 4 },
				],
				button: "right",
				durationMs: 120,
				modifiers: ["Shift"],
			},
		]) {
			expect(validateJsonSchemaValue(schema, args).success).toBe(true);
		}
	});

	it("teaches snapshot-scoped refs and coordinates", () => {
		const description = new BrowserTool(makeSession()).description;
		expect(description).toContain('action:"elements"');
		expect(description).toContain('action:"visual"');
		expect(description).toContain("60 seconds");
		expect(description).toContain("snapshotId");
	});

	it("teaches original crops, drag paths and device re-observation", () => {
		const description = new BrowserTool(makeSession()).description;
		expect(description).toContain('action:"visual_crop"');
		expect(description).toContain("sourceSnapshotId");
		expect(description).toContain('action:"drag_path"');
		expect(description).toContain('action:"device_profiles"');
		expect(description).toContain('action:"set_device"');
		expect(description).toContain("Re-observe after device changes");
	});

	it("teaches retained history and download semantics", () => {
		const description = new BrowserTool(makeSession()).description;
		expect(description).toContain('action:"history"');
		expect(description).toContain('action:"downloads"');
		expect(description).toContain("200 history entries");
		expect(description).toContain("100 downloads");
		expect(description).toContain("savePath does not guarantee the file still exists");
	});

	it("teaches navigation lifecycle and observable waiting", () => {
		const description = new BrowserTool(makeSession()).description;
		expect(description).toContain('action:"search"');
		expect(description).toContain('action:"back"');
		expect(description).toContain('action:"forward"');
		expect(description).toContain('action:"wait_load"');
		expect(description).toContain('action:"wait_for"');
		expect(description).toContain("stableForMs");
		expect(description).toContain("lastObserved");
	});

	it("teaches safe visual input, element text and panel-only activation", () => {
		const tool = new BrowserTool(makeSession());
		const description = tool.description;
		expect(description).toContain('action:"click_if_interactive"');
		expect(description).toContain("never clicked automatically");
		expect(description).toContain('action:"visual_type"');
		expect(description).toContain('scope:"element"');
		expect(description).toContain('action:"activate_panel"');
		expect(description).toContain("without creating or switching a tab");
		for (const action of ["click_if_interactive", "visual_type", "activate_panel"] as const) {
			expect(tool.examples.some(example => "call" in example && example.call.action === action)).toBe(true);
		}
		expect(
			tool.examples.some(
				example => "call" in example && example.call.action === "read" && example.call.scope === "element",
			),
		).toBe(true);
	});

	it("teaches dialog response and control release", () => {
		const description = new BrowserTool(makeSession()).description;
		expect(description).toContain("pendingDialogs");
		expect(description).toContain('action:"dialog_respond"');
		expect(description).toContain("handledDialogs");
		expect(description).toContain("`release` detaches Agent control without closing the page");
	});
});

describe("snapshot action code", () => {
	it("uses observation ids for ref actions", () => {
		const snapshot = createElementSnapshot("docs", observation);
		expect(snapshotActionCode({ action: "click", snapshotId: snapshot.snapshotId, ref: "e7" }, snapshot)).toContain(
			"tab.id(7)",
		);
		expect(
			snapshotActionCode({ action: "fill", snapshotId: snapshot.snapshotId, ref: "e7", text: 'a"b' }, snapshot),
		).toContain('fill("a\\"b")');
		expect(() =>
			snapshotActionCode({ action: "click", snapshotId: snapshot.snapshotId, ref: "e99" }, snapshot),
		).toThrow(/ref/i);
	});

	it("maps visual coordinates without using current viewport state", () => {
		const snapshot = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		const code = snapshotActionCode(
			{ action: "click", snapshotId: snapshot.snapshotId, x: 512, y: 348 },
			undefined,
			snapshot,
		);
		expect(code).toContain("page.mouse.click(550,375");
	});

	it("compiles double-click and right-click for refs and visual points", () => {
		const snapshot = createElementSnapshot("docs", observation);
		expect(
			snapshotActionCode({ action: "double_click", snapshotId: snapshot.snapshotId, ref: "e7" }, snapshot),
		).toContain("handle.click({ count: 2 })");
		expect(
			snapshotActionCode({ action: "right_click", snapshotId: snapshot.snapshotId, ref: "e7" }, snapshot),
		).toContain('handle.click({ button: "right" })');
		const visual = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		expect(
			snapshotActionCode(
				{ action: "double_click", snapshotId: visual.snapshotId, x: 512, y: 348 },
				undefined,
				visual,
			),
		).toContain("page.mouse.click(550,375, { count: 2 })");
		expect(
			snapshotActionCode(
				{ action: "right_click", snapshotId: visual.snapshotId, x: 512, y: 348 },
				undefined,
				visual,
			),
		).toContain('page.mouse.click(550,375, { button: "right" })');
	});

	it("compiles safe interactive candidates and visual typing", () => {
		const snapshot = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		const interactive = snapshotActionCode(
			{ action: "click_if_interactive", snapshotId: snapshot.snapshotId, x: 512, y: 348 },
			undefined,
			snapshot,
		);
		expect(interactive).toContain("elementsFromPoint(550,375)");
		expect(interactive).toContain('outcome: "candidates"');
		expect(interactive).toContain("radius: 48");
		const typed = snapshotActionCode(
			{ action: "visual_type", snapshotId: snapshot.snapshotId, x: 512, y: 348, text: "hello", replace: true },
			undefined,
			snapshot,
		);
		expect(typed).toContain("page.mouse.click(550,375)");
		expect(typed).toContain("const selectAllModifier = await tab.evaluate");
		expect(typed).toContain('"Meta" : "Control"');
		expect(typed).toContain("page.keyboard.down(selectAllModifier)");
		expect(typed).toContain('page.keyboard.press("A")');
		expect(typed).toContain("page.keyboard.up(selectAllModifier)");
		expect(typed).not.toContain('"ControlOrMeta"');
		expect(typed).toContain('page.keyboard.type("hello")');
		const press = snapshotActionCode(
			{ action: "press", snapshotId: snapshot.snapshotId, x: 512, y: 348, key: "Enter" },
			undefined,
			snapshot,
		);
		expect(press).toContain("page.mouse.click(550,375)");
		expect(() =>
			snapshotActionCode(
				{ action: "click_if_interactive", snapshotId: snapshot.snapshotId, x: 0, y: 0, radius: 129 },
				undefined,
				snapshot,
			),
		).toThrow(/radius/);
	});

	it("returns nearby candidates and distances in returned screenshot pixels", async () => {
		const snapshot = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		const code = snapshotActionCode(
			{ action: "click_if_interactive", snapshotId: snapshot.snapshotId, x: 84, y: 96, radius: 48 },
			undefined,
			snapshot,
		);
		const element = {
			tagName: "BUTTON",
			textContent: "Submit",
			getAttribute: () => null,
			getBoundingClientRect: () => ({ x: 100, y: 80, width: 60, height: 48 }),
		};
		const result = (await runInNewContext(`(async () => { ${code} })()`, {
			document: {
				elementsFromPoint: () => [],
				querySelectorAll: () => [element],
			},
			tab: { evaluate: (fn: (args: unknown) => unknown, args: unknown) => fn(args) },
			page: {
				mouse: {
					click: () => {
						throw new Error("candidate must not be clicked");
					},
				},
			},
		})) as {
			outcome: string;
			candidates: Array<{ x: number; y: number; role: string; name: string; distance: number }>;
		};
		expect(result.outcome).toBe("candidates");
		expect(result.candidates).toEqual([{ x: 121, y: 97, role: "button", name: "Submit", distance: 37 }]);
	});

	it("compiles a continuous drag path with mapped points and bounded input", () => {
		const snapshot = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		const code = snapshotActionCode(
			{
				action: "drag_path",
				snapshotId: snapshot.snapshotId,
				points: [
					{ x: 0, y: 0 },
					{ x: 512, y: 348 },
				],
				button: "right",
				durationMs: 120,
				modifiers: ["Shift", "Control"],
			},
			undefined,
			snapshot,
		);
		expect(code).toContain("[550,375]");
		expect(code).toContain("const durationMs = 120");
		expect(code).toContain('page.mouse.down({ button: "right" })');
		expect(code).toContain('page.keyboard.down("Shift")');
		expect(code).toContain('page.keyboard.up("Control")');
		expect(code).toContain("finally");
		expect(code.indexOf("try {")).toBeLessThan(code.indexOf('page.keyboard.down("Shift")'));
		const defaultTiming = snapshotActionCode(
			{
				action: "drag_path",
				snapshotId: snapshot.snapshotId,
				points: [
					{ x: 0, y: 0 },
					{ x: 100, y: 100 },
				],
			},
			undefined,
			snapshot,
		);
		expect(defaultTiming).toContain("Math.min(5000, totalSteps * 8)");
	});

	it("rejects invalid paths before pressing the pointer", () => {
		const snapshot = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		expect(() =>
			snapshotActionCode(
				{ action: "drag_path", snapshotId: snapshot.snapshotId, points: [{ x: 0, y: 0 }] },
				undefined,
				snapshot,
			),
		).toThrow(/2–500/);
		expect(() =>
			snapshotActionCode(
				{
					action: "drag_path",
					snapshotId: snapshot.snapshotId,
					points: Array.from({ length: 501 }, () => ({ x: 0, y: 0 })),
				},
				undefined,
				snapshot,
			),
		).toThrow(/2–500/);
		expect(() =>
			snapshotActionCode(
				{
					action: "drag_path",
					snapshotId: snapshot.snapshotId,
					points: [
						{ x: 0, y: 0 },
						{ x: 1, y: 1 },
					],
					durationMs: 20_001,
				},
				undefined,
				snapshot,
			),
		).toThrow(/durationMs/);
		expect(() =>
			snapshotActionCode(
				{
					action: "drag_path",
					snapshotId: snapshot.snapshotId,
					points: [
						{ x: 0, y: 0 },
						{ x: 1, y: 1 },
					],
					modifiers: ["Bogus"] as never,
				},
				undefined,
				snapshot,
			),
		).toThrow(/modifiers/);
	});

	it("rejects incomplete actions before generating code", () => {
		const snapshot = createElementSnapshot("docs", observation);
		expect(() =>
			snapshotActionCode({ action: "fill", snapshotId: snapshot.snapshotId, ref: "e7" }, snapshot),
		).toThrow(/text/i);
		expect(() => snapshotActionCode({ action: "click", snapshotId: snapshot.snapshotId }, snapshot)).toThrow(
			/snapshotId/i,
		);
	});

	it("resolves drag_path snapshots through the real tool action", async () => {
		vi.restoreAllMocks();
		const snapshot = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		vi.spyOn(supervisor, "runInTab").mockResolvedValue({
			displays: [],
			returnValue: { ok: true },
			screenshots: [],
			operations: [],
		});
		const result = await new BrowserTool(makeSession()).execute("path", {
			action: "drag_path",
			name: "docs",
			snapshotId: snapshot.snapshotId,
			points: [
				{ x: 0, y: 0 },
				{ x: 10, y: 10 },
			],
		});
		expect(result.details?.actionReceipt?.status).toBe("completed");
		vi.restoreAllMocks();
	});

	it("rethrows aborts instead of converting them to failed receipts", async () => {
		vi.restoreAllMocks();
		vi.spyOn(supervisor, "runInTab").mockImplementation(async () => {
			throw new ToolAbortError();
		});
		const snapshot = createElementSnapshot("docs", observation);
		const tool = new BrowserTool(makeSession());
		await expect(
			tool.execute("abort", { action: "click", name: "docs", snapshotId: snapshot.snapshotId, ref: "e7" }),
		).rejects.toBeInstanceOf(ToolAbortError);
		vi.restoreAllMocks();
	});
});
