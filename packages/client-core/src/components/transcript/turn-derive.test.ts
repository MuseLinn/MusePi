import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { createTurnDeriveCache, deriveTurns, deriveTurnsUncached } from "./turn-derive";

/** Minimal EntryBase fields shared by every SessionEntry. */
const base = { parentId: null, timestamp: "0" };

let seq = 0;
function withId(overrides: object): SessionEntry {
	return { ...base, id: `e${++seq}`, ...overrides } as unknown as SessionEntry;
}

const userMsg = (text = "hi"): SessionEntry =>
	withId({ type: "message", message: { role: "user", content: text, timestamp: 1 } });

const assistantText = (text = "ok"): SessionEntry =>
	withId({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } });

const assistantToolCall = (id: string, name = "read"): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], timestamp: 1 },
	});

const toolResult = (toolCallId: string, toolName = "read"): SessionEntry =>
	withId({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: "out" }],
			isError: false,
			timestamp: 1,
		},
	});

const bashExecution = (): SessionEntry =>
	withId({ type: "message", message: { role: "bashExecution", content: "ls", timestamp: 1 } });

const custom = (customType: string): SessionEntry =>
	withId({ type: "custom_message", customType, content: "x", display: true });

const advisor = (): SessionEntry =>
	withId({ type: "custom_message", customType: "advisor", content: "hint", display: true });

const modelChange = (model: string): SessionEntry => withId({ type: "model_change", model });

/** One completed round: user → tool work → reply. */
function round(): SessionEntry[] {
	return [userMsg(), assistantToolCall(`c${++seq}`), toolResult(`c${seq}`), assistantText("done")];
}

function expectParity(entries: readonly SessionEntry[], working: boolean, options?: { fallbackModel?: string }): void {
	const cached = deriveTurns(entries, working, options, createTurnDeriveCache());
	const uncached = deriveTurnsUncached(entries, working, options);
	expect(cached.folds).toEqual(uncached.folds);
	expect(cached.units).toEqual(uncached.units);
}

describe("deriveTurns parity with uncached builders", () => {
	test("empty transcript", () => {
		expectParity([], false);
		expectParity([], true);
	});

	test("single text-only round (no fold)", () => {
		expectParity([userMsg(), assistantText("hi")], false);
	});

	test("single tool round, idle and working", () => {
		const entries = [...round()];
		expectParity(entries, false);
		expectParity(entries, true);
	});

	test("multi-round session with mixed shapes", () => {
		const entries: SessionEntry[] = [
			modelChange("acme/fast"),
			userMsg("q1"),
			assistantText("a1"),
			...round(),
			// advisor-started turn (isTurnStart includes advisors)
			advisor(),
			assistantToolCall(`c${++seq}`),
			bashExecution(),
			toolResult(`c${seq}`, "bash"),
			assistantText("advisor reply"),
			modelChange("acme/slow"),
			userMsg("q2"),
			custom("hook:lint"),
			assistantText("final"),
		];
		expectParity(entries, false);
		expectParity(entries, true);
		expectParity(entries, false, { fallbackModel: "acme/fallback" });
	});

	test("pre-compaction entries + trailing compaction row", () => {
		const compaction = withId({ type: "compaction", content: "x" });
		expectParity([...round(), compaction, ...round()], false);
	});
});

