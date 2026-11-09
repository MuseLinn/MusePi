import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../src/i18n";
import { browserRenderer } from "../src/tool-render/tools/browser";
import type { ToolResultLike } from "../src/tool-render/types";

setLocale("en-US");
const Body = browserRenderer.Body!;

function render(action: string, details: Record<string, unknown>): string {
	const result: ToolResultLike = { content: [], details: { action, ...details } };
	return renderToStaticMarkup(
		createElement(Body, {
			name: "browser",
			args: { action },
			result,
		}),
	);
}

describe("browser dialog and control cards", () => {
	it("shows a pending prompt with its message and default value", () => {
		const html = render("dialog", {
			pendingDialogs: [
				{
					dialogId: "PAGE1:1",
					tabId: "PAGE1",
					kind: "prompt",
					message: "Your name?",
					defaultValue: "MusePi",
					ageMs: 25,
				},
			],
			handledDialogs: [],
		});
		expect(html).toContain("Pending dialog");
		expect(html).toContain("Your name?");
		expect(html).toContain("MusePi");
		expect(html).toContain("prompt");
	});

	it("shows the actor, outcome and answer for a handled dialog", () => {
		const html = render("dialog_respond", {
			pendingDialogs: [],
			handledDialogs: [
				{
					dialogId: "PAGE1:1",
					tabId: "PAGE1",
					kind: "prompt",
					message: "Your name?",
					outcome: "accepted",
					answerer: "agent",
					text: "MusePi Agent",
				},
			],
		});
		expect(html).toContain("Handled dialog");
		expect(html).toContain("Accepted");
		expect(html).toContain("Agent");
		expect(html).toContain("MusePi Agent");
	});

	it("keeps the current action receipt visible after an earlier dialog", () => {
		const html = render("click", {
			actionReceipt: { action: "click", status: "completed", target: "e7" },
			pendingDialogs: [],
			handledDialogs: [
				{
					dialogId: "PAGE1:1",
					tabId: "PAGE1",
					kind: "alert",
					message: "Earlier",
					outcome: "accepted",
					answerer: "agent",
				},
			],
		});
		expect(html).toContain("Action receipt");
		expect(html).toContain("e7");
		expect(html).not.toContain("Handled dialog");
	});

	it("distinguishes releasing control from closing the page", () => {
		const html = render("release", {
			control: { action: "release", activeTabId: "PAGE1", released: true },
		});
		expect(html).toContain("Control");
		expect(html).toContain("Page remains open");
		expect(html).not.toContain("Closed tab");
	});
});
