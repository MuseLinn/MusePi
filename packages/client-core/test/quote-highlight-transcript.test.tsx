import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionEntry } from "@musepi/pi-wire";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Transcript } from "../src/components/transcript/Transcript";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** happy-dom has no CSS Custom Highlight API; the stub keeps the layer's paint
 *  contract observable. `CSS` is replaced wholesale because its global getter
 *  hands out a fresh object per access. */
class HighlightStub {
	readonly ranges: Range[];
	priority = 0;
	constructor(...ranges: Range[]) {
		this.ranges = ranges;
	}
}
const registry = new Map<string, HighlightStub>();
Object.defineProperty(globalThis, "Highlight", { configurable: true, value: HighlightStub });
const cssStub = Object.create(CSS) as typeof CSS & { highlights: Map<string, HighlightStub> };
Object.defineProperty(cssStub, "highlights", { value: registry });
Object.defineProperty(globalThis, "CSS", { configurable: true, value: cssStub });

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	registry.clear();
	document.body.innerHTML = "";
});

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const SOURCE_TEXT = "Source: quoted fragment ends here.";
const ANCHOR = { text: "quoted fragment", prefix: "Source: ", suffix: " ends here.", start: 8 };

function sourceEntry(): SessionEntry {
	return {
		type: "message",
		id: "src-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: { role: "user", content: SOURCE_TEXT, timestamp: 1 },
	};
}

function quotingEntry(): SessionEntry {
	return {
		type: "message",
		id: "quote-1",
		parentId: "src-1",
		timestamp: "2026-07-09T00:00:01Z",
		message: {
			role: "user",
			content: "why?",
			timestamp: 2,
			displayContext: { kind: "chat-quote", messageId: "src-1", quote: "quoted fragment", anchor: ANCHOR },
		},
	};
}

async function mountTranscript(onJumpToMessage?: (messageId: string) => void): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	const element: ReactNode = createElement(Transcript, {
		entries: [sourceEntry(), quotingEntry()],
		stream: null,
		streamDone: true,
		activeTools: new Map(),
		working: false,
		...(onJumpToMessage ? { onJumpToMessage } : {}),
	});
	await act(async () => root.render(element));
	return host;
}

describe("anchored chat quotes in the transcript", () => {
	it("marks the quoted fragment inside its source message", async () => {
		const host = await mountTranscript();
		const painted = registry.get("musepi-quote");
		expect(painted?.ranges.map(range => range.toString())).toEqual(["quoted fragment"]);
		expect(host.querySelector('[data-entry-id="src-1"] .tr-body')?.textContent?.trim()).toBe(SOURCE_TEXT);
	});

	it("jumps to the source message and flashes the fragment when the quote card is clicked", async () => {
		const jumps: string[] = [];
		const host = await mountTranscript(messageId => jumps.push(messageId));
		const sourceButton = host.querySelector<HTMLButtonElement>(
			'[data-entry-id="quote-1"] .tr-display-context-source',
		);
		expect(sourceButton).not.toBeNull();
		await act(async () => sourceButton!.click());

		expect(jumps).toEqual(["src-1"]);
		const flashed = registry.get("musepi-quote-focus");
		expect(flashed?.ranges.map(range => range.toString())).toEqual(["quoted fragment"]);
	});
});
