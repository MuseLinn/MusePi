import { describe, expect, it } from "bun:test";
import { normalizeQueueSnapshot } from "../src/lib/message-queue";

describe("normalizeQueueSnapshot", () => {
	it("keeps stable ids, attachment counts and paused state from the current daemon", () => {
		expect(
			normalizeQueueSnapshot({
				count: 3,
				paused: true,
				steering: [{ id: "s1", text: "same", imageCount: 2 }],
				followUp: [{ id: "f1", text: "same", imageCount: 0 }],
			}),
		).toEqual({
			count: 3,
			paused: true,
			steering: [{ id: "s1", text: "same", imageCount: 2 }],
			followUp: [{ id: "f1", text: "same", imageCount: 0 }],
		});
	});

	it("adapts legacy text arrays without inventing attachment or pause state", () => {
		expect(normalizeQueueSnapshot({ count: 2, steering: ["same", "same"], followUp: [] })).toEqual({
			count: 2,
			paused: false,
			steering: [
				{ id: "same", text: "same", imageCount: 0 },
				{ id: "same", text: "same", imageCount: 0 },
			],
			followUp: [],
		});
	});

	it("drops malformed rows and derives a missing count from valid items", () => {
		expect(
			normalizeQueueSnapshot({
				steering: [null, { id: "valid", text: "keep", imageCount: -2 }, { id: 4, text: "drop" }],
				followUp: "invalid",
			}),
		).toEqual({
			count: 1,
			paused: false,
			steering: [{ id: "valid", text: "keep", imageCount: 0 }],
			followUp: [],
		});
	});
});
