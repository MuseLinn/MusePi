import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { planErrorSurfaces } from "./error-surfaces";

/**
 * A terminal retry failure is written twice — into the assistant message and into
 * a durable retry_failure row. Both records are load-bearing (the first is what a
 * consumer reads, the second survives the empty turn being dropped), but rendering
 * both showed one failure twice. These cases pin which surface owns the reason,
 * because getting it backwards either hides the failure or duplicates it.
 */
const errorAssistant = (id: string, text: string): SessionEntry =>
	({
		type: "message",
		id,
		timestamp: "2026-10-05T00:00:00.000Z",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage: text },
	}) as unknown as SessionEntry;

const retryRow = (id: string, text: string): SessionEntry =>
	({
		type: "custom_message",
		id,
		customType: "retry_failure",
		content: text,
		timestamp: "2026-10-05T00:00:01.000Z",
		display: true,
	}) as unknown as SessionEntry;

const okAssistant = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		timestamp: "2026-10-05T00:00:00.000Z",
		message: { role: "assistant", content: [], stopReason: "stop" },
	}) as unknown as SessionEntry;

describe("planErrorSurfaces", () => {
	test("gives the reason to the assistant row when both carry the same text", () => {
		// The regression: the transcript showed the 429 twice, once as an assistant
		// row and again in the retry card.
		const reason = "429 insufficient balance";
		const plan = planErrorSurfaces([errorAssistant("a1", reason), retryRow("c1", reason)]);

		expect([...plan.ownedByAssistant]).toEqual(["a1"]);
		expect([...plan.suppressedReason]).toEqual(["c1"]);
	});

	test("lets the retry row own the reason when the texts differ", () => {
		// Different text means these are two separate facts, not one written twice —
		// a retry card reporting something new must stay visible.
		const plan = planErrorSurfaces([
			errorAssistant("a1", "socket connection was closed unexpectedly"),
			retryRow("c1", "429 insufficient balance"),
		]);

		expect([...plan.suppressedReason]).toEqual([]);
	});

	test("does not let an old failure suppress a later card", () => {
		// Scanning the whole transcript would make a failure from earlier suppress
		// today's card. Two failures that both happened are two facts.
		const stale = Array.from({ length: 10 }, (_, i) => okAssistant(`s${i}`));
		const reason = "429 insufficient balance";
		const plan = planErrorSurfaces([...stale, retryRow("c1", reason)]);

		expect([...plan.suppressedReason]).toEqual([]);
	});

	test("claims an assistant row that carries a reason but no matching card", () => {
		const plan = planErrorSurfaces([errorAssistant("a1", "socket closed")]);

		expect([...plan.ownedByAssistant]).toEqual(["a1"]);
		expect([...plan.suppressedReason]).toEqual([]);
	});

	test("ignores entries without an id", () => {
		// Sessions can be mid-write; a row with no id cannot be matched, so it must
		// not be claimed or suppressed.
		const reason = "429 insufficient balance";
		const plan = planErrorSurfaces([errorAssistant("", reason), retryRow("", reason)]);

		expect([...plan.ownedByAssistant]).toEqual([]);
		expect([...plan.suppressedReason]).toEqual([]);
	});

	test("treats surrounding whitespace as the same reason", () => {
		const plan = planErrorSurfaces([
			errorAssistant("a1", "429 out of credit"),
			retryRow("c1", "  429 out of credit  "),
		]);

		expect([...plan.suppressedReason]).toEqual(["c1"]);
	});
});
