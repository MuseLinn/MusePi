import { describe, expect, test } from "bun:test";
import { validateBoards } from "../src/daemon/boards";
import { WIDGET_TYPES } from "../src/tools/widget";

const known = WIDGET_TYPES as unknown as Record<string, unknown>;

function board(widgets: unknown[]): unknown {
	return { id: "b1", title: "测试看板", widgets };
}

describe("board tool validation (validateBoards)", () => {
	test("accepts a valid board with integer pixel positions", () => {
		const r = validateBoards(
			[board([{ id: "w1", type: "clock", title: "C", data: {}, pos: { x: 0, y: 0, w: 356, h: 296 } }])],
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
		const r = validateBoards([board([{ id: "w1", type: "clock", pos: { x: 10.5, y: 0, w: 100, h: 100 } }])], known);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("integer pos");
	});

	test("rejects missing position", () => {
		const r = validateBoards([board([{ id: "w1", type: "clock" }])], known);
		expect(r.ok).toBe(false);
	});

	test("rejects boards without id/title strings", () => {
		const r = validateBoards([{ id: 42, widgets: [] }], known);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("id + title");
	});

	test("rejects oversized html widgets (>64KB)", () => {
		const r = validateBoards(
			[board([{ id: "w1", type: "html", data: { html: "x".repeat(64_001) }, pos: { x: 0, y: 0, w: 300, h: 200 } }])],
			known,
		);
		expect(r.ok).toBe(false);
	});
});
