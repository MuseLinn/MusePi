import { beforeEach, describe, expect, test } from "bun:test";
import { draftKey, NEW_SESSION_SLOT, readDraft, writeDraft } from "./drafts";

/**
 * Draft storage: keyed per connection + session so a half-typed prompt cannot
 * follow the user into another conversation, and persisted so an Android
 * process kill does not throw it away.
 */

class MemoryStorage {
	#map = new Map<string, string>();
	getItem(key: string): string | null {
		return this.#map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.#map.set(key, value);
	}
	removeItem(key: string): void {
		this.#map.delete(key);
	}
	get size(): number {
		return this.#map.size;
	}
}

beforeEach(() => {
	const storage = new MemoryStorage();
	(globalThis as { localStorage?: unknown }).localStorage = storage;
});

describe("draftKey", () => {
	test("the new-session slot is distinct from every focused session", () => {
		expect(draftKey("ws://a", null)).not.toBe(draftKey("ws://a", "s1"));
		expect(draftKey("ws://a", null)).toContain(NEW_SESSION_SLOT);
	});

	test("the same session on two connections keeps two drafts", () => {
		expect(draftKey("ws://a", "s1")).not.toBe(draftKey("ws://b", "s1"));
	});

	test("the same session id on the same connection is stable", () => {
		expect(draftKey("ws://a", "s1")).toBe(draftKey("ws://a", "s1"));
	});
});

describe("read/writeDraft", () => {
	test("round-trips text", () => {
		const key = draftKey("ws://a", "s1");
		writeDraft(key, "half-typed prompt");
		expect(readDraft(key)).toBe("half-typed prompt");
	});

	test("writing empty text removes the key instead of storing ''", () => {
		const key = draftKey("ws://a", "s1");
		writeDraft(key, "text");
		writeDraft(key, "");
		expect(readDraft(key)).toBe("");
		expect((globalThis as unknown as { localStorage: MemoryStorage }).localStorage.size).toBe(0);
	});

	test("drafts are capped so a stray paste cannot bloat storage", () => {
		const key = draftKey("ws://a", "s1");
		writeDraft(key, "x".repeat(50_000));
		expect(readDraft(key).length).toBe(20_000);
	});

	test("a missing draft reads as empty, never as undefined", () => {
		expect(readDraft(draftKey("ws://a", "never-written"))).toBe("");
	});

	test("storage failures degrade to an in-memory composer, not a throw", () => {
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem() {
				throw new Error("denied");
			},
			setItem() {
				throw new Error("quota");
			},
			removeItem() {
				throw new Error("denied");
			},
		};
		expect(() => writeDraft(draftKey("ws://a", "s1"), "text")).not.toThrow();
		expect(readDraft(draftKey("ws://a", "s1"))).toBe("");
	});
});
