import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { MessageDisplayContext } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UserMsgContent } from "./transcript-content";

afterAll(() => {
	void GlobalRegistrator.unregister();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function render(content: string, displayContext?: MessageDisplayContext): HTMLDivElement {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(<UserMsgContent content={content} plain collapse={false} displayContext={displayContext} />));
	return host;
}

function chipLabels(div: HTMLDivElement): string[] {
	return [...div.querySelectorAll(".tr-inline-ref")].map(node => node.textContent ?? "");
}

describe("user body attachment references", () => {
	it("draws a recorded image reference as a chip and hides the pointer", () => {
		const div = render("看看 [图片 1] 这张", {
			kind: "attachment-ref",
			attachmentKind: "image",
			ordinal: 1,
			name: "shot.png",
		});
		expect(chipLabels(div)).toEqual(["图片 1"]);
		expect(div.textContent).toContain("看看");
		expect(div.textContent).not.toContain("[图片 1]");
	});

	it("draws a recorded file reference by the name it was sent with", () => {
		const div = render("见 [Attachment:app.ts]", {
			kind: "attachment-ref",
			attachmentKind: "file",
			name: "app.ts",
		});
		expect(chipLabels(div)).toEqual(["app.ts"]);
		expect(div.textContent).not.toContain("[Attachment:app.ts]");
	});

	it("leaves a bracket the records do not claim as plain text", () => {
		// The reader quoted someone else's `[图片 1]`; no record describes it, so
		// it stays exactly as they typed it.
		const div = render("他写了 [图片 1] 但这不是附件", {
			kind: "attachment-ref",
			attachmentKind: "file",
			name: "unrelated.ts",
		});
		expect(chipLabels(div)).toEqual([]);
		expect(div.textContent).toContain("[图片 1]");
	});

	it("falls back to reading pointers from text when no record exists", () => {
		// Conversation history written before references were recorded.
		const div = render("看看 [图片 2] 这张");
		expect(chipLabels(div)).toEqual(["图片 2"]);
	});

	it("keeps the reference off the card row", () => {
		// A reference is not a quote card: the body owns it.
		const div = render("看看 [图片 1]", {
			kind: "attachment-ref",
			attachmentKind: "image",
			ordinal: 1,
			name: "shot.png",
		});
		expect(div.querySelector(".tr-display-context") === null).toBe(true);
	});
});
