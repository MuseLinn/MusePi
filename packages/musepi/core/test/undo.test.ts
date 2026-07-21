// ============================================================
// undo.ts tests — /undo anchor planning (kimi port, pi session-tree variant)
// ============================================================

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeUndoPlan,
	formatNothingToUndoMessage,
	formatUndoLimitMessage,
	listUndoAnchors,
	resolveUndoAvailability,
	undoAnchorLabel,
	undoRefillText,
	type UndoEntry,
} from "../src/undo.ts";

const user = (id: string, text: string): UndoEntry => ({ id, kind: "user", text });
const bash = (id: string, command: string, excludeFromContext = false): UndoEntry => ({
	id,
	kind: "bash",
	command,
	excludeFromContext,
});
const compaction = (id: string): UndoEntry => ({ id, kind: "compaction" });
const other = (id: string): UndoEntry => ({ id, kind: "other" });

describe("resolveUndoAvailability", () => {
	it("counts user and bash anchors on a plain branch", () => {
		const entries = [user("u1", "first"), other("a1"), bash("b1", "ls"), other("a2"), user("u2", "second")];
		assert.deepEqual(resolveUndoAvailability(entries), { maxCount: 3, stoppedAtCompaction: false });
	});

	it("caps at the most recent compaction entry", () => {
		const entries = [user("u1", "old"), compaction("c1"), user("u2", "new"), other("a1")];
		assert.deepEqual(resolveUndoAvailability(entries), { maxCount: 1, stoppedAtCompaction: true });
	});

	it("returns zero on an empty branch", () => {
		assert.deepEqual(resolveUndoAvailability([]), { maxCount: 0, stoppedAtCompaction: false });
	});
});

describe("computeUndoPlan", () => {
	it("plans navigation before the latest anchor for count=1", () => {
		const entries = [user("u1", "first"), other("a1"), user("u2", "second"), other("a2")];
		const plan = computeUndoPlan(entries, 1);
		assert.equal(plan.ok, true);
		if (!plan.ok) return;
		assert.equal(plan.anchor.entryId, "u2");
		assert.equal(plan.anchor.refillText, "second");
	});

	it("walks back N anchors for count=N", () => {
		const entries = [user("u1", "first"), other("a1"), user("u2", "second"), other("a2")];
		const plan = computeUndoPlan(entries, 2);
		assert.equal(plan.ok, true);
		if (!plan.ok) return;
		assert.equal(plan.anchor.entryId, "u1");
		assert.equal(plan.anchor.refillText, "first");
	});

	it("rejects counts beyond availability", () => {
		const entries = [user("u1", "first"), other("a1"), user("u2", "second")];
		const plan = computeUndoPlan(entries, 3);
		assert.equal(plan.ok, false);
		if (plan.ok) return;
		assert.equal(plan.reason, "limit");
		assert.equal(plan.availability.maxCount, 2);
	});

	it("rejects non-positive and non-integer counts", () => {
		const entries = [user("u1", "first"), other("a1")];
		assert.equal(computeUndoPlan(entries, 0).ok, false);
		assert.equal(computeUndoPlan(entries, -1).ok, false);
		assert.equal(computeUndoPlan(entries, 1.5).ok, false);
	});

	it("reports nothing-to-undo on an empty branch", () => {
		const plan = computeUndoPlan([], 1);
		assert.equal(plan.ok, false);
		if (plan.ok) return;
		assert.equal(plan.reason, "nothing");
	});

	it("ignores anchors folded into compaction", () => {
		const entries = [user("u1", "old"), other("a0"), compaction("c1"), user("u2", "new"), other("a1")];
		const plan = computeUndoPlan(entries, 1);
		assert.equal(plan.ok, true);
		if (!plan.ok) return;
		assert.equal(plan.anchor.entryId, "u2");
		const beyond = computeUndoPlan(entries, 2);
		assert.equal(beyond.ok, false);
		if (beyond.ok) return;
		assert.equal(beyond.availability.stoppedAtCompaction, true);
	});

	it("lists anchors in branch order for the selector", () => {
		const entries = [user("u1", "old"), compaction("c1"), user("u2", "mid"), other("a1"), bash("b1", "ls")];
		const { anchors, availability } = listUndoAnchors(entries);
		assert.equal(availability.maxCount, 2);
		assert.deepEqual(
			anchors.map((anchor) => anchor.entryId),
			["u2", "b1"],
		);
		assert.deepEqual(
			anchors.map((anchor) => anchor.label),
			["mid", "!ls"],
		);
	});

	it("refills bash anchors with their ! / !! prefix", () => {
		const entries = [user("u1", "first"), bash("b1", "npm test", true), other("a1")];
		const plan = computeUndoPlan(entries, 1);
		assert.equal(plan.ok, true);
		if (!plan.ok) return;
		assert.equal(plan.anchor.refillText, "!!npm test");
	});
});

describe("labels and messages", () => {
	it("formats single-line labels", () => {
		assert.equal(undoAnchorLabel(user("u", "hello\n  world")), "hello world");
		assert.equal(undoAnchorLabel(user("u", "  ")), "User message");
		assert.equal(undoAnchorLabel(bash("b", "ls -la")), "!ls -la");
	});

	it("formats refill text", () => {
		assert.equal(undoRefillText(user("u", "hi")), "hi");
		assert.equal(undoRefillText(bash("b", "ls")), "!ls");
		assert.equal(undoRefillText(bash("b", "ls", true)), "!!ls");
	});

	it("formats limit messages with compaction note", () => {
		assert.equal(
			formatUndoLimitMessage(3, { maxCount: 1, stoppedAtCompaction: true }),
			"Cannot undo 3 prompts; only 1 prompt can be undone in the active context after the last compaction.",
		);
		assert.equal(
			formatUndoLimitMessage(2, { maxCount: 2, stoppedAtCompaction: false }),
			"Cannot undo 2 prompts; only 2 prompts can be undone in the active context.",
		);
	});

	it("formats nothing-to-undo messages", () => {
		assert.equal(
			formatNothingToUndoMessage({ maxCount: 0, stoppedAtCompaction: true }),
			"Nothing to undo after the last compaction.",
		);
		assert.equal(formatNothingToUndoMessage({ maxCount: 0, stoppedAtCompaction: false }), "Nothing to undo.");
	});
});
