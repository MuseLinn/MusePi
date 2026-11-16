import { describe, expect, test } from "bun:test";
import { readWidgetFaceMessage } from "./html";

/**
 * The face protocol is the security boundary: only the card's own frame can
 * speak, and the only shape it may ask for is its own workspace.
 */

const frame = {} as MessageEventSource;

describe("widget face resource requests", () => {
	test("a read request carries the id and path", () => {
		const msg = readWidgetFaceMessage(frame, frame, {
			type: "musepi-widget-resource",
			id: 7,
			op: "read",
			path: "data.csv",
		});
		expect(msg).toEqual({ kind: "resource", id: 7, op: "read", path: "data.csv" });
	});

	test("a list request needs no path", () => {
		const msg = readWidgetFaceMessage(frame, frame, { type: "musepi-widget-resource", id: 2, op: "list" });
		expect(msg).toEqual({ kind: "resource", id: 2, op: "list", path: "" });
	});

	test("another frame cannot ask", () => {
		const other = {} as MessageEventSource;
		expect(readWidgetFaceMessage(other, frame, { type: "musepi-widget-resource", id: 1, op: "list" })).toBeNull();
	});

	test("a malformed request is ignored rather than guessed at", () => {
		for (const raw of [
			{ type: "musepi-widget-resource", op: "list" },
			{ type: "musepi-widget-resource", id: 1 },
			{ type: "musepi-widget-resource", id: 1, op: "read" },
			{ type: "musepi-widget-resource", id: "1", op: "list" },
		]) {
			expect(readWidgetFaceMessage(frame, frame, raw)).toBeNull();
		}
	});
});

describe("widget face selection", () => {
	test("a selection is reported so the host can quote it", () => {
		const msg = readWidgetFaceMessage(frame, frame, { type: "musepi-widget-selection", text: "  选中这一句  " });
		expect(msg).toEqual({ kind: "selection", text: "选中这一句" });
	});

	test("an empty selection reports nothing, which clears the affordance", () => {
		expect(readWidgetFaceMessage(frame, frame, { type: "musepi-widget-selection", text: "   " })).toBeNull();
	});

	test("another frame cannot quote on the card's behalf", () => {
		expect(
			readWidgetFaceMessage({} as MessageEventSource, frame, { type: "musepi-widget-selection", text: "x" }),
		).toBeNull();
	});
});
