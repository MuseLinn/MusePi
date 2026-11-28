import { describe, expect, test } from "bun:test";
import { applySurfaceOpsForTest } from "../src/session/dsh-session-store";

/**
 * A v4 `surfaceOp: replace` retires the records in its range.
 *
 * The regression this pins: appending every record unconditionally leaves the
 * replaced content in the transcript *and* keeps what replaced it, so a
 * compacted session imports with its history duplicated.
 */
describe("dsh surface operations", () => {
	const message = (seq: number): { seq: number; message: { role: "user"; content: string; timestamp: number } } => ({
		seq,
		message: { role: "user", content: `m${seq}`, timestamp: seq },
	});

	test("keeps every message when no record replaces a range", () => {
		const records = [
			{ type: "user/message", seq: 1, surfaceOp: "append" },
			{ type: "user/message", seq: 2 },
		];
		const nodes = [message(1), message(2)];
		expect(applySurfaceOpsForTest(records, nodes).map(n => n.seq)).toEqual([1, 2]);
	});

	test("drops the replaced range and keeps the replacing record", () => {
		const records = [
			{ type: "user/message", seq: 1 },
			{ type: "assistant/message", seq: 2 },
			{ type: "user/message", seq: 3 },
			{ type: "system/message", seq: 4, surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 } },
		];
		const nodes = [message(1), message(2), message(3), message(4)];
		expect(applySurfaceOpsForTest(records, nodes).map(n => n.seq)).toEqual([3, 4]);
	});

	test("reads the operation from the event payload too", () => {
		const records = [
			{ type: "user/message", seq: 1 },
			{ type: "user/message", seq: 2, data: { surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 } } },
		];
		const nodes = [message(1), message(2)];
		expect(applySurfaceOpsForTest(records, nodes).map(n => n.seq)).toEqual([2]);
	});

	test("ignores a range that names no recorded message", () => {
		// An unreadable or truncated record leaves the range unresolvable; dropping
		// nothing is recoverable, dropping by guess is not.
		const records = [{ type: "user/message", seq: 9, surfaceOp: { op: "replace", startSeq: 100, endSeq: 200 } }];
		const nodes = [message(1), message(2)];
		expect(applySurfaceOpsForTest(records, nodes).map(n => n.seq)).toEqual([1, 2]);
	});

	test("ignores an operation it cannot parse", () => {
		const records = [{ type: "user/message", seq: 2, surfaceOp: { op: "replace", startSeq: "x" } }];
		const nodes = [message(1), message(2)];
		expect(applySurfaceOpsForTest(records, nodes).map(n => n.seq)).toEqual([1, 2]);
	});
});