describe("deriveTurns incremental caching", () => {
	test("identical inputs return the same result by reference", () => {
		const cache = createTurnDeriveCache();
		const entries = [...round(), ...round()];
		const a = deriveTurns(entries, false, undefined, cache);
		const b = deriveTurns(entries, false, undefined, cache);
		expect(a).toBe(b);
	});

	test("streaming append reuses completed-round spans (absolute shifts correct)", () => {
		const cache = createTurnDeriveCache();
		const first = round();
		const r1 = deriveTurns(first, false, undefined, cache);
		// Stream a second round in: the first round's fold must be reused
		// internally AND come out with identical absolute indexes.
		const second = [...first, ...round()];
		const r2 = deriveTurns(second, false, undefined, cache);
		expect(r2.folds.slice(0, r1.folds.length)).toEqual(r1.folds);
		expect(deriveTurnsUncached(second, false).folds).toEqual(r2.folds);
	});

	test("history prepend hits the same span cache (indexes shift, content stable)", () => {
		const cache = createTurnDeriveCache();
		const tail = [...round(), ...round()];
		deriveTurns(tail, false, undefined, cache);
		// Page in an older round ABOVE: every existing round shifts by +4
		// but its content (and span key) is unchanged.
		const prepended = [...round(), ...tail];
		const r = deriveTurns(prepended, false, undefined, cache);
		expect(r.folds).toEqual(deriveTurnsUncached(prepended, false).folds);
		expect(r.units).toEqual(deriveTurnsUncached(prepended, false).units);
	});

	test("working flag flips the in-flight fold without touching spans", () => {
		const cache = createTurnDeriveCache();
		const entries = [...round(), userMsg(), assistantToolCall(`c${++seq}`), toolResult(`c${seq}`)];
		const idle = deriveTurns(entries, false, undefined, cache);
		const working = deriveTurns(entries, true, undefined, cache);
		// The trailing round folds only when idle.
		expect(idle.folds.length).toBe(2);
		expect(working.folds.length).toBe(1);
		expect(deriveTurnsUncached(entries, true).folds).toEqual(working.folds);
	});

	test("truncated tail prunes stale span entries", () => {
		const cache = createTurnDeriveCache();
		const full = [...round(), ...round(), ...round()];
		deriveTurns(full, false, undefined, cache);
		expect(cache.spans.size).toBe(3);
		const truncated = full.slice(0, 4); // keep one round
		const r = deriveTurns(truncated, false, undefined, cache);
		expect(r.folds).toEqual(deriveTurnsUncached(truncated, false).folds);
		expect(cache.spans.size).toBe(1);
	});

	test("endpoint identity changes defeat the cache (no stale data)", () => {
		const cache = createTurnDeriveCache();
		const entries = [...round()];
		const a = deriveTurns(entries, false, undefined, cache);
		// (a) An in-place ID change alters the signature → full recompute.
		const first = entries[0] as { id: string };
		first.id = "mutated-id";
		const b = deriveTurns(entries, false, undefined, cache);
		expect(b.folds).toEqual(deriveTurnsUncached(entries, false).folds);
		expect(b).not.toBe(a);
		// (b) Replacing the tail entry object (new reference, same id/length)
		// trips the endpoint identity guard even though the signature matches.
		const replaced: SessionEntry[] = [
			...entries.slice(0, -1),
			withId({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "replaced" }], timestamp: 1 },
			}),
		];
		// Keep the id stable so only object identity differs.
		(replaced[replaced.length - 1] as { id: string }).id = (entries[entries.length - 1] as { id: string }).id;
		const d = deriveTurns(replaced, false, undefined, cache);
		expect(d).not.toBe(b);
		expect(d.units.map(u => u.replyIdx)).toEqual(deriveTurnsUncached(replaced, false).units.map(u => u.replyIdx));
	});

	test("model resolution stays correct with cached spans", () => {
		const cache = createTurnDeriveCache();
		const entries: SessionEntry[] = [modelChange("acme/fast"), ...round(), modelChange("acme/slow"), ...round()];
		const r = deriveTurns(entries, false, { fallbackModel: "acme/fb" }, cache);
		// The model_change row sits INSIDE turn 0's range (turn = up to the row
		// before the next turn start) — inclusive semantics make it apply to
		// turn 0's end (same as the uncached builder, verified by parity).
		expect(r.units.map(u => u.model)).toEqual(["slow", "slow"]);
		expect(r.units.map(u => u.model)).toEqual(
			deriveTurnsUncached(entries, false, { fallbackModel: "acme/fb" }).units.map(u => u.model),
		);
		// Append another round — model carries forward through the cache.
		const grown: SessionEntry[] = [...entries, ...round()];
		const r2 = deriveTurns(grown, false, { fallbackModel: "acme/fb" }, cache);
		expect(r2.units.map(u => u.model)).toEqual(["slow", "slow", "slow"]);
	});
});
