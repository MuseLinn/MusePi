import { describe, expect, test } from "bun:test";
import {
	browserCallStats,
	browserOperationGroups,
	browserOperationsOf,
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
