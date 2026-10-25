import { describe, expect, it } from "bun:test";
import {
	BrowserOperationTracker,
	operationResultDetails,
	redactBrowserUrl,
} from "@musepi/pi-coding-agent/tools/browser/operation-activity";
import type { BrowserOperation } from "@musepi/pi-coding-agent/tools/browser/tab-protocol";
import {
	describeInflight,
	describeScreenshot,
	type InflightOp,
	preparePageForScreenshot,
} from "@musepi/pi-coding-agent/tools/browser/tab-worker";

type ScreenshotPage = Parameters<typeof preparePageForScreenshot>[0];

describe("browser op tracking — timeout diagnostics", () => {
	it("labels a screenshot op by its distinguishing argument", () => {
		expect(describeScreenshot({ selector: ".wb-paper-popover" })).toBe(
			'tab.screenshot({ selector: ".wb-paper-popover" })',
		);
		expect(describeScreenshot({ fullPage: true })).toBe("tab.screenshot({ fullPage: true })");
		expect(describeScreenshot()).toBe("tab.screenshot()");
		expect(describeScreenshot({})).toBe("tab.screenshot()");
	});

	it("names every still-running helper so a cell timeout is attributable", () => {
		const now = Date.now();
		// Inserted newest-first to prove the summary sorts by start time, not insertion order.
		const inflight = new Map<number, InflightOp>([
			[1, { label: "tab.observe()", startedAt: now - 1_000 }],
			[0, { label: 'tab.screenshot({ selector: ".x" })', startedAt: now - 3_000 }],
		]);

		const summary = describeInflight(inflight);

		// Oldest op (most likely the culprit) is listed first.
		expect(summary.indexOf("tab.screenshot")).toBeLessThan(summary.indexOf("tab.observe"));
		// Each op carries an elapsed-seconds annotation.
		expect(summary).toMatch(/tab\.screenshot\(\{ selector: "\.x" \}\) \(\d+\.\d+s\)/);
		expect(summary).toMatch(/tab\.observe\(\) \(\d+\.\d+s\)/);
	});

	it("returns an empty summary when nothing is in flight", () => {
		expect(describeInflight(new Map())).toBe("");
	});
});

describe("browser screenshot activation", () => {
	it("activates owned targets before capture", async () => {
		let activations = 0;
		const page = {
			bringToFront: async () => {
				activations += 1;
			},
			evaluate: async () => {
				throw new Error("visibility should not be queried");
			},
		};

		await preparePageForScreenshot(page as ScreenshotPage, undefined, true);

		expect(activations).toBe(1);
	});

	it("leaves a visible user-driven target in place", async () => {
		let activations = 0;
		const page = {
			bringToFront: async () => {
				activations += 1;
			},
			evaluate: async () => true,
		};

		await preparePageForScreenshot(page as ScreenshotPage, undefined, false);

		expect(activations).toBe(0);
	});

	it("rejects a background user-driven target instead of capturing sibling pixels", async () => {
		const page = {
			bringToFront: async () => undefined,
			evaluate: async () => false,
		};

		await expect(preparePageForScreenshot(page as ScreenshotPage, undefined, false)).rejects.toThrow(
			"The attached browser tab is not visible",
		);
	});
});

describe("browser operation activity", () => {
	it("publishes cumulative lifecycle snapshots with observation metadata", () => {
		const snapshots: BrowserOperation[][] = [];
		const tracker = new BrowserOperationTracker("run-1", operations => snapshots.push(operations));

		const observed = tracker.start("observe");
		tracker.complete(observed, { elementCount: 4 });
		const clicked = tracker.start("click", { target: "#go" });

		expect(snapshots[0]?.map(operation => operation.status)).toEqual(["running"]);
		expect(snapshots.at(-1)?.map(operation => [operation.action, operation.status])).toEqual([
			["observe", "completed"],
			["click", "running"],
		]);
		expect(tracker.snapshot()[0]?.elementCount).toBe(4);
	});

	it("settles failures and cancellation without changing earlier steps", () => {
		const tracker = new BrowserOperationTracker("run-2");
		const completed = tracker.start("goto", { target: "https://example.com" });
		tracker.complete(completed);
		const failed = tracker.start("fill", { target: "#email" });
		tracker.fail(failed, new Error("not editable"));
		const waiting = tracker.start("wait");

		tracker.cancel(waiting);

		expect(tracker.snapshot().map(operation => operation.status)).toEqual(["completed", "failed", "canceled"]);
		expect(tracker.snapshot()[1]?.error).toBe("not editable");
	});

	it("does not read observation metadata from void helper results", () => {
		expect(operationResultDetails(undefined)).toEqual({});
		expect(operationResultDetails({ elements: [{ id: 1 }, { id: 2 }] })).toEqual({ elementCount: 2 });
	});

	it("removes credentials from navigation targets", () => {
		expect(redactBrowserUrl("https://user:password@example.com/private")).toBe("https://example.com/private");
	});

	it("settles every running operation when a run ends", () => {
		const tracker = new BrowserOperationTracker("run-end");
		const completed = tracker.start("observe");
		tracker.complete(completed);
		tracker.start("click");
		tracker.start("screenshot");

		tracker.cancelPending();

		expect(tracker.snapshot().map(operation => operation.status)).toEqual(["completed", "canceled", "canceled"]);
	});
});
