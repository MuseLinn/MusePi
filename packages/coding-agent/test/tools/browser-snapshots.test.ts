import { describe, expect, it } from "bun:test";
import {
	createElementSnapshot,
	createVisualSnapshot,
	paginateElementSnapshot,
	readElementSnapshot,
	readVisualSnapshot,
	visualPointToCss,
} from "@musepi/pi-coding-agent/tools/browser/snapshots";

const observation = {
	url: "https://example.test/form",
	title: "Form",
	viewport: { width: 1100, height: 750 },
	scroll: { x: 0, y: 0, width: 1100, height: 750, scrollWidth: 1100, scrollHeight: 1600 },
	elements: [
		{ id: 1, role: "button", name: "Sign in", states: [] },
		{ id: 2, role: "textbox", name: "Email", states: [] },
		{ id: 3, role: "link", name: "Documentation", states: ["focusable"] },
	],
};

describe("browser snapshot registry", () => {
	it("expires snapshots and refuses cross-tab reads", () => {
		const snapshot = createElementSnapshot("docs", observation, 1_000);
		expect(readElementSnapshot("docs", snapshot.snapshotId, 61_000).snapshotId).toBe(snapshot.snapshotId);
		expect(() => readElementSnapshot("other", snapshot.snapshotId, 1_000)).toThrow(/tab/i);
		expect(() => readElementSnapshot("docs", snapshot.snapshotId, 61_001)).toThrow(/expired/i);
	});

	it("keeps visual snapshots under the same ownership and TTL", () => {
		const snapshot = createVisualSnapshot(
			"docs",
			{
				url: observation.url,
				title: observation.title,
				viewport: observation.viewport,
				image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
				capturedAt: "2026-11-08T00:00:00.000Z",
			},
			1_000,
		);
		expect(readVisualSnapshot("docs", snapshot.snapshotId, 61_000).image.width).toBe(1024);
		expect(() => readVisualSnapshot("other", snapshot.snapshotId, 1_000)).toThrow(/tab/i);
	});
});

describe("element snapshot pagination", () => {
	it("filters roles and text before counting results", () => {
		const snapshot = createElementSnapshot("docs", observation, 1_000);
		const page = paginateElementSnapshot(snapshot, { role: "button", text: "sign" });
		expect(page.elements.map(element => element.ref)).toEqual(["e1"]);
		expect(page.returned).toBe(1);
		expect(page.total).toBe(1);
		expect(page.truncated).toBe(false);
	});

	it("continues the same snapshot with limit and maxChars bounds", () => {
		const snapshot = createElementSnapshot("docs", observation, 1_000);
		const first = paginateElementSnapshot(snapshot, { limit: 2, maxChars: 2048 });
		expect(first.elements.map(element => element.ref)).toEqual(["e1", "e2"]);
		expect(first.nextCursor).toBe("2");
		const second = paginateElementSnapshot(snapshot, { limit: 2, maxChars: 2048, cursor: first.nextCursor });
		expect(second.elements.map(element => element.ref)).toEqual(["e3"]);
		expect(second.truncated).toBe(false);
		expect(() => paginateElementSnapshot(snapshot, { cursor: "99" })).toThrow(/cursor/i);
		expect(() => paginateElementSnapshot(snapshot, { maxChars: 2047 })).toThrow(/2048/);
	});
});

describe("visual coordinate mapping", () => {
	it("maps returned screenshot pixels into the captured CSS viewport", () => {
		const snapshot = createVisualSnapshot("docs", {
			url: observation.url,
			title: observation.title,
			viewport: observation.viewport,
			image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		expect(visualPointToCss(snapshot, { x: 512, y: 348 })).toEqual({ x: 550, y: 375 });
		expect(() => visualPointToCss(snapshot, { x: -1, y: 0 })).toThrow(/coordinate/i);
		expect(() => visualPointToCss(snapshot, { x: 1025, y: 0 })).toThrow(/coordinate/i);
	});
});
