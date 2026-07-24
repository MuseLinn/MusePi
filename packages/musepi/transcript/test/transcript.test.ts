// MusePi transcript tests — model mapping, idempotent replay, store sync.
import assert from "node:assert";
import { describe, it } from "node:test";
import { replayEntries, TranscriptStore } from "../src/index.ts";

let idCounter = 0;
function entry(type: string, extra: Record<string, unknown> = {}): any {
	idCounter++;
	return { type, id: `e${idCounter}`, timestamp: new Date(1784000000000 + idCounter * 1000).toISOString(), ...extra };
}
function msg(role: string, content: any[]): any {
	return entry("message", { message: { role, content } });
}
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t });
const toolCall = (name: string, id: string) => ({ type: "toolCall", name, id });

describe("transcript replay", () => {
	it("groups entries into turns at user messages", () => {
		const t = replayEntries([
			msg("user", [text("hello")]),
			msg("assistant", [thinking("hmm"), text("hi")]),
			msg("user", [text("next")]),
			msg("assistant", [text("answer")]),
		]);
		assert.strictEqual(t.turns.length, 2);
		assert.strictEqual(t.turns[0].interactions[0].kind, "user");
		assert.strictEqual(t.turns[0].interactions.length, 3); // user + thinking + assistant
		assert.strictEqual(t.turns[1].interactions[0].text, "next");
	});

	it("maps tool calls and results with errors", () => {
		const t = replayEntries([
			msg("user", [text("run it")]),
			msg("assistant", [toolCall("bash", "tc1")]),
			entry("message", { message: { role: "toolResult", toolName: "bash", toolCallId: "tc1", isError: true, content: [text("boom")] } }),
		]);
		const turn = t.turns[0];
		assert.strictEqual(turn.interactions[1].kind, "tool_call");
		assert.strictEqual(turn.interactions[1].toolName, "bash");
		assert.strictEqual(turn.interactions[2].kind, "tool_result");
		assert.strictEqual(turn.interactions[2].isError, true);
	});

	it("maps meta entries and hidden custom messages, skips state entries", () => {
		const t = replayEntries([
			msg("user", [text("x")]),
			entry("custom_message", { customType: "plugin", display: false, content: "ctx" }),
			entry("compaction", { summary: "s", firstKeptEntryId: "e1" }),
			entry("custom", { customType: "muselinn_goal", data: {} }),
		]);
		assert.strictEqual(t.turns[0].interactions[1].kind, "custom");
		assert.strictEqual(t.turns[0].interactions[1].display, false);
		assert.strictEqual(t.turns[0].interactions[2].kind, "meta");
		assert.strictEqual(t.turns[0].interactions[2].metaType, "compaction");
		assert.strictEqual(t.turns[0].interactions.length, 3); // custom state entry skipped
	});

	it("is idempotent under double replay via applyEntry", async () => {
		const { applyEntry } = await import("../src/ops.ts");
		const { emptyTranscript } = await import("../src/model.ts");
		const entries = [msg("user", [text("a")]), msg("assistant", [text("b")])];
		const t1 = replayEntries(entries);
		const t2 = emptyTranscript();
		for (const e of entries) { applyEntry(t2, e); applyEntry(t2, e); }
		assert.strictEqual(t2.turns.length, t1.turns.length);
		assert.strictEqual(t2.turns[0].interactions.length, t1.turns[0].interactions.length);
	});
});

describe("TranscriptStore", () => {
	it("rebuild + sync only adds new entries, aggregates per turn", () => {
		const store = new TranscriptStore();
		const base = [
			msg("user", [text("q1")]),
			msg("assistant", [toolCall("read", "r1"), text("a1")]),
			entry("message", { message: { role: "toolResult", toolName: "read", toolCallId: "r1", isError: false, content: [text("ok")] } }),
		];
		store.rebuild(base);
		assert.strictEqual(store.turns.length, 1);
		assert.strictEqual(store.turns[0].toolCalls, 1);
		assert.strictEqual(store.turns[0].hasError, false);

		const added = store.sync([...base, msg("user", [text("q2")])]);
		assert.strictEqual(added, 1);
		assert.strictEqual(store.turns.length, 2);
		const stats = store.stats();
		assert.strictEqual(stats.toolCalls, 1);
		assert.strictEqual(stats.errorTurns, 0);
	});

	it("pages newest-first with a turn cursor", () => {
		const store = new TranscriptStore();
		const entries = [];
		for (let i = 0; i < 7; i++) {
			entries.push(msg("user", [text(`q${i}`)]), msg("assistant", [text(`a${i}`)]));
		}
		store.rebuild(entries);
		const p1 = store.page({ limit: 3 });
		assert.strictEqual(p1.turns.length, 3);
		assert.strictEqual(p1.turns[2].interactions[0].text, "q6");
		assert.strictEqual(p1.nextBefore, 4);
		const p2 = store.page({ beforeTurn: p1.nextBefore, limit: 3 });
		assert.strictEqual(p2.turns[0].interactions[0].text, "q1");
		assert.strictEqual(p2.nextBefore, 1);
		const p3 = store.page({ beforeTurn: p2.nextBefore, limit: 3 });
		assert.strictEqual(p3.nextBefore, undefined);
	});
});
