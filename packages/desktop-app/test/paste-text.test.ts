import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { insertPastedPlainText } from "../src/components/composer/paste-text";

describe("insertPastedPlainText", () => {
	it("inserts at the caret, moves the caret and notifies the controlled input", () => {
		const el = document.createElement("textarea");
		el.value = "hello world";
		el.selectionStart = 5;
		el.selectionEnd = 5;
		let inputEvents = 0;
		el.addEventListener("input", () => {
			inputEvents += 1;
		});

		insertPastedPlainText(el, " big");

		expect(el.value).toBe("hello big world");
		expect(el.selectionStart).toBe(9);
		expect(inputEvents).toBe(1);
	});

	it("replaces the selected range like a native paste", () => {
		const el = document.createElement("textarea");
		el.value = "keep this";
		el.selectionStart = 0;
		el.selectionEnd = 4;

		insertPastedPlainText(el, "drop");

		expect(el.value).toBe("drop this");
	});

	it("is a no-op for empty text or a missing textarea", () => {
		const el = document.createElement("textarea");
		el.value = "unchanged";
		insertPastedPlainText(el, "");
		expect(el.value).toBe("unchanged");
		expect(() => insertPastedPlainText(null, "x")).not.toThrow();
	});
});
