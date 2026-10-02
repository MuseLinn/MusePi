/**
 * Contract test for defect P1-17: jumps keyed on `timestamp` land on the
 * FIRST entry sharing that millisecond, so two turns that start in the same
 * tick navigated to the wrong one.
 *
 * The failure mode this defends: a user clicks the SECOND of two same-tick
 * turns in the rail (or ⌘F finds a message in it) and the transcript scrolls
 * to the earlier one — with no error, just the wrong content on screen.
 */
import { describe, expect, test } from "bun:test";
import { resolveJumpEntryId } from "../src/lib/jump-target";

const msg = (id: string, timestamp: string, text: string) => ({
	id,
	timestamp,
	type: "message",
	message: { role: "user", content: text },
});

describe("resolveJumpEntryId", () => {
	test("id-keyed target resolves regardless of timestamp collisions", () => {
		// Two turns, same millisecond — the exact P1-17 shape.
		const entries = [
			msg("a", "2026-10-02T10:00:00.000Z", "first prompt"),
			msg("b", "2026-10-02T10:00:00.000Z", "second prompt"),
		];
		expect(resolveJumpEntryId(entries, { entryId: "b" })).toBe("b");
		expect(resolveJumpEntryId(entries, { entryId: "a" })).toBe("a");
	});

	test("id-keyed target outside the loaded window returns null (keep paging)", () => {
		const entries = [msg("a", "2026-10-02T10:00:00.000Z", "first")];
		expect(resolveJumpEntryId(entries, { entryId: "older" })).toBeNull();
	});

	test("timestamp+snippet disambiguates colliding entries by content", () => {
		// The ⌘F path: the daemon has no entry id, so a hit arrives as
		// timestamp + matched text. It must reach the SECOND entry.
		const entries = [
			msg("a", "2026-10-02T10:00:00.000Z", "fix the login bug please"),
			msg("b", "2026-10-02T10:00:00.000Z", "now the logout flow"),
		];
		expect(
			resolveJumpEntryId(entries, {
				timestamp: "2026-10-02T10:00:00.000Z",
				snippet: "now the logout flow",
			}),
		).toBe("b");
		expect(
			resolveJumpEntryId(entries, {
				timestamp: "2026-10-02T10:00:00.000Z",
				snippet: "fix the login bug",
			}),
		).toBe("a");
	});

	test("snippet matching works for block-array message content", () => {
		const entries = [
			{
				id: "a",
				timestamp: "t",
				type: "message",
				message: { content: [{ type: "text", text: "alpha" }] },
			},
			{
				id: "b",
				timestamp: "t",
				type: "message",
				message: { content: [{ type: "text", text: "beta" }] },
			},
		];
		expect(resolveJumpEntryId(entries, { timestamp: "t", snippet: "beta" })).toBe("b");
	});

	test("non-colliding timestamp resolves without needing the snippet", () => {
		const entries = [msg("a", "t1", "one"), msg("b", "t2", "two")];
		expect(resolveJumpEntryId(entries, { timestamp: "t2", snippet: "anything" })).toBe("b");
	});

	test("unmatched snippet on a collision keeps first-match instead of dropping the jump", () => {
		// Silently doing nothing would read as "the jump is broken"; landing on
		// the first row is the historical behaviour and is the safer floor.
		const entries = [msg("a", "t", "one"), msg("b", "t", "two")];
		expect(resolveJumpEntryId(entries, { timestamp: "t", snippet: "no such text" })).toBe("a");
	});

	test("missing entries / unknown timestamp return null rather than throwing", () => {
		expect(resolveJumpEntryId(null, { entryId: "a" })).toBeNull();
		expect(resolveJumpEntryId([], { timestamp: "t", snippet: "s" })).toBeNull();
		expect(resolveJumpEntryId(undefined, { entryId: "a" })).toBeNull();
	});
});
