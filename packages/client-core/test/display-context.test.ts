import { describe, expect, it } from "bun:test";
import type { AnnotationPayload } from "../src/annotation/contract";
import { formatAnnotationPrompt } from "../src/annotation/prompt";
import {
	browserAnnotationTargetCount,
	composeDisplayContextPrompt,
	createBrowserAnnotationContext,
	createChatQuoteContext,
	createFileQuoteContext,
	isDisplayContext,
	messageDisplayContext,
	textWithoutDisplayContext,
	withDisplayContextComment,
} from "../src/messages/display-context";

const payload: AnnotationPayload = {
	id: "annotation-1",
	pageUrl: "https://example.com/docs",
	pageTitle: "Docs",
	viewport: { width: 1200, height: 800 },
	devicePixelRatio: 1,
	comment: "old comment",
	elements: [
		{
			id: "element-1",
			element: {
				tag: "button",
				text: "Save",
				selector: "#save",
				path: "main > button#save",
				bounds: { x: 1, y: 2, width: 30, height: 40 },
				center: { x: 16, y: 22 },
				attributes: {},
				computedStyle: {},
				ancestry: [],
			},
		},
	],
	regions: [{ id: "region-1", rect: { x: 3, y: 4, width: 50, height: 60 } }],
	strokes: [],
};

describe("DisplayContext contract", () => {
	it("round-trips both variants through JSON without accepting malformed values", () => {
		const contexts = [
			createBrowserAnnotationContext({ payload, prompt: "annotation prompt" }),
			createChatQuoteContext({ messageId: "assistant-1", quote: "quoted answer", comment: "why?" }),
		];
		for (const context of contexts) expect(isDisplayContext(JSON.parse(JSON.stringify(context)))).toBe(true);
		expect(isDisplayContext({ kind: "chat-quote", quote: 42 })).toBe(false);
		expect(isDisplayContext({ kind: "ordinary-blockquote", quote: "not a context" })).toBe(false);
	});

	it("keeps the legacy annotation prompt byte-for-byte and counts its targets", () => {
		const prompt = formatAnnotationPrompt({ payload, screenshotAttached: true, intro: "Browser annotation" });
		const context = createBrowserAnnotationContext({ payload, prompt });
		expect(context.prompt).toBe(prompt);
		expect(context.pageUrl).toBe("https://example.com/docs");
		expect(context.comment).toBe("old comment");
		expect(browserAnnotationTargetCount(context)).toBe(2);
	});

	it("generates quote and annotation model text from the same contexts used for display", () => {
		const quote = createChatQuoteContext({ quote: "first\nsecond", comment: "why" });
		const annotation = createBrowserAnnotationContext({ payload, prompt: "Intro:\nPage: Docs" });
		expect(composeDisplayContextPrompt([quote], "fix it")).toBe("> first\n> second\n\nwhy\n\nfix it");
		expect(composeDisplayContextPrompt([annotation], "fix it")).toBe("fix it\n\nIntro:\nPage: Docs");
	});

	it("derives file selection and whole-file model text from the same context shown in the UI", () => {
		const selection = createFileQuoteContext({
			path: "src/example.ts",
			quote: "const answer = 42;",
			language: "ts",
			startLine: 2,
			endLine: 2,
			comment: "rename this",
		});
		const prompt = composeDisplayContextPrompt([selection], "fix it");
		expect(prompt).toBe(
			"Comment on this fragment of `src/example.ts` lines 2-2:\n> const answer = 42;\n\nrename this\n\nfix it",
		);
		expect(textWithoutDisplayContext(prompt, selection)).toBe("fix it");
		expect(
			composeDisplayContextPrompt([createFileQuoteContext({ path: "docs/guide.md", quote: "" })], "review"),
		).toBe("Workspace file reference: `docs/guide.md`\n\nreview");
	});

	it("updates browser comments in both the context and its model prompt", () => {
		const context = createBrowserAnnotationContext({
			payload,
			prompt: "Intro:\nPage: Docs\nComment: old comment\n\nElement 1: button",
		});
		const updated = withDisplayContextComment(context, "new comment");
		expect(updated.comment).toBe("new comment");
		expect(updated.prompt).toBe("Intro:\nPage: Docs\nComment: new comment\n\nElement 1: button");
	});

	it("preserves one context as an object and multiple contexts as an array", () => {
		const first = createChatQuoteContext({ quote: "one" });
		const second = createChatQuoteContext({ quote: "two" });
		expect(messageDisplayContext([first])).toBe(first);
		expect(messageDisplayContext([first, second])).toEqual([first, second]);
		expect(messageDisplayContext([])).toBeUndefined();
	});

	it("removes only context-owned prompt text from the visible remainder", () => {
		const quote = createChatQuoteContext({ quote: "quoted", comment: "note" });
		expect(textWithoutDisplayContext("> quoted\n\nnote\n\nordinary body", quote)).toBe("ordinary body");
		expect(textWithoutDisplayContext("> an ordinary blockquote", undefined)).toBe("> an ordinary blockquote");
	});
});
