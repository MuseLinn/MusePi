import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CustomMessageEntry, MessageEntry, SessionEntry } from "@musepi/pi-wire";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { pickStickyUserEntry, StickyUserMessage, visibleEntryRange } = await import(
	"../src/components/transcript/sticky-user-message"
);

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const TS = "2026-01-01T00:00:00.000Z";

function user(id: string, text: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistant(id: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			model: "test/model",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		},
	};
}

function advisor(id: string): CustomMessageEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: TS,
		customType: "advisor",
		content: "note",
		display: true,
	};
}

const roots: Root[] = [];

function render(node: ReactNode): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return host;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("visibleEntryRange", () => {
	test("drops overscan rows that do not intersect the viewport", () => {
		const rows = [
			{ index: 0, start: 0, end: 50 },
			{ index: 1, start: 50, end: 150 },
			{ index: 2, start: 150, end: 260 },
		];
		expect(visibleEntryRange(rows, 100, 100)).toEqual({ first: 1, last: 2 });
	});

	test("reports no window when every mounted row sits outside the viewport", () => {
		expect(visibleEntryRange([{ index: 0, start: 0, end: 50 }], 100, 100)).toBeNull();
		expect(visibleEntryRange([], 0, 100)).toBeNull();
		expect(visibleEntryRange([{ index: 0, start: 0, end: 50 }], 0, 0)).toBeNull();
	});

	test("skips collapsed zero-height slots", () => {
		const rows = [
			{ index: 0, start: 0, end: 0 },
			{ index: 1, start: 0, end: 40 },
		];
		expect(visibleEntryRange(rows, 0, 40)).toEqual({ first: 1, last: 1 });
	});
});

describe("pickStickyUserEntry", () => {
	test("has no candidate at the top of the transcript or above the first prompt", () => {
		const entries = [assistant("a0"), user("u1", "hello")];
		// Scrolled to the very top: the first turn starts on the first visible row.
		expect(pickStickyUserEntry(entries, { first: 0, last: 1 })).toBeNull();
		expect(pickStickyUserEntry([], { first: 0, last: 0 })).toBeNull();
	});

	test("hides while the prompt row itself is visible", () => {
		const entries = [assistant("a0"), user("u1", "hello"), assistant("a1")];
		expect(pickStickyUserEntry(entries, { first: 1, last: 2 })).toBeNull();
	});

	test("pins the prompt once its row scrolled out and its round still fills the viewport", () => {
		const entries = [assistant("a0"), user("u1", "hello"), assistant("a1"), assistant("a2")];
		expect(pickStickyUserEntry(entries, { first: 2, last: 3 })).toEqual({
			entry: entries[1],
			index: 1,
			summary: "hello",
		});
	});

	test("picks the nearest prompt when several rounds scrolled past", () => {
		const entries = [user("u1", "first"), assistant("a1"), user("u2", "second"), assistant("a2"), assistant("a3")];
		expect(pickStickyUserEntry(entries, { first: 4, last: 4 })?.summary).toBe("second");
		expect(pickStickyUserEntry(entries, { first: 4, last: 4 })?.index).toBe(2);
	});

	test("hides when the prompt's round ended above the viewport", () => {
		// A displayed advisor note opens the turn now in view; the previous
		// prompt's round is entirely above it.
		const entries = [user("u1", "first"), advisor("adv"), assistant("a1")];
		expect(pickStickyUserEntry(entries, { first: 2, last: 2 })).toBeNull();
	});

	test("summarizes what the user said, not the quote prefix", () => {
		const quoted: MessageEntry = {
			...user("u1", "> quoted line\n\nmy comment"),
			message: {
				role: "user",
				content: "> quoted line\n\nmy comment",
				timestamp: 1,
				displayContext: { kind: "chat-quote", quote: "quoted line" },
			},
		};
		const entries = [assistant("a0"), quoted, assistant("a1")];
		expect(pickStickyUserEntry(entries, { first: 2, last: 2 })?.summary).toBe("my comment");
	});

	test("collapses whitespace to one line and skips prompts without text", () => {
		const entries = [assistant("a0"), user("u1", "line one\n  line two\t"), assistant("a1")];
		expect(pickStickyUserEntry(entries, { first: 2, last: 2 })?.summary).toBe("line one line two");

		const empty = [assistant("a0"), user("u1", " \n\t "), assistant("a1")] as SessionEntry[];
		expect(pickStickyUserEntry(empty, { first: 2, last: 2 })).toBeNull();
	});
});

describe("StickyUserMessage", () => {
	test("clicking the pill jumps to the prompt", () => {
		const entry = user("u1", "hello");
		const candidate = { entry, index: 1, summary: "hello" };
		const jumps: unknown[] = [];
		const host = render(<StickyUserMessage candidate={candidate} onJump={c => jumps.push(c)} />);

		const button = host.querySelector<HTMLButtonElement>(".tr-sticky-user");
		expect(button).not.toBeNull();
		expect(button?.tagName).toBe("BUTTON");
		expect(button?.getAttribute("aria-label")).toContain("hello");
		expect(host.querySelector(".tr-sticky-user-text")?.textContent).toBe("hello");

		act(() => button?.click());
		expect(jumps).toEqual([candidate]);
	});

	test("renders nothing when no prompt is pinned", () => {
		const host = render(<StickyUserMessage candidate={null} onJump={() => {}} />);
		expect(host.querySelector(".tr-sticky-user")).toBeNull();
		expect(host.querySelector(".tr-sticky-user-slot")).toBeNull();
	});

	test("never duplicates the turn avatar — the pill is the only pinned element", () => {
		const candidate = { entry: user("u1", "hello"), index: 1, summary: "hello" };
		const host = render(<StickyUserMessage candidate={candidate} onJump={() => {}} />);
		expect(host.querySelector(".tr-sticky-user")).not.toBeNull();
		// Failure mode if regressed: the row's avatar and a pinned copy were both
		// on screen, which read as a second orb floating over the message.
		expect(host.querySelector(".tr-sticky-agent")).toBeNull();
		expect(host.querySelector(".tr-sticky-user-slot--agent")).toBeNull();
	});
});
