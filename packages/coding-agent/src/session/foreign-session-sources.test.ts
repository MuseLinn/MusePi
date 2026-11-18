import { describe, expect, it } from "bun:test";
import { FOREIGN_SESSION_SOURCE_IDS } from "./foreign-session-source-ids";
import {
	createForeignSessionStore,
	foreignSessionSourceDescriptors,
	foreignSessionSourceName,
	foreignSessionSources,
} from "./foreign-session-sources";

describe("foreign session sources", () => {
	it("lists exactly the declared ids, in order", () => {
		expect(foreignSessionSources()).toEqual([...FOREIGN_SESSION_SOURCE_IDS]);
	});

	it("names every source", () => {
		for (const source of foreignSessionSources()) {
			expect(foreignSessionSourceName(source)).not.toBe("");
			expect(foreignSessionSourceName(source)).not.toBe(source);
		}
	});

	it("builds a store for every source, each naming its own source", () => {
		for (const source of foreignSessionSources()) {
			const store = createForeignSessionStore(source);
			expect(store.source).toBe(source);
			store.close?.();
		}
	});

	it("rejects a source it does not declare", () => {
		expect(() => createForeignSessionStore("nonesuch" as never)).toThrow();
	});

	it("declares one descriptor per source", () => {
		expect(foreignSessionSourceDescriptors().map(d => d.source)).toEqual([...FOREIGN_SESSION_SOURCE_IDS]);
		expect(new Set(foreignSessionSourceDescriptors().map(d => d.source)).size).toBe(
			foreignSessionSourceDescriptors().length,
		);
	});
});
