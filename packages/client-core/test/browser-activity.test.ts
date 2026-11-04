import { describe, expect, test } from "bun:test";
import { browserOperationsOf } from "../src/tool-render/tools/browser-activity";

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
