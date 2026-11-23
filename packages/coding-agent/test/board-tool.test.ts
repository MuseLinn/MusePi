import { describe, expect, test } from "bun:test";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
import { WIDGET_TYPES } from "../src/plugins/media/board/catalog";
import { validateBoards } from "../src/plugins/media/board/store";

const known = WIDGET_TYPES as unknown as Record<string, unknown>;

function board(widgets: unknown[]): unknown {
	return { id: "b1", title: "测试看板", widgets };
}

describe("board tool validation (validateBoards)", () => {
	test("accepts a valid board with integer pixel positions", () => {
		const r = validateBoards(
			[
				board([
					{
						id: "w1",
						type: "block",
						title: "C",
						data: { source: 'root = Stack([Text("hi")])' },
						pos: { x: 0, y: 0, w: 356, h: 296 },
					},
				]),
			],
			known,
		);
		expect(r.ok).toBe(true);
	});

	test("rejects unknown widget types", () => {
		const r = validateBoards([board([{ id: "w1", type: "no-such-widget", pos: { x: 0, y: 0, w: 1, h: 1 } }])], known);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("unknown widget type");
	});

	test("rejects non-integer positions", () => {
		const r = validateBoards(
			[
				board([
					{
						id: "w1",
						type: "block",
						data: { source: "root = Stack([])" },
						pos: { x: 10.5, y: 0, w: 100, h: 100 },
					},
				]),
			],
			known,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("integer pos");
	});

	test("rejects missing position", () => {
		const r = validateBoards([board([{ id: "w1", type: "block", data: { source: "root = Stack([])" } }])], known);
		expect(r.ok).toBe(false);
	});

	test("rejects boards without id/title strings", () => {
		const r = validateBoards([{ id: 42, widgets: [] }], known);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("id + title");
	});

	test(`rejects oversized html widgets (>${MAX_WIDGET_HTML} chars)`, () => {
		const r = validateBoards(
			[
				board([
					{
						id: "w1",
						type: "html",
						data: { html: "x".repeat(MAX_WIDGET_HTML + 1) },
						pos: { x: 0, y: 0, w: 300, h: 200 },
					},
				]),
			],
			known,
		);
		expect(r.ok).toBe(false);
	});
});

describe("board refuses a block it cannot draw", () => {
	const at = (source: string) => ({
		id: "w1",
		type: "block",
		title: "x",
		data: { source },
		pos: { x: 0, y: 0, w: 320, h: 200 },
	});

	test("a source without a root Stack is refused at the save", () => {
		const r = validateBoards([board([at('Card("x", [Text("y")])')])], known);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("root = Stack");
	});

	test("a root Stack saves", () => {
		expect(validateBoards([board([at('root = Stack([Card("x", [Text("y")])])')])], known).ok).toBe(true);
	});
});
