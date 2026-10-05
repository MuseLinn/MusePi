import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { planErrorSurfaces } from "./error-surfaces";

/**
 * A terminal retry failure is written twice — into the assistant message and into
 * a durable retry_failure row. Both records are load-bearing (the first is what a
 * consumer reads, the second survives the empty turn being dropped), but rendering
 * both showed one failure twice. These cases pin which surface owns the reason,
 * because getting it backwards either hides the failure or duplicates it.
 *
 * The plan reports the two things the UI actually renders, and together they fully
 * determine what a reader sees: which assistant rows show a reason (and what extra
 * facts they inherited), and which failure the dock above the composer is reporting.
 */
const errorAssistant = (id: string, text: string): SessionEntry =>
	({
		type: "message",
		id,
		timestamp: "2026-10-05T00:00:00.000Z",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage: text },
	}) as unknown as SessionEntry;

const retryRow = (id: string, text: string, attempt?: number): SessionEntry =>
	({
		type: "custom_message",
		id,
		customType: "retry_failure",
		content: text,
		timestamp: "2026-10-05T00:00:01.000Z",
		display: true,
		...(attempt === undefined ? {} : { details: { attempt } }),
	}) as unknown as SessionEntry;

const okAssistant = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		timestamp: "2026-10-05T00:00:00.000Z",
		message: { role: "assistant", content: [], stopReason: "stop" },
	}) as unknown as SessionEntry;

const userPrompt = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		timestamp: "2026-10-05T00:00:02.000Z",
		message: { role: "user", content: [{ type: "text", text: "again" }] },
	}) as unknown as SessionEntry;

describe("planErrorSurfaces", () => {
	test("gives the reason to the assistant row when both carry the same text", () => {
		// The regression: the transcript showed the 429 twice, once as an assistant
		// row and again in the retry card. The retry row's attempt count is the one
		// fact the assistant row cannot know, so it moves there rather than staying
		// behind on a row that has nothing left to say.
		const reason = "429 insufficient balance";
		const plan = planErrorSurfaces([errorAssistant("a1", reason), retryRow("c1", reason, 3)]);

		expect([...plan.ownedByAssistant.keys()]).toEqual(["a1"]);
		expect(plan.ownedByAssistant.get("a1")).toEqual({ attempt: 3 });
		expect(plan.banner).toBeNull();
	});

	test("lets the retry row own the reason when the texts differ", () => {
		// Different text means these are two separate facts, not one written twice —
		// a retry card reporting something new must reach the banner.
		const plan = planErrorSurfaces([
			errorAssistant("a1", "socket connection was closed unexpectedly"),
			retryRow("c1", "429 insufficient balance", 2),
		]);

		expect(plan.ownedByAssistant.get("a1")).toEqual({});
		expect(plan.banner).toEqual({ reason: "429 insufficient balance", attempt: 2 });
	});

	test("does not let an old failure absorb a later card", () => {
		// The window only reaches a few entries back, so an assistant failure that far
		// behind the retry row cannot claim it. Without the window the scan would walk
		// the whole transcript and absorb today's card on the strength of an old
		// failure — two failures that both happened are two facts.
		const between = Array.from({ length: 10 }, (_, i) => okAssistant(`s${i}`));
		const reason = "429 insufficient balance";
		const plan = planErrorSurfaces([errorAssistant("a1", reason), ...between, retryRow("c1", reason, 5)]);

		// The empty facts are the observable consequence of not being absorbed: had the
		// card been absorbed here, a1 would have inherited the attempt count.
		expect(plan.ownedByAssistant.get("a1")).toEqual({});
		expect(plan.banner).toEqual({ reason, attempt: 5 });
	});

	test("claims an assistant row that carries a reason but no matching card", () => {
		const plan = planErrorSurfaces([errorAssistant("a1", "socket closed")]);

		expect([...plan.ownedByAssistant.keys()]).toEqual(["a1"]);
		expect(plan.banner).toBeNull();
	});

	test("ignores entries without an id", () => {
		// Sessions can be mid-write; a row with no id cannot be matched, so it must
		// not be claimed by anything.
		const reason = "429 insufficient balance";
		const plan = planErrorSurfaces([errorAssistant("", reason), retryRow("", reason)]);

		expect([...plan.ownedByAssistant.keys()]).toEqual([]);
		// The unmatched retry row still describes a failure the user must see.
		expect(plan.banner?.reason).toBe(reason);
	});

	test("treats surrounding whitespace as the same reason", () => {
		const plan = planErrorSurfaces([
			errorAssistant("a1", "429 out of credit"),
			retryRow("c1", "  429 out of credit  ", 2),
		]);

		expect(plan.ownedByAssistant.get("a1")).toEqual({ attempt: 2 });
		expect(plan.banner).toBeNull();
	});

	test("retires the banner once the user sends again", () => {
		// The dismissal is the next prompt, not a close button: after it, the failure
		// is history and the dock must clear rather than sit over a settled round.
		const plan = planErrorSurfaces([retryRow("c1", "429 insufficient balance"), userPrompt("u1")]);

		expect(plan.banner).toBeNull();
	});

	test("keeps the banner when only bookkeeping follows the failure", () => {
		// A tool result landing after the failure is not the user moving on. Clearing
		// on it would hide a failure the user has not been told about yet.
		const reason = "429 insufficient balance";
		const plan = planErrorSurfaces([retryRow("c1", reason), okAssistant("a9")]);

		expect(plan.banner?.reason).toBe(reason);
	});

	test("an absorbed retry row does not stand in for an unabsorbed one", () => {
		// The only absorbable failure is the first row, and the user has since sent
		// again, so the dock must be clear. The later retry_failure was absorbed by an
		// assistant message and is not a candidate — reading the candidate off the
		// final retry_failure instead would search for a prompt after an unrelated
		// row, find none, and re-raise a failure the user already moved past.
		const first = "429 insufficient balance";
		const plan = planErrorSurfaces([
			retryRow("c1", first),
			userPrompt("u1"),
			errorAssistant("a1", first),
			retryRow("c2", first),
		]);

		expect(plan.banner).toBeNull();
		expect([...plan.ownedByAssistant.keys()]).toEqual(["a1"]);
		expect(plan.ownedByAssistant.get("a1")).toEqual({});
	});

	test("reports the latest unabsorbed failure when rounds stack up", () => {
		// Two unabsorbed failures in a row: the dock states the current round, so the
		// later one wins rather than the first.
		const plan = planErrorSurfaces([
			retryRow("c1", "first failure"),
			userPrompt("u1"),
			retryRow("c2", "second failure", 5),
		]);

		expect(plan.banner).toEqual({ reason: "second failure", attempt: 5 });
	});

	test("a retry row without an attempt count still reaches the banner", () => {
		// The count is optional detail, not the banner's reason. Dropping the banner
		// because the count is missing would hide a failure the user needs.
		const plan = planErrorSurfaces([retryRow("c1", "provider refused the connection")]);

		expect(plan.banner).toEqual({ reason: "provider refused the connection" });
	});

	test("no failure anywhere yields no surfaces at all", () => {
		const plan = planErrorSurfaces([userPrompt("u1"), okAssistant("a1")]);

		expect(plan.banner).toBeNull();
		expect([...plan.ownedByAssistant.keys()]).toEqual([]);
	});
});
