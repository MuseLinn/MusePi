import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionEntry } from "@musepi/pi-wire";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

const { entryViewKey } = await import("@musepi/client-core/src/components/transcript/Transcript");

function userEntry(id: string, requestIdentity?: string): SessionEntry {
	const message: Record<string, unknown> = { role: "user", timestamp: 1, content: [{ type: "text", text: id }] };
	if (requestIdentity) message.requestIdentity = requestIdentity;
	return { type: "message", id, parentId: null, timestamp: "1970-01-01T00:00:00.000Z", message } as SessionEntry;
}

describe("entryViewKey", () => {
	test("the optimistic row and the acknowledged row share one key", () => {
		const identity = "msg:client:req-1";
		expect(entryViewKey(userEntry("user:optimistic-1", identity), 3)).toBe(identity);
		// The daemon's entry has a different id and timestamp; the key does not move.
		expect(entryViewKey(userEntry("user:1750000000", identity), 3)).toBe(identity);
		expect(entryViewKey(userEntry("user:1750000001", identity), 4)).toBe(identity);
	});

	test("a user row without an identity falls back to its entry id", () => {
		expect(entryViewKey(userEntry("user:1"), 0)).toBe("user:1");
		expect(entryViewKey(userEntry("user:1", ""), 0)).toBe("user:1");
	});

	test("non-user rows keep entry ids, and a missing id keys by position", () => {
		const assistant = {
			type: "message",
			id: "assistant:2",
			parentId: null,
			timestamp: "1970-01-01T00:00:00.000Z",
			message: { role: "assistant", timestamp: 1, content: [], model: "p/m" },
		} as unknown as SessionEntry;
		expect(entryViewKey(assistant, 2)).toBe("assistant:2");
		const bare = { ...assistant, id: undefined } as unknown as SessionEntry;
		expect(entryViewKey(bare, 7)).toBe("pos:7");
	});
});
