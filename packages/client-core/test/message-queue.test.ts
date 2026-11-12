import { describe, expect, it } from "bun:test";
import { normalizeQueueSnapshot } from "../src/lib/message-queue";

describe("normalizeQueueSnapshot", () => {
	it("keeps stable ids, attachment counts and paused state from the current daemon", () => {
		// `count` follows the rows: the chip's actions address rows, and the
		// wire total also counts parked non-user work the panel cannot show.
		expect(
			normalizeQueueSnapshot({
				count: 3,
				paused: true,
				steering: [{ id: "s1", text: "same", imageCount: 2 }],
				followUp: [{ id: "f1", text: "same", imageCount: 0 }],
			}),
		).toEqual({
			count: 2,
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

	it("does not report a queue for a pending count with no rows", () => {
		// Parked advisor cards / hidden next-turn notices inflate the daemon's
		// pending count without producing a row; the old count rendered a
		// "队列 1" chip above an empty panel that 清空队列 could not dismiss.
		expect(normalizeQueueSnapshot({ count: 1, steering: [], followUp: [] })).toEqual({
			count: 0,
			paused: false,
			steering: [],
			followUp: [],
		});
	});

	it("drops rows with neither text nor images", () => {
		expect(
			normalizeQueueSnapshot({
				steering: [
					{ id: "blank", text: "   ", imageCount: 0 },
					{ id: "image-only", text: "", imageCount: 1 },
				],
				followUp: [],
			}),
		).toEqual({
			count: 1,
			paused: false,
			steering: [{ id: "image-only", text: "", imageCount: 1 }],
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
