import { describe, expect, it } from "bun:test";
import { createRootSelectionStore, resolveWorkspaceRoot, rootSelectionKey } from "../src/lib/workspace-roots";

describe("file pane root selection", () => {
	it("keeps a choice per session so switching sessions does not inherit it", () => {
		const store = createRootSelectionStore();
		const first = rootSelectionKey("s1", "/work/a");
		const second = rootSelectionKey("s2", "/work/a");

		store.set(first, "/work/shared");

		expect(store.get(first)).toBe("/work/shared");
		expect(store.get(second)).toBeNull();
		expect(resolveWorkspaceRoot("/work/a", ["/work/a", "/work/shared"], store.get(second))).toBe("/work/a");
		expect(resolveWorkspaceRoot("/work/a", ["/work/a", "/work/shared"], store.get(first))).toBe("/work/shared");
	});

	it("falls back to the primary directory when the selected root is gone", () => {
		const store = createRootSelectionStore();
		const key = rootSelectionKey(null, "/work/a");
		expect(key).toBe("cwd:/work/a");
		store.set(key, "/work/old");

		expect(resolveWorkspaceRoot("/work/a", ["/work/a"], store.get(key))).toBe("/work/a");
		expect(resolveWorkspaceRoot("/work/a", ["/work/a", "/work/new"], null)).toBe("/work/a");
	});

	it("matches a selection spelled with different separators or drive casing", () => {
		expect(resolveWorkspaceRoot("D:\\Work\\A", ["D:\\Work\\A", "D:\\Work\\B"], "d:/work/b/")).toBe("D:\\Work\\B");
	});

	it("notifies only listeners of the changed key", () => {
		const store = createRootSelectionStore();
		const events: Array<[string, string | null]> = [];
		const unsubscribe = store.subscribe((key, root) => events.push([key, root]));

		store.set(rootSelectionKey("s1", "/work/a"), "/work/b");
		store.set(rootSelectionKey("s1", "/work/a"), "/work/b");
		store.set(rootSelectionKey("s2", "/work/a"), "/work/c");
		unsubscribe();
		store.set(rootSelectionKey("s2", "/work/a"), null);

		expect(events).toEqual([
			["session:s1", "/work/b"],
			["session:s2", "/work/c"],
		]);
		expect(store.get(rootSelectionKey("s2", "/work/a"))).toBeNull();
	});
});
