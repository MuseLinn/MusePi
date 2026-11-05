import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionEntry } from "@musepi/pi-wire";

GlobalRegistrator.register();

const { captureQuoteAnchor, collectQuoteMarks, findQuoteRoot, locateQuote, resolveQuoteAnchor } = await import(
	"../src/components/transcript/quote-anchor"
);

afterAll(() => {
	void GlobalRegistrator.unregister();
});

function mountMessage(entryId: string, bodyHtml: string): HTMLElement {
	document.body.innerHTML = `
		<div class="tr-root">
			<div data-entry-id="${entryId}">
				<div class="tr-row"><div class="tr-body"><div class="tr-md">${bodyHtml}</div></div></div>
			</div>
		</div>`;
	const root = findQuoteRoot(document, entryId);
	if (!root) throw new Error("fixture row did not mount");
	return root;
}

function rangeOver(root: Element, start: number, end: number): Range {
	const text = root.textContent ?? "";
	const walker = document.createTreeWalker(root, 4);
	const range = document.createRange();
	let offset = 0;
	let startSet = false;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const length = node.data.length;
		if (!startSet && start <= offset + length) {
			range.setStart(node, start - offset);
			startSet = true;
		}
		if (startSet && end <= offset + length) {
			range.setEnd(node, end - offset);
			return range;
		}
		offset += length;
	}
	throw new Error(`range ${start}-${end} is outside ${JSON.stringify(text)}`);
}

describe("chat quote anchors", () => {
	it("re-finds the selected fragment after the message DOM renders again", () => {
		const first = mountMessage("entry-1", "<p>Alpha beta gamma delta.</p>");
		const anchor = captureQuoteAnchor(first, rangeOver(first, 6, 16));
		expect(anchor).not.toBeNull();
		expect(anchor?.text).toBe("beta gamma");
		expect(anchor?.start).toBe(6);

		// A re-render replaces the nodes; the anchor must not depend on them.
		const again = mountMessage("entry-1", "<p>Alpha beta gamma delta.</p>");
		const range = resolveQuoteAnchor(again, anchor!);
		expect(range?.toString()).toBe("beta gamma");
	});

	it("disambiguates a repeated fragment by its surrounding characters", () => {
		const root = mountMessage("entry-2", "<p>one two one two one</p>");
		const stream = root.textContent ?? "";
		const second = stream.indexOf("one", 4);

		const anchor = captureQuoteAnchor(root, rangeOver(root, second, second + 3));
		expect(locateQuote(stream, anchor!)).toBe(second);

		// Same fragment without context (a quote persisted before anchors
		// existed) is ambiguous and must not highlight a guess.
		expect(locateQuote(stream, { text: "one" })).toBeNull();
		// Context that no longer matches resolves to nothing.
		expect(locateQuote(stream, { text: "one", prefix: "zzz", suffix: "zzz" })).toBeNull();
	});

	it("returns no range once the quoted text is gone", () => {
		const root = mountMessage("entry-3", "<p>rewritten message</p>");
		expect(resolveQuoteAnchor(root, { text: "old fragment", prefix: "", suffix: "", start: 0 })).toBeNull();
	});

	it("collects only anchored chat quotes carried by user messages", () => {
		const entries = [
			{
				type: "message",
				id: "assistant-1",
				timestamp: 1,
				message: {
					role: "assistant",
					content: [],
					displayContext: { kind: "chat-quote", messageId: "src-1", quote: "x", anchor: { text: "x" } },
				},
			},
			{
				type: "message",
				id: "user-1",
				timestamp: 2,
				message: {
					role: "user",
					content: "q",
					displayContext: [
						{ kind: "chat-quote", messageId: "src-1", quote: "plain quote" },
						{ kind: "chat-quote", messageId: "src-2", quote: "anchored", anchor: { text: "anchored" } },
						{ kind: "file-quote", path: "a.ts", quote: "file fragment" },
					],
				},
			},
		] as unknown as SessionEntry[];
		expect(collectQuoteMarks(entries)).toEqual([{ entryId: "src-2", anchor: { text: "anchored" } }]);
	});
});
