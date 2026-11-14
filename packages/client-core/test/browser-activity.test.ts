import { describe, expect, test } from "bun:test";
import { setLocale } from "../src/i18n";
import {
	browserCallStats,
	browserOperationGroups,
	browserOperationStatus,
	browserOperationsOf,
	browserStepChanges,
} from "../src/tool-render/tools/browser-activity";

describe("browserOperationsOf", () => {
	test("keeps element geometry, page title and image thumbnails", () => {
		const operations = browserOperationsOf({
			operations: [
				{
					id: "run:1",
					action: "click",
					status: "completed",
					startedAt: 1,
					endedAt: 2,
					target: "#submit",
					x: 149.4,
					y: 317.2,
					width: 88,
					height: 32,
					pageTitle: "Upload Manuscript | IEEE Author Portal",
					pageUrl: "https://ieee.test/submit",
					thumbnail: "data:image/jpeg;base64,AAAA",
				},
			],
		});
		expect(operations).toEqual([
			{
				id: "run:1",
				action: "click",
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				target: "#submit",
				x: 149.4,
				y: 317.2,
				width: 88,
				height: 32,
				pageTitle: "Upload Manuscript | IEEE Author Portal",
				pageUrl: "https://ieee.test/submit",
				thumbnail: "data:image/jpeg;base64,AAAA",
			},
		]);
	});

	test("drops non-image thumbnails and non-numeric geometry", () => {
		const [operation] = browserOperationsOf({
			operations: [
				{
					id: "run:1",
					action: "click",
					status: "completed",
					startedAt: 1,
					x: "149",
					thumbnail: "https://example.com/shot.png",
				},
			],
		});
		expect(operation).not.toHaveProperty("x");
		expect(operation).not.toHaveProperty("thumbnail");
	});
});

describe("browser call summary and page grouping", () => {
	const operation = (overrides: Record<string, unknown>) =>
		({
			id: `op-${String(overrides.id ?? Math.random())}`,
			action: "click",
			status: "completed",
			startedAt: 1,
			endedAt: 2,
			...overrides,
		}) as never;

	test("summarizes pages, clicks, screenshots, failures and duration", () => {
		const stats = browserCallStats(
			[
				operation({ id: "a", action: "observe", pageUrl: "https://a.test", startedAt: 1_000, endedAt: 2_000 }),
				operation({ id: "b", action: "click", pageUrl: "https://a.test", startedAt: 2_000, endedAt: 3_500 }),
				operation({
					id: "c",
					action: "click",
					pageUrl: "https://b.test",
					status: "failed",
					startedAt: 3_500,
					endedAt: 4_000,
				}),
				operation({ id: "d", action: "screenshot", pageUrl: "https://b.test", startedAt: 4_000, endedAt: 5_000 }),
			],
			6_000,
		);
		expect(stats).toEqual({ pages: 2, clicks: 1, screenshots: 1, failures: 1, durationMs: 4_000 });
	});

	test("groups steps by page and keeps run order", () => {
		const groups = browserOperationGroups([
			operation({ id: "a", pageUrl: "https://a.test", pageTitle: "A" }),
			operation({ id: "b", pageUrl: "https://a.test" }),
			operation({ id: "c", pageUrl: "https://b.test", pageTitle: "B" }),
		]);
		expect(groups.map(group => ({ url: group.url, title: group.title, count: group.operations.length }))).toEqual([
			{ url: "https://a.test", title: "A", count: 2 },
			{ url: "https://b.test", title: "B", count: 1 },
		]);
	});
});

describe("browserStepChanges", () => {
	const step = (stateBefore: unknown, stateAfter: unknown) => {
		const [parsed] = browserOperationsOf({
			operations: [{ id: "run:1", action: "click", status: "completed", startedAt: 1, stateBefore, stateAfter }],
		});
		if (!parsed) throw new Error("operation did not parse");
		return parsed;
	};

	test("reports title, url, scroll and loading changes in display order", () => {
		const changes = browserStepChanges(
			step(
				{ url: "https://a.test/form", title: "Form", scrollY: 0, loading: true },
				{ url: "https://a.test/done", title: "Done", scrollY: 640, loading: false },
			),
		);
		expect(changes).toEqual([
			{ key: "pageTitle", before: "Form", after: "Done" },
			{ key: "url", before: "https://a.test/form", after: "https://a.test/done" },
			{ key: "scrollY", before: 0, after: 640 },
			{ key: "loading", before: true, after: false },
		]);
	});

	test("returns an empty list when the page stood still", () => {
		const state = { url: "https://a.test/form", title: "Form", scrollY: 0, loading: false };
		expect(browserStepChanges(step(state, { ...state }))).toEqual([]);
	});

	test("stays silent when one side was never sampled", () => {
		expect(browserStepChanges(step(undefined, { url: "https://a.test" }))).toBeNull();
		expect(browserStepChanges(step({ url: "https://a.test" }, undefined))).toBeNull();
	});

	test("drops the title when either side is empty", () => {
		expect(
			browserStepChanges(step({ url: "https://a.test", title: "Form" }, { url: "https://a.test", title: "" })),
		).toEqual([]);
	});
});

describe("browserOperationStatus", () => {
	test("carries the action verb through running, done and failed", () => {
		setLocale("zh-CN");
		expect(browserOperationStatus({ action: "click", status: "running" })).toBe("正在点击");
		expect(browserOperationStatus({ action: "click", status: "completed" })).toBe("已点击");
		expect(browserOperationStatus({ action: "click", status: "failed" })).toBe("点击失败");
		expect(browserOperationStatus({ action: "fill", status: "completed" })).toBe("已填写");
	});

	test("keeps cancellation generic", () => {
		setLocale("en-US");
		expect(browserOperationStatus({ action: "click", status: "canceled" })).toBe("Canceled");
	});
});
