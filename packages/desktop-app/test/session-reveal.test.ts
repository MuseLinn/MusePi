import { describe, expect, it } from "bun:test";
import type { SessionListNode } from "../src/components/SessionList";
import { sessionAncestorIds } from "../src/components/session-list-shared";

function node(id: string, children: SessionListNode[] = []): SessionListNode {
	const timestamp = new Date(0).toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, label: id }, children };
}

describe("session selection reveal", () => {
	it("returns every collapsed ancestor that hides the selected session", () => {
		const tree = [node("root", [node("fork", [node("child")]), node("sibling")])];

		expect(sessionAncestorIds(tree, "child")).toEqual(["root", "fork"]);
		expect(sessionAncestorIds(tree, "sibling")).toEqual(["root"]);
		expect(sessionAncestorIds(tree, "root")).toEqual([]);
	});

	it("does not reveal unrelated or stale session ids", () => {
		const tree = [node("root", [node("child")]), node("other")];

		expect(sessionAncestorIds(tree, "missing")).toBeNull();
		expect(sessionAncestorIds(tree, "other")).toEqual([]);
	});
});
