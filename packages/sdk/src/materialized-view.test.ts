import { describe, expect, test } from "bun:test";
import { MaterializedView } from "./materialized-view";
import type { AgentEvent, SessionEntry } from "@musepi/pi-wire";

function userMsg(ts: number, text = `m${ts}`): AgentEvent {
	return {
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
	};
}

function oldEntries(ids: string[], baseTs = 1): SessionEntry[] {
	return ids.map((id, i) => ({
		type: "message" as const,
		id,
		parentId: null,
		timestamp: new Date(baseTs + i).toISOString(),
		message: { role: "user" as const, content: id, timestamp: baseTs + i },
	}));
}

describe("MaterializedView lazy backfill", () => {
	test("prependEntries inserts older entries at the head, newest-first preserved", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		for (let i = 1; i <= 5; i++) view.apply(userMsg(1000 + i)); // m1..m5

		view.prependEntries(oldEntries(["old-3", "old-2", "old-1"], 1));

		const entries = view.snapshot().entries;
		expect(entries.length).toBe(8);
		expect(entries.map(e => (e.type === "message" ? e.id : "")).join(",")).toBe(
			"old-3,old-2,old-1,user:1001,user:1002,user:1003,user:1004,user:1005",
		);
	});

	test("prepended messages are upsertable by the stream (re-keyed)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		for (let i = 1; i <= 3; i++) view.apply(userMsg(1000 + i));
		view.prependEntries(oldEntries(["old-1"], 1));

		// A streamed update to the prepended message replaces it in place
		// (new object reference, same position) — the row re-renders.
		const update: AgentEvent = {
			type: "message_update",
			message: { role: "user", content: "updated", timestamp: 1 },
		};
		view.apply(update);

		const entries = view.snapshot().entries;
		expect(entries.length).toBe(4); // no duplicate
		const first = entries[0];
		expect(first.type).toBe("message");
		if (first.type === "message") {
			expect(first.message.content).toBe("updated");
		}
	});

	test("empty prepend is a no-op", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(1));
		view.prependEntries([], 0);
		expect(view.snapshot().entries.length).toBe(1);
	});
});
