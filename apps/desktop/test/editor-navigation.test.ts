import { describe, expect, it } from "bun:test";
import {
	canMoveEditorHistory,
	type EditorLocation,
	EMPTY_EDITOR_HISTORY,
	moveEditorHistory,
	pushEditorHistory,
	updateEditorHistoryCurrent,
} from "../src/lib/editor-navigation";

function location(path: string, lineNumber: number, column = 1): EditorLocation {
	return { path, lineNumber, column };
}

describe("editor navigation history", () => {
	it("restores the source cursor and moves forward to the definition", () => {
		const source = location("/workspace/source.ts", 2, 3);
		const target = location("/workspace/target.ts", 8, 4);
		const history = pushEditorHistory(EMPTY_EDITOR_HISTORY, source, target);

		const back = moveEditorHistory(history, "back");
		expect(back?.location).toEqual(source);
		expect(canMoveEditorHistory(back!.history, "back")).toBe(false);
		expect(canMoveEditorHistory(back!.history, "forward")).toBe(true);

		const forward = moveEditorHistory(back!.history, "forward");
		expect(forward?.location).toEqual(target);
		expect(canMoveEditorHistory(forward!.history, "forward")).toBe(false);
	});

	it("keeps the latest cursor when returning to a history entry", () => {
		const source = location("/workspace/source.ts", 2, 3);
		const target = location("/workspace/target.ts", 8, 4);
		const history = pushEditorHistory(EMPTY_EDITOR_HISTORY, source, target);
		const back = moveEditorHistory(history, "back");
		const moved = updateEditorHistoryCurrent(back!.history, location(source.path, 12, 6));

		const forward = moveEditorHistory(moved, "forward");
		expect(forward?.location).toEqual(target);
		expect(moveEditorHistory(forward!.history, "back")?.location).toEqual(location(source.path, 12, 6));
	});

	it("truncates forward entries after a new jump from a restored location", () => {
		const a = location("/workspace/a.ts", 1);
		const b = location("/workspace/b.ts", 2);
		const c = location("/workspace/c.ts", 3);
		const d = location("/workspace/d.ts", 4);
		const first = pushEditorHistory(EMPTY_EDITOR_HISTORY, a, b);
		const second = pushEditorHistory(first, b, c);
		const back = moveEditorHistory(second, "back");
		const next = pushEditorHistory(back!.history, location(b.path, 10), d);

		expect(next.entries).toEqual([a, location(b.path, 10), d]);
		expect(moveEditorHistory(next, "forward")).toBeNull();
	});

	it("records same-file definition jumps without duplicating an identical position", () => {
		const source = location("/workspace/a.ts", 2, 3);
		const target = location(source.path, 9, 5);
		const history = pushEditorHistory(EMPTY_EDITOR_HISTORY, source, target);
		expect(history.entries).toEqual([source, target]);
		expect(moveEditorHistory(history, "back")?.location).toEqual(source);
		expect(pushEditorHistory(history, target, target).entries).toEqual([source, target]);
	});

	it("returns null at empty and terminal boundaries", () => {
		expect(moveEditorHistory(EMPTY_EDITOR_HISTORY, "back")).toBeNull();
		expect(moveEditorHistory(EMPTY_EDITOR_HISTORY, "forward")).toBeNull();
		const only = pushEditorHistory(
			EMPTY_EDITOR_HISTORY,
			location("/workspace/a.ts", 1),
			location("/workspace/b.ts", 2),
		);
		expect(moveEditorHistory(only, "forward")).toBeNull();
	});
});
