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

const msg = (id: string, iso: string, text: string) => ({
	id,
	timestamp: iso,
	type: "message",
	message: { role: "user", content: text },
});

/** The wire timestamps the daemon stores, i.e. epoch ms of the ISO stamp. */
const ms = (iso: string): number => Date.parse(iso);

describe("resolveJumpEntryId", () => {
	test("id-keyed target resolves regardless of timestamp collisions", () => {
		// Two turns, same millisecond — the exact P1-17 shape.
		const t = "2026-10-02T10:00:00.000Z";
		const entries = [msg("a", t, "first prompt"), msg("b", t, "second prompt")];
		expect(resolveJumpEntryId(entries, { entryId: "b" })).toBe("b");
		expect(resolveJumpEntryId(entries, { entryId: "a" })).toBe("a");
	});

	test("id-keyed target outside the loaded window returns null (keep paging)", () => {
		const entries = [msg("a", "2026-10-02T10:00:00.000Z", "first")];
		expect(resolveJumpEntryId(entries, { entryId: "older" })).toBeNull();
	});

	test("a daemon hit resolves against the entry's ISO stamp", () => {
		// The live bug: `messages.timestamp` is epoch ms while the transcript
		// entry carries an ISO string. Comparing them as strings never matches,
		// so the jump paged to exhaustion and silently did nothing — the
		// counter still read 1/1, which read as "found but won't jump".
		const iso = "2026-09-28T04:43:01.517Z";
		const entries = [msg("a", iso, "the login bug is here"), msg("b", "2026-09-28T05:00:00.000Z", "later")];
		expect(
			resolveJumpEntryId(entries, {
				timestampMs: ms(iso),
				snippet: "the login bug",
			}),
		).toBe("a");
	});

	test("timestamp window tolerates the daemon/entry clock skew", () => {
		// The daemon stamps the wire message, the transcript stamps the entry:
		// different code paths, same instant in practice but not the same
		// reading. A few hundred ms of skew must still land on the row.
		const entries = [msg("a", "2026-09-28T04:43:01.517Z", "hello")];
		expect(
			resolveJumpEntryId(entries, {
				timestampMs: ms("2026-09-28T04:43:01.517Z") + 250,
				snippet: "",
			}),
		).toBe("a");
		// Beyond the window it is a different instant, not a skew.
		expect(
			resolveJumpEntryId(entries, {
				timestampMs: ms("2026-09-28T04:43:01.517Z") + 9000,
				snippet: "",
			}),
		).toBeNull();
	});

	test("colliding entries are disambiguated by the hit's text", () => {
		const t = "2026-10-02T10:00:00.000Z";
		const entries = [msg("a", t, "fix the login bug please"), msg("b", t, "now the logout flow")];
		expect(
			resolveJumpEntryId(entries, {
				timestampMs: ms(t),
				snippet: "now the logout flow",
			}),
		).toBe("b");
		expect(
			resolveJumpEntryId(entries, {
				timestampMs: ms(t),
				snippet: "fix the login bug",
			}),
		).toBe("a");
	});

	test("snippet matching works for block-array message content", () => {
		const t = "2026-10-02T10:00:00.000Z";
		const entries = [
			{
				id: "a",
				timestamp: t,
				type: "message",
				message: { content: [{ type: "text", text: "alpha" }] },
			},
			{
				id: "b",
				timestamp: t,
				type: "message",
				message: { content: [{ type: "text", text: "beta" }] },
			},
		];
		expect(resolveJumpEntryId(entries, { timestampMs: ms(t), snippet: "beta" })).toBe("b");
	});

	test("unmatched snippet on a collision keeps first-match instead of dropping the jump", () => {
		// Silently doing nothing would read as "the jump is broken"; landing on
		// the first row is the historical behaviour and is the safer floor.
		const t = "2026-10-02T10:00:00.000Z";
		const entries = [msg("a", t, "one"), msg("b", t, "two")];
		expect(
			resolveJumpEntryId(entries, {
				timestampMs: ms(t),
				snippet: "no such text",
			}),
		).toBe("a");
	});

	test("missing entries / unknown timestamp return null rather than throwing", () => {
		expect(resolveJumpEntryId(null, { entryId: "a" })).toBeNull();
		expect(resolveJumpEntryId([], { timestampMs: 1, snippet: "s" })).toBeNull();
		expect(resolveJumpEntryId(undefined, { entryId: "a" })).toBeNull();
	});

	test("an unparseable entry stamp is skipped, not matched", () => {
		const entries = [msg("a", "not-a-date", "x"), msg("b", "2026-10-02T10:00:00.000Z", "y")];
		expect(
			resolveJumpEntryId(entries, {
				timestampMs: Date.parse("2026-10-02T10:00:00.000Z"),
				snippet: "",
			}),
		).toBe("b");
	});
});
