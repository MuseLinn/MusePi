import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { captureSelectionContext } from "../src/lib/selection-capture";

afterEach(() => {
	document.body.innerHTML = "";
});

describe("file selection capture", () => {
	it("keeps file path, language, and unique source line range with the selected text", () => {
		const host = document.createElement("div");
		host.dataset.filePath = "src/example.ts";
		host.dataset.fileLanguage = "ts";
		const textarea = document.createElement("textarea");
		textarea.value = "first\nconst answer = 42;\nlast";
		host.appendChild(textarea);
		document.body.appendChild(host);
		textarea.focus();
		textarea.selectionStart = 6;
		textarea.selectionEnd = 24;

		expect(captureSelectionContext()).toEqual({
			text: "const answer = 42;",
			file: { path: "src/example.ts", language: "ts", startLine: 2, endLine: 2 },
		});
		expect(textarea.selectionStart).toBe(textarea.selectionEnd);
	});

	it("leaves selections outside file previews as ordinary chat quotes", () => {
		const textarea = document.createElement("textarea");
		textarea.value = "ordinary selection";
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.selectionStart = 0;
		textarea.selectionEnd = 8;
		expect(captureSelectionContext()).toEqual({ text: "ordinary" });
	});
});
